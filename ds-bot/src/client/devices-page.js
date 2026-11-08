import { createElement as h, useCallback, useEffect, useState } from 'react'
import { DevicesIcon } from './icons.js'
import { dateLocale, t } from './i18n.js'

// Settings → Devices: turn this computer into the hub, let the machines paired with it
// in, or join a hub that is already on this network. The page polls while it is open so
// a machine that joins, drops or asks to join shows up without reopening Settings.
const POLL_MS = 3000

const STATE_LABEL = { off: 'Off', starting: 'Starting…', listening: 'Listening', failed: 'Could not start' }

function timeText(value) {
  if (typeof value !== 'string' || value === '') return t('Never seen')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url ?? '')
  }
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return h('button', {
    type: 'button',
    className: 'bt-soft bt-soft-sm',
    onClick: () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}) },
  }, t(copied ? 'Copied' : label))
}

export function NodeRow({ node, confirming, busy, onRemove }) {
  const details = [node.os, node.arch].filter(Boolean).join('/')
  return h('div', { className: 'bt-dev-node', 'data-online': node.online || undefined },
    h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-dev-node-copy' },
      h('span', { className: 'bt-dev-node-name' }, node.name),
      h('span', { className: 'bt-dev-node-meta' },
        [node.hostname, details].filter(Boolean).join(' · ') || t('Unknown machine'),
        h('span', { className: 'bt-dev-sep', 'aria-hidden': true }),
        node.online
          ? t('Online')
          : [t('Offline'), h('span', { key: 'sep', className: 'bt-dev-sep', 'aria-hidden': true }), t('Last seen {time}', { time: timeText(node.lastSeen) })])),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm bt-dev-remove',
      'data-confirm': confirming || undefined,
      disabled: busy,
      onClick: onRemove,
    }, confirming ? t('Click again to remove') : t('Remove')))
}

function RequestRow({ request, busy, onAllow, onDeny }) {
  const meta = [request.hostname, request.os].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-dev-node' },
    h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-dev-node-copy' },
      h('span', { className: 'bt-dev-node-name' }, t('{name} wants to join', { name: request.name })),
      meta === '' ? null : h('span', { className: 'bt-dev-node-meta' }, meta)),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => onAllow(request) }, t('Allow')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-dev-remove', disabled: busy, onClick: () => onDeny(request) }, t('Deny')))
}

