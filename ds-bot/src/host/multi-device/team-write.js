// The hub's team writes. A joined node submits Bot and group changes through its device
// token; the hub applies them with its own rt functions, so the hub stays the one owner
// of the team and every other node picks the change up through the ordinary sync. The
// client's op id makes a retry idempotent: the id is recorded before the write, committed
// after, and persisted so a retry after a hub restart still lands once.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TEAM_WRITE_LOG_FILE = 'team-write-dedupe.json'
const OP_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_OPS = 2000

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// The operations a node may submit, and what a successful write answers with.
const OPS = Object.freeze([
  'create-bot', 'update-bot', 'delete-bot', 'duplicate-bot', 'private-release',
  'set-main', 'set-flags', 'create-room', 'update-room', 'delete-room',
])

// The stable id a write touched or made, for the idempotent reply.
function resultIdOf(op, result) {
  if (op === 'create-room') return result?.room?.id ?? result?.id
  return result?.id
}

function pick(source, names) {
  const out = {}
  for (const name of names) if (source?.[name] !== undefined) out[name] = source[name]
  return out
}

// Applies one op with the hub's own rt functions, exactly as the hub's browser channel
// would. Every op returns the same shape the browser endpoint returns (a Bot, a room, or
// a plain ok), so the node can hand it straight back to its UI.
async function applyOp(rt, op, payload) {
  switch (op) {
    case 'create-bot':
      return rt.createBot(pick(payload, ['name', 'role', 'color', 'instructions', 'brief', 'avatar', 'model', 'effort', 'workDir']))
    case 'update-bot':
      return rt.updateBot(String(payload.id ?? ''), pick(payload, ['name', 'role', 'color', 'instructions', 'brief', 'avatar', 'model', 'effort', 'pinned', 'hidden', 'permission']))
    case 'delete-bot':
      await rt.deleteBot(String(payload.id ?? ''))
      return { ok: true, id: String(payload.id ?? '') }
    case 'duplicate-bot':
      return rt.duplicateBot(String(payload.id ?? ''))
    case 'private-release':
      await rt.releaseArchive(String(payload.id ?? ''))
      return { ok: true, id: String(payload.id ?? '') }
    case 'set-main':
      await rt.setMain(String(payload.id ?? ''), payload.main !== false, {
        primary: payload.primary === true,
        replace: typeof payload.replace === 'string' ? payload.replace : undefined,
      })
      return { ok: true, id: String(payload.id ?? '') }
    case 'set-flags':
      return rt.setFlags(String(payload.id ?? ''), pick(payload, ['pinned', 'hidden']))
    case 'create-room': {
      const room = await rt.createRoom({
        members: Array.isArray(payload.members) ? payload.members : [],
        name: payload.name,
        ...(typeof payload.admin === 'string' ? { admin: payload.admin } : {}),
      })
      if (payload.greet === true) await rt.greetRoom(room.id).catch(() => {})
      return room
    }
    case 'update-room': {
      const { room, changes } = await rt.updateRoom(String(payload.id ?? ''), {
        name: payload.name,
        notice: payload.notice,
        mode: payload.mode,
        admin: payload.admin,
        members: Array.isArray(payload.members) ? payload.members : undefined,
        add: Array.isArray(payload.add) ? payload.add : undefined,
        remove: Array.isArray(payload.remove) ? payload.remove : undefined,
        workDir: payload.workDir,
        permission: payload.permission,
      })
      return { room, changes }
    }
    case 'delete-room':
      await rt.deleteRoom(String(payload.id ?? ''))
      return { ok: true, id: String(payload.id ?? '') }
    default:
      throw fail(`the hub does not accept this team write: ${op}`)
  }
}

