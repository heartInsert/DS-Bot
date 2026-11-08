// Finding the hub on the same network without typing an address. The hub answers a UDP
// probe on one fixed port; a machine looking for it sends a broadcast from an ephemeral
// socket and reads the unicast answers. The probe goes out first, so the answer is
// accepted by a host firewall that drops unsolicited inbound traffic, and the machine
// looking only needs an outbound datagram. Addresses come from where the answer arrived,
// not from what the hub thinks its address is, so a hub bound to one interface still
// hands out a reachable URL.
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const DISCOVERY_PORT = 8789
export const DISCOVERY_VERSION = 1
const PROBE = 'dsbot-lan-discover'
const MAX_BEACON = 2 * 1024

// The limited broadcast address reaches every host on the link; the per-interface one
// covers platforms that route only the subnet broadcast.
export function broadcastAddresses() {
  const found = new Set(['255.255.255.255'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const address = entry.address.split('.').map(Number)
      const mask = String(entry.netmask ?? '').split('.').map(Number)
      if (address.length !== 4 || mask.length !== 4) continue
      const broadcast = address.map((part, index) => (part & mask[index]) | (~mask[index] & 255))
      found.add(broadcast.join('.'))
    }
  }
  return [...found]
}

export function beaconOf({ name, port, id, protocol }) {
  return {
    dsbot: 'hub',
    v: DISCOVERY_VERSION,
    id: String(id ?? ''),
    name: String(name ?? 'DS Bot hub').slice(0, 60),
    port: Number(port),
    protocol: Number.isInteger(protocol) ? protocol : undefined,
  }
}

// A beacon from any other program, or a malformed one, is ignored: this port is a public
// place on the link.
export function readBeacon(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : ''
  if (text.length === 0 || text.length > MAX_BEACON) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed?.dsbot !== 'hub' || parsed.v !== DISCOVERY_VERSION) return undefined
  if (typeof parsed.id !== 'string' || parsed.id === '') return undefined
  if (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535) return undefined
  return {
    id: parsed.id,
    name: typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : 'DS Bot hub',
    port: parsed.port,
    protocol: Number.isInteger(parsed.protocol) ? parsed.protocol : undefined,
  }
}

export function urlOf(address, port) {
  const host = String(address).replace(/^::ffff:/i, '')
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

// The hub's side: one socket, one reply per probe, nothing remembered.
export function startResponder({ port = DISCOVERY_PORT, identity, log = () => {} } = {}) {
  const socket = createSocket({ type: 'udp4', reuseAddr: false })
  let boundPort = port
  const close = () => new Promise(resolve => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, '0.0.0.0', () => {
      socket.off('error', reject)
      const address = socket.address()
      if (address !== null && typeof address === 'object') boundPort = address.port
      resolve()
    })
  }).then(() => {
    socket.on('message', (message, from) => {
      if (message.toString('utf8') !== PROBE) return
      const current = typeof identity === 'function' ? identity() : identity
      if (current === undefined) return
      const payload = JSON.stringify(beaconOf(current))
      socket.send(payload, from.port, from.address, error => {
        if (error) log('ds-bot lan: could not answer a discovery probe: %s', error.message)
      })
    })
    // A socket error after the bind (a network change, a closed interface) must not
    // take the plugin down; discovery is best effort.
    socket.on('error', error => log('ds-bot lan: discovery stopped answering: %s', error.message))
    return { port: boundPort, close }
  })
  ready.catch(async error => {
    log('ds-bot lan: discovery is off: %s', error.message)
    await close()
  })
  return {
    get port() {
      return boundPort
    },
    ready,
    close,
  }
}

// The machine that wants to join: send the probe, collect the answers that name a
// different hub id, and stop after `timeoutMs`.
export async function findHubs({ port = DISCOVERY_PORT, timeoutMs = 1200, targets, ignore = [] } = {}) {
  const socket = createSocket({ type: 'udp4', reuseAddr: false })
  const found = new Map()
  const skipped = new Set(ignore)
  const close = () => new Promise(resolve => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', () => {
      socket.off('error', reject)
      resolve()
    })
  })
  socket.setBroadcast(true)
  socket.on('message', (message, from) => {
    const beacon = readBeacon(message)
    if (beacon === undefined || skipped.has(beacon.id) || found.has(beacon.id)) return
    found.set(beacon.id, { ...beacon, address: String(from.address).replace(/^::ffff:/i, ''), url: urlOf(from.address, beacon.port) })
  })
  // An interface without a route (or a sandbox that forbids broadcast) is not an error
  // the user can act on: the other targets still go out.
  const send = target => { socket.send(PROBE, port, target, () => {}) }
  // 127.0.0.1 is a real case (two DSH profiles on one machine) and also makes the
  // answer deterministic where a sandbox has no broadcast route.
  for (const target of targets ?? [...broadcastAddresses(), '127.0.0.1']) send(target)
  await new Promise(resolve => setTimeout(resolve, timeoutMs))
  await close()
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}
