// The conversation sync across every team conversation — a Bot's own chat and a group
// chat — as the node sees it. The hub is the single writer; the node pulls revisioned
// snapshots, pushes a user message back, switches conversation, resumes from a cursor
// after a drop, re-snapshots after a hub restart, and never replays a side-effecting
// turn. All of this runs against a fake team, so the protocol is proven without DSH or
// a model key.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub } from '../src/host/multi-device/hub.js'
import { createSessionSync } from '../src/host/multi-device/session-sync.js'
import { createSessionClient, replicaFile } from '../src/host/multi-device/session-client.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-conv-${name}-`))

async function until(check, { timeout = 8_000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

const convKey = reference => (String(reference).startsWith('room:') ? reference : `bot:${String(reference).replace(/^bot:/, '')}`)

// A Bot team with group chats, without DSH: `chatPage` and `roomPage` serve the two
// conversations, `sendUser` is the one write path, and `runTurn` is a model turn whose
// only effect is a reply item — it must never be replayed by a reconnect.
function fakeTeam() {
  const state = {
    bots: {
      b1: { id: 'b1', name: 'Chief', role: 'Chief of Staff', sessionId: 's-b1' },
      b2: { id: 'b2', name: 'Writer', role: 'Writer', sessionId: 's-b2' },
    },
    mainBotIds: ['b1'],
    rooms: { r1: { id: 'r1', name: 'Ops' } },
  }
  const chats = new Map([['bot:b1', []], ['bot:b2', []], ['room:r1', []]])
  let seq = 0
  const sent = []
  const turns = []
  const nextSeq = () => { seq += 1; return seq }
  const at = key => chats.get(key) ?? []

  return {
    state,
    sent,
    turns,
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    async load() {},
    readOnly: () => undefined,
    async chatPage(botId) {
      return { sessionId: `s-${botId}`, items: at(`bot:${botId}`), cursor: null }
    },
    async roomPage(roomId) {
      return { sessionId: `s-${roomId}`, items: at(`room:${roomId}`), cursor: null }
    },
    async sendUser({ sessionId, content }) {
      const text = content[0].text
      sent.push({ sessionId, text })
      const key = state.rooms[sessionId] !== undefined ? `room:${sessionId}` : `bot:${sessionId}`
      at(key).push({ kind: 'user', text, seq: nextSeq() })
    },
    // A message from another party — the hub's user or a Bot reply — appearing over time.
    add(reference, item) {
      at(convKey(reference)).push({ ...item, seq: item.seq ?? nextSeq() })
    },
    // A model turn's side effect: a reply item. Counted so a test can prove a reconnect
    // never re-runs it.
    runTurn(reference, text) {
      turns.push({ reference: convKey(reference), text })
      at(convKey(reference)).push({ kind: 'bot', text, seq: nextSeq() })
    },
    items: reference => at(convKey(reference)),
  }
}

async function bench(t, team = fakeTeam()) {
  const sync = createSessionSync({ rt: team })
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, sessionSync: sync, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const pair = async name => {
    const response = await fetch(`${hub.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: hub.issueCode().code, device: { name, os: 'darwin', hostname: name, agentVersion: 'test' } }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    return body
  }
  return { hub, sync, team, pair }
}

const client = (hubOrUrl, token, dataDir, extra = {}) => createSessionClient({
  hubUrl: typeof hubOrUrl === 'string' ? hubOrUrl : hubOrUrl.url,
  dataDir,
  token,
  bot: 'main',
  pollMs: 100,
  waitMs: 300,
  log: () => {},
  ...extra,
})

test('a node reads the history of a Bot chat and a group chat first', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  team.add('bot:b1', { kind: 'user', text: 'private history', time: '2026-11-08T10:00:00.000Z' })
  team.add('room:r1', { kind: 'post', text: 'group history', botId: 'b1', name: 'Chief', time: '2026-11-08T10:00:01.000Z' })

  const dataDir = folder('node')
  const c = client(hub, node.token, dataDir)
  t.after(() => c.stop())

  // The first read of a Bot's own chat.
  const botView = await c.open('bot:b1')
  assert.ok(botView, 'the Bot conversation has a replica')
  assert.equal(botView.botName, 'Chief')
  assert.equal(botView.items.some(item => item.text === 'private history'), true)
  assert.equal(botView.items[0].id.length > 0, true, 'every item has a stable id')

  // And of a group chat.
  const roomView = await c.open('room:r1')
  assert.ok(roomView, 'the group conversation has a replica')
  assert.equal(roomView.roomName, 'Ops')
  assert.equal(roomView.items.some(item => item.text === 'group history'), true)
})

test('messages flow both ways, from the hub to the node and back', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')
  const c = client(hub, node.token, dataDir)
  t.after(() => c.stop())
  await c.start()

  await until(() => c.info().revision !== undefined, { what: 'the first pull' })

  // Hub to node: a message written on the hub shows up in the node's replica.
  team.add('bot:b1', { kind: 'user', text: 'from the hub' })
  await until(() => c.view()?.items.some(item => item.text === 'from the hub'), { what: 'the hub message' })

  // Node to hub: the node's message reaches the one write path and comes back.
  const sent = await c.send('from the node')
  assert.equal(sent.ok, true)
  await until(() => team.sent.some(entry => entry.text === 'from the node'), { what: 'the node message to reach the hub' })
  await until(() => c.view()?.items.some(item => item.text === 'from the node'), { what: 'the node message to come back' })
})

test('a reply streams to the node in steps until it is done', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')
  const c = client(hub, node.token, dataDir)
  t.after(() => c.stop())
  await c.start()
  await until(() => c.info().revision !== undefined, { what: 'the first pull' })

  team.add('bot:b1', { kind: 'user', text: 'go' })
  await until(() => c.view()?.items.some(item => item.text === 'go'), { what: 'the user message' })

  // A Bot reply that arrives in chunks: the node's replica updates at each step and
  // keeps both chunks in order until the reply is complete.
  team.runTurn('bot:b1', 'part one')
  await until(() => c.view()?.items.some(item => item.text === 'part one'), { what: 'the first part' })
  team.runTurn('bot:b1', 'part two, done')
  await until(() => c.view()?.items.some(item => item.text === 'part two, done'), { what: 'the second part' })

  const texts = c.view().items.map(item => item.text)
  assert.deepEqual(texts, ['go', 'part one', 'part two, done'])
  assert.equal(team.turns.length, 2)
})

test('a node switches between a Bot chat and a group chat', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  team.add('bot:b1', { kind: 'user', text: 'chief only' })
  team.add('bot:b2', { kind: 'user', text: 'writer only' })
  team.add('room:r1', { kind: 'post', text: 'room only', botId: 'b1' })

  const dataDir = folder('node')
  const c = client(hub, node.token, dataDir)
  t.after(() => c.stop())

  const chief = await c.open('bot:b1')
  assert.equal(chief.botName, 'Chief')
  assert.equal(chief.items.some(item => item.text === 'chief only'), true)

  const writer = await c.open('bot:b2')
  assert.equal(writer.botName, 'Writer')
  assert.equal(writer.items.some(item => item.text === 'writer only'), true)

  const room = await c.open('room:r1')
  assert.equal(room.roomName, 'Ops')
  assert.equal(room.items.some(item => item.text === 'room only'), true)

  // Sending while a conversation is active lands in that conversation, not the others.
  await c.send('typed in the room')
  await until(() => team.sent.some(entry => entry.text === 'typed in the room'), { what: 'the room send' })
  assert.equal(team.items('room:r1').some(item => item.text === 'typed in the room'), true)
  assert.equal(team.items('bot:b1').some(item => item.text === 'typed in the room'), false)
})

test('a duplicate submit with the same idempotency key writes one message', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')
  const c = client(hub, node.token, dataDir)
  t.after(() => c.stop())
  await c.start()
  await until(() => c.info().revision !== undefined, { what: 'the first pull' })

  const first = await c.send('the same twice', { messageId: 'key-1' })
  assert.equal(first.duplicate, undefined)
  const second = await c.send('the same twice', { messageId: 'key-1' })
  assert.equal(second.duplicate, true)
  assert.equal(team.sent.filter(entry => entry.text === 'the same twice').length, 1)
  assert.equal(team.items('bot:b1').filter(item => item.text === 'the same twice').length, 1)
})

test('a reconnect catches up from the cursor without duplicates', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')

  const first = client(hub, node.token, dataDir)
  await first.start()
  await until(() => first.info().revision !== undefined, { what: 'the first pull' })
  team.add('bot:b1', { kind: 'user', text: 'before the drop' })
  await until(() => first.view()?.items.some(item => item.text === 'before the drop'), { what: 'the message before the drop' })
  const revision = first.info().revision
  await first.stop()

  team.add('bot:b1', { kind: 'user', text: 'while away' })

  const second = client(hub, node.token, dataDir)
  t.after(() => second.stop())
  await second.start()
  await until(() => second.view()?.items.some(item => item.text === 'while away'), { what: 'the missed message' })
  assert.ok(second.info().revision > revision)
  // No message appears twice.
  const counts = new Map()
  for (const item of second.view().items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
  assert.equal([...counts.values()].every(n => n === 1), true)
})

test('a hub restart changes the epoch and the node re-snapshots', async t => {
  const team = fakeTeam()
  team.add('bot:b1', { kind: 'user', text: 'kept across restart' })
  const dataDir = folder('hub-restart')

  const syncA = createSessionSync({ rt: team })
  const hubA = createHub({ dataDir, host: '127.0.0.1', port: 0, sessionSync: syncA, log: () => {} })
  await hubA.start()
  t.after(() => hubA.stop())
  const paired = await fetch(`${hubA.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hubA.issueCode().code, device: { name: 'node-a' } }),
  }).then(response => response.json())

  const nodeData = folder('node')
  const c = client(hubA.url, paired.token, nodeData)
  t.after(() => c.stop())
  await c.start()
  await until(() => c.info().revision !== undefined, { what: 'the first pull' })
  const beforeEpoch = c.info().epoch
  await c.stop()

  // The hub comes back on the same data folder, so the node's token is still known, but
  // its epoch is new: the node must take a full snapshot, not wait for an old revision.
  const syncB = createSessionSync({ rt: team })
  assert.notEqual(syncB.epoch, beforeEpoch)
  const hubB = createHub({ dataDir, host: '127.0.0.1', port: 0, sessionSync: syncB, log: () => {} })
  await hubB.start()
  t.after(() => hubB.stop())

  const resumed = client(hubB.url, paired.token, nodeData)
  t.after(() => resumed.stop())
  await resumed.start()
  const caught = await until(() => (resumed.info().epoch !== undefined && resumed.info().epoch === syncB.epoch) ? resumed.info() : undefined, { what: 'the new epoch to arrive' })
  assert.equal(caught.epoch, syncB.epoch)
  assert.equal(resumed.view().items.some(item => item.text === 'kept across restart'), true)
})

