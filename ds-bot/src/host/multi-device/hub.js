// The hub: the machine the user sits at. It hands out pairing codes, keeps the node
// registry, holds the task queue, and pushes tasks down each node's open stream. A node
// always connects outward, so a Windows worker needs no listening port or firewall rule.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createCodeStore, newToken } from './pairing.js'
import { startResponder, DISCOVERY_PORT } from './discovery.js'
import { MAX_FILE_BYTES, normalizeTaskSpec, wireTask } from './protocol.js'
import { createRegistry, nodeName } from './registry.js'
import { writeEvent, writePing } from './sse.js'

export const PROTOCOL = 2
export const VERSION = '0.2.0'

// A file task carries up to 1 MiB, or about 1.4 MiB in base64, in one JSON body.
const MAX_BODY = 2 * 1024 * 1024
const MAX_OUTPUT = 128 * 1024
const STREAM_PING_MS = 15_000
const DEFAULT_TASK_TIMEOUT_MS = 30_000
const MAX_TASK_TIMEOUT_MS = 5 * 60_000
const TASK_GRACE_MS = 5_000
const MAX_TASKS = 500
const PAIR_WINDOW_MS = 5 * 60_000
const PAIR_TRIES = 10
const JOIN_TTL_MS = 5 * 60_000
// An answered request keeps its token only this long, so the hub's memory does not hold
// a usable device token after the machine that asked is long gone.
const JOIN_KEEP_MS = 2 * 60_000
const MAX_JOIN_REQUESTS = 8
const MAX_JOIN_PER_ADDRESS = 3
const JOIN_WAIT_MAX_MS = 20_000
const JOIN_FILE = 'join-requests.json'
// A dual-stack listener reaches an IPv4 client and an IPv6 one; the IPv4-only bind is the
// fallback for a machine or a container where IPv6 is not available.
const FAMILY_ERRORS = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT'])
const VIRTUAL_ADAPTER = /(vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|loopback|npcap|\btap\b|\btun\b|zerotier|tailscale|utun|vnic|virtual adapter)/i

const TERMINAL = new Set(['done', 'failed', 'rejected', 'timeout', 'cancelled'])
const terminal = state => TERMINAL.has(state)

const badRequest = (message, status = 400) => Object.assign(new Error(message), { status })

function send(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(badRequest('request body is too large', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(badRequest('request body is not JSON'))
      }
    })
    request.on('error', reject)
  })
}

const bearer = request => {
  const value = String(request.headers.authorization ?? '')
  const [scheme, token] = value.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
}

