// The center's conversation sync: every team conversation — a Bot's own chat or a group
// chat — as a revisioned snapshot that paired machines pull, and a user message they push
// back. The hub lives in the DSH plugin process, so this module is the single writer of
// the conversation: a node keeps a read replica and never runs a second team.
//
// A revision is a counter of this hub run. `epoch` names the run, so a node that kept a
// cursor from before a hub restart is told to take a full snapshot instead of waiting
// for a revision the new hub will never reach. Every item carries a stable id built from
// its Session and its event seq, so a re-snapshot (a reset, a reconnect) can be de-duped
// by the node rather than appended twice.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_MESSAGE_CHARS = 32 * 1024
export const MAX_ITEMS = 200
export const MAX_SNAPSHOT_BYTES = 1.5 * 1024 * 1024
export const MAX_WAIT_MS = 25_000
export const DEFAULT_WAIT_MS = 20_000

// The send log keeps accepted message ids so a retry after a hub restart still lands
// once. It is keyed per conversation (`bot:<id>` / `room:<id>`), keeps the resulting
// message reference (the run epoch and revision) for an idempotent reply, and is
// pruned both by age and by count so it stays bounded.
export const SEND_LOG_FILE = 'send-dedupe.json'
// Seven days: long enough to cover a machine that was offline over a weekend, short
// enough that the file cannot grow without bound from everyday sends.
export const SEND_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000
// A conversation rarely exceeds a thousand sends in a week; the per-conversation cap
// keeps one busy chat from evicting every other chat's ids, and the global cap is the
// last line against an unbounded file regardless of how many conversations exist.
export const MAX_IDS_PER_CONVERSATION = 1000
export const MAX_TOTAL_IDS = 10_000

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const notFound = message => fail(message, 404)

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// A snapshot is the tail of the current part, capped both by item count and by bytes so
// one long Bot post cannot turn every poll into a multi-megabyte transfer.
function capItems(all) {
  const kept = all.slice(-MAX_ITEMS)
  let bytes = 0
  let start = kept.length
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(kept[start - 1]))
    if (bytes + size > MAX_SNAPSHOT_BYTES) break
    bytes += size
    start -= 1
  }
  return { items: kept.slice(start), hidden: all.length - (kept.length - start) }
}

// A conversation reference is a Bot or a group chat. It travels as `bot:<id>` or
// `room:<id>`; a bare id means a Bot, so the first protocol's callers keep working.
export function conversationOf(reference) {
  if (reference !== null && typeof reference === 'object') {
    if ((reference.kind === 'bot' || reference.kind === 'room') && typeof reference.id === 'string' && reference.id !== '') {
      return { kind: reference.kind, id: reference.id }
    }
    throw fail('the conversation was not named')
  }
  const text = String(reference ?? '').trim()
  if (text === '') throw fail('the conversation was not named')
  const match = /^(bot|room):(.+)$/.exec(text)
  if (match !== null) return { kind: match[1], id: match[2] }
  return { kind: 'bot', id: text }
}

export const keyOf = reference => {
  const conv = conversationOf(reference)
  return `${conv.kind}:${conv.id}`
}