test('an unreachable hub is an explicit offline state and the send is refused', async t => {
  const { hub, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')
  const c = client(hub.url, node.token, dataDir)
  t.after(() => c.stop())
  await c.start()
  await until(() => c.info().revision !== undefined, { what: 'the first pull' })

  await hub.stop()

  await until(() => c.info().status === 'offline', { what: 'the offline state' })
  await assert.rejects(c.send('this must not send'), /not reachable|offline|did not answer/)
  assert.equal(c.info().status, 'offline')
})

test('Bot and room list changes on the hub propagate to the node after join', async t => {
  // The list is the team's Bots and rooms; when the hub adds one, a later pull of the
  // list reflects it, and the node applies the new team through the onTeam callback.
  const team = fakeTeam()
  const applied = []
  const sync = createSessionSync({ rt: team })
  const hub = createHub({
    dataDir: folder('hub'),
    host: '127.0.0.1',
    port: 0,
    sessionSync: sync,
    log: () => {},
  })
  await hub.start()
  t.after(() => hub.stop())
  const paired = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.issueCode().code, device: { name: 'node-a' } }),
  }).then(response => response.json())

  const dataDir = folder('node')
  const c = client(hub.url, paired.token, dataDir, { onTeam: async list => { applied.push(list) }, teamPollMs: 200 })
  t.after(() => c.stop())
  await c.start()

  await until(() => applied.length >= 1, { what: 'the first team list' })
  assert.deepEqual(applied.at(-1).bots.map(bot => bot.name), ['Chief', 'Writer'])
  assert.deepEqual(applied.at(-1).rooms.map(room => room.name), ['Ops'])

  // The hub adds a Bot and a group chat; the next list pull sees both.
  team.state.bots.b3 = { id: 'b3', name: 'Later', sessionId: 's-b3' }
  team.state.rooms.r2 = { id: 'r2', name: 'Planning' }
  const change = await until(async () => {
    await c.bots()
    const last = applied.at(-1)
    return last && last.bots.length === 3 && last.rooms.length === 2 ? last : undefined
  }, { what: 'the changed list to propagate' })
  assert.equal(change.bots.some(bot => bot.name === 'Later'), true)
  assert.equal(change.rooms.some(room => room.name === 'Planning'), true)
})

