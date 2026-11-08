// What a machine takes over when it joins a hub: the team's Bots, group chats, agents,
// capability entries, preferences and the memory files. The hub is the owner, so the
// bundle is one object the node applies whole instead of merging its own team into it.
//
// The scope is an allowlist, written out here rather than "everything except". Credentials
// never travel: the API keys and tokens live in secrets.json and in the connectors, which
// this module does not read. Machine-specific configuration stays on the machine that owns
// it: the multi-device block (device id, ports, the hub this computer joined), the
// computer-use permissions, and any working directory a Bot or a group chat was given.
//
// Applying is all or nothing. The caller makes a timestamped backup of the local team
// first; this module keeps the previous values in memory as well, and puts both back when
// a write fails, so a node never ends up with half of the hub's team.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const TEAM_BUNDLE_VERSION = 1

// The part of `<DSH_HOME>/bot/state.json` a hub hands over. Everything not named here stays
// local: see KEPT_LOCAL_STATE below.
export const SYNCED_STATE_KEYS = Object.freeze([
  'bots',
  'mainBotIds',
  'rooms',
  'privateArchives',
  'agents',
  'capabilities',
  'prefs',
])

// Listed so a reader can see the decision, not to be filtered at run time. These are the
// fields a node keeps: `multiDevice` holds the device id and the hub it joined, `computer`
// holds this machine's computer-use permissions, the rest is per-window or per-run state.
export const KEPT_LOCAL_STATE = Object.freeze([
  'version',
  'revision',
  'multiDevice',
  'computer',
  'works',
  'exchanges',
  'exchangeTurns',
  'requests',
  'questions',
  'views',
  'closedCards',
  'switching',
])

// The memory tree, by directory under `<home>/memory`. `snapshots/` is what one Session
// froze of the memory and is rebuilt there; `archive/` keeps deleted Bots, which belong to
// the hub that deleted them.
export const SYNCED_MEMORY_DIRS = Object.freeze(['team', 'bots', 'groups'])
export const SYNCED_MEMORY_FILES = Object.freeze(['journal.jsonl', 'reviewed.json'])
const MIRRORED_EXTENSIONS = new Set(['.md', '.json', '.jsonl'])
const MEMORY_FILE_MAX = 512 * 1024
const MEMORY_TOTAL_MAX = 8 * 1024 * 1024

// A key with one of these names holds a credential, wherever it sits in the team.
const SECRET_KEYS = new Set([
  'apikey', 'api_key', 'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'secret', 'secretkey', 'secret_key', 'password', 'passwd', 'authorization', 'cookie',
  'privatekey', 'private_key', 'clientsecret', 'client_secret', 'sessionkey', 'session_key',
])

// A path a Bot or a group chat was given on the hub machine means nothing here.
const MACHINE_PATH_KEYS = new Set(['workdir'])

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function scrub(value) {
  if (Array.isArray(value)) return value.map(entry => scrub(entry))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [name, entry] of Object.entries(value)) {
    const lower = name.toLowerCase()
    if (SECRET_KEYS.has(lower) || MACHINE_PATH_KEYS.has(lower)) continue
    out[name] = scrub(entry)
  }
  return out
}

/**
 * The hub's team as it travels: the allowlisted state keys with credentials and
 * machine-specific paths removed.
 */
export function teamOf(state) {
  const source = state !== null && typeof state === 'object' ? state : {}
  const team = {}
  for (const key of SYNCED_STATE_KEYS) {
    if (source[key] === undefined) continue
    team[key] = scrub(clone(source[key]))
  }
  team.mainBotIds = Array.isArray(team.mainBotIds) ? team.mainBotIds.filter(id => team.bots?.[id] !== undefined) : []
  return team
}

