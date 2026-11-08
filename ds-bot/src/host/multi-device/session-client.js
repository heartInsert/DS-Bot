// The node side of the conversation sync: read replicas of the hub's conversations — a
// Bot's own chat or a group chat — pulled by revision, plus a send that the hub applies
// to the Session. The replicas are not a second team: nothing here writes team state,
// and this process never opens the Session. Reconnect is just another pull with the
// cursor it saved; every item carries a stable id, so a re-snapshot after a reset is
// de-duped instead of appended twice.
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_MESSAGE_CHARS = 32 * 1024

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function replicaDir(dataDir) {
  return join(dataDir, 'sync')
}

// A conversation's replica file. A Bot keeps its plain id (the first protocol's layout);
// a group chat is prefixed so the two can never collide.
export function replicaFile(dataDir, reference) {
  const text = String(reference ?? '')
  const room = /^room:(.+)$/.exec(text)
  const name = room ? `room-${room[1]}` : text.replace(/^bot:/, '')
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'bot'
  return join(replicaDir(dataDir), `${safe}.json`)
}

function readReplica(dataDir, reference) {
  try {
    const parsed = JSON.parse(readFileSync(replicaFile(dataDir, reference), 'utf8'))
    if (typeof parsed?.epoch === 'string' && Number.isInteger(parsed.revision) && Array.isArray(parsed.items)) return parsed
  } catch {
    // No replica yet, or one this version cannot read: start from a full snapshot.
  }
  return undefined
}

function writeReplica(dataDir, replica) {
  const dir = replicaDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = replicaFile(dataDir, replica.reference)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(replica, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // A file system without modes keeps the 0600 write above.
    }
  }
}

// Abort either on stop or when the request runs long past the hub's own wait, so a
// silent network does not hold the loop forever. The caller's controller is not
// consumed by the timeout, so the next pull still listens to stop().
function requestSignal(outer, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('the hub did not answer in time')), timeoutMs)
  timer.unref?.()
  const forward = () => controller.abort()
  outer?.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    },
  }
}

const failure = (message, { fatal = false, code } = {}) => Object.assign(new Error(message), { fatal, code })

// `reference` is `bot:<id>` or `room:<id>`. A replica's file name uses `bot-`/`room-`
// only for rooms, so the on-disk layout of the first protocol keeps working for Bots.
const readTeamReference = reference => String(reference ?? '')

