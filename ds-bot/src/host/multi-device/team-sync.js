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

// Where a node records the local Bots and group chats the hub's bundle does not own, so
// a take-over never drops them silently: they are kept in the backup and listed here. The
// record is merged, never replaced: an entry stays until the hub accepts its migration,
// and a pre-join entry stays for good.
export const UNSYNCED_LOCAL_FILE = 'unsynced-local.json'
export function unsyncedLocalPath(dataDir) {
  return join(dataDir, UNSYNCED_LOCAL_FILE)
}

// Where a recorded entry came from. `pre-join` is the team this machine held before its
// first take-over: preserved and shown read-only, never submitted on its own.
// `node-after-join` is an entry made on this node after a previous apply (for example by
// an older build that wrote locally); these are the ones migrated to the hub.
export const UNSYNCED_PRE_JOIN = 'pre-join'
export const UNSYNCED_NODE_AFTER_JOIN = 'node-after-join'

const idSetOf = value => new Set(Array.isArray(value) ? value : value instanceof Set ? [...value] : [])

/**
 * The local Bots and group chats the hub's team does not name and that the hub has never
 * owned. An entry is node-local only when its id is absent from the bundle AND absent from
 * the previously applied hub team (`appliedBotIds` / `appliedRoomIds`): an entry the hub
 * deleted since the last apply came from the hub, so a node must not re-create it.
 */
export function unsyncedLocalTeam(localState, hubTeam, { appliedBotIds, appliedRoomIds } = {}) {
  const hubBots = hubTeam?.bots ?? {}
  const hubRooms = hubTeam?.rooms ?? {}
  const knownBots = idSetOf(appliedBotIds)
  const knownRooms = idSetOf(appliedRoomIds)
  const bots = []
  const rooms = []
  for (const [id, bot] of Object.entries(localState?.bots ?? {})) {
    if (hubBots[id] === undefined && !knownBots.has(id)) bots.push(bot)
  }
  for (const [id, room] of Object.entries(localState?.rooms ?? {})) {
    if (hubRooms[id] === undefined && !knownRooms.has(id)) rooms.push(room)
  }
  return { bots, rooms }
}

function readUnsyncedRecord(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(unsyncedLocalPath(dataDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return {
      bots: Array.isArray(parsed.bots) ? parsed.bots.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') : [],
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') : [],
      migratedBots: parsed.migratedBots !== null && typeof parsed.migratedBots === 'object' && !Array.isArray(parsed.migratedBots) ? parsed.migratedBots : {},
    }
  } catch {
    // No record yet, or one this version cannot read.
  }
  return undefined
}

function writeUnsyncedRecord(dataDir, record, now) {
  const payload = `${JSON.stringify({
    version: 1,
    recordedAt: new Date(now()).toISOString(),
    bots: record.bots,
    rooms: record.rooms,
    migratedBots: record.migratedBots,
  }, null, 2)}\n`
  writeAtomic(unsyncedLocalPath(dataDir), payload)
}

/** Reads the unsynced local team a previous take-over recorded, if any. */
export function readUnsyncedLocalTeam(dataDir) {
  return readUnsyncedRecord(dataDir)
}

/**
 * Merges the given entries into the unsynced record by id. An entry already recorded, or
 * already migrated, keeps its earlier copy, so a later sync with an empty diff never
 * clears an entry that still waits for the hub. The file is written, never deleted whole:
 * a pre-join entry stays forever, and a node-after-join entry leaves only when the hub
 * accepts its migration.
 */
export function recordUnsyncedLocalTeam(dataDir, entries, { now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('recording the local team needs the multi-device data folder')
  const record = readUnsyncedRecord(dataDir) ?? { bots: [], rooms: [], migratedBots: {} }
  const bots = new Map(record.bots.map(entry => [entry.id, entry]))
  const rooms = new Map(record.rooms.map(entry => [entry.id, entry]))
  for (const entry of Array.isArray(entries?.bots) ? entries.bots : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue
    if (bots.has(entry.id) || rooms.has(entry.id) || Object.hasOwn(record.migratedBots, entry.id)) continue
    bots.set(entry.id, entry)
  }
  for (const entry of Array.isArray(entries?.rooms) ? entries.rooms : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue
    if (rooms.has(entry.id) || bots.has(entry.id) || Object.hasOwn(record.migratedBots, entry.id)) continue
    rooms.set(entry.id, entry)
  }
  const recorded = { bots: [...bots.values()], rooms: [...rooms.values()], migratedBots: record.migratedBots }
  writeUnsyncedRecord(dataDir, recorded, now)
  return recorded
}

/**
 * Removes entries the hub accepted (a migrated Bot or room) and records the hub id a Bot
 * received, so a room's members can be mapped. The file is never deleted whole.
 */
export function removeUnsyncedLocalTeam(dataDir, { bots = [], rooms = [], migratedBots = {} } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('updating the local team record needs the multi-device data folder')
  const record = readUnsyncedRecord(dataDir)
  if (record === undefined) return undefined
  const botIds = new Set(Array.isArray(bots) ? bots : [])
  const roomIds = new Set(Array.isArray(rooms) ? rooms : [])
  const migrated = { ...record.migratedBots }
  for (const [id, hubId] of Object.entries(migratedBots ?? {})) migrated[id] = hubId
  const recorded = {
    bots: record.bots.filter(entry => !botIds.has(entry.id)),
    rooms: record.rooms.filter(entry => !roomIds.has(entry.id)),
    migratedBots: migrated,
  }
  writeUnsyncedRecord(dataDir, recorded, Date.now)
  return recorded
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
  // Before the hub's team replaces the local one, remember the Bots and group chats this
  // machine holds that the hub has never owned. Entries the hub deleted since the last
  // apply came from the hub and are not recorded; on the first take-over (no marker) the
  // pre-join team is recorded as `pre-join`, preserved and shown, never submitted.
  let unsynced = { bots: 0, rooms: 0 }
  try {
    const found = unsyncedLocalTeam(rt.state, bundle.team, {
      appliedBotIds: marker?.appliedBotIds,
      appliedRoomIds: marker?.appliedRoomIds,
    })
    if (found.bots.length > 0 || found.rooms.length > 0) {
      const origin = marker === undefined ? UNSYNCED_PRE_JOIN : UNSYNCED_NODE_AFTER_JOIN
      recordUnsyncedLocalTeam(dataDir, {
        bots: found.bots.map(bot => ({ ...bot, origin })),
        rooms: found.rooms.map(room => ({ ...room, origin })),
      })
    }
    const recorded = readUnsyncedLocalTeam(dataDir)
    unsynced = {
      bots: Array.isArray(recorded?.bots) ? recorded.bots.length : 0,
      rooms: Array.isArray(recorded?.rooms) ? recorded.rooms.length : 0,
    }
  } catch (error) {
    log('ds-bot lan: could not record the unsynced local team: %s', error.message)
  }
  if (sameBundle(marker, keyed)) {
    return { applied: false, unchanged: true, revision: bundle.revision, hub: bundle.hub ?? null, backup: backup?.dir ?? null, unsynced }
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
    appliedBotIds: Object.keys(bundle.team?.bots ?? {}),
    appliedRoomIds: Object.keys(bundle.team?.rooms ?? {}),
  })
  log('ds-bot lan: took over the team from %s (%d bots, %d memory files)', bundle.hub ?? hubUrl, result.bots, result.memory)
  return { ...result, hubId, unsynced }
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