// Machine paths are dropped on the way out, so the machine that keeps them puts its own
// back after the allowlisted keys have been replaced. A Bot that exists only on the hub
// arrives without a working directory and uses the default folder.
export function keepLocalPaths(team, local) {
  const next = team
  for (const [id, bot] of Object.entries(next.bots ?? {})) {
    const workDir = local?.bots?.[id]?.workDir
    if (workDir !== undefined) bot.workDir = workDir
  }
  for (const [id, room] of Object.entries(next.rooms ?? {})) {
    const workDir = local?.rooms?.[id]?.workDir
    if (workDir !== undefined) room.workDir = workDir
  }
  next.privateArchives = Array.isArray(next.privateArchives)
    ? next.privateArchives.map(entry => {
        const workDir = Array.isArray(local?.privateArchives)
          ? local.privateArchives.find(local => local?.id === entry?.id)?.workDir
          : undefined
        return workDir === undefined ? entry : { ...entry, workDir }
      })
    : []
  return next
}

const posix = value => value.split('\\').join('/')

function isMirrored(key) {
  if (key === undefined || key === '') return false
  if (!SYNCED_MEMORY_FILES.some(file => key === `memory/${file}`) && !SYNCED_MEMORY_DIRS.some(dir => key.startsWith(`memory/${dir}/`))) return false
  const dot = key.lastIndexOf('.')
  return dot >= 0 && MIRRORED_EXTENSIONS.has(key.slice(dot).toLowerCase())
}

function walk(root, base = root, found = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walk(path, base, found)
    else if (entry.isFile()) found.push(posix(path.slice(base.length + 1)))
  }
  return found
}

/** Every memory file this module would mirror, as `memory/...` keys. */
export function listMemory(home) {
  const dir = join(home ?? '', 'memory')
  if (typeof home !== 'string' || home === '' || !existsSync(dir)) return []
  return walk(dir).map(relative => `memory/${relative}`).filter(isMirrored).sort()
}

/**
 * The memory files a node takes over: everything under the synced directories, capped by
 * one file's size and by the bundle's total. A file over the cap is left on the hub rather
 * than sent in half.
 */
export function readMemory(home) {
  const files = {}
  let total = 0
  for (const key of listMemory(home)) {
    const path = join(home, ...key.split('/'))
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (info.size > MEMORY_FILE_MAX) continue
    if (total + info.size > MEMORY_TOTAL_MAX) break
    try {
      files[key] = readFileSync(path, 'utf8')
      total += info.size
    } catch {
      // A file that went away between the listing and the read is simply not in the bundle.
    }
  }
  return files
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

function removeIfEmpty(dir, stop) {
  let current = dir
  while (current !== stop && current.startsWith(stop)) {
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      rmSync(current, { recursive: false })
    } catch {
      return
    }
    current = dirname(current)
  }
}

/**
 * Writes the bundle's memory files under `<home>/memory` and, unless `prune` is false,
 * removes the local ones the hub does not have, so the node mirrors the hub rather than
 * keeping a mix of both. A file whose bytes already match is not written again.
 */
export function writeMemory(home, files, { prune = true } = {}) {
  const written = []
  const removed = []
  for (const [key, text] of Object.entries(files ?? {})) {
    if (!isMirrored(key)) throw new Error(`the hub sent a memory file outside the synced memory: ${key}`)
    const path = join(home, ...key.split('/'))
    try {
      if (readFileSync(path, 'utf8') === text) continue
    } catch {
      // Missing or unreadable: write it.
    }
    writeAtomic(path, text)
    written.push(key)
  }
  if (prune) {
    for (const key of listMemory(home)) {
      if (Object.hasOwn(files ?? {}, key)) continue
      const path = join(home, ...key.split('/'))
      try {
        unlinkSync(path)
        removed.push(key)
        removeIfEmpty(dirname(path), join(home, 'memory'))
      } catch {
        // Already gone.
      }
    }
  }
  return { written, removed }
}

const stampOf = at => new Date(at).toISOString().replace(/[:.]/g, '-')

