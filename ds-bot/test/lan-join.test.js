import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-lan-join-${name}-`))

async function until(check, { timeout = 15_000, step = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

// A UDP port that is free right now, so the hub's discovery answer lands where the
// other runtime looks for it.
async function freeUdpPort() {
  const socket = createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

test('the page path: the center is found, allowed, and the machine comes online', async t => {
  const discoveryPort = await freeUdpPort()
  const centerCtx = fakeContext()
  const center = createRuntime(centerCtx, {
    home: folder('center-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('center-data'), name: 'office-mac', discoveryPort },
  })
  t.after(async () => {
    await center.multiDeviceHub?.stop()
    await centerCtx.dispose()
  })
  await center.multiDeviceReady
  assert.equal(center.multiDeviceStatus().hub.state, 'listening')

  const nodeCtx = fakeContext()
  const node = createRuntime(nodeCtx, {
    home: folder('node-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('node-data'), name: 'win-pc', discoveryPort, discovery: false },
  })
  t.after(async () => {
    await node.multiDeviceHub?.stop()
    await nodeCtx.dispose()
  })
  await node.multiDeviceReady
  // This computer started as a hub of its own; joining another one turns that off.
  assert.equal(node.multiDeviceStatus().hub.state, 'listening')

  const found = await node.multiDeviceScan()
  assert.equal(found.hubs.length, 1)
  assert.equal(found.hubs[0].name, 'office-mac')
  // The answer names the address it arrived on; the port is the hub's own.
  assert.equal(new URL(found.hubs[0].url).port, String(center.multiDeviceHub.port))

  const asking = await node.multiDeviceJoin(center.multiDeviceHub.url)
  assert.equal(asking.node.joining.state, 'waiting')

  const request = await until(() => center.multiDeviceStatus().requests[0], { what: 'the join request on the center' })
  assert.equal(request.name, 'win-pc')
  assert.equal(request.status, 'pending')
  assert.equal(center.multiDeviceStatus().nodes.length, 0)

  // The button on the center's Devices page.
  const approved = await center.multiDeviceApproveJoin(request.id)
  assert.equal(approved.nodes.length, 1)
  assert.equal(approved.nodes[0].name, 'win-pc')

  await until(() => {
    const node = center.multiDeviceStatus().nodes[0]
    return node?.online === true
  }, { what: 'the joined machine to come online on the center' })

  const joinedNode = await until(() => {
    const value = node.multiDeviceStatus()
    return value.node.paired && value.node.online ? value : undefined
  }, { what: 'the node to report itself online' })
  assert.equal(joinedNode.node.hubName, 'office-mac')
  assert.equal(joinedNode.hub.state, 'off')
  assert.equal(joinedNode.enabled, false)

  // The new node runs the same worker inside the plugin process: a task sent from the
  // center lands there and comes back.
  const task = center.multiDeviceHub.dispatch({ node: 'win-pc', kind: 'shell', argv: ['echo', 'joined from the page'] })
  const done = await center.multiDeviceHub.waitForTask(task.id, { timeoutMs: 8000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.stdout.trim(), 'joined from the page')

  // Leaving stops the worker and drops the saved token; the center sees it offline.
  const left = await node.multiDeviceLeave()
  assert.equal(left.node.paired, false)
  assert.equal(left.hub.state, 'listening')
  await until(() => center.multiDeviceStatus().nodes[0]?.online === false, { what: 'the center to see the machine offline' })
})

test('a denied join leaves the machine unpaired with a reason', async t => {
  const discoveryPort = await freeUdpPort()
  const centerCtx = fakeContext()
  const center = createRuntime(centerCtx, {
    home: folder('deny-center-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('deny-center-data'), name: 'office-mac', discoveryPort },
  })
  t.after(async () => {
    await center.multiDeviceHub?.stop()
    await centerCtx.dispose()
  })
  await center.multiDeviceReady

  const nodeCtx = fakeContext()
  const node = createRuntime(nodeCtx, {
    home: folder('deny-node-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('deny-node-data'), name: 'win-pc', discoveryPort, discovery: false },
  })
  t.after(async () => {
    await node.multiDeviceHub?.stop()
    await nodeCtx.dispose()
  })
  await node.multiDeviceReady
  await node.multiDeviceJoin(center.multiDeviceHub.url)

  const request = await until(() => center.multiDeviceStatus().requests[0], { what: 'the join request on the center' })
  await center.multiDeviceDenyJoin(request.id)

  const denied = await until(() => {
    const value = node.multiDeviceStatus()
    return value.node.error === undefined ? undefined : value
  }, { what: 'the node to hear the denial' })
  assert.match(denied.node.error, /did not allow/)
  assert.equal(denied.node.paired, false)
  assert.equal(center.multiDeviceStatus().nodes.length, 0)
})
