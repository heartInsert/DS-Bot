import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createHub } from '../src/host/multi-device/hub.js'
import { createTeamWrite, TEAM_WRITE_LOG_FILE } from '../src/host/multi-device/team-write.js'
import { createTeamSource, readUnsyncedLocalTeam, recordUnsyncedLocalTeam, removeUnsyncedLocalTeam, unsyncedLocalPath, unsyncedLocalTeam, UNSYNCED_PRE_JOIN } from '../src/host/multi-device/team-sync.js'
import { fakeContext } from './fake-ctx.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-twrite-${name}-`))

async function until(check, { timeout = 15_000, step = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

async function freeUdpPort() {
  const socket = createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

// A hub team state the write tests mutate, plus a runtime stand-in whose create/update/
// delete mirror the real roster functions without needing a Session controller.
function hubState(extra = {}) {
  return {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Main', sessionId: 'chief', createdAt: 1 },
      writer: { id: 'writer', name: 'Writer', role: 'Writes', sessionId: 'writer', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['chief', 'writer'], mode: 'admin', admin: 'chief', named: true } },
    agents: {},
    privateArchives: [],
    capabilities: { items: {} },
    prefs: { theme: 'dark' },
    revision: 4,
    ...extra,
  }
}

function stubHubRt(state, home) {
  const bump = () => { state.revision = (state.revision ?? 0) + 1 }
  let seq = 100
  return {
    home,
    state,
    load: async () => undefined,
    readOnly: () => undefined,
    save: async () => {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    },
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    async createBot(options) {
      const id = `b${seq += 1}`
      state.bots[id] = { id, name: options.name, role: options.role ?? '', sessionId: id, createdAt: Date.now() }
      bump()
      return state.bots[id]
    },
    async updateBot(id, patch) {
      if (state.bots[id] === undefined) throw new Error('Unknown Bot')
      Object.assign(state.bots[id], patch)
      delete state.bots[id].id
      bump()
      return state.bots[id]
    },
    async deleteBot(id) {
      if (state.bots[id] === undefined) throw new Error('Unknown Bot')
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(main => main !== id)
      bump()
    },
    async duplicateBot(id) {
      const bot = state.bots[id]
      if (bot === undefined) throw new Error('Unknown Bot')
      return this.createBot({ name: `${bot.name} copy`, role: bot.role })
    },
    async releaseArchive() { bump() },
    async setMain(id) { if (!state.mainBotIds.includes(id)) state.mainBotIds.push(id); bump() },
    async setFlags(id, flags) { if (state.bots[id] !== undefined) Object.assign(state.bots[id], flags); bump(); return state.bots[id] },
    async createRoom({ members = [], name, admin } = {}) {
      const id = `r${seq += 1}`
      state.rooms[id] = { id, name: name ?? 'Group', members, admin: admin ?? null, named: true }
      bump()
      return state.rooms[id]
    },
    async updateRoom(id, patch) {
      if (state.rooms[id] === undefined) throw new Error('Unknown group')
      Object.assign(state.rooms[id], patch)
      delete state.rooms[id].id
      bump()
      return { room: state.rooms[id], changes: {} }
    },
    async deleteRoom(id) {
      if (state.rooms[id] === undefined) throw new Error('Unknown group')
      delete state.rooms[id]
      bump()
    },
    async greetRoom() {},
  }
}

// The hub side: createTeamWrite applies a node's op with the rt functions and keeps the
// accepted op ids, so a retry lands once and returns the same stable id.
test('a node create applies on the hub and a retry with the same op id writes one Bot', async () => {
  const dataDir = folder('hub')
  const home = folder('home')
  const state = hubState()
  const write = createTeamWrite({ rt: stubHubRt(state, home), dataDir, log: () => {} })
  const first = await write.apply({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-1' })
  assert.equal(first.ok, true)
  const id = first.id
  assert.equal(Object.keys(state.bots).length, 3)
  // The retry returns the same Bot instead of making a second one.
  const retry = await write.apply({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-1' })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.id, id)
  assert.equal(Object.keys(state.bots).length, 3)
  // A different op id makes a second Bot.
  await write.apply({ op: 'create-bot', payload: { name: 'Scout 2', role: 'Look' }, opId: 'op-2' })
  assert.equal(Object.keys(state.bots).length, 4)
})

test('accepted op ids survive a hub restart', async () => {
  const dataDir = folder('hub2')
  const home = folder('home2')
  const state = hubState()
  const first = createTeamWrite({ rt: stubHubRt(state, home), dataDir, log: () => {} })
  const made = await first.apply({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-1' })
  const second = createTeamWrite({ rt: stubHubRt(state, home), dataDir, log: () => {} })
  const retry = await second.apply({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-1' })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.id, made.id)
  assert.ok(existsSync(join(dataDir, TEAM_WRITE_LOG_FILE)))
})

test('rename and delete forward through the same apply', async () => {
  const dataDir = folder('hub3')
  const home = folder('home3')
  const state = hubState()
  const write = createTeamWrite({ rt: stubHubRt(state, home), dataDir, log: () => {} })
  const renamed = await write.apply({ op: 'update-bot', payload: { id: 'writer', name: 'Scribe' }, opId: 'op-u1' })
  assert.equal(renamed.name, 'Scribe')
  await write.apply({ op: 'delete-bot', payload: { id: 'writer' }, opId: 'op-d1' })
  assert.equal(state.bots.writer, undefined)
  const room = await write.apply({ op: 'create-room', payload: { members: ['chief'], name: 'New Group' }, opId: 'op-r1' })
  assert.equal(state.rooms[room.id].name, 'New Group')
  await assert.rejects(write.apply({ op: 'not-an-op', payload: {}, opId: 'op-x' }), /does not accept/)
})

// The unsynced local team: the local Bots and groups the hub's bundle does not name are
// recorded in the node data dir before a take-over, so nothing is dropped silently.
test('unsynced local Bots and groups are detected and recorded, merged not cleared', () => {
  const dataDir = folder('unsynced')
  const local = { bots: { a: { id: 'a' }, z: { id: 'z' } }, rooms: { r1: { id: 'r1' }, r9: { id: 'r9' } } }
  const hub = { bots: { a: { id: 'a' } }, rooms: { r1: { id: 'r1' } } }
  const found = unsyncedLocalTeam(local, hub)
  assert.deepEqual(found.bots.map(bot => bot.id), ['z'])
  assert.deepEqual(found.rooms.map(room => room.id), ['r9'])
  const recorded = recordUnsyncedLocalTeam(dataDir, {
    bots: found.bots.map(bot => ({ ...bot, origin: UNSYNCED_PRE_JOIN })),
    rooms: found.rooms.map(room => ({ ...room, origin: UNSYNCED_PRE_JOIN })),
  })
  assert.equal(recorded.bots.length, 1)
  assert.equal(recorded.rooms.length, 1)
  assert.equal(readUnsyncedLocalTeam(dataDir).bots[0].id, 'z')
  assert.equal(readUnsyncedLocalTeam(dataDir).rooms[0].id, 'r9')
  // A later take-over with nothing unsynced keeps the earlier record instead of clearing it.
  recordUnsyncedLocalTeam(dataDir, { bots: [], rooms: [] })
  assert.equal(existsSync(unsyncedLocalPath(dataDir)), true)
  assert.equal(readUnsyncedLocalTeam(dataDir).bots[0].id, 'z')
  assert.equal(readUnsyncedLocalTeam(dataDir).rooms[0].id, 'r9')
  // Only the hub accepting a migration removes an entry, and it stores the hub's id.
  removeUnsyncedLocalTeam(dataDir, { bots: ['z'], migratedBots: { z: 'hub-z' } })
  assert.deepEqual(readUnsyncedLocalTeam(dataDir).bots, [])
  assert.equal(readUnsyncedLocalTeam(dataDir).migratedBots.z, 'hub-z')
  assert.equal(readUnsyncedLocalTeam(dataDir).rooms[0].id, 'r9')
})

test('a Bot the hub deleted since the last apply is not node-local and is not recorded', () => {
  // The node holds the previously applied team (a and z); the hub then dropped z.
  const local = { bots: { a: { id: 'a' }, z: { id: 'z' } }, rooms: {} }
  const hub = { bots: { a: { id: 'a' } }, rooms: {} }
  const found = unsyncedLocalTeam(local, hub, { appliedBotIds: ['a', 'z'] })
  assert.deepEqual(found.bots, [], 'z came from the hub, so it is not node-local')
  assert.deepEqual(found.rooms, [])
  // Without the applied set (a first join) the same diff is node-local.
  assert.deepEqual(unsyncedLocalTeam(local, hub).bots.map(bot => bot.id), ['z'])
})

// The full path: a node forwards a create to the hub through its device token, the hub
// applies it, and a second node pulls the new Bot without a restart.
async function joinedPair(t) {
  const hubHome = folder('hub-home')
  const state = hubState()
  mkdirSync(hubHome, { recursive: true })
  writeFileSync(join(hubHome, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  const hubData = folder('hub-data')
  const hubRt = stubHubRt(state, hubHome)
  const session = {
    async bots() { return { epoch: 'e1', revision: state.revision, bots: Object.values(state.bots).map(bot => ({ id: bot.id, name: bot.name, role: bot.role, main: state.mainBotIds.includes(bot.id) })), rooms: Object.values(state.rooms).map(room => ({ id: room.id, name: room.name })) } },
    async snapshot() { return { epoch: 'e1', revision: 1, botId: 'chief', botName: 'Chief', sessionId: 's1', items: [], hidden: 0 } },
    async send() { return { ok: true, revision: 1 } },
    async earlier() { return { items: [], cursor: null } },
    wakeTeam() {},
  }
  const hub = createHub({
    dataDir: hubData,
    host: '127.0.0.1',
    port: 0,
    discovery: false,
    name: 'office-hub',
    sessionSync: session,
    teamSync: createTeamSource({ state: () => state, home: () => hubHome, name: 'office-hub' }),
    teamWrite: createTeamWrite({ rt: hubRt, dataDir: hubData, log: () => {} }),
    log: () => {},
  })
  await hub.start()
  t.after(() => hub.stop())

  const makeNode = async (name) => {
    const home = folder(`node-${name}-home`)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({ version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, privateArchives: [], capabilities: { items: {} }, prefs: {}, revision: 1 }, null, 2)}\n`)
    const ctx = fakeContext()
    const rt = createRuntime(ctx, { home, multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder(`node-${name}-data`), name, discoveryPort: await freeUdpPort(), discovery: false } })
    await rt.multiDeviceReady
    return { rt, ctx }
  }

  const nodeA = await makeNode('node-a')
  const nodeB = await makeNode('node-b')
  t.after(async () => { await nodeA.ctx.dispose(); await nodeB.ctx.dispose() })

  await nodeA.rt.multiDeviceJoin(hub.url)
  const reqA = await until(() => hub.joinRequests()[0], { what: 'node-a join request' })
  hub.approveJoin(reqA.id)
  await nodeB.rt.multiDeviceJoin(hub.url)
  const reqB = await until(() => hub.joinRequests().find(entry => entry.name === 'node-b'), { what: 'node-b join request' })
  hub.approveJoin(reqB.id)

  await until(() => nodeA.rt.multiDeviceStatus().node.online, { what: 'node-a online' })
  await until(() => nodeB.rt.multiDeviceStatus().node.online, { what: 'node-b online' })
  await until(() => Object.keys(readState(nodeA.rt.home).bots).length === 2, { what: 'node-a team' })
  await until(() => Object.keys(readState(nodeB.rt.home).bots).length === 2, { what: 'node-b team' })
  return { hub, state, nodeA, nodeB }
}

const readState = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

test('a node create forwards to the hub and reaches the second node', async t => {
  const { state, nodeA, nodeB } = await joinedPair(t)
  const made = await nodeA.rt.multiDeviceTeamWrite({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-int-1' })
  assert.ok(made.id, 'the hub returns the stable id')
  // The hub holds it now.
  assert.equal(state.bots[made.id].name, 'Scout')
  // Both nodes pull it without a restart or manual refresh.
  await until(() => readState(nodeA.rt.home).bots[made.id] !== undefined, { what: 'node-a to get the new Bot' })
  await until(() => readState(nodeB.rt.home).bots[made.id] !== undefined, { what: 'node-b to get the new Bot' })
})

test('a retry of the same node create is idempotent', async t => {
  const { state, nodeA } = await joinedPair(t)
  const first = await nodeA.rt.multiDeviceTeamWrite({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-int-2' })
  const before = Object.keys(state.bots).length
  const retry = await nodeA.rt.multiDeviceTeamWrite({ op: 'create-bot', payload: { name: 'Scout', role: 'Look' }, opId: 'op-int-2' })
  assert.equal(retry.id, first.id)
  assert.equal(Object.keys(state.bots).length, before)
})

test('rename and delete forward to the hub from a node', async t => {
  const { state, nodeA } = await joinedPair(t)
  const renamed = await nodeA.rt.multiDeviceTeamWrite({ op: 'update-bot', payload: { id: 'writer', name: 'Scribe' }, opId: 'op-ren-1' })
  assert.equal(renamed.name, 'Scribe')
  assert.equal(state.bots.writer.name, 'Scribe')
  await nodeA.rt.multiDeviceTeamWrite({ op: 'delete-bot', payload: { id: 'writer' }, opId: 'op-del-1' })
  assert.equal(state.bots.writer, undefined)
})

test('a node not joined to a hub refuses a team write', async () => {
  const home = folder('lonely-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({ version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, privateArchives: [], capabilities: { items: {} }, prefs: {}, revision: 1 }, null, 2)}\n`)
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('lonely-data'), name: 'lonely', discovery: false } })
  await rt.multiDeviceReady
  try {
    await assert.rejects(rt.multiDeviceTeamWrite({ op: 'create-bot', payload: { name: 'X' }, opId: 'op-off' }), /not joined to a hub/)
  } finally {
    await ctx.dispose()
  }
})

// A hub that accepts team writes, with a live `state` object and its rt stand-in.
function writeHubSession(state) {
  return {
    async bots() {
      return {
        epoch: 'e1', revision: state.revision,
        bots: Object.values(state.bots).map(bot => ({ id: bot.id, name: bot.name, role: bot.role, main: state.mainBotIds.includes(bot.id) })),
        rooms: Object.values(state.rooms).map(room => ({ id: room.id, name: room.name })),
      }
    },
    async snapshot() { return { epoch: 'e1', revision: 1, botId: 'chief', botName: 'Chief', sessionId: 's1', items: [], hidden: 0 } },
    async send() { return { ok: true, revision: 1 } },
    async earlier() { return { items: [], cursor: null } },
    wakeTeam() {},
  }
}

async function startWriteHub(t, state) {
  const hubHome = folder('write-hub-home')
  mkdirSync(hubHome, { recursive: true })
  writeFileSync(join(hubHome, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  const hubData = folder('write-hub-data')
  const hubRt = stubHubRt(state, hubHome)
  const hub = createHub({
    dataDir: hubData, host: '127.0.0.1', port: 0, discovery: false, name: 'office-hub',
    sessionSync: writeHubSession(state),
    teamSync: createTeamSource({ state: () => state, home: () => hubHome, name: 'office-hub' }),
    teamWrite: createTeamWrite({ rt: hubRt, dataDir: hubData, log: () => {} }),
    log: () => {},
  })
  await hub.start()
  t.after(() => hub.stop())
  return { hub, state, hubRt }
}

function nodeHomeState(extra = {}) {
  return { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, privateArchives: [], capabilities: { items: {} }, prefs: {}, revision: 1, ...extra }
}

// A node seeded with `homeState`, joined to the hub and left with the hub's team applied.
async function makeJoinedNode(t, hub, state, name, homeState) {
  const home = folder(`node-${name}-home`)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), `${JSON.stringify(homeState ?? nodeHomeState(), null, 2)}\n`)
  const ctx = fakeContext()
  const dataDir = folder(`node-${name}-data`)
  const rt = createRuntime(ctx, { home, multiDevice: { host: '127.0.0.1', port: 0, dataDir, name, discoveryPort: await freeUdpPort(), discovery: false } })
  await rt.multiDeviceReady
  t.after(async () => { await rt.multiDeviceHub?.stop(); await ctx.dispose() })
  await rt.multiDeviceJoin(hub.url)
  const req = await until(() => hub.joinRequests().find(entry => entry.name === name), { what: `${name} join request` })
  hub.approveJoin(req.id)
  await until(() => rt.multiDeviceStatus().node.online, { what: `${name} online` })
  await until(() => Object.keys(readState(home).bots ?? {}).length === Object.keys(state.bots ?? {}).length, { what: `${name} team applied` })
  return { rt, ctx, home, dataDir }
}

// The pre-join team this machine held before its first take-over is kept (backup + record)
// and shown read-only, but never submitted to the hub on its own.
test('the pre-join team is preserved and shown, never auto-migrated', async t => {
  const state = hubState()
  const { hub } = await startWriteHub(t, state)
  const node = await makeJoinedNode(t, hub, state, 'node-pre', nodeHomeState({
    mainBotIds: ['localonly'],
    bots: { localonly: { id: 'localonly', name: 'LocalOnly', role: 'Here', sessionId: 'localonly', createdAt: 1 } },
    prefs: { theme: 'light' },
  }))

  const recorded = readUnsyncedLocalTeam(node.dataDir)
  assert.equal(recorded.bots.length, 1)
  assert.equal(recorded.bots[0].id, 'localonly')
  assert.equal(recorded.bots[0].origin, UNSYNCED_PRE_JOIN)
  assert.equal(Object.values(state.bots).some(bot => bot.name === 'LocalOnly'), false, 'pre-join entries are not auto-migrated')
  assert.equal(readState(node.home).bots.localonly, undefined, 'the node took over the hub team')
  // The Devices view reads them, with nothing pending.
  const view = node.rt.multiDeviceStatus().node.unsynced
  assert.deepEqual(view.preJoin, [{ kind: 'bot', id: 'localonly', name: 'LocalOnly' }])
  assert.equal(view.pending, 0)
})

// A Bot made on the node after a previous apply (an older build writing locally) is the
// one that migrates, and it lands on the hub once.
test('a Bot made on the node after a previous apply is migrated to the hub', async t => {
  const state = hubState()
  const { hub } = await startWriteHub(t, state)
  const node = await makeJoinedNode(t, hub, state, 'node-after', nodeHomeState())

  // Simulate an older build writing locally: the Bot is in the node's state, not the hub's.
  node.rt.state.bots.late = { id: 'late', name: 'LateMade', role: 'Look', sessionId: 'late', createdAt: 9 }
  node.rt.state.mainBotIds = [...(node.rt.state.mainBotIds ?? []), 'late']
  await node.rt.save()

  await node.rt.multiDeviceRefreshTeam()
  await until(() => Object.values(state.bots).some(bot => bot.name === 'LateMade'), { what: 'the node-local Bot to reach the hub' })

  const migrated = Object.values(state.bots).find(bot => bot.name === 'LateMade')
  assert.equal(Object.values(state.bots).filter(bot => bot.name === 'LateMade').length, 1)
  // The pending entry left the record and the hub's resulting id is stored for rooms.
  const recorded = readUnsyncedLocalTeam(node.dataDir)
  assert.equal(recorded.bots.some(entry => entry.id === 'late'), false)
  assert.equal(recorded.migratedBots.late, migrated.id)
})

// A hub-side delete of a Bot must not be undone by any node re-reading the team.
test('a hub-side delete of a Bot is not undone by any node', async t => {
  const state = hubState()
  const { hub, hubRt } = await startWriteHub(t, state)
  const nodeA = await makeJoinedNode(t, hub, state, 'node-a', nodeHomeState())
  const nodeB = await makeJoinedNode(t, hub, state, 'node-b', nodeHomeState())

  await hubRt.deleteBot('writer')

  await nodeA.rt.multiDeviceRefreshTeam()
  await nodeB.rt.multiDeviceRefreshTeam()
  await until(() => readState(nodeA.home).bots.writer === undefined, { what: 'node-a to drop the deleted Bot' })
  await until(() => readState(nodeB.home).bots.writer === undefined, { what: 'node-b to drop the deleted Bot' })

  assert.equal(state.bots.writer, undefined, 'the hub delete holds')
  assert.equal(Object.values(state.bots).some(bot => bot.name === 'Writer'), false)
  for (const dir of [nodeA.dataDir, nodeB.dataDir]) {
    const record = readUnsyncedLocalTeam(dir)
    assert.equal(record === undefined || record.bots.every(entry => entry.id !== 'writer'), true, 'the deleted Bot is not recorded as node-local')
  }
})

// A node-local room's members are node-local Bot ids; they map through the migrated Bots'
// hub ids, and the room is created only once every member resolves.
test('a node-local room migrates with its members mapped to hub ids, Bots first', async t => {
  const state = hubState()
  const { hub } = await startWriteHub(t, state)
  const node = await makeJoinedNode(t, hub, state, 'node-room', nodeHomeState())

  node.rt.state.bots.x1 = { id: 'x1', name: 'Alpha', role: 'Look', sessionId: 'x1', createdAt: 10 }
  node.rt.state.bots.x2 = { id: 'x2', name: 'Beta', role: 'Look', sessionId: 'x2', createdAt: 11 }
  node.rt.state.rooms.rlocal = { id: 'rlocal', name: 'Pair', members: ['x1', 'x2'], mode: 'admin', admin: 'x1', named: true }
  await node.rt.save()

  await node.rt.multiDeviceRefreshTeam()
  await until(() => Object.values(state.rooms).some(room => room.name === 'Pair'), { what: 'the node-local room to reach the hub' })

  const room = Object.values(state.rooms).find(entry => entry.name === 'Pair')
  const alpha = Object.values(state.bots).find(bot => bot.name === 'Alpha')
  const beta = Object.values(state.bots).find(bot => bot.name === 'Beta')
  assert.ok(alpha, 'Alpha migrated first')
  assert.ok(beta, 'Beta migrated first')
  assert.deepEqual([...room.members].sort(), [alpha.id, beta.id].sort(), 'members map to the migrated hub ids')
  assert.equal(room.admin, alpha.id, 'the admin maps too')
  // The record is cleared of the room and both Bots.
  const recorded = readUnsyncedLocalTeam(node.dataDir)
  assert.equal(recorded.bots.length, 0)
  assert.equal(recorded.rooms.length, 0)
})