const sameSecret = (left, right) => {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

const capped = (value, limit) => {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated by the hub]`
}

function lanAddresses(interfaces = networkInterfaces()) {
  // A Windows or macOS machine usually has more than one IPv4: a physical adapter plus
  // Hyper-V, WSL, Docker, VirtualBox or a VPN. The address shown to the user has to be one
  // the other machine can reach, so the virtual ones only serve as a fallback.
  const real = []
  const virtual = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      // 169.254/16 is what an adapter reports before DHCP answers.
      if (entry.address.startsWith('169.254.')) continue
      if (VIRTUAL_ADAPTER.test(name)) virtual.push(entry.address)
      else real.push(entry.address)
    }
  }
  return [...real, ...virtual]
}

export function lanAddress(interfaces) {
  return lanAddresses(interfaces)[0] ?? '127.0.0.1'
}

// The peer address as one string. A dual-stack listener reports an IPv4 client as
// `::ffff:a.b.c.d`, and a link-local IPv6 carries its zone, which is this machine's
// business and never the peer's identity.
export function normalizeAddress(value) {
  const text = String(value ?? '').trim()
  if (text === '') return 'unknown'
  const plain = text.replace(/^::ffff:/i, '')
  const zone = plain.indexOf('%')
  return zone < 0 ? plain : plain.slice(0, zone)
}


function adminToken(dataDir) {
  const file = join(dataDir, 'admin.token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return { token: existing, file, created: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const token = randomBytes(24).toString('base64url')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
    } catch {
      // A file system without modes keeps the 0600 write above.
    }
  }
  return { token, file, created: true }
}

export function createHub({ dataDir, host = '0.0.0.0', port = 8787, name = 'DS Bot hub', sessionSync, teamSync, discovery = true, discoveryPort = DISCOVERY_PORT, log = () => {}, now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createHub needs a dataDir')
  mkdirSync(dataDir, { recursive: true })
  const registry = createRegistry({ dataDir, now, log })
  const secret = adminToken(dataDir)
  const codes = createCodeStore({ now })
  const events = new EventEmitter()
  const tasks = new Map()
  const taskTimers = new Map()
  const waiters = new Map()
  const streams = new Map()
  const pairFailures = new Map()
  const joins = new Map()
  const joinWaiters = new Map()
  // The identity a discovery answer carries. It is made per hub run, so a machine that
  // restarted is a different hub to a page that is still looking.
  const id = `hub_${randomBytes(6).toString('base64url')}`
  let responder

  let server
  let boundPort = port
  let url = ''
  let stopped = false

  function publicNode(node) {
    const { tokenHash, ...rest } = node
    return { ...rest, online: streams.has(node.id) }
  }

  function publicTask(task) {
    return {
      ...task,
      result: task.result === undefined
        ? undefined
        : { ...task.result, ...(task.result.file === undefined ? {} : { file: { ...task.result.file } }) },
    }
  }

  function addNode(device) {
    const token = newToken()
    const node = registry.add({
      name: device.name,
      token,
      os: device.os,
      platform: device.platform,
      arch: device.arch,
      hostname: device.hostname,
      agentVersion: device.agentVersion,
    })
    return { node, token }
  }

  // A join request is what the person at the hub sees before anything is paired: the
  // machine's name, what it runs and where it came from. The token is not in this shape.
  function joinPublic(request) {
    return {
      id: request.id,
      name: request.name,
      hostname: request.hostname,
      os: request.os,
      arch: request.arch,
      address: request.address,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      status: request.status,
    }
  }

  function notifyJoin(id) {
    const set = joinWaiters.get(id)
    if (set === undefined) return
    joinWaiters.delete(id)
    for (const resolve of set) resolve()
  }

  // A pending request is not a pairing and holds no token, so it is safe to keep on disk.
  // It has to be: a hub that reloads the plugin (the desktop app restarts, or the user
  // turns the switch off and on) would otherwise forget the machine that is still waiting
  // for the Allow button, and the person at the hub would never see it.
  const joinFile = join(dataDir, JOIN_FILE)
  function persistJoins() {
    const requests = [...joins.values()]
      .filter(entry => entry.status === 'pending')
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map(({ token, ...entry }) => entry)
    try {
      const payload = `${JSON.stringify({ version: 1, requests }, null, 2)}\n`
      const temp = `${joinFile}.${process.pid}.tmp`
      writeFileSync(temp, payload, { mode: 0o600 })
      renameSync(temp, joinFile)
    } catch (error) {
      log('ds-bot lan: could not write %s: %s', joinFile, error.message)
    }
  }

  function loadJoins() {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(joinFile, 'utf8'))
    } catch {
      return
    }
    const at = now()
    for (const entry of Array.isArray(parsed?.requests) ? parsed.requests : []) {
      if (typeof entry?.id !== 'string' || entry.id === '') continue
      if (!Number.isInteger(entry.expiresAtMs) || at >= entry.expiresAtMs) continue
      joins.set(entry.id, { ...entry, status: 'pending' })
    }
  }
  loadJoins()

  function pruneJoins() {
    const at = now()
    let changed = false
    for (const request of joins.values()) {
      if (request.status === 'pending' && at >= request.expiresAtMs) {
        request.status = 'expired'
        changed = true
      }
      if (request.status !== 'pending' && at - request.createdAtMs > JOIN_KEEP_MS) {
        joins.delete(request.id)
        changed = true
      }
    }
    if (changed) persistJoins()
  }

  function waitJoin(request, waitMs) {
    if (request.status !== 'pending' || !(waitMs > 0)) return Promise.resolve()
    return new Promise(resolve => {
      const set = joinWaiters.get(request.id) ?? new Set()
      joinWaiters.set(request.id, set)
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      set.add(done)
    })
  }

  function settle(task, patch) {
    if (terminal(task.state)) return task
    Object.assign(task, patch, { finishedAt: new Date(now()).toISOString() })
    const timer = taskTimers.get(task.id)
    if (timer !== undefined) {
      clearTimeout(timer)
      taskTimers.delete(task.id)
    }
    const set = waiters.get(task.id)
    if (set !== undefined) {
      waiters.delete(task.id)
      for (const resolve of set) resolve(publicTask(task))
    }
    events.emit('task', publicTask(task))
    // One task runs per node, so the next queued one goes out now that this one is done.
    flush(task.nodeId)
    return task
  }

  function armTimeout(task) {
    const timer = setTimeout(() => {
      settle(task, {
        state: 'timeout',
        result: { stdout: '', stderr: `the node did not return a result within ${task.timeoutMs} ms`, exitCode: 124 },
      })
    }, task.timeoutMs + TASK_GRACE_MS)
    timer.unref?.()
    taskTimers.set(task.id, timer)
  }

  // Sends the oldest queued task of a node, unless one of its tasks is already running.
  function flush(nodeId) {
    const stream = streams.get(nodeId)
    if (stream === undefined) return
    for (const task of tasks.values()) {
      if (task.nodeId !== nodeId) continue
      if (task.state === 'sent') return
      if (task.state !== 'queued') continue
      task.state = 'sent'
      task.sentAt = new Date(now()).toISOString()
      writeEvent(stream.response, 'task', wireTask(task))
      armTimeout(task)
      return
    }
  }

  function dropStream(nodeId, response) {
    const stream = streams.get(nodeId)
    if (stream === undefined) return
    if (response !== undefined && stream.response !== response) return
    clearInterval(stream.interval)
    streams.delete(nodeId)
    if (!stream.response.writableEnded) stream.response.end()
    // A task that was on its way when the stream broke goes back to the queue: the node
    // runs it again after reconnecting, which can repeat a command but never loses one.
    for (const task of tasks.values()) {
      if (task.nodeId !== nodeId || task.state !== 'sent') continue
      const timer = taskTimers.get(task.id)
      if (timer !== undefined) clearTimeout(timer)
      taskTimers.delete(task.id)
      task.state = 'queued'
      delete task.sentAt
    }
    const node = registry.find(nodeId)
    if (node !== undefined) events.emit('offline', publicNode(node))
  }

  function handleStream(request, response) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    // A reconnect replaces the old stream: the worker only ever reads one.
    dropStream(node.id)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders?.()
    writeEvent(response, 'ready', { protocol: PROTOCOL, nodeId: node.id, nodeName: node.name, hub: name, version: VERSION })
    const interval = setInterval(() => {
      if (!response.writableEnded) writePing(response)
    }, STREAM_PING_MS)
    interval.unref?.()
    streams.set(node.id, { response, interval })
    registry.touch(node.id)
    events.emit('online', publicNode(node))
    const close = () => dropStream(node.id, response)
    request.on('close', close)
    response.on('close', close)
    flush(node.id)
  }

  async function handlePair(request, response) {
    const address = normalizeAddress(request.socket.remoteAddress)
    const failures = (pairFailures.get(address) ?? []).filter(at => now() - at < PAIR_WINDOW_MS)
    if (failures.length >= PAIR_TRIES) {
      pairFailures.set(address, failures)
      return send(response, 429, { error: 'too many pairing attempts; wait a few minutes' })
    }
    const body = await readJson(request)
    if (codes.redeem(body.code) !== true) {
      failures.push(now())
      pairFailures.set(address, failures)
      return send(response, 403, { error: 'pairing code is invalid or expired' })
    }
    const device = body.device && typeof body.device === 'object' ? body.device : {}
    const { node, token } = addNode(device)
    log('ds-bot lan: paired %s as %s', node.name, node.id)
    events.emit('paired', publicNode(node))
    send(response, 200, { protocol: PROTOCOL, hub: name, nodeId: node.id, nodeName: node.name, token })
  }

  // Looking for the hub, and asking to be let in. The request is free to make and pairs
  // nothing: the node exists only after approveJoin, so the person at the hub is the one
  // who decides, and the machine that asked never learns whether a token exists until
  // then.
  async function handleJoinRequest(request, response) {
    pruneJoins()
    const body = await readJson(request)
    const known = typeof body.requestId === 'string' ? joins.get(body.requestId) : undefined
    if (known !== undefined) {
      return send(response, 200, {
        ...joinPublic(known),
        requestId: known.id,
        hub: name,
        ...(known.status === 'approved' ? { token: known.token, nodeId: known.nodeId, nodeName: known.nodeName } : {}),
      })
    }
    const device = body.device && typeof body.device === 'object' ? body.device : {}
    const address = normalizeAddress(request.socket.remoteAddress)
    const pending = [...joins.values()].filter(entry => entry.status === 'pending')
    // A page that asks twice, or asks again after a lost answer, means the same machine:
    // it gets the request that is already waiting instead of a second row on the hub. The
    // hostname and the name the machine reports identify it; its address changes with
    // DHCP, Wi-Fi versus Ethernet and IPv6 privacy addresses, so it is only the fallback
    // when the machine sent no hostname.
    const hostname = typeof device.hostname === 'string' ? device.hostname.trim().toLowerCase() : ''
    const deviceName = typeof device.name === 'string' ? device.name.trim().toLowerCase() : ''
    const repeated = pending.find(entry => (hostname !== ''
      ? String(entry.hostname ?? '').toLowerCase() === hostname && String(entry.name ?? '').toLowerCase() === deviceName
      : entry.address === address))
    if (repeated !== undefined) {
      return send(response, 200, { ...joinPublic(repeated), requestId: repeated.id, hub: name })
    }
    if (pending.length >= MAX_JOIN_REQUESTS) {
      return send(response, 429, { error: 'too many machines are waiting to join; allow or deny them on the hub first' })
    }
    if (pending.filter(entry => entry.address === address).length >= MAX_JOIN_PER_ADDRESS) {
      return send(response, 429, { error: 'this machine already asked to join; wait for the answer on the hub' })
    }
    const createdAtMs = now()
    const entry = {
      id: `jr_${randomBytes(9).toString('base64url')}`,
      name: typeof device.name === 'string' && device.name.trim() !== '' ? device.name.trim().slice(0, 40) : nodeName('device'),
      hostname: hostname === '' ? undefined : String(device.hostname).slice(0, 120),
      os: typeof device.os === 'string' ? device.os.slice(0, 40) : undefined,
      arch: typeof device.arch === 'string' ? device.arch.slice(0, 40) : undefined,
      address,
      // Only the fields a hub acts on; the asker does not get to write arbitrary keys into
      // the hub's data folder.
      device: {
        name: typeof device.name === 'string' ? device.name.slice(0, 40) : undefined,
        hostname: typeof device.hostname === 'string' ? device.hostname.slice(0, 120) : undefined,
        os: typeof device.os === 'string' ? device.os.slice(0, 40) : undefined,
        platform: typeof device.platform === 'string' ? device.platform.slice(0, 80) : undefined,
        arch: typeof device.arch === 'string' ? device.arch.slice(0, 40) : undefined,
      },
      status: 'pending',
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      expiresAt: new Date(createdAtMs + JOIN_TTL_MS).toISOString(),
      expiresAtMs: createdAtMs + JOIN_TTL_MS,
    }
    joins.set(entry.id, entry)
    persistJoins()
    log('ds-bot lan: %s asked to join from %s', entry.name, address)
    events.emit('join', joinPublic(entry))
    return send(response, 200, { ...joinPublic(entry), requestId: entry.id, hub: name })
  }

  async function handleJoinStatus(request, response, requestId, query) {
    pruneJoins()
    const entry = joins.get(requestId)
    if (entry === undefined) return send(response, 404, { error: 'no such join request' })
    const wait = Number(query.get('wait'))
    await waitJoin(entry, Number.isFinite(wait) ? Math.min(Math.max(wait, 0), JOIN_WAIT_MAX_MS) : 0)
    // A waiting poll may outlive its socket when the page closes; writing to it would
    // only raise an error nobody reads.
    if (response.writableEnded || response.destroyed) return undefined
    return send(response, 200, {
      ...joinPublic(entry),
      requestId: entry.id,
      hub: name,
      ...(entry.status === 'approved' ? { token: entry.token, nodeId: entry.nodeId, nodeName: entry.nodeName } : {}),
    })
  }

  async function handleResult(request, response) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    const body = await readJson(request)
    const task = tasks.get(String(body.taskId ?? ''))
    if (task === undefined) return send(response, 404, { error: 'no such task' })
    if (task.nodeId !== node.id) return send(response, 403, { error: 'this task belongs to another node' })
    if (terminal(task.state)) return send(response, 200, { ok: true, duplicate: true })
    const exitCode = Number.isInteger(body.exitCode) ? body.exitCode : 1
    const file = body.file !== null && typeof body.file === 'object'
      ? {
          path: String(body.file.path ?? ''),
          size: Number.isFinite(body.file.size) ? Math.max(0, Math.round(body.file.size)) : undefined,
          mime: typeof body.file.mime === 'string' ? body.file.mime.slice(0, 120) : undefined,
          encoding: body.file.encoding === 'base64' ? 'base64' : 'utf8',
          // A worker enforces the limit; the hub caps a bad one so one result cannot
          // exhaust this process's memory.
          data: typeof body.file.data === 'string' ? body.file.data.slice(0, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) : '',
          truncated: body.file.truncated === true,
        }
      : undefined
    settle(task, {
      state: body.rejected === true ? 'rejected' : exitCode === 0 ? 'done' : 'failed',
      result: {
        exitCode,
        stdout: capped(body.stdout, MAX_OUTPUT),
        stderr: capped(body.stderr, MAX_OUTPUT),
        ...(file === undefined ? {} : { file }),
        durationMs: Number.isFinite(body.durationMs) ? Math.max(0, Math.round(body.durationMs)) : undefined,
        rejected: body.rejected === true,
      },
    })
    registry.touch(node.id)
    send(response, 200, { ok: true })
  }

  // The conversation a paired machine pulls and pushes. The node token authorizes it:
  // this is the same trust the stream has, and the center still owns the Session.
  async function handleSession(request, response, path, query) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    if (sessionSync === undefined) {
      return send(response, 503, { error: 'this hub does not serve a conversation; it runs without the Bot team' })
    }
    registry.touch(node.id)
    if (request.method === 'GET' && (path === '/session/bots' || path === '/session/list')) {
      return send(response, 200, await sessionSync.bots())
    }
    if (request.method === 'GET' && path === '/session') {
      const since = Number(query.get('since'))
      const wait = Number(query.get('wait'))
      // A conversation is a Bot's own chat (`bot=`) or a group chat (`room=`).
      const room = query.get('room')
      const reference = room !== null && room !== '' ? `room:${room}` : `bot:${query.get('bot') ?? ''}`
      // `before` pages the conversation's earlier items (a cursor, a seq or an id);
      // without it a snapshot answers with the current tail.
      const before = query.get('before')
      if (before !== null && before !== '') {
        const page = await sessionSync.earlier(reference, { before })
        if (response.writableEnded || response.destroyed) return undefined
        return send(response, 200, page)
      }
      const snapshot = await sessionSync.snapshot(reference, {
        since: Number.isFinite(since) ? since : undefined,
        epoch: query.get('epoch') ?? undefined,
        waitMs: Number.isFinite(wait) ? wait : undefined,
      })
      // A waiting poll may outlive its socket when the node reconnects; a write to a
      // closed response would only produce an error event no one reads.
      if (response.writableEnded || response.destroyed) return undefined
      return send(response, 200, snapshot)
    }
    if (request.method === 'POST' && path === '/session') {
      const body = await readJson(request)
      const result = await sessionSync.send({
        botId: body.botId,
        roomId: body.roomId,
        text: body.text,
        messageId: body.messageId,
      })
      return send(response, 200, { ...result, node: node.name })
    }
    // A node's card answer is forwarded to the hub's existing answer paths. The device
    // token authorizes it; the idempotency and the stale/expired handling live in the
    // session sync, so a repeated answer changes nothing and never re-runs a tool.
    if (request.method === 'POST' && path === '/session/approval') {
      const body = await readJson(request)
      const result = await sessionSync.answerApproval({ approvalId: body.approvalId, choice: body.choice })
      return send(response, 200, { ...result, node: node.name })
    }
    if (request.method === 'POST' && path === '/session/question') {
      const body = await readJson(request)
      const result = await sessionSync.answerQuestion({ botId: body.botId, questionId: body.questionId, answer: body.answer })
      return send(response, 200, { ...result, node: node.name })
    }
    if (request.method === 'POST' && path === '/session/question-dismiss') {
      const body = await readJson(request)
      const result = await sessionSync.dismissQuestion({ botId: body.botId })
      return send(response, 200, { ...result, node: node.name })
    }
    if (request.method === 'POST' && path === '/session/view') {
      const body = await readJson(request)
      const result = await sessionSync.answerView({ botId: body.botId, viewId: body.viewId, action: body.action, values: body.values })
      return send(response, 200, { ...result, node: node.name })
    }
    if (request.method === 'POST' && path === '/session/view-dismiss') {
      const body = await readJson(request)
      const result = await sessionSync.dismissView({ botId: body.botId })
      return send(response, 200, { ...result, node: node.name })
    }
    return send(response, 404, { error: 'not found' })
  }

  // The team a machine joins, not only the address of one: the Bots, group chats,
  // preferences and memory files (team-sync.js decides which, and leaves credentials and
  // machine paths behind). The device token authorizes it, like the conversation.
  async function handleTeam(request, response) {
    const node = registry.findByToken(bearer(request))
    if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
    if (teamSync === undefined) {
      return send(response, 503, { error: 'this hub does not share its Bot team' })
    }
    registry.touch(node.id)
    return send(response, 200, await teamSync.snapshot())
  }

  async function handleAdmin(request, response, path) {
    const given = String(request.headers['x-admin-token'] ?? '')
    if (!sameSecret(given, secret.token)) return send(response, 401, { error: 'the admin token is required' })

    if (request.method === 'POST' && path === '/admin/pair-code') {
      const issued = codes.issue()
      // The code goes back to the caller only: a log line would leave it in diagnostics.
      log('ds-bot lan: a pairing code was issued')
      return send(response, 200, issued)
    }
    if (request.method === 'GET' && path === '/admin/nodes') {
      return send(response, 200, { nodes: registry.list().map(publicNode), count: streams.size })
    }
    if (request.method === 'GET' && path === '/admin/join-requests') {
      return send(response, 200, { requests: joinRequests() })
    }
    const joinMatch = /^\/admin\/join-requests\/([^/]+)$/.exec(path)
    if (request.method === 'POST' && joinMatch !== null) {
      const requestId = decodeURIComponent(joinMatch[1])
      const body = await readJson(request)
      const allowed = body.action !== 'deny'
      const done = allowed ? approveJoin(requestId) : denyJoin(requestId)
      if (!done) return send(response, 404, { error: 'no join request with that id is waiting' })
      return send(response, 200, { ok: true, requests: joinRequests() })
    }
    // A removed node loses its token now; it has to pair again before it can be used.
    const removeMatch = /^\/admin\/nodes\/([^/]+)$/.exec(path)
    if (request.method === 'DELETE' && removeMatch !== null) {
      const reference = decodeURIComponent(removeMatch[1])
      if (!removeNode(reference)) return send(response, 404, { error: 'no such node' })
      return send(response, 200, { ok: true, nodes: registry.list().map(publicNode) })
    }
    if (request.method === 'POST' && path === '/admin/tasks') {
      // The body is the task spec: a file task carries `kind`, `path` and `data`, and
      // picking only `argv` here would dispatch an empty shell task instead.
      const task = dispatch(await readJson(request))
      return send(response, 200, { task: publicTask(task) })
    }
    const match = /^\/admin\/tasks\/([A-Za-z0-9_]+)$/.exec(path)
    if (request.method === 'GET' && match) {
      const task = tasks.get(match[1])
      if (task === undefined) return send(response, 404, { error: 'no such task' })
      return send(response, 200, { task: publicTask(task) })
    }
    return send(response, 404, { error: 'not found' })
  }

  async function handle(request, response) {
    const target = new URL(request.url ?? '/', 'http://hub')
    const path = target.pathname
    if (request.method === 'GET' && path === '/health') {
      return send(response, 200, { ok: true, hub: name, id, version: VERSION, protocol: PROTOCOL, nodes: registry.list().length, session: sessionSync !== undefined, team: teamSync !== undefined })
    }
    if (request.method === 'POST' && path === '/pair') return handlePair(request, response)
    if (request.method === 'POST' && path === '/join') return handleJoinRequest(request, response)
    const joinStatus = /^\/join\/([A-Za-z0-9_-]+)$/.exec(path)
    if (request.method === 'GET' && joinStatus !== null) return handleJoinStatus(request, response, joinStatus[1], target.searchParams)
    if (request.method === 'GET' && path === '/stream') return handleStream(request, response)
    if (request.method === 'POST' && path === '/heartbeat') {
      const node = registry.findByToken(bearer(request))
      if (node === undefined) return send(response, 401, { error: 'the device token is not known to this hub' })
      registry.touch(node.id)
      return send(response, 200, { ok: true, time: new Date(now()).toISOString() })
    }
    if (request.method === 'POST' && path === '/result') return handleResult(request, response)
    if (path === '/session' || path === '/session/bots' || path === '/session/list'
      || path === '/session/approval' || path === '/session/question' || path === '/session/question-dismiss'
      || path === '/session/view' || path === '/session/view-dismiss') return handleSession(request, response, path, target.searchParams)
    if (path === '/team') return handleTeam(request, response)
    if (path.startsWith('/admin/')) return handleAdmin(request, response, path)
    return send(response, 404, { error: 'not found' })
  }

  function dispatch(input) {
    const { node, timeoutMs, ...raw } = input ?? {}
    const target = registry.find(node)
    if (target === undefined) throw Object.assign(new Error(`no paired node named ${node ?? ''}`), { code: 'no-node', status: 400 })
    const normalized = normalizeTaskSpec(raw)
    if (!normalized.ok) throw Object.assign(new Error(normalized.reason), { code: 'bad-task', status: 400 })
    const wanted = Number.isInteger(timeoutMs) ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS
    const task = {
      id: `tk_${randomBytes(6).toString('hex')}`,
      nodeId: target.id,
      nodeName: target.name,
      ...normalized.spec,
      timeoutMs: Math.min(Math.max(wanted, 1000), MAX_TASK_TIMEOUT_MS),
      state: 'queued',
      createdAt: new Date(now()).toISOString(),
    }
    tasks.set(task.id, task)
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value
      const entry = tasks.get(oldest)
      if (!terminal(entry.state)) break
      tasks.delete(oldest)
    }
    if (streams.has(target.id)) flush(target.id)
    else log('ds-bot lan: %s is offline; task %s waits for it', target.name, task.id)
    return task
  }

  // Removing a node ends its stream and cancels what it still owes: the task would
  // otherwise wait in the queue for a machine that can never come back.
  function removeNode(reference) {
    const node = registry.find(reference)
    if (node === undefined) return false
    dropStream(node.id)
    for (const task of tasks.values()) {
      if (task.nodeId !== node.id || terminal(task.state)) continue
      settle(task, {
        state: 'cancelled',
        result: { stdout: '', stderr: 'the machine was removed from this hub', exitCode: 1 },
      })
    }
    return registry.remove(node.id)
  }

  // What the Devices page lists and what the two buttons act on. A request that was
  // answered stays visible for a while so the page can show what happened, then goes.
  function joinRequests() {
    pruneJoins()
    return [...joins.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map(joinPublic)
  }

  function approveJoin(reference) {
    pruneJoins()
    const request = joins.get(String(reference ?? ''))
    if (request === undefined || request.status !== 'pending') return false
    const { node, token } = addNode(request.device)
    Object.assign(request, { status: 'approved', token, nodeId: node.id, nodeName: node.name })
    // The token stays in this process; the file keeps only what is still waiting.
    persistJoins()
    log('ds-bot lan: allowed %s to join as %s', request.name, node.name)
    events.emit('paired', publicNode(node))
    notifyJoin(request.id)
    return true
  }

  function denyJoin(reference) {
    pruneJoins()
    const request = joins.get(String(reference ?? ''))
    if (request === undefined || request.status !== 'pending') return false
    request.status = 'denied'
    persistJoins()
    log('ds-bot lan: denied a join request from %s', request.name)
    notifyJoin(request.id)
    return true
  }

  function waitForTask(id, { timeoutMs = 60_000 } = {}) {
    const task = tasks.get(id)
    if (task === undefined) return Promise.reject(new Error(`no such task: ${id}`))
    if (terminal(task.state)) return Promise.resolve(publicTask(task))
    return new Promise((resolve, reject) => {
      const set = waiters.get(id) ?? new Set()
      waiters.set(id, set)
      const timer = setTimeout(() => {
        set.delete(done)
        reject(new Error(`task ${id} did not finish within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      const done = value => {
        clearTimeout(timer)
        resolve(value)
      }
      set.add(done)
    })
  }

  return {
    get url() {
      return url
    },
    get id() {
      return id
    },
    get port() {
      return boundPort
    },
    get discoveryPort() {
      return responder?.port
    },
    get dataDir() {
      return dataDir
    },
    get adminTokenFile() {
      return secret.file
    },
    get adminToken() {
      return secret.token
    },
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
    nodes: () => registry.list().map(publicNode),
    isOnline: nodeId => streams.has(nodeId),
    issueCode: () => codes.issue(),
    joinRequests,
    approveJoin,
    denyJoin,
    dispatch,
    removeNode,
    task: id => (tasks.has(id) ? publicTask(tasks.get(id)) : undefined),
    waitForTask,
    dropStream: nodeId => dropStream(nodeId),
    async start() {
      if (server !== undefined) return { url, port: boundPort }
      server = createServer((request, response) => {
        handle(request, response).catch(error => {
          const status = error?.status ?? 500
          if (status >= 500) log('ds-bot lan: %s %s failed: %s', request.method, request.url, error.message)
          if (!response.headersSent) send(response, status, { error: status >= 500 ? 'internal error' : error.message })
          else response.end()
        })
      })
      await new Promise((resolve, reject) => {
        // A hub on `0.0.0.0` is asked for by machines on the link, and a Mac or a phone
        // that resolves this machine's name tries IPv6 first. Listening dual-stack means
        // both families reach the same hub; an IPv4-only fallback keeps a machine without
        // IPv6 working. An IPv4 client then arrives as `::ffff:a.b.c.d`, which
        // normalizeAddress folds back to the plain address.
        const bind = (options, next) => {
          const onError = error => {
            server.off('error', onError)
            next(error)
          }
          server.once('error', onError)
          server.listen(options, () => {
            server.off('error', onError)
            resolve()
          })
        }
        if (host !== '0.0.0.0') return bind({ port, host }, reject)
        bind({ port, host: '::', ipv6Only: false }, error => {
          if (!FAMILY_ERRORS.has(error?.code)) return reject(error)
          bind({ port, host: '0.0.0.0' }, reject)
        })
      })
      const address = server.address()
      if (address !== null && typeof address === 'object') boundPort = address.port
      const display = host === '0.0.0.0' || host === '::' ? lanAddress() : host
      url = `http://${display}:${boundPort}`
      // Discovery is best effort: a machine with the UDP port taken or a firewall that
      // drops the probe still serves the hub, and the Devices page falls back to the
      // pairing code.
      if (discovery !== false) {
        responder = startResponder({
          port: discoveryPort,
          identity: () => ({ name, port: boundPort, id, protocol: PROTOCOL }),
          log,
        })
        await responder.ready.catch(() => {})
      }
      return { url, port: boundPort }
    },
    async stop() {
      if (stopped) return
      stopped = true
      await responder?.close()
      responder = undefined
      for (const nodeId of streams.keys()) dropStream(nodeId)
      for (const timer of taskTimers.values()) clearTimeout(timer)
      taskTimers.clear()
      if (server !== undefined) {
        const closing = new Promise(resolve => server.close(() => resolve()))
        server.closeAllConnections?.()
        await closing
        server = undefined
      }
      registry.save(true)
    },
  }
}
