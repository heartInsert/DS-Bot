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

export const MAX_MESSAGE_CHARS = 32 * 1024
export const MAX_ITEMS = 200
export const MAX_SNAPSHOT_BYTES = 1.5 * 1024 * 1024
export const MAX_WAIT_MS = 25_000
export const DEFAULT_WAIT_MS = 20_000
const APPLIED_LIMIT = 500

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

export function createSessionSync({ rt, now = Date.now, refreshMs = 1_000, maxItems = MAX_ITEMS } = {}) {
  if (rt === undefined || typeof rt.chatPage !== 'function' || typeof rt.sendUser !== 'function') {
    throw new Error('createSessionSync needs the plugin runtime')
  }
  const epoch = randomBytes(8).toString('hex')
  let revision = 0
  let teamRevision = 0
  let lastTeamKey = undefined
  const entries = new Map()
  const waiters = new Map()
  const rendering = new Map()
  const applied = new Map()

  const ready = async () => {
    if (typeof rt.load === 'function') await rt.load()
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
      return { conv: { kind: 'bot', id: bot.id }, name: bot.name, sessionOf: () => rt.chatPage(bot.id) }
    }
    const room = roomNamed(conv.id)
    if (typeof rt.roomPage !== 'function') throw notFound('no group chat is served here')
    return { conv: { kind: 'room', id: room.id }, name: room.name ?? room.id, sessionOf: () => rt.roomPage(room.id) }
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

  async function render(reference) {
    const page = pageOf(reference)
    const rendered = await page.sessionOf()
    const all = Array.isArray(rendered.items) ? rendered.items : []
    const capped = capItems(all.slice(-maxItems))
    const items = stampIds(rendered.sessionId ?? null, capped.items)
    return {
      key: digest({ sessionId: rendered.sessionId ?? null, items }),
      conv: page.conv,
      name: page.name,
      sessionId: rendered.sessionId ?? null,
      items,
      hidden: capped.hidden,
      cursor: rendered.cursor ?? null,
    }
  }

  function wake(key) {
    const set = waiters.get(key)
    if (set === undefined) return
    waiters.delete(key)
    for (const done of set) done()
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
    while (!reset && now() - started < wanted) {
      const left = wanted - (now() - started)
      await waitForChange(key, Math.min(left, refreshMs))
      entry = await refresh(reference)
      if (entry.revision !== current) return { ...viewOf(entry), reset: false, unchanged: false }
    }
    return { ...viewOf(entry), reset: false, unchanged: true }
  }

  // A node's message is applied through the same path as the browser's composer, so the
  // Bot, the group log and the search index see one ordinary user message. `messageId`
  // makes a retry on a flaky link land once; the same id is kept for the hub run, so a
  // reconnect within one run cannot write the message a second time.
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
    const seen = id === undefined ? undefined : applied.get(id)
    if (seen !== undefined) {
      const key = keyOf(reference)
      return { ok: true, duplicate: true, ...(page.conv.kind === 'bot' ? { botId: page.conv.id } : { roomId: page.conv.id }), epoch, revision: entries.get(key)?.revision ?? revision, messageId: id, acceptedAt: seen }
    }
    if (typeof rt.readOnly === 'function' && rt.readOnly() !== undefined) {
      throw fail('this computer is only reading the Bot team, so it cannot add a message', 409)
    }
    await rt.sendUser({ sessionId: page.conv.id, content: [{ type: 'text', text: value }] })
    const acceptedAt = new Date(now()).toISOString()
    if (id !== undefined) {
      applied.set(id, acceptedAt)
      while (applied.size > APPLIED_LIMIT) applied.delete(applied.keys().next().value)
    }
    const entry = await refresh(reference).catch(() => undefined)
    return { ok: true, ...(page.conv.kind === 'bot' ? { botId: page.conv.id } : { roomId: page.conv.id }), epoch, revision: entry?.revision ?? revision, messageId: id, acceptedAt }
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
    send,
    // The Devices page and tests read this without touching a node.
    status: () => ({
      epoch,
      revision,
      synced: entries.size,
      waiting: [...waiters.values()].reduce((total, set) => total + set.size, 0),
    }),
  }
}