// Where another machine opens the same conversation. The Web server reports only its
// origin: the login token belongs to the URL DSH printed at startup. A loopback origin
// is not reachable from another machine, so the page shows a port forward instead of a
// link that would fail.
export function sharedSessionLink(webUrl) {
  if (typeof webUrl !== 'string' || webUrl === '') return { kind: 'none' }
  let url
  try {
    url = new URL(webUrl)
  } catch {
    return { kind: 'none' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  if (!loopback) return { kind: 'url', url: webUrl }
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return {
    kind: 'forward',
    url: webUrl,
    port,
    command: `ssh -L ${port}:127.0.0.1:${port} <user>@<this-machine>`,
  }
}

// What a row in the sidebar can say about the paired machines without repeating the
// Devices page: whether multi-device is on, and how many of the paired machines are
// online. The roster already refreshes on the normal state poll, so this needs no
// timer of its own.
export function deviceSummary(multiDevice) {
  const nodes = Array.isArray(multiDevice?.nodes) ? multiDevice.nodes : []
  const online = nodes.filter(node => node.online === true).length
  return {
    available: multiDevice?.available !== false,
    enabled: multiDevice?.enabled === true,
    total: nodes.length,
    online,
    names: nodes.map(node => `${node.name}${node.online ? ' (online)' : ' (offline)'}`).join(', '),
  }
}

function copyText(text) {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

// The always-visible entry to Settings → Devices: a strip above the account row when
// the sidebar is wide, a round button with an online count on the rail. When another
// machine can open the same conversation, the wide strip also copies that address.
export function DevicesStrip({ multiDevice, actions, wide = true }) {
  const summary = deviceSummary(multiDevice)
  if (!summary.available || !summary.enabled) return null
  const open = () => actions?.openSettings?.('devices')
  const link = sharedSessionLink(multiDevice?.hub?.webUrl)
  const label = summary.total === 0
    ? t('Devices · no machines paired')
    : t('Devices · {online} of {total} online', { online: summary.online, total: summary.total })
  if (!wide) {
    return h('button', {
      type: 'button',
      className: 'bt-round bt-dev-strip-rail',
      'aria-label': label,
      title: summary.names === '' ? label : `${label}\n${summary.names}`,
      onClick: open,
    },
    h(DevicesIcon),
    summary.online > 0 ? h('span', { className: 'bt-dev-strip-count', 'aria-hidden': true }, String(summary.online)) : null)
  }
  const strip = h('button', {
    type: 'button',
    className: 'bt-dev-strip',
    'data-online': summary.online > 0 || undefined,
    'aria-label': label,
    title: summary.names === '' ? label : `${label}\n${summary.names}`,
    onClick: open,
  },
  h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-dev-strip-text' }, label))
  if (link.kind !== 'url') return strip
  return h('div', { className: 'bt-dev-strip-row' },
    strip,
    h('button', {
      type: 'button',
      className: 'bt-round bt-dev-strip-copy',
      'aria-label': t('Copy session link'),
      title: t('Copy session link'),
      onClick: () => copyText(link.url),
    }, h(LinkIcon)))
}

function LinkIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
    h('path', { d: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1' }))
}

// The pairing code and the command line stay for a machine whose page cannot reach this
// hub (a firewall that drops the probe) and for a hub without a screen to press.
function CommandPanel({ pairing, daemon, onClose }) {
  return h('div', { className: 'bt-dev-pairing' },
    h('div', { className: 'bt-dev-pairing-head' },
      h('span', { className: 'bt-dev-pairing-label' }, t('Pairing code for the command line')),
      h('code', { className: 'bt-dev-code' }, pairing.code)),
    h('div', { className: 'bt-dev-hint' }, t('Valid until {time}. One machine, one use.', { time: timeText(pairing.expiresAt) })),
    h('div', { className: 'bt-dev-command' },
      h('code', null, pairing.command),
      h(CopyButton, { text: pairing.command, label: 'Copy command' })),
    daemon?.command === undefined ? null : h('div', { className: 'bt-dev-command' },
      h('code', null, daemon.command),
      h(CopyButton, { text: daemon.command, label: 'Copy command' })),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Done'))))
}

export function Nearby({ hubs, scanning, busy, onScan, onJoin }) {
  if (scanning) return h('div', { className: 'bt-dev-hint' }, t('Searching…'))
  if (hubs.length === 0) {
    return h('div', { className: 'bt-dev-hint' },
      t('No hub found. Check that both computers are on the same Wi-Fi.'),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onScan }, t('Search again'))))
  }
  return hubs.map(hub => h('div', { key: hub.id ?? hub.url, className: 'bt-dev-node' },
    h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-dev-node-copy' },
      h('span', { className: 'bt-dev-node-name' }, hub.name),
      h('span', { className: 'bt-dev-node-meta' }, hub.url)),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => onJoin(hub.url) }, t('Join'))))
}