export function createSessionClient({
  hubUrl,
  dataDir,
  token,
  bot = 'main',
  pollMs = 2_000,
  waitMs = 20_000,
  teamPollMs = 10_000,
  log = () => {},
  now = Date.now,
  onTeam = undefined,
} = {}) {
  if (typeof hubUrl !== 'string' || hubUrl === '') throw new Error('createSessionClient needs the hub URL')
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createSessionClient needs a dataDir')
  if (typeof token !== 'string' || token === '') throw new Error('createSessionClient needs the device token')
  const base = hubUrl.replace(/\/+$/, '')
  const controller = new AbortController()

  let status = 'idle'
  let lastError
  let lastSyncedAt
  let running = false
  let stopped = false
  let loopPromise
  let backoff = Math.max(500, Math.min(pollMs, 5_000))
  // The conversation the node follows now, and the replica it keeps for it. One active
  // conversation is pulled at a time; replicas for others stay on disk.
  let active = undefined
  let activeName
  let team = undefined
  let teamEpoch
  let teamRevision
  const convs = new Map()

  const iso = () => new Date(now()).toISOString()

  function convOf(reference) {
    const key = readTeamReference(reference)
    let conv = convs.get(key)
    if (conv === undefined) {
      conv = {
        reference: key,
        replica: readReplica(dataDir, key),
        botId: undefined,
        botName: undefined,
        roomId: undefined,
        roomName: undefined,
      }
      convs.set(key, conv)
    }
    return conv
  }

  function info() {
    const activeConv = active === undefined ? undefined : convs.get(active)
    return {
      status,
      supported: status !== 'unsupported',
      reference: active,
      ...(activeConv?.botId !== undefined ? { botId: activeConv.botId, botName: activeConv.botName } : {}),
      ...(activeConv?.roomId !== undefined ? { roomId: activeConv.roomId, roomName: activeConv.roomName } : {}),
      ...(activeName !== undefined ? { name: activeName } : {}),
      epoch: activeConv?.replica?.epoch,
      revision: activeConv?.replica?.revision,
      sessionId: activeConv?.replica?.sessionId,
      items: activeConv?.replica?.items?.length ?? 0,
      lastSyncedAt,
      lastError,
      pollMs,
      waitMs,
      ...(team === undefined ? {} : { team: { bots: team.bots.length, rooms: team.rooms.length, revision: teamRevision } }),
    }
  }

  async function request(path, init = {}) {
    const link = requestSignal(controller.signal, init.timeoutMs ?? (waitMs + REQUEST_TIMEOUT_MS))
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        signal: link.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
    } finally {
      link.done()
    }
  }

  async function list() {
    const response = await request('/session/list')
    if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
    if (response.status === 503) return { unsupported: true, bots: [], rooms: [] }
    if (!response.ok) throw failure(`the hub refused the team list: HTTP ${response.status}`)
    return response.json()
  }

  // The list names every conversation the hub has; the node picks the one it follows.
  function resolve(reference) {
    const text = String(reference ?? '')
    const match = /^(bot|room):(.+)$/.exec(text)
    const kind = match?.[1] ?? 'bot'
    const wanted = match?.[2] ?? text
    if (team === undefined) throw failure('the hub list has not been read yet')
    const list = kind === 'room' ? team.rooms : team.bots
    const found = wanted === '' || wanted === 'main' || wanted === 'auto'
      ? (list.find(entry => entry.main) ?? list[0])
      : (list.find(entry => entry.id === wanted) ?? list.find(entry => entry.name === wanted))
    if (found === undefined) {
      const error = failure(`the hub has no ${kind === 'room' ? 'group chat' : 'Bot'} named ${wanted}`, { code: 'bot/not-found' })
      error.unknown = true
      throw error
    }
    return { kind, id: found.id, name: found.name }
  }

  async function refreshTeam() {
    const answer = await list()
    if (answer.unsupported === true) return answer
    const changed = team === undefined || teamRevision !== answer.revision || teamEpoch !== answer.epoch
    team = answer
    teamEpoch = answer.epoch
    teamRevision = answer.revision
    if (changed && typeof onTeam === 'function') {
      // The callback reads the list and applies it; a throw here must not kill the pull.
      try {
        await onTeam(answer)
      } catch (error) {
        log('ds-bot lan: team change was not applied: %s', error.message)
      }
    }
    return answer
  }

  async function resolveActive() {
    if (active !== undefined) return active
    const answer = await refreshTeam()
    if (answer.unsupported === true) {
      const error = failure('this hub does not serve a conversation', { code: 'bot/unsupported' })
      error.unsupported = true
      throw error
    }
    const wanted = typeof bot === 'string' && bot !== '' ? bot : 'main'
    const found = resolve(`bot:${wanted}`)
    const key = `${found.kind}:${found.id}`
    const conv = convOf(key)
    conv.botId = found.kind === 'bot' ? found.id : undefined
    conv.botName = found.kind === 'bot' ? found.name : undefined
    conv.roomId = found.kind === 'room' ? found.id : undefined
    conv.roomName = found.kind === 'room' ? found.name : undefined
    active = key
    activeName = found.name
    return key
  }

  // A re-snapshot is merged by id so a reset (a hub restart) that returns overlapping
  // items does not double them; the tail itself is the hub's latest view.
  function mergeItems(existing, incoming) {
    if (!Array.isArray(existing) || existing.length === 0) return Array.isArray(incoming) ? incoming : []
    const incomingItems = Array.isArray(incoming) ? incoming : []
    const seen = new Set()
    const out = []
    // Incoming is the newest tail; keep it in order, then append the older items that
    // are not already represented, so a reset keeps the history the hub sent before.
    for (const item of incomingItems) {
      if (item?.id === undefined || !seen.has(item.id)) {
        out.push(item)
        if (item?.id !== undefined) seen.add(item.id)
      }
    }
    for (const item of existing) {
      if (item?.id === undefined || !seen.has(item.id)) {
        out.push(item)
        if (item?.id !== undefined) seen.add(item.id)
      }
    }
    return out
  }

  async function pullOnce() {
    const key = await resolveActive()
    const conv = convOf(key)
    const query = new URLSearchParams()
    if (conv.roomId !== undefined) query.set('room', conv.roomId)
    else query.set('bot', conv.botId ?? '')
    query.set('wait', String(Math.max(0, waitMs)))
    if (conv.replica !== undefined) {
      query.set('since', String(conv.replica.revision))
      if (typeof conv.replica.epoch === 'string') query.set('epoch', conv.replica.epoch)
    }
    const response = await request(`/session?${query.toString()}`)
    if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
    if (response.status === 503) return { unsupported: true }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 404) {
        active = undefined
        throw failure(body.error ?? 'the conversation is no longer on the hub', { code: 'bot/not-found' })
      }
      throw failure(body.error ?? `the hub refused the snapshot: HTTP ${response.status}`)
    }
    lastSyncedAt = iso()
    if (body.unchanged === true) {
      status = 'syncing'
      return { unchanged: true, revision: body.revision, epoch: body.epoch }
    }
    const incoming = {
      version: 1,
      epoch: String(body.epoch ?? ''),
      revision: Number.isInteger(body.revision) ? body.revision : 0,
      reference: key,
      ...(body.botId !== undefined ? { botId: String(body.botId) } : {}),
      ...(body.botName !== undefined ? { botName: body.botName } : {}),
      ...(body.roomId !== undefined ? { roomId: String(body.roomId) } : {}),
      ...(body.roomName !== undefined ? { roomName: body.roomName } : {}),
      sessionId: body.sessionId ?? null,
      items: Array.isArray(body.items) ? body.items : [],
      hidden: Number.isInteger(body.hidden) ? body.hidden : 0,
      updatedAt: body.updatedAt ?? null,
      savedAt: iso(),
    }
    const merged = body.reset === true ? mergeItems(conv.replica?.items, incoming.items) : incoming.items
    conv.replica = { ...incoming, items: merged }
    if (conv.botId === undefined && incoming.botId !== undefined) conv.botId = incoming.botId
    if (conv.roomId === undefined && incoming.roomId !== undefined) conv.roomId = incoming.roomId
    if (conv.botName === undefined && incoming.botName !== undefined) conv.botName = incoming.botName
    if (conv.roomName === undefined && incoming.roomName !== undefined) conv.roomName = incoming.roomName
    if (active === key) activeName = incoming.botName ?? incoming.roomName ?? activeName
    writeReplica(dataDir, conv.replica)
    status = 'syncing'
    return { ...conv.replica, reset: body.reset === true }
  }

  async function loop() {
    let lastTeamRefresh = 0
    while (!stopped) {
      try {
        const result = await pullOnce()
        if (result.unsupported === true) {
          status = 'unsupported'
          log('ds-bot lan: this hub does not serve a conversation; session sync is off')
          return
        }
        lastError = undefined
        backoff = Math.max(500, Math.min(pollMs, 5_000))
        // The team list is re-read on a timer, not only when a conversation changes, so a
        // Bot or a group chat created, renamed or deleted on the hub reaches the node.
        if (now() - lastTeamRefresh >= teamPollMs) {
          lastTeamRefresh = now()
          await refreshTeam().catch(() => {})
        }
        if (result.unchanged !== true) continue
        // A hub that answered the long poll at once would otherwise spin.
        await sleep(Math.min(250, pollMs))
      } catch (error) {
        if (stopped || controller.signal.aborted || error?.name === 'AbortError') break
        if (error?.fatal === true) {
          status = 'unauthorized'
          lastError = error.message
          log('ds-bot lan: session sync stopped: %s', error.message)
          return
        }
        status = 'offline'
        lastError = error.message
        if (error?.unknown === true) active = undefined
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  return {
    info,
    // The replica of a conversation, by reference or the active one.
    view: (reference) => {
      if (reference === undefined) return active === undefined ? undefined : convs.get(active)?.replica
      const conv = convOf(readTeamReference(reference))
      return conv.replica
    },
    // The hub's Bot and group list, read now if it has not been read yet.
    async bots() {
      if (team === undefined) await refreshTeam()
      return team ?? { bots: [], rooms: [] }
    },
    pull: pullOnce,
    // Follow a conversation: the next pull and every pull after reads this one. The
    // replica on disk is returned immediately when it already exists; a conversation
    // never opened here is pulled now, whether or not the background loop is running.
    async open(reference) {
      if (team === undefined) await refreshTeam()
      const found = resolve(reference)
      const key = `${found.kind}:${found.id}`
      const conv = convOf(key)
      if (found.kind === 'bot') { conv.botId = found.id; conv.botName = found.name }
      else { conv.roomId = found.id; conv.roomName = found.name }
      active = key
      activeName = found.name
      if (conv.replica === undefined) await pullOnce().catch(() => {})
      return conv.replica
    },
    // A message typed on this machine goes to the hub, which writes it into the one
    // Session; the reply comes back through the same pull as any other message. The
    // idempotency key is made here and kept by the caller for a retried submit.
    async send(text, { messageId = randomUUID(), reference } = {}) {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') throw new Error('the message is empty')
      if (value.length > MAX_MESSAGE_CHARS) throw new Error(`the message is longer than ${MAX_MESSAGE_CHARS} characters`)
      const key = await resolveActive()
      const conv = convOf(reference === undefined ? key : readTeamReference(reference))
      const body = conv.roomId !== undefined
        ? { roomId: conv.roomId, text: value, messageId }
        : { botId: conv.botId, text: value, messageId }
      let response
      try {
        response = await request('/session', { method: 'POST', body: JSON.stringify(body), timeoutMs: REQUEST_TIMEOUT_MS })
      } catch (error) {
        throw failure(`the hub is not reachable; the message was not sent (${error.message})`, { code: 'hub/offline' })
      }
      const answer = await response.json().catch(() => ({}))
      if (response.status === 401) throw failure('the hub does not know this device; pair it again', { fatal: true })
      if (!response.ok) throw failure(answer.error ?? `the hub refused the message: HTTP ${response.status}`, { code: response.status === 503 ? 'hub/offline' : undefined })
      if (!running) void pullOnce().catch(error => { lastError = error.message })
      return { ...answer, messageId }
    },
    async start() {
      if (running) return info()
      running = true
      stopped = false
      loopPromise = loop()
      return info()
    },
    async stop() {
      stopped = true
      running = false
      controller.abort()
      await loopPromise?.catch(() => {})
      status = 'stopped'
    },
  }
}