test('a reconnect replays no side-effecting turn or write', async t => {
  const { hub, team, pair } = await bench(t)
  const node = await pair('node-a')
  const dataDir = folder('node')

  const first = client(hub.url, node.token, dataDir)
  await first.start()
  await until(() => first.info().revision !== undefined, { what: 'the first pull' })
  const sentBefore = team.sent.length
  await first.stop()

  // A hub-side turn runs while the node is away; the node's reconnect only reads it.
  team.runTurn('bot:b1', 'a reply the node missed')
  const turnsAfterTurn = team.turns.length

  const second = client(hub.url, node.token, dataDir)
  t.after(() => second.stop())
  await second.start()
  await until(() => second.view()?.items.some(item => item.text === 'a reply the node missed'), { what: 'the missed reply' })

  // The reconnect added no turn of its own and wrote nothing back.
  assert.equal(team.turns.length, turnsAfterTurn, 'the node ran no model turn')
  assert.equal(team.sent.length, sentBefore, 'the node wrote no message')
  assert.ok(second.info().revision > first.info().revision)
  // The replica file still never carries the device token.
  const persisted = await import('node:fs').then(fs => fs.readFileSync(replicaFile(dataDir, 'b1'), 'utf8'))
  assert.equal(persisted.includes(node.token), false)
})
