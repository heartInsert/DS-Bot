import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createHub, lanAddress, normalizeAddress } from '../src/host/multi-device/hub.js'
import { createSessionClient, replicaFile } from '../src/host/multi-device/session-client.js'
import { createWorker } from '../src/host/multi-device/worker.js'
import {
  applyTeamBundle, backupTeam, listMemory, readMemory, restoreTeam,
  SYNCED_MEMORY_DIRS, SYNCED_MEMORY_FILES, SYNCED_STATE_KEYS, teamOf, writeMemory,
} from '../src/host/multi-device/team-sync.js'
import { fakeContext } from './fake-ctx.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-team-${name}-`))

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

function teamState(extra = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, instructions: 'Write it down.' },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true } },
    agents: {},
    privateArchives: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    views: {},
    prefs: { theme: 'dark' },
    revision: 4,
    ...extra,
  }
}

function seedHome(home, state, memory = {}) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  for (const [key, text] of Object.entries(memory)) {
    const path = join(home, ...key.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return home
}

const readState = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

function fakeRuntime({ home, state, failSave = 0 } = {}) {
  let saves = 0
  return {
    home,
    state,
    readOnly: () => undefined,
    load: async () => undefined,
    async save() {
      saves += 1
      if (saves <= failSave) throw new Error('the disk is full')
      writeFileSync(join(home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    },
    saves: () => saves,
  }
}

test('the bundle carries the allowlisted team and leaves credentials and paths behind', () => {
  const state = teamState({
    bots: {
      a: { id: 'a', name: 'Chief', apiKey: 'sk-live-secret', workDir: 'C:\\work', model: { provider: 'deepseek', model: 'chat' }, sessionId: 'a' },
      b: { id: 'b', name: 'Writer', sessionId: 'b' },
    },
    prefs: { theme: 'dark', token: 'abcd', refreshToken: 'efgh' },
    capabilities: { items: { c1: { name: 'mcp', values: { apiKey: 'k', url: 'https://example.test' } } } },
    multiDevice: { enabled: true, node: { hubUrl: 'http://192.168.1.5:8787' } },
    computer: { permission: 'always' },
    works: { w1: { from: 'a' } },
  })
  const team = teamOf(state)
  assert.deepEqual(Object.keys(team).sort(), [...SYNCED_STATE_KEYS].sort())
  // A Bot keeps what describes it and loses the credential and the folder of the hub machine.
  assert.equal(team.bots.a.apiKey, undefined)
  assert.equal(team.bots.a.workDir, undefined)
  assert.deepEqual(team.bots.a.model, { provider: 'deepseek', model: 'chat' })
  assert.equal(team.bots.b.name, 'Writer')
  // Settings travel; tokens do not, at any depth.
  assert.equal(team.prefs.theme, 'dark')
  assert.equal(team.prefs.token, undefined)
  assert.equal(team.prefs.refreshToken, undefined)
  assert.equal(team.capabilities.items.c1.values.apiKey, undefined)
  assert.equal(team.capabilities.items.c1.values.url, 'https://example.test')
  // The switch, the device identity and this machine's permissions stay local.
  assert.equal(team.multiDevice, undefined)
  assert.equal(team.computer, undefined)
  assert.equal(team.works, undefined)
  // The Main Bot list only names Bots that are in the bundle.
  assert.deepEqual(team.mainBotIds, ['a'])
})

test('the memory tree is mirrored without its session snapshots or deleted archives', () => {
  const home = folder('memory-home')
  seedHome(home, teamState(), {
    'memory/team/MEMORY.md': '# Team\n',
    'memory/bots/a/MEMORY.md': '# A\n',
    'memory/bots/a/topics/place.md': 'Paris\n',
    'memory/groups/r1/MEMORY.md': '# Ops\n',
    'memory/journal.jsonl': '{"at":1}\n',
    'memory/snapshots/s1.json': '{"frozen":true}\n',
    'memory/archive/old/MEMORY.md': '# gone\n',
    'memory/team/notes.txt': 'not memory\n',
  })
  const files = readMemory(home)
  assert.deepEqual(Object.keys(files).sort(), [
    'memory/bots/a/MEMORY.md',
    'memory/bots/a/topics/place.md',
    'memory/groups/r1/MEMORY.md',
    'memory/journal.jsonl',
    'memory/team/MEMORY.md',
  ])
  assert.deepEqual(SYNCED_MEMORY_DIRS, ['team', 'bots', 'groups'])
  assert.deepEqual(SYNCED_MEMORY_FILES, ['journal.jsonl', 'reviewed.json'])
  // The listing and the read agree, and a file outside the roots is refused.
  assert.deepEqual(listMemory(home).sort(), Object.keys(files).sort())
  assert.throws(() => writeMemory(home, { 'memory/../../escape.md': 'x' }), /outside the synced memory/)
})

test('applying replaces the allowlisted team, mirrors the memory and keeps local folders', async () => {
  const home = folder('apply-home')
  const local = teamState({
    bots: {
      a: { id: 'a', name: 'Chief (mine)', workDir: '/Users/me/work', sessionId: 'a' },
      z: { id: 'z', name: 'OnlyHere', sessionId: 'z' },
    },
    prefs: { theme: 'light', enterToSend: true },
    multiDevice: { enabled: true, node: { hubUrl: 'http://192.168.1.5:8787' } },
  })
  seedHome(home, local, { 'memory/team/MEMORY.md': '# mine\n', 'memory/bots/z/MEMORY.md': '# z\n' })
  const rt = fakeRuntime({ home, state: local })
  // The hub's team: same Main Bot id, a new Bot, another theme.
  const hubTeam = teamState({
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a' },
      b: { id: 'b', name: 'Writer', sessionId: 'b' },
    },
    prefs: { theme: 'dark' },
  })
  const result = await applyTeamBundle({ rt, bundle: { version: 1, hub: 'office-mac', revision: 9, team: teamOf(hubTeam), memory: { 'memory/team/MEMORY.md': '# hub\n', 'memory/bots/a/MEMORY.md': '# a\n' } } })
  assert.equal(result.applied, true)
  assert.equal(result.bots, 2)
  const after = readState(home)
  assert.deepEqual(Object.keys(after.bots).sort(), ['a', 'b'])
  assert.equal(after.bots.a.name, 'Chief')
  assert.equal(after.bots.a.workDir, '/Users/me/work', 'the folder this machine had is kept')
  assert.equal(after.bots.b.workDir, undefined)
  assert.deepEqual(after.prefs, { theme: 'dark' })
  // This machine's own switch and join record are not the hub's to overwrite.
  assert.deepEqual(after.multiDevice, { enabled: true, node: { hubUrl: 'http://192.168.1.5:8787' } })
  // Memory mirrors the hub: the Bot it no longer has is gone, and so is the old MEMORY.md.
  assert.equal(readFileSync(join(home, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# hub\n')
  assert.equal(existsSync(join(home, 'memory', 'bots', 'a', 'MEMORY.md')), true)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'z', 'MEMORY.md')), false)
})

test('a failed write puts the local team and memory back instead of leaving half of the hub', async () => {
  const home = folder('rollback-home')
  const local = teamState()
  seedHome(home, local, { 'memory/team/MEMORY.md': '# mine\n', 'memory/bots/a/MEMORY.md': '# a mine\n' })
  const rt = fakeRuntime({ home, state: local, failSave: 1 })
  const hubTeam = teamState({ bots: { x: { id: 'x', name: 'Other', sessionId: 'x' } }, mainBotIds: ['x'] })
  await assert.rejects(
    applyTeamBundle({ rt, bundle: { version: 1, revision: 2, team: teamOf(hubTeam), memory: { 'memory/team/MEMORY.md': '# hub\n' } } }),
    /disk is full/,
  )
  // Back in memory and on disk: the Bot that was only on the hub is not here.
  assert.deepEqual(Object.keys(rt.state.bots).sort(), ['a', 'b'])
  const after = readState(home)
  assert.deepEqual(Object.keys(after.bots).sort(), ['a', 'b'])
  assert.equal(readFileSync(join(home, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# mine\n')
  assert.equal(readFileSync(join(home, 'memory', 'bots', 'a', 'MEMORY.md'), 'utf8'), '# a mine\n')
  assert.equal(rt.saves(), 2, 'the failed save and the restoring save')
})

test('a backup holds the state and the memory, and restoring it brings both back', async () => {
  const home = folder('backup-home')
  const dataDir = folder('backup-data')
  const local = teamState()
  seedHome(home, local, { 'memory/team/MEMORY.md': '# mine\n' })
  const backup = backupTeam({ home, dataDir, at: Date.UTC(2026, 10, 8, 10, 30, 0), label: 'join' })
  assert.match(backup.dir, /backups[\\/]join-2026-11-08T10-30-00-000Z$/)
  assert.deepEqual(backup.files.sort(), ['memory', 'state.json'])
  assert.deepEqual(readState(backup.dir).bots.a.name, 'Chief')
  assert.equal(readFileSync(join(backup.dir, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# mine\n')

  const rt = fakeRuntime({ home, state: local })
  const hubTeam = teamState({ bots: {}, mainBotIds: [] })
  await applyTeamBundle({ rt, bundle: { version: 1, team: teamOf(hubTeam), memory: {} } })
  assert.equal(Object.keys(rt.state.bots).length, 0)
  await restoreTeam({ rt, backup })
  assert.equal(rt.state.bots.a.name, 'Chief')
  assert.equal(readFileSync(join(home, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# mine\n')
})

test('a backup that cannot be written fails instead of starting a join', () => {
  const home = folder('bad-backup-home')
  const notAFolder = join(folder('bad-backup-file'), 'file')
  writeFileSync(notAFolder, 'not a folder\n')
  assert.throws(() => backupTeam({ home, dataDir: notAFolder }), /ENOTDIR|EEXIST|not a directory/i)
})

test('addresses fold IPv4-mapped IPv6 and link-local zones to one identity', () => {
  assert.equal(normalizeAddress('::ffff:192.168.1.5'), '192.168.1.5')
  assert.equal(normalizeAddress('::FFFF:10.0.0.2'), '10.0.0.2')
  assert.equal(normalizeAddress('fe80::1%12'), 'fe80::1')
  assert.equal(normalizeAddress('192.168.1.5'), '192.168.1.5')
  assert.equal(normalizeAddress(undefined), 'unknown')
  // A virtual adapter does not become the address the page shows when a real one exists.
  assert.equal(lanAddress({
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  }), '192.168.1.5')
  assert.equal(lanAddress({ 'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }] }), '172.20.0.1')
})

test('a waiting machine survives the hub process restarting', async t => {
  const dataDir = folder('durable-data')
  const first = createHub({ dataDir, host: '127.0.0.1', port: 0, discovery: false, log: () => {} })
  await first.start()
  t.after(() => first.stop())
  const answer = await fetch(`${first.url}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: { name: 'mac-mini', hostname: 'Mac.lan', os: 'darwin', arch: 'arm64' } }),
  })
  assert.equal(answer.status, 200)
  const request = await answer.json()
  assert.equal(request.status, 'pending')
  await first.stop()

  // A hub that comes back on the same data folder still shows the machine that waits.
  const second = createHub({ dataDir, host: '127.0.0.1', port: 0, discovery: false, log: () => {} })
  await second.start()
  t.after(() => second.stop())
  const waiting = second.joinRequests().filter(entry => entry.status === 'pending')
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].name, 'mac-mini')
  assert.equal(waiting[0].token, undefined, 'a pending request holds no token, so it is safe on disk')
  assert.equal(second.approveJoin(request.requestId), true)
  assert.equal(second.nodes()[0].name, 'mac-mini')
  // The file keeps only what still waits.
  const saved = JSON.parse(readFileSync(join(dataDir, 'join-requests.json'), 'utf8'))
  assert.deepEqual(saved.requests, [])
})

test('the same machine asking twice is one row, whatever case its hostname has', async t => {
  const hub = createHub({ dataDir: folder('dedupe-data'), host: '127.0.0.1', port: 0, discovery: false, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const ask = hostname => fetch(`${hub.url}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: { name: 'mac-mini', hostname, os: 'darwin' } }),
  }).then(response => response.json())
  const first = await ask('Mac.lan')
  const second = await ask('MAC.LAN')
  assert.equal(second.requestId, first.requestId)
  assert.equal(hub.joinRequests().length, 1)
})

test('a request that waited too long cannot be allowed and leaves the page', async t => {
  let at = Date.UTC(2026, 10, 8, 10, 0, 0)
  const hub = createHub({ dataDir: folder('expiry-data'), host: '127.0.0.1', port: 0, discovery: false, now: () => at, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const request = await fetch(`${hub.url}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: { name: 'mac-mini', hostname: 'Mac.lan' } }),
  }).then(response => response.json())
  assert.equal(hub.joinRequests().filter(entry => entry.status === 'pending').length, 1)
  at += 5 * 60_000 + 1
  assert.deepEqual(hub.joinRequests().filter(entry => entry.status === 'pending'), [])
  assert.equal(hub.approveJoin(request.requestId), false)
  assert.equal(hub.nodes().length, 0)
})

test('a machine joins, takes over the hub team and backs up its own first', async t => {
  const discoveryPort = await freeUdpPort()
  const centerHome = folder('center-home')
  seedHome(centerHome, teamState({ revision: 11 }), {
    'memory/team/MEMORY.md': '# Office team\n',
    'memory/bots/a/MEMORY.md': '# Chief at the office\n',
  })
  const centerCtx = fakeContext()
  const center = createRuntime(centerCtx, {
    home: centerHome,
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('center-data'), name: 'office-mac', discoveryPort },
  })
  t.after(async () => {
    await center.multiDeviceHub?.stop()
    await centerCtx.dispose()
  })
  await center.multiDeviceReady
  assert.equal(center.multiDeviceStatus().hub.state, 'listening')

  const nodeHome = folder('node-home')
  seedHome(nodeHome, teamState({
    bots: { n1: { id: 'n1', name: 'LocalOnly', sessionId: 'n1' } },
    mainBotIds: ['n1'],
    prefs: { theme: 'light' },
  }), { 'memory/team/MEMORY.md': '# this machine\n' })
  const nodeCtx = fakeContext()
  const nodeData = folder('node-data')
  const node = createRuntime(nodeCtx, {
    home: nodeHome,
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: nodeData, name: 'win-pc', discoveryPort, discovery: false },
  })
  t.after(async () => {
    await node.multiDeviceHub?.stop()
    await nodeCtx.dispose()
  })
  await node.multiDeviceReady

  await node.multiDeviceJoin(center.multiDeviceHub.url)
  const request = await until(() => center.multiDeviceStatus().requests[0], { what: 'the join request' })
  await center.multiDeviceApproveJoin(request.id)

  const joined = await until(() => {
    const value = node.multiDeviceStatus()
    return value.node.paired && value.node.online ? value : undefined
  }, { what: 'the node to come online' })

  // The Bots, the settings and the memory are the hub's now.
  const state = readState(nodeHome)
  assert.deepEqual(Object.keys(state.bots).sort(), ['a', 'b'])
  assert.deepEqual(state.mainBotIds, ['a'])
  assert.equal(state.prefs.theme, 'dark')
  assert.equal(readFileSync(join(nodeHome, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# Office team\n')
  assert.equal(readFileSync(join(nodeHome, 'memory', 'bots', 'a', 'MEMORY.md'), 'utf8'), '# Chief at the office\n')
  // The local Bot that existed only here is gone, and the copy of it is on disk.
  assert.equal(state.bots.n1, undefined)
  assert.equal(typeof joined.node.backup, 'string')
  assert.equal(existsSync(joined.node.backup), true)
  const saved = readState(joined.node.backup)
  assert.deepEqual(Object.keys(saved.bots), ['n1'])
  assert.equal(readFileSync(join(joined.node.backup, 'memory', 'team', 'MEMORY.md'), 'utf8'), '# this machine\n')
  // The join record and the hub's own settings are this machine's, not the hub's.
  assert.equal(state.multiDevice.node.hubUrl, center.multiDeviceHub.url)

  // A second refresh with the same revision writes nothing.
  const again = await node.multiDeviceRefreshTeam()
  assert.equal(again.applied, false)
  assert.equal(again.unchanged, true)

  // A hub that changed its team reaches the node on the next refresh, once.
  center.state.bots.c = { id: 'c', name: 'Later', sessionId: 'c', createdAt: 3 }
  await center.save()
  const changed = await node.multiDeviceRefreshTeam()
  assert.equal(changed.applied, true)
  assert.equal(readState(nodeHome).bots.c.name, 'Later')
  const repeat = await node.multiDeviceRefreshTeam()
  assert.equal(repeat.applied, false)
  assert.equal(Object.keys(readState(nodeHome).bots).length, 3)
})

test('a join whose backup fails asks the hub for nothing and changes nothing', async t => {
  const discoveryPort = await freeUdpPort()
  const centerCtx = fakeContext()
  const center = createRuntime(centerCtx, {
    home: folder('nobackup-center-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('nobackup-center-data'), name: 'office-mac', discoveryPort },
  })
  t.after(async () => {
    await center.multiDeviceHub?.stop()
    await centerCtx.dispose()
  })
  await center.multiDeviceReady

  const nodeHome = folder('nobackup-node-home')
  const original = teamState({ bots: { n1: { id: 'n1', name: 'LocalOnly', sessionId: 'n1' } }, mainBotIds: ['n1'] })
  seedHome(nodeHome, original)
  // A file where the backup folder should be: the copy cannot be made.
  const nodeData = folder('nobackup-data')
  writeFileSync(join(nodeData, 'backups'), 'not a folder\n')
  const nodeCtx = fakeContext()
  const node = createRuntime(nodeCtx, {
    home: nodeHome,
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: nodeData, name: 'win-pc', discoveryPort, discovery: false },
  })
  t.after(async () => {
    await node.multiDeviceHub?.stop()
    await nodeCtx.dispose()
  })
  await node.multiDeviceReady

  await assert.rejects(node.multiDeviceJoin(center.multiDeviceHub.url), /back up/)
  assert.equal(node.multiDeviceStatus().node.paired, false)
  assert.deepEqual(Object.keys(readState(nodeHome).bots), ['n1'])
  // Nothing reached the hub: there is no row to allow.
  assert.deepEqual(center.multiDeviceStatus().requests, [])
})

test('a hub on the wildcard address answers on IPv4 and, when it can, on IPv6', async t => {
  const hub = createHub({ dataDir: folder('dualstack-data'), host: '0.0.0.0', port: 0, discovery: false, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const ipv4 = await fetch(`http://127.0.0.1:${hub.port}/health`).then(response => response.json())
  assert.equal(ipv4.ok, true)
  let ipv6 = undefined
  try {
    ipv6 = await fetch(`http://[::1]:${hub.port}/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json())
  } catch {
    // A machine or a container without an IPv6 loopback keeps the IPv4 answer.
  }
  if (ipv6 !== undefined) assert.equal(ipv6.ok, true)
})

// The conversation half of a join, over the same device token: the hub answers a
// revisioned snapshot and takes a user message back. The Session itself is not needed to
// prove the direction of the two messages, so this stands in for the one writer.
function mockSession() {
  let revision = 0
  const items = [{ kind: 'user', text: 'hello from the hub' }]
  const waiting = new Set()
  const wake = () => {
    for (const done of waiting) done()
    waiting.clear()
  }
  return {
    async bots() {
      return { bots: [{ id: 'a', name: 'Chief', role: 'Boss', main: true }] }
    },
    async snapshot(botId, { since, waitMs } = {}) {
      if (since === revision && (waitMs ?? 0) > 0) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, Math.min(waitMs, 400))
          waiting.add(() => { clearTimeout(timer); resolve() })
        })
      }
      return { epoch: 'e1', revision, botId: 'a', botName: 'Chief', sessionId: 's1', items: [...items], hidden: 0 }
    },
    async send({ text }) {
      items.push({ kind: 'user', text })
      revision += 1
      wake()
      return { ok: true, revision }
    },
    say(text) {
      items.push({ kind: 'bot', text })
      revision += 1
      wake()
    },
    items: () => items,
  }
}

test('the conversation follows both ways over the token a join returned', async t => {
  const session = mockSession()
  const hub = createHub({ dataDir: folder('conv-data'), host: '127.0.0.1', port: 0, discovery: false, sessionSync: session, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const { code } = hub.issueCode()
  const dataDir = folder('conv-node')
  const worker = createWorker({
    hubUrl: hub.url,
    dataDir,
    name: 'win-pc',
    code,
    sync: true,
    log: () => {},
    reconnectMs: 50,
    maxReconnectMs: 200,
  })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })

  // Hub to node: the replica on this machine catches up with the hub's snapshot.
  const replica = await until(() => {
    try {
      return JSON.parse(readFileSync(replicaFile(dataDir, 'a'), 'utf8'))
    } catch {
      return undefined
    }
  }, { what: 'the node replica' })
  assert.equal(replica.items[0].text, 'hello from the hub')
  session.say('the Bot answered')
  await until(() => JSON.parse(readFileSync(replicaFile(dataDir, 'a'), 'utf8')).items.some(item => item.text === 'the Bot answered'), { what: 'the Bot reply to reach the node' })

  // Node to hub: a message sent from this machine lands in the one Session and comes back.
  const client = createSessionClient({ hubUrl: hub.url, dataDir, token: worker.token, bot: 'main', log: () => {} })
  await client.send('typed on the node')
  assert.ok(session.items().some(item => item.kind === 'user' && item.text === 'typed on the node'))
  await until(() => JSON.parse(readFileSync(replicaFile(dataDir, 'a'), 'utf8')).items.some(item => item.text === 'typed on the node'), { what: 'the node message to come back' })
  await client.stop()
})