/** Where a backup for a join made now goes: one directory per attempt, named by time. */
export function backupPath({ dataDir, at = Date.now(), label = 'join' } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('a backup needs the multi-device data folder')
  return join(dataDir, 'backups', `${label}-${stampOf(at)}`)
}

/**
 * Copies the local team — `state.json` and the memory tree — into a timestamped directory
 * and returns where it went. A copy that fails throws: the caller aborts the join, because
 * without a backup there is nothing to go back to.
 */
export function backupTeam({ home, dataDir, at = Date.now(), label = 'join' } = {}) {
  if (typeof home !== 'string' || home === '') throw new Error('a backup needs the Bot team folder')
  const dir = backupPath({ dataDir, at, label })
  mkdirSync(dir, { recursive: true })
  const saved = { createdAt: new Date(at).toISOString(), home, files: [] }
  const statePath = join(home, 'state.json')
  if (existsSync(statePath)) {
    const target = join(dir, 'state.json')
    writeFileSync(target, readFileSync(statePath))
    saved.files.push('state.json')
  }
  const memoryDir = join(home, 'memory')
  if (existsSync(memoryDir)) {
    cpSync(memoryDir, join(dir, 'memory'), { recursive: true })
    saved.files.push('memory')
  }
  writeFileSync(join(dir, 'backup.json'), `${JSON.stringify(saved, null, 2)}\n`)
  return { dir, path: dir, createdAt: saved.createdAt, files: saved.files }
}

/**
 * Puts a backup back on disk and into the running runtime. Used when the apply itself
 * failed after some files had been written.
 */
export async function restoreTeam({ rt, backup }) {
  if (backup?.dir === undefined) throw new Error('there is no backup to restore')
  const saved = join(backup.dir, 'state.json')
  if (existsSync(saved)) {
    const parsed = JSON.parse(readFileSync(saved, 'utf8'))
    for (const key of SYNCED_STATE_KEYS) delete rt.state[key]
    if (parsed !== null && typeof parsed === 'object') Object.assign(rt.state, parsed)
  }
  if (existsSync(join(backup.dir, 'memory'))) {
    // readMemory walks `<dir>/memory` and names every file `memory/...`, which is the same
    // shape the hub sent, so the restore uses the apply path.
    writeMemory(rt.home, readMemory(backup.dir), { prune: true })
  }
  await rt.save()
  return rt.state
}

// What the local team looked like right before an apply, kept in memory for the rollback.
function localSnapshot(rt) {
  const keys = {}
  for (const key of SYNCED_STATE_KEYS) keys[key] = clone(rt.state[key])
  const memory = {}
  for (const key of listMemory(rt.home)) {
    try {
      memory[key] = readFileSync(join(rt.home, ...key.split('/')), 'utf8')
    } catch {
      // Not readable: it cannot be restored, and it is in the backup on disk.
    }
  }
  return { keys, memory }
}

function putBack(rt, snapshot) {
  for (const key of SYNCED_STATE_KEYS) {
    if (snapshot.keys[key] === undefined) delete rt.state[key]
    else rt.state[key] = clone(snapshot.keys[key])
  }
}

/**
 * Replaces the local team with the hub's, all of it or none of it. `rt.save()` is the only
 * way the state file is written, so the store's lock and its change detection stay in
 * charge. On any failure the previous state and memory go back — in memory and on disk —
 * and the error is thrown again for the caller to report.
 */
