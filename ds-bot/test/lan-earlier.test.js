// "Load earlier" for a hub conversation: the snapshot carries a paging cursor, and the
// node asks the hub for the page before it, prepending by stable id so an overlap is not
// doubled. Run against a fake team whose `chatPage` pages by seq, as the sync tests do.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub } from '../src/host/multi-device/hub.js'
import { createSessionSync } from '../src/host/multi-device/session-sync.js'
import { createSessionClient } from '../src/host/multi-device/session-client.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-earlier-${name}-`))

// A single-part Bot chat of ten messages; `chatPage` pages the last four before a seq.
function pagingTeam() {
  const state = { bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's-b1' } }, mainBotIds: ['b1'], rooms: {} }
  const chat = []
  for (let i = 1; i <= 10; i += 1) chat.push({ kind: 'user', text: `m${i}`, seq: i })
  return {
    state,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    async load() {},
    readOnly: () => undefined,
    async chatPage(botId, cursor) {
      const beforeSeq = Number.isInteger(cursor?.beforeSeq) ? cursor.beforeSeq : Infinity
      const page = chat.filter(item => item.seq < beforeSeq).slice(-4)
      return { sessionId: `s-${botId}`, items: page, cursor: page.length > 0 && page[0].seq > 1 ? { beforeSeq: page[0].seq } : null }
    },
    async roomPage() { return { sessionId: 's-r', items: [], cursor: null } },
    async sendUser() {},
  }
}

test('the hub pages the conversation before a seq, then before an id', async () => {
  const sync = createSessionSync({ rt: pagingTeam(), dataDir: folder('sync') })
  const bySeq = await sync.earlier('bot:b1', { before: 7 })
  assert.deepEqual(bySeq.items.map(item => item.text), ['m3', 'm4', 'm5', 'm6'])
  assert.deepEqual(bySeq.cursor, { beforeSeq: 3 })

  // The stable id `s-b1:7:0` names seq 7.
  const byId = await sync.earlier('bot:b1', { before: 's-b1:7:0' })
  assert.deepEqual(byId.items.map(item => item.text), ['m3', 'm4', 'm5', 'm6'])
  assert.deepEqual(byId.cursor, { beforeSeq: 3 })

  // The last page: nothing before seq 3 but m1 and m2, then no more.
  const last = await sync.earlier('bot:b1', { before: 3 })
  assert.deepEqual(last.items.map(item => item.text), ['m1', 'm2'])
  assert.equal(last.cursor, null)
})

test('a node prepends earlier pages through the hub until they run out', async t => {
  const team = pagingTeam()
  const sync = createSessionSync({ rt: team, dataDir: folder('hub') })
  const hub = createHub({ dataDir: folder('hubdir'), host: '127.0.0.1', port: 0, sessionSync: sync, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const paired = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.issueCode().code, device: { name: 'node-a' } }),
  }).then(response => response.json())

  const client = createSessionClient({ hubUrl: hub.url, dataDir: folder('node'), token: paired.token, bot: 'main', pollMs: 100, waitMs: 300, log: () => {} })
  t.after(() => client.stop())

  // The first pull holds the tail (m7..m10) and a cursor.
  const first = await client.open('bot:b1')
  assert.deepEqual(first.items.map(item => item.text), ['m7', 'm8', 'm9', 'm10'])
  assert.ok(first.cursor, 'the tail names a paging cursor')

  const page1 = await client.earlier('bot:b1')
  assert.deepEqual(page1.items.map(item => item.text), ['m3', 'm4', 'm5', 'm6'])
  assert.deepEqual(client.view('bot:b1').items.map(item => item.text), ['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'])

  const page2 = await client.earlier('bot:b1')
  assert.deepEqual(page2.items.map(item => item.text), ['m1', 'm2'])
  assert.equal(page2.cursor, null)
  assert.equal(client.view('bot:b1').items.length, 10)

  // No cursor left: an earlier ask returns nothing.
  const done = await client.earlier('bot:b1')
  assert.deepEqual(done.items, [])
})