export function DevicesPage({ roster, actions, run, Section, Row, Switch }) {
  const fallback = roster.multiDevice ?? { available: true, enabled: false, hub: { state: 'off' }, nodes: [], policy: [] }
  const [status, setStatus] = useState(fallback)
  const [hubs, setHubs] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [pairing, setPairing] = useState(null)
  const [advanced, setAdvanced] = useState(false)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState('')
  // Joining replaces this computer's whole team, so the tap that starts it only opens the
  // question; nothing is sent and nothing is replaced until the second button.
  const [joinConfirm, setJoinConfirm] = useState(null)

  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const refresh = useCallback(() => {
    if (typeof actions.multiDeviceStatus !== 'function') return
    void Promise.resolve(actions.multiDeviceStatus()).then(value => { if (value) setStatus(value) }, () => {})
  }, [actions])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const enabled = status.enabled === true
  const available = status.available !== false
  const hub = status.hub ?? { state: 'off' }
  const node = status.node ?? { paired: false, state: 'unpaired' }
  const nodes = status.nodes ?? []
  const requests = status.requests ?? []
  const joining = node.joining

  const scan = useCallback(() => {
    if (typeof actions.multiDeviceScan !== 'function') return
    setScanning(true)
    void run(Promise.resolve()
      .then(() => actions.multiDeviceScan())
      .then(value => { setHubs(value?.hubs ?? []) }))
      .finally(() => setScanning(false))
  }, [actions, run])

  // A page that is only a node, or a hub that is off, looks around once when it opens:
  // that hub is the answer the other machine is looking for. Later checks are the
  // Search again button, so a poll never turns into a scan loop.
  useEffect(() => {
    if (scanned || !available || enabled || node.paired || typeof actions.multiDeviceScan !== 'function') return undefined
    setScanned(true)
    scan()
    return undefined
  }, [scanned, available, enabled, node.paired, actions, scan])

  const toggle = (on) => {
    if (busy) return
    setBusy(true)
    setPairing(null)
    void run(actions.multiDeviceSetEnabled(on))
      .then(ok => { if (ok) refresh() })
      .finally(() => setBusy(false))
  }

  const join = (url) => {
    if (busy || url === '') return
    setJoinConfirm({ url })
  }

  const joinNow = () => {
    const url = joinConfirm?.url ?? ''
    setJoinConfirm(null)
    if (busy || url === '') return
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDeviceJoin(url))
      .then(value => { if (value) setStatus(value) }))
      .finally(() => setBusy(false))
  }

  const leave = () => {
    if (busy) return
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDeviceLeave())
      .then(value => { if (value) setStatus(value) }))
      .finally(() => setBusy(false))
  }

  const addMachine = () => {
    if (busy) return
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDevicePairCode())
      .then(value => { setPairing(value); return value }))
      .finally(() => setBusy(false))
  }

  const remove = (entry) => {
    if (busy) return
    if (confirming !== entry.id) { setConfirming(entry.id); return }
    setConfirming('')
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDeviceRemove(entry.id))
      .then(value => { if (value) setStatus(value) }))
      .finally(() => setBusy(false))
  }

  const answer = (request, allow) => {
    if (busy) return
    setBusy(true)
    const call = allow ? actions.multiDeviceApprove : actions.multiDeviceDeny
    void run(Promise.resolve()
      .then(() => call(request.id))
      .then(value => { if (value) setStatus(value) }))
      .finally(() => setBusy(false))
  }

  if (!available) {
    return [h(Section, { key: 'off', title: t('Multi-device') },
      h(Row, { label: t('This computer is set up without multi-device (multiDevice: false).') }))]
  }

  // A computer that joined a hub shows that one line; it does not run a second hub.
  if (node.paired) {
    const name = node.hubName ?? hostOf(node.hubUrl)
    return [h(Section, { key: 'node', title: t('This computer') },
      h(Row, {
        label: t('Joined {name}', { name }),
        hint: node.error ?? (node.online ? t('Online') : t('Offline')),
      }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: leave }, t('Leave'))),
      node.backup === undefined ? null : h(Row, { label: t('Backup'), hint: node.backup }))]
  }

  if (joining !== undefined) {
    return [h(Section, { key: 'joining', title: t('This computer') },
      h(Row, { label: t('Waiting for {name} to allow this computer…', { name: joining.hub ?? hostOf(joining.url) }) },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: leave }, t('Cancel'))),
      joining.backup === undefined ? null : h(Row, { label: t('Backup'), hint: joining.backup }),
      node.error === undefined ? null : h(Row, { label: node.error }))]
  }

  // A machine asking to join is the one thing on this page that needs an answer, so it has
  // its own block and is shown even when the hub is still starting or the switch is off:
  // hiding it there is how a request goes unanswered.
  const requestsSection = requests.length === 0 ? null : h(Section, { key: 'requests', title: t('Waiting to join · {count}', { count: requests.length }) },
    requests.map(request => h(RequestRow, {
      key: request.id,
      request,
      busy,
      onAllow: entry => answer(entry, true),
      onDeny: entry => answer(entry, false),
    })))

  const hubSection = h(Section, { key: 'devices', title: t('Devices · {count}', { count: nodes.length }) },
    nodes.length === 0
      ? h(Row, { label: t('No device yet.') })
      : nodes.map(entry => h(NodeRow, {
        key: entry.id,
        node: entry,
        confirming: confirming === entry.id,
        busy,
        onRemove: () => remove(entry),
      })),
    h('div', { className: 'bt-dev-hint' }, t('On the other computer, open Settings → Devices and pick this one under Nearby hubs.')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setAdvanced(value => !value) }, t('Advanced'))),
    advanced ? h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || hub.state !== 'listening', onClick: addMachine }, t('Pairing code'))) : null,
    pairing === null ? null : h(CommandPanel, { pairing, daemon: status.daemon, onClose: () => setPairing(null) }),
    confirming ? h('div', { className: 'bt-dev-hint' }, t('{name} must pair again before it can be used. Its running task is cancelled; stop the worker on that machine as well.', { name: nodes.find(entry => entry.id === confirming)?.name ?? t('The machine') })) : null)

  const nearbySection = h(Section, { key: 'nearby', title: t('Nearby hubs') },
    h(Nearby, { hubs, scanning, busy, onScan: scan, onJoin: join }),
    h('div', { className: 'bt-dev-hint' }, t('On the other computer, turn on multi-device in Settings → Devices.')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setAdvanced(value => !value) }, t('Advanced'))),
    advanced ? h('div', { className: 'bt-dev-row' },
      h('input', {
        type: 'text',
        className: 'bt-dev-input',
        value: manual,
        placeholder: 'http://192.168.1.23:8787',
        onChange: event => setManual(event.target.value),
      }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || manual.trim() === '', onClick: () => join(manual.trim()) }, t('Join'))) : null)

  const confirmSection = joinConfirm === null ? null : h(Section, { key: 'confirm', title: t('Join {name}?', { name: hostOf(joinConfirm.url) }) },
    h('div', { className: 'bt-dev-hint' }, t('This computer\'s Bots, memory and settings are replaced by the hub\'s. They are backed up first.')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: joinNow }, t('Replace and join')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setJoinConfirm(null) }, t('Cancel'))))

  return [
    confirmSection,
    requestsSection,
    h(Section, { key: 'switch', title: t('This computer') },
      h(Row, {
        label: t('Let this computer be the hub'),
        hint: t('Bots here can reach the machines that join it.'),
      }, Switch === undefined ? null : h(Switch, { label: t('Let this computer be the hub'), on: enabled, disabled: busy, onChange: toggle })),
      enabled ? h(Row, {
        label: t(STATE_LABEL[hub.state] ?? STATE_LABEL.failed),
        hint: hub.error,
      }, hub.url === undefined ? null : h('div', { className: 'bt-dev-url' },
        h('code', null, hub.url),
        h(CopyButton, { text: hub.url }))) : null,
      node.error === undefined ? null : h(Row, { label: node.error })),
    enabled ? hubSection : nearbySection,
  ].filter(section => section !== null)
}