export async function applyTeamBundle({ rt, bundle, backup } = {}) {
  if (rt === undefined || typeof rt.save !== 'function' || typeof rt.state !== 'object') throw new Error('applying a team needs the plugin runtime')
  if (bundle === undefined || bundle?.team === undefined) throw new Error('the hub sent no team')
  if (bundle.version !== undefined && bundle.version !== TEAM_BUNDLE_VERSION) {
    throw new Error(`the hub uses team sync version ${bundle.version}; this DS Bot reads version ${TEAM_BUNDLE_VERSION}`)
  }
  const readOnly = typeof rt.readOnly === 'function' ? rt.readOnly() : undefined
  if (readOnly !== undefined) throw new Error(readOnly)
  if (typeof rt.load === 'function') await rt.load()
  const before = localSnapshot(rt)
  let memoryDone = false
  try {
    const memory = writeMemory(rt.home, bundle.memory ?? {})
    memoryDone = true
    const team = keepLocalPaths(teamOf(bundle.team), rt.state)
    for (const key of SYNCED_STATE_KEYS) {
      if (team[key] === undefined) continue
      rt.state[key] = team[key]
    }
    // A team whose Main Bots all left would leave the team without one.
    if ((rt.state.mainBotIds ?? []).length === 0 && Object.keys(rt.state.bots ?? {}).length > 0) {
      rt.state.mainBotIds = [Object.keys(rt.state.bots)[0]]
    }
    await rt.save()
    return {
      applied: true,
      hub: bundle.hub ?? null,
      revision: bundle.revision ?? null,
      bots: Object.keys(team.bots ?? {}).length,
      rooms: Object.keys(team.rooms ?? {}).length,
      memory: memory.written.length,
      removed: memory.removed.length,
      backup: backup?.dir ?? null,
    }
  } catch (error) {
    putBack(rt, before)
    try {
      writeMemory(rt.home, before.memory, { prune: memoryDone })
      await rt.save()
    } catch {
      // The team file on disk still holds what it held; the caller reports the failure.
    }
    throw error
  }
}

/** The hub's side of the bundle: its team and memory, read when a node asks for them. */
export function createTeamSource({ state, home, name = 'DS Bot hub', now = Date.now } = {}) {
  const teamState = typeof state === 'function' ? state : () => state
  const teamHome = typeof home === 'function' ? home : () => home
  return {
    async snapshot() {
      const current = teamState() ?? {}
      return {
        version: TEAM_BUNDLE_VERSION,
        hub: name,
        generatedAt: new Date(now()).toISOString(),
        revision: Number.isInteger(current.revision) ? current.revision : 0,
        team: teamOf(current),
        memory: readMemory(teamHome()),
      }
    },
  }
}

export function teamApplyMarkerPath(dataDir) {
  return join(dataDir, 'team-sync.json')
}

// Where a node records the local Bots and group chats the hub's bundle does not know,
// so a take-over never drops them silently: they are kept in the backup and listed here,
// and migrated to the hub as creates once the node is connected.
export const UNSYNCED_LOCAL_FILE = 'unsynced-local.json'
export function unsyncedLocalPath(dataDir) {
  return join(dataDir, UNSYNCED_LOCAL_FILE)
}

/** The local Bots and group chats the hub's team does not name, as `{ bots, rooms }`. */
export function unsyncedLocalTeam(localState, hubTeam) {
  const hubBots = hubTeam?.bots ?? {}
  const hubRooms = hubTeam?.rooms ?? {}
  const bots = []
  const rooms = []
  for (const [id, bot] of Object.entries(localState?.bots ?? {})) {
    if (hubBots[id] === undefined) bots.push(bot)
  }
  for (const [id, room] of Object.entries(localState?.rooms ?? {})) {
    if (hubRooms[id] === undefined) rooms.push(room)
  }
  return { bots, rooms }
}

/** Writes the unsynced local team to the node data dir, or clears it when there is none. */
export function recordUnsyncedLocalTeam(dataDir, entries, { now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('recording the local team needs the multi-device data folder')
  const bots = Array.isArray(entries?.bots) ? entries.bots : []
  const rooms = Array.isArray(entries?.rooms) ? entries.rooms : []
  const path = unsyncedLocalPath(dataDir)
  if (bots.length === 0 && rooms.length === 0) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone: nothing unsynced to keep.
    }
    return { bots: [], rooms: [] }
  }
  const recorded = { recordedAt: new Date(now()).toISOString(), bots, rooms }
  writeAtomic(path, `${JSON.stringify(recorded, null, 2)}\n`)
  return recorded
}

