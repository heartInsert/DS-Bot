// The node-side wrappers the /api/bot channel calls for hub-chat and hub-send: the read
// honours the client's cursor and answers "unchanged" without the item list, and the write
// forwards the idempotency key so a retry lands once. Run against a fake team, as the
// conversation sync test does, so the protocol is proven without DSH or a model key.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub } from '../src/host/multi-device/hub.js'
import { createSessionSync } from '../src/host/multi-device/session-sync.js'
import { createSessionClient } from '../src/host/multi-device/session-client.js'
import { hubChatAnswer, readHubChat, sendHubChat } from '../src/host/multi-device/tools.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-hub-chat-${name}-`))

async function until(check, { timeout = 8000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

function fakeTeam() {
  const state = {
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's-b1' } },
    mainBotIds: ['b1'],
    rooms: {},
  }
  const chat = []
  const sent = []
  let seq = 0
  return {
    state,
    sent,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    async load() {},
    readOnly: () => undefined,
    async chatPage(botId) {
      return { sessionId: `s-${botId}`, items: chat, cursor: null }
    },
    async roomPage() {
      return { sessionId: 's-r', items: [], cursor: null }
    },
    async sendUser({ sessionId, content }) {
      sent.push({ sessionId, text: content[0].text })
      seq += 1
      chat.push({ kind: 'user', text: content[0].text, seq })
    },
  }
}

async function bench(t) {
  const team = fakeTeam()
  const sync = createSessionSync({ rt: team })
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, sessionSync: sync, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const response = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.issueCode().code, device: { name: 'node-a' } }),
  })
  const paired = await response.json()
  const client = createSessionClient({
    hubUrl: hub.url,
    dataDir: folder('node'),
    token: paired.token,
    bot: 'main',
    pollMs: 100,
    waitMs: 300,
    log: () => {},
  })
  t.after(() => client.stop())
  return { hub, team, client }
}

test('hubChatAnswer answers unchanged only when the cursor already names the replica', () => {
  const replica = { epoch: 'e1', revision: 7, botName: 'Chief', items: [{ id: 'a' }] }
  const current = hubChatAnswer({ replica, status: 'syncing', reference: 'bot:b1', cursor: { epoch: 'e1', revision: 7 } })
  assert.equal(current.unchanged, true)
  assert.equal('items' in current, false)
  assert.equal(current.offline, false)

  const behind = hubChatAnswer({ replica, status: 'syncing', reference: 'bot:b1', cursor: { epoch: 'e1', revision: 6 } })
  assert.equal('unchanged' in behind, false)
  assert.deepEqual(behind.items, replica.items)

  const fresh = hubChatAnswer({ replica, status: 'syncing', reference: 'bot:b1' })
  assert.deepEqual(fresh.items, replica.items)

  const offline = hubChatAnswer({ replica: undefined, status: 'offline', reference: 'bot:b1' })
  assert.equal(offline.offline, true)
  assert.deepEqual(offline.items, undefined)
})

test('readHubChat serves the history, then answers unchanged for the cursor it gave', async t => {
  const { client } = await bench(t)
  await client.start()
  const first = await readHubChat(client, 'bot:b1')
  assert.equal(first.botName, 'Chief')
  const cursor = { epoch: first.epoch, revision: first.revision }

  const again = await readHubChat(client, 'bot:b1', cursor)
  assert.equal(again.unchanged, true)
  assert.equal('items' in again, false)

  // A new message moves the revision; the pull loop catches it up, so the same cursor
  // is no longer current and the next read carries the item list.
  await sendHubChat(client, 'bot:b1', 'something new', 'msg-1')
  const moved = await until(async () => {
    const view = await readHubChat(client, 'bot:b1', cursor)
    return view.items?.some(item => item.text === 'something new') ? view : undefined
  }, { what: 'the new message to advance the replica' })
  assert.equal('unchanged' in moved, false)
  assert.equal(moved.items.some(item => item.text === 'something new'), true)
})

test('sendHubChat forwards the idempotency key and a retry writes once', async t => {
  const { team, client } = await bench(t)
  const first = await sendHubChat(client, 'bot:b1', 'the same message', 'key-1')
  assert.equal(first.messageId, 'key-1')
  assert.equal(first.duplicate, undefined)

  const retry = await sendHubChat(client, 'bot:b1', 'the same message', 'key-1')
  assert.equal(retry.duplicate, true)
  assert.equal(team.sent.filter(entry => entry.text === 'the same message').length, 1)
})
