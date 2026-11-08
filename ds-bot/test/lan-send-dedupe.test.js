// The hub's persistent send dedupe: a message id accepted once stays accepted across a
// hub restart, the log is bounded by age and count, a corrupt log starts empty, and the
// crash boundary between "pending" and "committed" is resolved by looking at the
// conversation. Run against a fake team, as the conversation sync tests do.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionSync, MAX_IDS_PER_CONVERSATION, SEND_ID_TTL_MS, SEND_LOG_FILE } from '../src/host/multi-device/session-sync.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-sendlog-${name}-`))
const logFile = dir => join(dir, SEND_LOG_FILE)
const readLog = dir => JSON.parse(readFileSync(logFile(dir), 'utf8'))
const writeLog = (dir, conversations) => writeFileSync(logFile(dir), `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`)

// A Bot team with a group chat, without DSH, as the conversation sync test uses.
function fakeTeam() {
  const state = {
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Chief of Staff', sessionId: 's-b1' } },
    mainBotIds: ['b1'],
    rooms: { r1: { id: 'r1', name: 'Ops' } },
  }
  const chats = new Map([['bot:b1', []], ['room:r1', []]])
  let seq = 0
  const nextSeq = () => { seq += 1; return seq }
  const at = key => chats.get(key) ?? []
  const sent = []
  return {
    state,
    sent,
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
    add(reference, item) {
      const text = String(reference ?? '').startsWith('room:') ? reference : `bot:${String(reference).replace(/^bot:/, '')}`
      at(text).push({ ...item, seq: item.seq ?? nextSeq() })
    },
  }
}

test('a retry after a hub restart writes once and returns the same result', async () => {
  const team = fakeTeam()
  const dir = folder('restart')
  const firstRun = createSessionSync({ rt: team, dataDir: dir })
  const first = await firstRun.send({ botId: 'b1', text: 'once', messageId: 'm1' })
  assert.equal(first.duplicate, undefined)
  assert.equal(first.messageId, 'm1')

  // A fresh sync over the same dataDir is the new hub run.
  const secondRun = createSessionSync({ rt: team, dataDir: dir })
  const retry = await secondRun.send({ botId: 'b1', text: 'once', messageId: 'm1' })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.acceptedAt, first.acceptedAt)
  assert.equal(team.sent.filter(entry => entry.text === 'once').length, 1)
})

test('different ids write two messages', async () => {
  const team = fakeTeam()
  const sync = createSessionSync({ rt: team, dataDir: folder('two') })
  await sync.send({ botId: 'b1', text: 'first', messageId: 'a' })
  await sync.send({ botId: 'b1', text: 'second', messageId: 'b' })
  assert.equal(team.sent.length, 2)
})

test('the same id in two conversations is two writes', async () => {
  const team = fakeTeam()
  const sync = createSessionSync({ rt: team, dataDir: folder('conv') })
  await sync.send({ botId: 'b1', text: 'hi', messageId: 'same' })
  await sync.send({ roomId: 'r1', text: 'hi', messageId: 'same' })
  assert.equal(team.sent.length, 2)
  assert.equal(team.sent.filter(entry => entry.text === 'hi').length, 2)
})

test('the send log keeps only the newest N ids per conversation', async () => {
  const team = fakeTeam()
  const dir = folder('cap')
  const at = Date.now()
  const entries = []
  for (let i = 0; i < MAX_IDS_PER_CONVERSATION + 5; i += 1) {
    entries.push({ id: `m${i}`, text: `t${i}`, at: at - (MAX_IDS_PER_CONVERSATION + 5 - i), state: 'committed' })
  }
  writeLog(dir, { 'bot:b1': entries })
  const sync = createSessionSync({ rt: team, dataDir: dir })
  assert.equal(sync.status().accepted, MAX_IDS_PER_CONVERSATION)

  // The newest id is still accepted; the pruned oldest id writes again.
  const newest = await sync.send({ botId: 'b1', text: 'anything', messageId: `m${MAX_IDS_PER_CONVERSATION + 4}` })
  assert.equal(newest.duplicate, true)
  const oldest = await sync.send({ botId: 'b1', text: 'anything', messageId: 'm0' })
  assert.equal(oldest.duplicate, undefined)
})