export function createTeamWrite({ rt, dataDir, log = () => {}, now = Date.now } = {}) {
  if (rt === undefined || typeof rt.createBot !== 'function' || typeof rt.updateBot !== 'function') {
    throw new Error('createTeamWrite needs the plugin runtime')
  }
  const applied = new Map()
  const inflight = new Map()

  const logFile = typeof dataDir === 'string' && dataDir !== '' ? join(dataDir, TEAM_WRITE_LOG_FILE) : undefined

  function pruneApplied() {
    const at = now()
    for (const [key, entry] of applied) {
      if (at - entry.at > OP_ID_TTL_MS) applied.delete(key)
    }
    if (applied.size > MAX_OPS) {
      const oldest = [...applied.values()].sort((left, right) => left.at - right.at)
      for (const entry of oldest.slice(0, applied.size - MAX_OPS)) applied.delete(`${entry.op}\u0000${entry.id}`)
    }
  }

  function persistApplied() {
    if (logFile === undefined) return
    pruneApplied()
    const entries = [...applied.values()]
      .sort((left, right) => left.at - right.at)
      .map(entry => ({
        id: entry.id,
        op: entry.op,
        at: entry.at,
        state: entry.state,
        ...(entry.resultId === undefined ? {} : { resultId: entry.resultId }),
      }))
    const payload = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
    const temp = `${logFile}.${process.pid}.tmp`
    try {
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, logFile)
      if (process.platform !== 'win32') {
        try { chmodSync(logFile, 0o600) } catch { /* a file system without modes keeps the 0600 write */ }
      }
    } catch (error) {
      log('ds-bot lan: could not write %s: %s', logFile, error.message)
    }
  }

  function loadApplied() {
    let text
    try {
      text = readFileSync(logFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') log('ds-bot lan: could not read %s: %s', logFile, error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      log('ds-bot lan: the team write log %s is corrupt; starting without it', logFile)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return
    const at = now()
    for (const raw of parsed.entries.slice(-MAX_OPS)) {
      if (raw === null || typeof raw !== 'object') continue
      if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.op !== 'string') continue
      if (at - raw.at > OP_ID_TTL_MS) continue
      if (raw.state !== 'committed') continue
      applied.set(`${raw.op}\u0000${raw.id}`, {
        id: raw.id,
        op: raw.op,
        at: raw.at,
        state: 'committed',
        ...(typeof raw.resultId === 'string' ? { resultId: raw.resultId } : {}),
      })
    }
  }

  if (logFile !== undefined) {
    try { mkdirSync(dataDir, { recursive: true }) } catch (error) { log('ds-bot lan: could not make %s: %s', dataDir, error.message) }
    loadApplied()
  }

  // A committed op id returns the same answer as the original write. Creates and updates
  // re-read the live Bot/room so the reply is current; deletes answer "already done".
  function committedReply(entry) {
    const reply = { ok: true, duplicate: true }
    if (entry.resultId !== undefined) {
      const bot = typeof rt.botOf === 'function' ? rt.botOf(entry.resultId) : undefined
      const room = typeof rt.roomOf === 'function' ? rt.roomOf(entry.resultId) : undefined
      if (room !== undefined) return { ...reply, ...room, id: entry.resultId }
      if (bot !== undefined) return { ...reply, ...bot, id: entry.resultId }
      reply.id = entry.resultId
    }
    return reply
  }

  async function apply({ op, payload = {}, opId } = {}) {
    if (typeof rt.load === 'function') await rt.load()
    if (typeof op !== 'string' || !OPS.includes(op)) throw fail(`the hub does not accept this team write: ${op ?? ''}`)
    if (typeof rt.readOnly === 'function' && rt.readOnly() !== undefined) {
      throw fail('this computer is only reading the Bot team, so it cannot change it', 409)
    }
    const id = typeof opId === 'string' && opId.trim() !== '' ? opId.trim().slice(0, 80) : undefined
    const key = `${op}\u0000${id ?? ''}`

    if (id !== undefined) {
      const seen = applied.get(key)
      if (seen !== undefined && seen.state === 'committed') return committedReply(seen)
      const running = inflight.get(key)
      if (running !== undefined) return running
    }

    const run = (async () => {
      if (id !== undefined) {
        const seen = applied.get(key)
        if (seen !== undefined && seen.state === 'committed') return committedReply(seen)
        applied.set(key, { id, op, at: now(), state: 'pending' })
        persistApplied()
      }
      const result = await applyOp(rt, op, payload)
      const resultId = resultIdOf(op, result)
      if (id !== undefined) {
        applied.set(key, { id, op, at: now(), state: 'committed', ...(resultId === undefined ? {} : { resultId }) })
        persistApplied()
      }
      return { ok: true, ...result }
    })()

    if (id !== undefined) inflight.set(key, run)
    try {
      return await run
    } finally {
      if (id !== undefined && inflight.get(key) === run) inflight.delete(key)
    }
  }

  return {
    apply,
    status: () => ({ accepted: applied.size }),
  }
}