export const DEVICES_CSS = `
.bt-dev-url{display:flex;align-items:center;gap:8px;min-width:0}
.bt-dev-url code,.bt-dev-command code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-dev-node{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:.5px solid var(--bt-line)}
.bt-dev-node:last-of-type{border-bottom:0}
.bt-dev-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--bt-ink-3)}
.bt-dev-node[data-online] .bt-dev-dot{background:var(--bt-green)}
.bt-dev-node-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-dev-node-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-node-meta{font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-sep{display:inline-block;width:4px}
.bt-dev-remove{flex:none}
.bt-dev-remove[data-confirm]{background:var(--bt-danger-soft);color:var(--bt-danger);border-color:var(--bt-danger-soft)}
.bt-dev-pairing{margin:10px 14px 14px;padding:12px;border-radius:10px;background:var(--bt-tag-bg);display:flex;flex-direction:column;gap:8px}
.bt-dev-pairing-head{display:flex;align-items:baseline;gap:10px}
.bt-dev-pairing-label{font-size:12px;color:var(--bt-ink-2)}
.bt-dev-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:22px;letter-spacing:2px;font-weight:600}
.bt-dev-hint{font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-dev-command{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bt-card);border:.5px solid var(--bt-line);min-width:0}
.bt-dev-command code{flex:1}
.bt-dev-row{display:flex;align-items:center;gap:8px;padding:8px 14px}
.bt-dev-input{flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px}
.bt-dev-strip{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;margin:0 0 4px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.bt-dev-strip:hover{background:var(--bt-hover)}
.bt-dev-strip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-strip[data-online] .bt-dev-dot{background:var(--bt-green)}
.bt-dev-strip-rail{position:relative}
.bt-dev-strip-count{position:absolute;top:2px;right:2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--bt-green);color:var(--bt-main);font-size:9px;line-height:14px;text-align:center}
.bt-dev-strip-row{display:flex;align-items:center;gap:2px;margin:0 4px 4px 0}
.bt-dev-strip-row .bt-dev-strip{margin:0;flex:1;min-width:0}
.bt-dev-strip-copy{flex:none;width:26px;height:26px}
.bt-dev-strip-copy:hover{background:var(--bt-hover)}
`