test('an id older than the retention window is dropped', async () => {
  const team = fakeTeam()
  const dir = folder('ttl')
  const at = Date.now()
  writeLog(dir, {
    'bot:b1': [
      { id: 'old', text: 'old', at: at - SEND_ID_TTL_MS - 1, state: 'committed' },
      { id: 'fresh', text: 'fresh', at, state: 'committed' },
    ],
  })
  const sync = createSessionSync({ rt: team, dataDir: dir })
  assert.equal(sync.status().accepted, 1)
  const fresh = await sync.send({ botId: 'b1', text: 'anything', messageId: 'fresh' })
  assert.equal(fresh.duplicate, true)
  const old = await sync.send({ botId: 'b1', text: 'anything', messageId: 'old' })
  assert.equal(old.duplicate, undefined)
})

test('a corrupt send log starts empty and the hub keeps working', async () => {
  const team = fakeTeam()
  const dir = folder('corrupt')
  writeFileSync(logFile(dir), 'not json {{{{')
  const sync = createSessionSync({ rt: team, dataDir: dir })
  assert.equal(sync.status().accepted, 0)
  const sent = await sync.send({ botId: 'b1', text: 'still works', messageId: 'm1' })
  assert.equal(sent.duplicate, undefined)
  assert.equal(team.sent.length, 1)
})

test('a pending send whose message landed is treated committed after a restart', async () => {
  const team = fakeTeam()
  const dir = folder('crash-landed')
  // A crash after the write but before the commit mark: the pending entry is on disk
  // and the message is in the conversation.
  writeLog(dir, { 'bot:b1': [{ id: 'm1', text: 'landed', at: Date.now(), state: 'pending' }] })
  team.add('bot:b1', { kind: 'user', text: 'landed' })
  const sync = createSessionSync({ rt: team, dataDir: dir })
  const retry = await sync.send({ botId: 'b1', text: 'landed', messageId: 'm1' })
  assert.equal(retry.duplicate, true)
  assert.equal(team.sent.length, 0, 'the landed message is not written again')
})

test('a pending send whose message never landed is dropped so a retry writes once', async () => {
  const team = fakeTeam()
  const dir = folder('crash-lost')
  // A crash before the write: the pending entry is on disk but the message is not in
  // the conversation. The hub must not re-run anything; it drops the entry and lets a
  // retry write once.
  writeLog(dir, { 'bot:b1': [{ id: 'm1', text: 'lost', at: Date.now(), state: 'pending' }] })
  const sync = createSessionSync({ rt: team, dataDir: dir })
  const retry = await sync.send({ botId: 'b1', text: 'lost', messageId: 'm1' })
  assert.equal(retry.duplicate, undefined)
  assert.equal(team.sent.length, 1)
  assert.equal(team.sent[0].text, 'lost')
})

test('two concurrent submits of the same id write one message', async () => {
  const team = fakeTeam()
  const sync = createSessionSync({ rt: team, dataDir: folder('race') })
  const [first, second] = await Promise.all([
    sync.send({ botId: 'b1', text: 'same', messageId: 'm1' }),
    sync.send({ botId: 'b1', text: 'same', messageId: 'm1' }),
  ])
  assert.equal(team.sent.filter(entry => entry.text === 'same').length, 1)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
})

test('the send log is written atomically and keeps the reference it committed', async () => {
  const team = fakeTeam()
  const dir = folder('shape')
  const sync = createSessionSync({ rt: team, dataDir: dir })
  const sent = await sync.send({ botId: 'b1', text: 'shape', messageId: 'm1' })
  const log = readLog(dir)
  assert.equal(log.version, 1)
  const entry = log.conversations['bot:b1'][0]
  assert.equal(entry.id, 'm1')
  assert.equal(entry.state, 'committed')
  assert.equal(entry.revision, sent.revision)
  assert.equal(entry.epoch, sent.epoch)
})