export function createSessionSync({ rt, dataDir, log = () => {}, now = Date.now, refreshMs = 1_000, maxItems = MAX_ITEMS } = {}) {
  if (rt === undefined || typeof rt.chatPage !== 'function' || typeof rt.sendUser !== 'function') {
    throw new Error('createSessionSync needs the plugin runtime')
  }
  const epoch = randomBytes(8).toString('hex')
  let revision = 0
  let teamRevision = 0
  let teamGeneration = 0
  let lastTeamKey = undefined
  const entries = new Map()
  const waiters = new Map()
  const rendering = new Map()
  // Accepted sends, keyed per conversation so one conversation's id never shadows
  // another's: `applyKey` joins the conversation reference and the client's id. The
  // entry keeps the reference and id so the reply and the file read them back.
  const applied = new Map()
  const applyKey = (conv, id) => `${conv}\u0000${id}`
  // A send that is still in flight, so two concurrent submits of the same id wait for
  // the one write instead of racing it.
  const inflight = new Map()
  // Card answers the hub has already settled, kept so a retry answers "duplicate"
  // instead of being mistaken for a card that never opened. In-memory only: cards are
  // live DSH state and do not survive a hub restart anyway.
  const settledApprovals = new Map()
  const settledQuestions = new Map()
  const settledViews = new Map()

  // The durable send log. Without a dataDir the hub is a CLI process with no team, so
  // the dedupe is in-memory only (the first protocol's behavior).
  const sendFile = typeof dataDir === 'string' && dataDir !== ''
    ? join(dataDir, SEND_LOG_FILE)
    : undefined

  function pruneApplied() {
    const at = now()
    for (const [key, entry] of applied) {
      if (at - entry.at > SEND_ID_TTL_MS) applied.delete(key)
    }
    // Newest N per conversation, then a global cap across all conversations.
    const perConversation = new Map()
    for (const entry of applied.values()) {
      const list = perConversation.get(entry.conv) ?? []
      list.push(entry)
      perConversation.set(entry.conv, list)
    }
    for (const list of perConversation.values()) {
      list.sort((left, right) => right.at - left.at)
      for (const entry of list.slice(MAX_IDS_PER_CONVERSATION)) applied.delete(applyKey(entry.conv, entry.id))
    }
    if (applied.size > MAX_TOTAL_IDS) {
      const oldest = [...applied.values()].sort((left, right) => left.at - right.at)
      for (const entry of oldest.slice(0, applied.size - MAX_TOTAL_IDS)) applied.delete(applyKey(entry.conv, entry.id))
    }
  }

  function persistApplied() {
    if (sendFile === undefined) return
    pruneApplied()
    const conversations = {}
    for (const entry of applied.values()) {
      const list = conversations[entry.conv] ?? (conversations[entry.conv] = [])
      list.push({
        id: entry.id,
        text: entry.text,
        at: entry.at,
        state: entry.state,
        ...(entry.epoch !== undefined ? { epoch: entry.epoch } : {}),
        ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
        ...(entry.acceptedAt !== undefined ? { acceptedAt: entry.acceptedAt } : {}),
      })
    }
    for (const list of Object.values(conversations)) list.sort((left, right) => left.at - right.at)
    // Atomic: write a sibling temp file, then rename over the real one. The mode is
    // 0600 (the log carries no secret, but a message id and text belong to the user).
    const payload = `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`
    const temp = `${sendFile}.${process.pid}.tmp`
    try {
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, sendFile)
      if (process.platform !== 'win32') {
        try { chmodSync(sendFile, 0o600) } catch { /* a file system without modes keeps the 0600 write */ }
      }
    } catch (error) {
      log('ds-bot lan: could not write %s: %s', sendFile, error.message)
    }
  }

  function loadApplied() {
    let text
    try {
      text = readFileSync(sendFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') log('ds-bot lan: could not read %s: %s', sendFile, error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      log('ds-bot lan: the send log %s is corrupt (%s); starting without it', sendFile, error.message)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.conversations === null || typeof parsed.conversations !== 'object') {
      log('ds-bot lan: the send log %s has an unknown shape; starting without it', sendFile)
      return
    }
    const at = now()
    let loaded = 0
    for (const [conv, list] of Object.entries(parsed.conversations)) {
      if (typeof conv !== 'string' || conv === '' || !Array.isArray(list)) continue
      for (const raw of list.slice(-MAX_IDS_PER_CONVERSATION)) {
        if (raw === null || typeof raw !== 'object') continue
        if (typeof raw.id !== 'string' || raw.id === '') continue
        if (typeof raw.text !== 'string' || !Number.isInteger(raw.at)) continue
        if (at - raw.at > SEND_ID_TTL_MS) continue
        const entry = {
          id: raw.id,
          conv,
          text: raw.text,
          at: raw.at,
          state: raw.state === 'pending' ? 'pending' : 'committed',
        }
        if (typeof raw.epoch === 'string') entry.epoch = raw.epoch
        if (Number.isInteger(raw.revision)) entry.revision = raw.revision
        if (typeof raw.acceptedAt === 'string') entry.acceptedAt = raw.acceptedAt
        applied.set(applyKey(conv, raw.id), entry)
        loaded += 1
      }
    }
    if (loaded > 0) log('ds-bot lan: loaded %d accepted sends from %s', loaded, sendFile)
  }

  if (sendFile !== undefined) {
    try { mkdirSync(dataDir, { recursive: true }) } catch (error) { log('ds-bot lan: could not make %s: %s', dataDir, error.message) }
    loadApplied()
  }

  // A pending entry was recorded before its write and left uncommitted by a crash. The
  // write is the only side effect a pending entry guards (a user message, never a model
  // turn or a tool), so on restart we only need to know whether it landed: look for a
  // user message with the same text in the conversation's current tail. Found → treat
  // as committed (a retry answers "already sent"); not found → drop it, so a retry
  // writes once. Either way no model turn is re-run.
  let reconciled = false
  async function reconcilePending() {
    if (reconciled || sendFile === undefined) return
    reconciled = true
    const pending = [...applied.values()].filter(entry => entry.state === 'pending')
    if (pending.length === 0) return
    for (const entry of pending) {
      let landed = false
      try {
        const page = pageOf(entry.conv)
        const rendered = await page.sessionOf()
        const items = Array.isArray(rendered.items) ? rendered.items : []
        landed = items.some(item => item?.kind === 'user' && String(item.text ?? '').trim() === entry.text)
      } catch (error) {
        log('ds-bot lan: could not check whether pending send %s landed: %s', entry.id, error.message)
      }
      if (landed) {
        entry.state = 'committed'
        if (entry.acceptedAt === undefined) entry.acceptedAt = new Date(entry.at).toISOString()
      } else {
        applied.delete(applyKey(entry.conv, entry.id))
      }
    }
    persistApplied()
  }

  const ready = async () => {
    if (typeof rt.load === 'function') await rt.load()
    await reconcilePending()
  }

  function botNamed(id) {
    const direct = rt.botOf?.(id)
    if (direct !== undefined) return direct
    const byName = Object.values(rt.state?.bots ?? {}).find(bot => bot.name === id)
    if (byName === undefined) throw notFound(`no Bot named ${id}`)
    return byName
  }

  function roomNamed(id) {
    const direct = rt.roomOf?.(id)
    if (direct !== undefined) return direct
    const byName = Object.values(rt.state?.rooms ?? {}).find(room => room.name === id)
    if (byName === undefined) throw notFound(`no group chat named ${id}`)
    return byName
  }

  async function bots() {
    await ready()
    const bots = Object.values(rt.state?.bots ?? {}).map(bot => ({
      id: bot.id,
      name: bot.name,
      role: bot.role ?? null,
      main: (rt.state?.mainBotIds ?? []).includes(bot.id),
    }))
    const rooms = Object.values(rt.state?.rooms ?? {}).map(room => ({
      id: room.id,
      name: room.name ?? room.id,
    }))
    // The list's revision counts the team itself — its Bots and group chats — not the
    // messages inside them, so a node notices a created, renamed or deleted conversation.
    const teamKey = digest({ bots, rooms })
    if (teamKey !== lastTeamKey) {
      lastTeamKey = teamKey
      teamRevision += 1
    }
    return { epoch, revision: teamRevision, bots, rooms }
  }

  function pageOf(reference) {
    const conv = conversationOf(reference)
    if (conv.kind === 'bot') {
      const bot = botNamed(conv.id)
      if (typeof rt.chatPage !== 'function') throw notFound('no Bot chat is served here')
      return { conv: { kind: 'bot', id: bot.id }, name: bot.name, sessionOf: cursor => rt.chatPage(bot.id, cursor) }
    }
    const room = roomNamed(conv.id)
    if (typeof rt.roomPage !== 'function') throw notFound('no group chat is served here')
    return { conv: { kind: 'room', id: room.id }, name: room.name ?? room.id, sessionOf: cursor => rt.roomPage(room.id, cursor) }
  }

  // Stable ids: an item with a seq names `${sessionId}:${seq}`, disambiguated by how many
  // items share that seq (one assistant message split into blocks, or a group relay row).
  // An item without a seq (a group reply row) falls back to its time and position.
  function stampIds(sessionId, items) {
    const seen = new Map()
    return items.map((item, index) => {
      const seq = Number.isInteger(item.seq) ? item.seq : null
      const id = seq !== null
        ? `${sessionId}:${seq}:${seen.get(seq) ?? 0}`
        : `${sessionId}:t:${item.time ?? ''}:${index}`
      if (seq !== null) seen.set(seq, (seen.get(seq) ?? 0) + 1)
      return { ...item, id }
    })
  }

  // The live cards a conversation holds, on top of its rendered items. A question or a
  // view is a Bot's own-chat card (`state.questions` / `state.views`, keyed by the chat
  // part); an approval belongs to the Bot or to a member of the group. None of these
  // are in `displayItems` — they are live DSH state, which is why the snapshot carries
  // them beside the items instead of inside them.
  const ownOf = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

  function approvalsOf(page) {
    const all = typeof rt.approvalsView === 'function' ? rt.approvalsView() : []
    const wanted = page.conv.kind === 'bot'
      ? all.filter(entry => entry.roomId === undefined && entry.botId === page.conv.id)
      : all.filter(entry => entry.roomId === page.conv.id)
    return wanted.map(entry => ({
      id: entry.id,
      botId: entry.botId,
      ...(typeof rt.botOf === 'function' && rt.botOf(entry.botId)?.name !== undefined ? { botName: rt.botOf(entry.botId).name } : {}),
      tool: entry.tool,
      reason: entry.reason,
      detail: entry.detail,
      answerable: entry.answerable,
      at: entry.at,
    }))
  }

  function pendingCardOf(botId, field) {
    const sessionId = typeof rt.chatOf === 'function' ? rt.chatOf(botId) : botId
    const cards = rt.state?.[field]
    if (cards === null || typeof cards !== 'object') return undefined
    return ownOf(cards, sessionId) ? cards[sessionId] : undefined
  }

  function cardsOf(page) {
    const cards = { approvals: approvalsOf(page) }
    if (page.conv.kind === 'bot') {
      const question = pendingCardOf(page.conv.id, 'questions')
      if (question !== undefined) cards.question = question
      const view = pendingCardOf(page.conv.id, 'views')
      if (view !== undefined) cards.view = view
    }
    return cards
  }

  async function render(reference) {
    const page = pageOf(reference)
    const rendered = await page.sessionOf()
    const all = Array.isArray(rendered.items) ? rendered.items : []
    const capped = capItems(all.slice(-maxItems))
    const items = stampIds(rendered.sessionId ?? null, capped.items)
    const cards = cardsOf(page)
    return {
      key: digest({ sessionId: rendered.sessionId ?? null, items, cards }),
      conv: page.conv,
      name: page.name,
      sessionId: rendered.sessionId ?? null,
      items,
      hidden: capped.hidden,
      cursor: rendered.cursor ?? null,
      ...cards,
    }
  }

  function wake(key) {
    const set = waiters.get(key)
    if (set === undefined) return
    waiters.delete(key)
    for (const done of set) done()
  }

  // A team write changed the roster; every node's waiting poll returns now so it re-reads
  // the team list promptly instead of on its slow timer. The generation lets a snapshot
  // tell "the team changed" apart from "the conversation changed".
  function wakeTeam() {
    teamGeneration += 1
    for (const [key, set] of [...waiters.entries()]) {
      waiters.delete(key)
      for (const done of set) done()
    }
  }

  // `before` names where an earlier page begins: the cursor a snapshot handed back
  // (`{part, beforeSeq}`), a bare seq, or a stable item id (`session:seq:n`). The seq
  // forms page the current part; the cursor form can cross into earlier parts.
  function cursorOf(before) {
    if (before === undefined || before === null) return undefined
    if (typeof before === 'object') {
      const part = Number.isInteger(before.part) ? before.part : undefined
      const beforeSeq = Number.isInteger(before.beforeSeq) ? before.beforeSeq : undefined
      return part === undefined && beforeSeq === undefined ? undefined : { ...(part === undefined ? {} : { part }), ...(beforeSeq === undefined ? {} : { beforeSeq }) }
    }
    const text = String(before).trim()
    if (text === '') return undefined
    if (/^\d+$/.test(text)) {
      const seq = Number(text)
      return seq > 0 ? { beforeSeq: seq } : undefined
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') return cursorOf(parsed)
    } catch {
      // Not JSON: fall through to the id form.
    }
    const idSeq = /:(\d+):(\d+)$/.exec(text)
    if (idSeq === null) return undefined
    const seq = Number(idSeq[1])
    return seq > 0 ? { beforeSeq: seq } : undefined
  }

  // The page before `before`, through the same `chatPage`/`roomPage` the live chat's
  // "Load earlier" uses, so earlier parts and their part lines page the same way.
  async function earlier(reference, { before } = {}) {
    await ready()
    const page = pageOf(reference)
    const rendered = await page.sessionOf(cursorOf(before))
    const all = Array.isArray(rendered.items) ? rendered.items : []
    const capped = capItems(all.slice(-maxItems))
    return {
      epoch,
      ...(page.conv.kind === 'bot' ? { botId: page.conv.id } : { roomId: page.conv.id }),
      sessionId: rendered.sessionId ?? null,
      items: stampIds(rendered.sessionId ?? null, capped.items),
      cursor: rendered.cursor ?? null,
    }
  }
  function publish(rendered) {
    const key = keyOf(rendered.conv)
    const previous = entries.get(key)
    if (previous !== undefined && previous.key === rendered.key) {
      previous.checkedAt = now()
      return previous
    }
    // One counter for every conversation: a node's cursor only has to order this hub's
    // answers.
    revision += 1
    const entry = {
      ...rendered,
      revision,
      updatedAt: new Date(now()).toISOString(),
      checkedAt: now(),
    }
    entries.set(key, entry)
    wake(key)
    return entry
  }

  // A burst of polls must not render the same conversation twice and bump the revision twice.
  function refresh(reference) {
    const key = keyOf(reference)
    const pending = rendering.get(key)
    if (pending !== undefined) return pending
    const run = ready()
      .then(() => render(reference))
      .then(publish)
      .finally(() => rendering.delete(key))
    rendering.set(key, run)
    return run
  }

  function viewOf(entry) {
    const { conv, name, sessionId, items, hidden, cursor, updatedAt } = entry
    return {
      epoch,
      revision: entry.revision,
      ...(conv.kind === 'bot' ? { botId: conv.id, botName: name } : { roomId: conv.id, roomName: name }),
      sessionId,
      items,
      hidden,
      cursor,
      updatedAt,
      approvals: entry.approvals ?? [],
      ...(entry.question === undefined ? {} : { question: entry.question }),
      ...(entry.view === undefined ? {} : { view: entry.view }),
    }
  }

  function waitForChange(key, timeoutMs) {
    return new Promise(resolve => {
      const set = waiters.get(key) ?? new Set()
      waiters.set(key, set)
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        if (set.size === 0 && waiters.get(key) === set) waiters.delete(key)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      set.add(done)
    })
  }

  // `since` is the revision a node already holds. It is answered at once when it is
  // behind or ahead; when it is current the call waits for a change, which is what makes
  // a paired screen show a message within about a second rather than on a blind timer.
  async function snapshot(reference, { since, epoch: fromEpoch, waitMs } = {}) {
    await ready()
    const key = keyOf(reference)
    let entry = await refresh(reference)
    const wanted = Math.min(Math.max(Number.isInteger(waitMs) ? waitMs : 0, 0), MAX_WAIT_MS)
    const reset = typeof fromEpoch === 'string' && fromEpoch !== '' && fromEpoch !== epoch
    const current = Number.isInteger(since) ? since : undefined
    const upToDate = current !== undefined && current === entry.revision
    if (reset || wanted === 0 || current === undefined || !upToDate) {
      return { ...viewOf(entry), reset, unchanged: !reset && upToDate }
    }
    const started = now()
    const teamAt = teamGeneration
    while (!reset && now() - started < wanted) {
      const left = wanted - (now() - started)
      await waitForChange(key, Math.min(left, refreshMs))
      entry = await refresh(reference)
      if (entry.revision !== current) return { ...viewOf(entry), reset: false, unchanged: false }
      // The team changed while this poll waited: answer now so the node re-reads the
      // team list; the conversation itself is unchanged.
      if (teamGeneration !== teamAt) return { ...viewOf(entry), reset: false, unchanged: true, teamChanged: true }
    }
    return { ...viewOf(entry), reset: false, unchanged: true }
  }

  // A node's message is applied through the same path as the browser's composer, so the
  // Bot, the group log and the search index see one ordinary user message. `messageId`
  // makes a retry on a flaky link land once, even across a hub restart: the id is
  // recorded as pending before the write and committed after, and a retry answers with
  // the same result instead of writing again.
  async function send({ botId, roomId, text, messageId } = {}) {
    await ready()
    const reference = roomId !== undefined && roomId !== ''
      ? { kind: 'room', id: String(roomId) }
      : { kind: 'bot', id: String(botId ?? '') }
    const page = pageOf(reference)
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '') throw fail('the message is empty')
    if (value.length > MAX_MESSAGE_CHARS) throw fail(`the message is longer than ${MAX_MESSAGE_CHARS} characters`)
    const id = typeof messageId === 'string' && messageId.trim() !== '' ? messageId.trim().slice(0, 80) : undefined
    const key = keyOf(reference)

    // The reply a committed id returns: the same reference and accepted time as the
    // original write, so a retry is indistinguishable from the first answer.
    const duplicateReply = entry => ({
      ok: true,
      duplicate: true,
      ...(page.conv.kind === 'bot' ? { botId: page.conv.id } : { roomId: page.conv.id }),
      epoch: entry.epoch ?? epoch,
      revision: entry.revision ?? entries.get(key)?.revision ?? revision,
      messageId: id,
      acceptedAt: entry.acceptedAt ?? new Date(entry.at).toISOString(),
    })

    if (id !== undefined) {
      const seen = applied.get(applyKey(key, id))
      if (seen !== undefined && seen.state === 'committed') return duplicateReply(seen)
      // A concurrent submit of the same id waits for the one that is already in
      // flight, so two racing requests never write twice.
      const running = inflight.get(id)
      if (running !== undefined) return running
    }

    const run = (async () => {
      if (id !== undefined) {
        const seen = applied.get(applyKey(key, id))
        if (seen !== undefined && seen.state === 'committed') return duplicateReply(seen)
      }
      if (typeof rt.readOnly === 'function' && rt.readOnly() !== undefined) {
        throw fail('this computer is only reading the Bot team, so it cannot add a message', 409)
      }
      const at = now()
      // Record before the write: if the process dies inside `sendUser`, the restart can
      // tell whether the message landed. The write is a plain user message — never a
      // model turn or a tool — so there is no side effect to replay, and at-most-once
      // for the model turn is preserved: a pending entry whose message is not found is
      // dropped, never re-sent by the hub on its own.
      if (id !== undefined) {
        applied.set(applyKey(key, id), { id, conv: key, text: value, at, state: 'pending' })
        persistApplied()
      }
      await rt.sendUser({ sessionId: page.conv.id, content: [{ type: 'text', text: value }] })
      const acceptedAt = new Date(now()).toISOString()
      const entry = await refresh(reference).catch(() => undefined)
      const landedRevision = entry?.revision ?? revision
      if (id !== undefined) {
        applied.set(applyKey(key, id), { id, conv: key, text: value, at, state: 'committed', epoch, revision: landedRevision, acceptedAt })
        persistApplied()
      }
      return { ok: true, ...(page.conv.kind === 'bot' ? { botId: page.conv.id } : { roomId: page.conv.id }), epoch, revision: landedRevision, messageId: id, acceptedAt }
    })()

    if (id !== undefined) inflight.set(id, run)
    try {
      return await run
    } finally {
      if (id !== undefined && inflight.get(id) === run) inflight.delete(id)
    }
  }

  const outcomeOf = choice => ({ allow: 'allowed-once', reject: 'rejected' })[choice]

  // A node's card answer reaches the hub's existing answer paths through the device
  // token. Each is idempotent by the card id: a retry returns the settled answer and
  // changes nothing, and an answer on a card the hub no longer holds (expired, already
  // answered elsewhere, or unknown) is a clear refusal. Answering never runs a tool —
  // it only resolves a pending request, or is refused when there is nothing left to
  // resolve, so a repeated answer can never re-execute a tool that already ran.
  async function answerApproval({ approvalId, choice } = {}) {
    await ready()
    const id = String(approvalId ?? '')
    if (id === '') throw fail('the approval was not named')
    const outcome = outcomeOf(choice)
    if (outcome === undefined) throw fail('Choose allow or reject')
    const settled = settledApprovals.get(id)
    if (settled !== undefined) return { ok: true, duplicate: true, outcome: settled, choice }
    if (typeof rt.answerApproval !== 'function') throw fail('approvals are not answered here', 503)
    try {
      rt.answerApproval(id, choice)
    } catch (error) {
      if (error?.code === 'bot/stale') throw Object.assign(fail('This approval is no longer open', 409), { code: 'bot/stale' })
      throw error
    }
    settledApprovals.set(id, outcome)
    return { ok: true, duplicate: false, outcome, choice }
  }

  async function answerQuestion({ botId, questionId, answer } = {}) {
    await ready()
    const id = String(questionId ?? '')
    if (id === '') throw fail('the question was not named')
    const settled = settledQuestions.get(id)
    if (settled !== undefined) return { ok: true, duplicate: true }
    if (typeof rt.answerQuestion !== 'function') throw fail('questions are not answered here', 503)
    const page = pageOf({ kind: 'bot', id: String(botId ?? '') })
    try {
      await rt.answerQuestion(page.conv.id, id, answer ?? {})
    } catch (error) {
      if (error?.code === 'bot/stale') throw Object.assign(fail('This question is no longer open', 409), { code: 'bot/stale' })
      if (error?.code === 'bot/invalid') throw Object.assign(fail(error.message || 'Nothing to send', 400), { code: 'bot/invalid' })
      throw error
    }
    settledQuestions.set(id, 'answered')
    return { ok: true, duplicate: false }
  }

  async function answerView({ botId, viewId, action, values } = {}) {
    await ready()
    const id = String(viewId ?? '')
    if (id === '') throw fail('the view was not named')
    const settled = settledViews.get(id)
    if (settled !== undefined) return { ok: true, duplicate: true }
    if (typeof rt.answerView !== 'function') throw fail('views are not answered here', 503)
    const page = pageOf({ kind: 'bot', id: String(botId ?? '') })
    try {
      await rt.answerView(page.conv.id, id, action, values)
    } catch (error) {
      if (error?.code === 'bot/stale') throw Object.assign(fail('This view is no longer open', 409), { code: 'bot/stale' })
      if (error?.code === 'bot/invalid') throw Object.assign(fail(error.message || 'Nothing to send', 400), { code: 'bot/invalid' })
      throw error
    }
    settledViews.set(id, 'answered')
    return { ok: true, duplicate: false }
  }

  async function dismissQuestion({ botId } = {}) {
    await ready()
    if (typeof rt.dismissQuestion !== 'function') throw fail('questions are not answered here', 503)
    const page = pageOf({ kind: 'bot', id: String(botId ?? '') })
    await rt.dismissQuestion(page.conv.id)
    return { ok: true }
  }

  async function dismissView({ botId } = {}) {
    await ready()
    if (typeof rt.dismissView !== 'function') throw fail('views are not answered here', 503)
    const page = pageOf({ kind: 'bot', id: String(botId ?? '') })
    await rt.dismissView(page.conv.id)
    return { ok: true }
  }

  return {
    epoch,
    get revision() {
      return revision
    },
    bots,
    // An alias the hub exposes for "the whole team, at once".
    list: bots,
    snapshot,
    earlier,
    send,
    answerApproval,
    answerQuestion,
    answerView,
    dismissQuestion,
    dismissView,
    // A team write woke every poll so each node re-reads the team list now.
    wakeTeam,
    // The Devices page and tests read this without touching a node.
    status: () => ({
      epoch,
      revision,
      synced: entries.size,
      accepted: applied.size,
      waiting: [...waiters.values()].reduce((total, set) => total + set.size, 0),
    }),
  }
}