/** Reads the unsynced local team a previous take-over recorded, if any. */
export function readUnsyncedLocalTeam(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(unsyncedLocalPath(dataDir), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      return {
        bots: Array.isArray(parsed.bots) ? parsed.bots : [],
        rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      }
    }
  } catch {
    // No record yet, or one this version cannot read.
  }
  return undefined
}

/** What this node last applied, so a reconnect with nothing new writes nothing. */
export function readApplyMarker(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(teamApplyMarkerPath(dataDir), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // No marker yet: the next sync applies the bundle.
  }
  return undefined
}

export function writeApplyMarker(dataDir, marker) {
  mkdirSync(dataDir, { recursive: true })
  writeAtomic(teamApplyMarkerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`)
}

const sameBundle = (marker, bundle) => marker?.hubId !== undefined
  && marker.hubId === bundle.hubId
  && Number.isInteger(marker.revision)
  && marker.revision === bundle.revision
  && marker.appliedAt !== undefined

/**
 * One pull of the hub's team, applied unless this node already applied exactly this bundle.
 * A reconnect therefore sends nothing and writes nothing twice, and a join after a leave
 * still lands on the same team.
 */
export async function syncTeam({ rt, hubUrl, token, dataDir, hubId, backup, timeoutMs = 15_000, tries = 2, log = () => {} } = {}) {
  const bundle = await fetchTeam({ hubUrl, token, timeoutMs, tries })
  const marker = readApplyMarker(dataDir)
  const keyed = { ...bundle, hubId }
  if (sameBundle(marker, keyed)) {
    return { applied: false, unchanged: true, revision: bundle.revision, hub: bundle.hub ?? null, backup: backup?.dir ?? null }
  }
  // Before the hub's team replaces the local one, remember the Bots and group chats this
  // machine holds that the hub does not, so a take-over never drops them silently.
  let unsynced
  try {
    unsynced = recordUnsyncedLocalTeam(dataDir, unsyncedLocalTeam(rt.state, bundle.team))
  } catch (error) {
    log('ds-bot lan: could not record the unsynced local team: %s', error.message)
  }
  const result = await applyTeamBundle({ rt, bundle, backup })
  writeApplyMarker(dataDir, {
    hubId,
    revision: bundle.revision,
    hub: bundle.hub ?? null,
    appliedAt: new Date().toISOString(),
    backup: backup?.dir ?? null,
    bots: result.bots,
    memory: result.memory,
  })
  log('ds-bot lan: took over the team from %s (%d bots, %d memory files)', bundle.hub ?? hubUrl, result.bots, result.memory)
  return { ...result, hubId, unsynced: { bots: unsynced?.bots?.length ?? 0, rooms: unsynced?.rooms?.length ?? 0 } }
}

const baseOf = hubUrl => String(hubUrl ?? '').replace(/\/+$/, '')

/** The hub's team over the device token the join already returned. */
export async function fetchTeam({ hubUrl, token, timeoutMs = 15_000, tries = 2 } = {}) {
  if (typeof hubUrl !== 'string' || hubUrl === '') throw new Error('reading the hub team needs the hub URL')
  if (typeof token !== 'string' || token === '') throw new Error('reading the hub team needs the device token')
  let lastError
  for (let attempt = 1; attempt <= Math.max(1, tries); attempt += 1) {
    try {
      const response = await fetch(`${baseOf(hubUrl)}/team`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 401) throw Object.assign(new Error('the hub does not know this device; join again'), { fatal: true })
      if (response.status === 503) throw Object.assign(new Error('this hub does not share its team'), { unsupported: true })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `the hub refused the team: HTTP ${response.status}`)
      if (body.team === undefined) throw new Error('the hub sent no team')
      return body
    } catch (error) {
      if (error.fatal === true || error.unsupported === true) throw error
      lastError = error
      if (attempt < tries) await new Promise(resolve => setTimeout(resolve, 300 * attempt))
    }
  }
  throw lastError
}
