import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findHubs, readBeacon, startResponder } from '../src/host/multi-device/discovery.js'
import { createHub } from '../src/host/multi-device/hub.js'
import { joinHub, pollJoin, requestJoin } from '../src/host/multi-device/join.js'
import { createWorker } from '../src/host/multi-device/worker.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-lan-${name}-`))

async function until(check, { timeout = 8000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

async function benchHub(t, options = {}) {
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, discovery: false, log: () => {}, ...options })
  await hub.start()
  t.after(() => hub.stop())
  return hub
}

test('a beacon names a hub and anything else on the port is ignored', () => {
  const beacon = readBeacon(JSON.stringify({ dsbot: 'hub', v: 1, id: 'hub_a', name: 'Mac mini', port: 8787, protocol: 2 }))
  assert.deepEqual(beacon, { id: 'hub_a', name: 'Mac mini', port: 8787, protocol: 2 })
  assert.equal(readBeacon('{"dsbot":"hub","v":1,"id":"hub_a"}'), undefined)
  assert.equal(readBeacon('{"dsbot":"other","v":1,"id":"hub_a","port":1}'), undefined)
  assert.equal(readBeacon('not json'), undefined)
  assert.equal(readBeacon(''), undefined)
  assert.equal(readBeacon(undefined), undefined)
})

test('a machine looking for a hub finds one that answers on the same network', async t => {
  const responder = startResponder({
    port: 0,
    identity: () => ({ id: 'hub_look', name: 'Mac mini', port: 8787, protocol: 2 }),
    log: () => {},
  })
  t.after(() => responder.close())
  await responder.ready
  const hubs = await findHubs({ port: responder.port, targets: ['127.0.0.1'], timeoutMs: 400 })
  assert.equal(hubs.length, 1)
  assert.equal(hubs[0].name, 'Mac mini')
  assert.equal(hubs[0].url, `http://127.0.0.1:8787`)
  // A hub this machine runs itself is not a place to join.
  const none = await findHubs({ port: responder.port, targets: ['127.0.0.1'], timeoutMs: 300, ignore: ['hub_look'] })
  assert.deepEqual(none, [])
})

test('the plugin hub answers discovery with its own port', async t => {
  const hub = await benchHub(t, { discovery: true, discoveryPort: 0 })
  const hubs = await findHubs({ port: hub.discoveryPort, targets: ['127.0.0.1'], timeoutMs: 500 })
  assert.equal(hubs.length, 1)
  assert.equal(hubs[0].id, hub.id)
  assert.equal(hubs[0].url, `http://127.0.0.1:${hub.port}`)
})

test('a join request pairs nothing until the hub allows it', async t => {
  const hub = await benchHub(t)
  const started = await requestJoin(hub.url, { name: 'win-pc', os: 'win32', arch: 'x64', hostname: 'WIN-PC' })
  assert.equal(started.status, 'pending')
  assert.equal(typeof started.requestId, 'string')
  assert.deepEqual(hub.nodes(), [])

  const requests = hub.joinRequests()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].name, 'win-pc')
  assert.equal(requests[0].hostname, 'WIN-PC')
  assert.equal(requests[0].status, 'pending')

  // A poll that arrives before the answer waits instead of returning `pending` at once.
  const waiting = pollJoin(hub.url, started.requestId, { waitMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(hub.approveJoin(started.requestId), true)
  const answer = await waiting
  assert.equal(answer.status, 'approved')
  assert.equal(answer.nodeName, 'win-pc')
  assert.equal(typeof answer.token, 'string')
  assert.equal(hub.nodes().length, 1)
  assert.equal(hub.joinRequests()[0].status, 'approved')
})

test('a denied request tells the machine that asked and pairs nothing', async t => {
  const hub = await benchHub(t)
  const started = await requestJoin(hub.url, { name: 'win-pc' })
  assert.equal(hub.denyJoin(started.requestId), true)
  const answer = await pollJoin(hub.url, started.requestId, { waitMs: 200 })
  assert.equal(answer.status, 'denied')
  assert.deepEqual(hub.nodes(), [])
  assert.equal(hub.denyJoin(started.requestId), false)
})

test('a machine joins from the page: ask, allow, connect, show online', async t => {
  const hub = await benchHub(t)
  const dataDir = folder('node')
  const saved = await joinHub({
    hubUrl: hub.url,
    dataDir,
    name: 'win-pc',
    waitMs: 1000,
    timeoutMs: 8000,
    onWaiting: ({ requestId }) => {
      setTimeout(() => hub.approveJoin(requestId), 60)
    },
  })
  assert.equal(saved.nodeName, 'win-pc')
  assert.equal(saved.hubUrl, hub.url)
  assert.equal(hub.nodes()[0].online, false)

  // The same worker the CLI runs, started from the page with the saved token.
  const worker = createWorker({ hubUrl: saved.hubUrl, dataDir, name: saved.nodeName, log: () => {}, reconnectMs: 50, maxReconnectMs: 200 })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })
  await until(() => hub.isOnline(worker.nodeId), { what: 'the joined machine to come online' })
  assert.equal(hub.nodes()[0].online, true)
})

test('a join that is never allowed stops when its time is up', async t => {
  const hub = await benchHub(t)
  await assert.rejects(
    joinHub({ hubUrl: hub.url, dataDir: folder('node-timeout'), name: 'win-pc', waitMs: 200, timeoutMs: 600 }),
    /did not answer/,
  )
  assert.deepEqual(hub.nodes(), [])
})

test('a hub answers a request it already knows instead of queueing it again', async t => {
  const hub = await benchHub(t)
  const started = await requestJoin(hub.url, { name: 'win-pc' })
  const again = await requestJoin(hub.url, { name: 'win-pc' })
  assert.equal(again.requestId, started.requestId)
  assert.equal(hub.joinRequests().length, 1)
})
