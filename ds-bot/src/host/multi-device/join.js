// Joining a hub the way the Devices page does it: ask, wait for the person at the hub to
// allow this machine, and save the token the hub hands back. The request carries no
// pairing code. It cannot become a pairing on its own: the hub only creates the node
// after someone there presses Allow, and the machine's name and address are shown there
// first. The code stays for the command line and for a hub with no screen to press.
import { arch, hostname as localHostname, platform as localPlatform, release, version as osVersion } from 'node:os'
import { writeDevice } from './worker.js'

const HUB_TIMEOUT_MS = 10_000
const WAIT_MS = 20_000
const JOIN_TTL_MS = 5 * 60_000

export function thisDevice(name) {
  return {
    name: name ?? localHostname(),
    os: localPlatform(),
    platform: `${osVersion()} ${release()}`.trim(),
    arch: arch(),
    hostname: localHostname(),
  }
}

const baseOf = hubUrl => String(hubUrl ?? '').replace(/\/+$/, '')

async function json(response) {
  return response.json().catch(() => ({}))
}

export async function requestJoin(hubUrl, device, { timeoutMs = HUB_TIMEOUT_MS } = {}) {
  const url = `${baseOf(hubUrl)}/join`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await json(response)
  if (!response.ok) throw new Error(`the hub did not accept the request: ${body.error ?? `HTTP ${response.status}`}`)
  return body
}

// One poll. `pending` is an ordinary answer, not an error: the person at the hub has not
// looked yet. The hub holds the answer open for `waitMs`, so this is one request per
// change, not a busy loop.
export async function pollJoin(hubUrl, requestId, { waitMs = WAIT_MS, timeoutMs = WAIT_MS + HUB_TIMEOUT_MS } = {}) {
  const url = `${baseOf(hubUrl)}/join/${encodeURIComponent(requestId)}?wait=${waitMs}`
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const body = await json(response)
  if (response.status === 404) return { status: 'expired' }
  if (!response.ok) throw new Error(`the hub did not answer: ${body.error ?? `HTTP ${response.status}`}`)
  return body
}

/**
 * Ask a hub to let this machine in and wait for the answer. `onWaiting` is called once
 * the hub knows the request, so a page can say which machine to look at. Resolves with
 * the saved device on approval; throws when the hub denies it, the request expires, or
 * the wait runs out.
 */
export async function joinHub({ hubUrl, dataDir, name, device, onWaiting, signal, waitMs = WAIT_MS, timeoutMs = JOIN_TTL_MS } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('joining a hub needs a dataDir')
  const started = await requestJoin(hubUrl, device ?? thisDevice(name))
  onWaiting?.({ requestId: started.requestId, hub: started.hub, expiresAt: started.expiresAt })
  const deadline = Date.now() + timeoutMs
  let interval = 0
  for (;;) {
    if (signal?.aborted === true) throw new Error('the join was cancelled')
    if (Date.now() > deadline) throw new Error('the other computer did not answer; try again, or use the pairing code')
    if (interval > 0) await new Promise(resolve => setTimeout(resolve, interval))
    const answer = await pollJoin(hubUrl, started.requestId, { waitMs: Math.min(waitMs, Math.max(1_000, deadline - Date.now())) })
    if (answer.status === 'approved') {
      if (typeof answer.token !== 'string' || answer.token === '') throw new Error('the answer expired before this machine saved it; ask to join again')
      const saved = {
        nodeId: answer.nodeId,
        nodeName: answer.nodeName,
        token: answer.token,
        hubUrl: baseOf(hubUrl),
        hubName: typeof answer.hub === 'string' ? answer.hub : undefined,
        pairedAt: new Date().toISOString(),
      }
      writeDevice(dataDir, saved)
      return saved
    }
    if (answer.status === 'denied') throw new Error('the other computer did not allow this machine')
    if (answer.status === 'expired') {
      // A request that outlived its window is asked for again, so a page left open still
      // joins once the person at the hub comes back.
      if (Date.now() >= deadline) throw new Error('the other computer did not answer; try again')
      return joinHub({ hubUrl, dataDir, name, device, onWaiting, signal, waitMs, timeoutMs: deadline - Date.now() })
    }
    interval = 1_000
  }
}
