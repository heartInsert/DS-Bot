import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DevicesPage, NodeRow, Nearby, DevicesStrip, deviceSummary, sharedSessionLink } from './src/client/devices-page.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
  useCallback: fn => fn,
  useEffect: (make, deps) => effect(make, deps ?? []),
  useState: initial => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = next }]
  },
}
const module = { exports: {} }
const copied = []
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
  navigator: { clipboard: { writeText: async text => { copied.push(text) } } },
  URL,
}, { filename: 'bundle.cjs' })
const { DevicesPage, NodeRow, Nearby, DevicesStrip, deviceSummary, sharedSessionLink } = module.exports

function render(component, props) {
  current = { index: 0, slots: [], effects: [] }
  // The page's polling lives in an effect, and this harness never runs effects; the
  // render itself must not start a timer.
  return component(props)
}

// A mounted page keeps its hooks between renders, so a click that sets state can be seen
// the way a browser would show it.
function mount(props) {
  const slots = []
  const run = () => {
    current = { index: 0, slots, effects: [] }
    return DevicesPage(props)
  }
  return { tree: run(), again: run }
}

const texts = (node, found = []) => {
  if (typeof node === 'string' || typeof node === 'number') found.push(String(node))
  if (Array.isArray(node)) node.forEach(item => texts(item, found))
  if (node && typeof node === 'object') {
    // The page leaves child components as elements; rendering one here is what a
    // browser would do before its text is read.
    if (typeof node.type === 'function') return texts(node.type(node.props), found)
    for (const key of ['children', 'label', 'title', 'hint']) if (node.props?.[key]) texts(node.props[key], found)
  }
  return found
}
const buttons = (node, found = []) => {
  if (Array.isArray(node)) node.forEach(item => buttons(item, found))
  if (node && typeof node === 'object') {
    if (node.type === 'button') found.push(texts(node).join(''))
    if (typeof node.type === 'function') return buttons(node.type(node.props), found)
    for (const key of ['children', 'label', 'title']) if (node.props?.[key]) buttons(node.props[key], found)
  }
  return found
}
const findButton = (node, label) => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButton(item, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node && typeof node === 'object') {
    if (node.type === 'button' && texts(node).join('') === label) return node
    if (typeof node.type === 'function') return findButton(node.type(node.props), label)
    for (const key of ['children', 'label', 'title']) {
      const found = node.props?.[key] === undefined ? undefined : findButton(node.props[key], label)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const Frame = ({ label, title, hint, children }) => ({ type: 'row', props: { label, title, hint, children } })
const Switch = ({ label }) => ({ type: 'switch', props: { label } })
const page = (roster, actions = {}) => render(DevicesPage, { roster, actions, run: promise => promise, Section: Frame, Row: Frame, Switch })

const findInput = (node) => {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findInput(item); if (found !== undefined) return found }
    return undefined
  }
  if (node && typeof node === 'object') {
    if (node.type === 'input') return node
    if (typeof node.type === 'function') return findInput(node.type(node.props))
    for (const key of ['children', 'label', 'title', 'hint']) {
      const found = node.props?.[key] === undefined ? undefined : findInput(node.props[key])
      if (found !== undefined) return found
    }
  }
  return undefined
}

test('the hub page shows the machines, who waits to join, and no command line', () => {
  const roster = {
    multiDevice: {
      available: true,
      enabled: true,
      hub: { state: 'listening', url: 'http://192.168.1.5:8787', localUrl: 'http://127.0.0.1:8787' },
      nodes: [{ id: 'nd_1', name: 'win-pc', hostname: 'WIN-PC', os: 'win32', arch: 'x64', online: true }],
      requests: [{ id: 'jr_1', name: 'pc2', hostname: 'PC2', os: 'win32', status: 'pending' }],
      policy: ['hostname', 'whoami'],
      daemon: { command: 'npm run lan:daemon -- install --hub http://192.168.1.5:8787 --name other-pc' },
    },
  }
  const tree = page(roster)
  const found = texts(tree)
  assert.ok(found.includes('Let this computer be the hub'))
  assert.ok(found.includes('Listening'))
  assert.ok(found.includes('http://192.168.1.5:8787'))
  assert.ok(found.includes('Devices · 1'))
  assert.ok(found.includes('pc2 wants to join'))
  assert.ok(found.includes('On the other computer, open Settings → Devices and pick this one under Nearby hubs.'))
  assert.deepEqual(buttons(tree).sort(), ['Advanced', 'Allow', 'Copy', 'Deny', 'Remove'])
  // The command line lives behind Advanced and is not on the main path.
  assert.equal(found.some(text => text.includes('npm run lan:worker')), false)
  assert.equal(found.includes('Pairing code'), false)

  const row = render(NodeRow, { node: roster.multiDevice.nodes[0], confirming: false, busy: false, onRemove: () => {} })
  assert.ok(texts(row).includes('win-pc'))
  assert.ok(texts(row).includes('WIN-PC · win32/x64'))
  assert.ok(texts(row).includes('Online'))
  assert.ok(buttons(row).includes('Remove'))
})

test('the hub page shows that no machine has joined yet', () => {
  const tree = page({ multiDevice: { available: true, enabled: true, hub: { state: 'listening', url: 'http://192.168.1.5:8787' }, nodes: [], requests: [] } })
  assert.ok(texts(tree).includes('No device yet.'))
})

test('a machine that has joined shows one line and a way out', () => {
  const tree = page({
    multiDevice: {
      available: true,
      enabled: false,
      hub: { state: 'off' },
      nodes: [],
      node: { paired: true, hubName: 'Mac mini', hubUrl: 'http://192.168.1.5:8787', online: true, state: 'online' },
    },
  })
  const found = texts(tree)
  assert.ok(found.includes('Joined Mac mini'))
  assert.ok(found.includes('Online'))
  assert.deepEqual(buttons(tree), ['Leave'])
  assert.equal(found.includes('Let this computer be the hub'), false)
  assert.equal(found.includes('Nearby hubs'), false)
})

test('a machine asking to join says which hub it waits for', () => {
  const tree = page({
    multiDevice: {
      available: true,
      enabled: false,
      hub: { state: 'off' },
      nodes: [],
      node: { paired: false, state: 'unpaired', joining: { state: 'waiting', url: 'http://192.168.1.5:8787', hub: 'Mac mini' } },
    },
  })
  assert.ok(texts(tree).includes('Waiting for Mac mini to allow this computer…'))
  assert.deepEqual(buttons(tree), ['Cancel'])
})

test('the page looks for hubs when this computer is not one', () => {
  const tree = page({ multiDevice: { available: true, enabled: false, hub: { state: 'off' }, nodes: [], requests: [], node: { paired: false } } })
  const found = texts(tree)
  assert.ok(found.includes('Nearby hubs'))
  assert.ok(found.includes('No hub found. Check that both computers are on the same Wi-Fi.'))
  assert.ok(found.includes('On the other computer, turn on multi-device in Settings → Devices.'))
  assert.deepEqual(buttons(tree).sort(), ['Advanced', 'Search again'])
  assert.equal(found.includes('Let this computer be the hub'), true)
})

test('a nearby hub is one row with a join button', () => {
  const joined = []
  const tree = render(Nearby, {
    hubs: [{ id: 'hub_a', name: 'Mac mini', url: 'http://192.168.1.5:8787' }],
    scanning: false,
    busy: false,
    onScan: () => {},
    onJoin: url => joined.push(url),
  })
  assert.ok(texts(tree).includes('Mac mini'))
  assert.ok(texts(tree).includes('http://192.168.1.5:8787'))
  const join = findButton(tree, 'Join')
  join.props.onClick()
  assert.deepEqual(joined, ['http://192.168.1.5:8787'])
  assert.ok(texts(render(Nearby, { hubs: [], scanning: true, busy: false, onScan: () => {}, onJoin: () => {} })).includes('Searching…'))
})

test('the Devices page keeps the switch out when the profile forbids multi-device', () => {
  const tree = page({ multiDevice: { available: false, enabled: false, hub: { state: 'off' }, nodes: [], policy: [] } })
  assert.ok(texts(tree).includes('This computer is set up without multi-device (multiDevice: false).'))
  assert.deepEqual(buttons(tree), [])
})

test('the sidebar strip shows how many paired machines are online and opens Devices', () => {
  const multiDevice = {
    available: true,
    enabled: true,
    nodes: [
      { id: 'nd_1', name: 'win-pc', online: true },
      { id: 'nd_2', name: 'old-mac', online: false },
    ],
  }
  assert.deepEqual(
    { ...deviceSummary(multiDevice), names: undefined },
    { available: true, enabled: true, total: 2, online: 1, names: undefined },
  )
  const opened = []
  const wide = render(DevicesStrip, { multiDevice, actions: { openSettings: page => opened.push(page) }, wide: true })
  assert.equal(wide.type, 'button')
  assert.ok(texts(wide).includes('Devices · 1 of 2 online'))
  assert.match(wide.props.title, /win-pc \(online\), old-mac \(offline\)/)
  wide.props.onClick()
  assert.deepEqual(opened, ['devices'])

  const rail = render(DevicesStrip, { multiDevice, actions: { openSettings: () => {} }, wide: false })
  assert.equal(texts(rail).includes('1'), true)
  assert.match(rail.props['aria-label'], /1 of 2 online/)
})

test('the sidebar strip stays out when multi-device is off or unavailable', () => {
  assert.equal(DevicesStrip({ multiDevice: { available: true, enabled: false, nodes: [] }, actions: {} }), null)
  assert.equal(DevicesStrip({ multiDevice: { available: false, enabled: true, nodes: [] }, actions: {} }), null)
  const none = render(DevicesStrip, { multiDevice: { available: true, enabled: true, nodes: [] }, actions: {}, wide: true })
  assert.ok(texts(none).includes('Devices · no machines paired'))
})

test('a session link is direct on the LAN and a port forward on loopback', () => {
  const direct = sharedSessionLink('http://192.168.1.5:3080')
  assert.equal(direct.kind, 'url')
  assert.equal(direct.url, 'http://192.168.1.5:3080')
  const loopback = sharedSessionLink('http://127.0.0.1:3080')
  assert.equal(loopback.kind, 'forward')
  assert.equal(loopback.port, '3080')
  assert.equal(loopback.command, 'ssh -L 3080:127.0.0.1:3080 <user>@<this-machine>')
  assert.equal(sharedSessionLink('http://localhost:3080').kind, 'forward')
  assert.equal(sharedSessionLink('http://[::1]:3080').kind, 'forward')
  assert.equal(sharedSessionLink('').kind, 'none')
  assert.equal(sharedSessionLink('not a url').kind, 'none')
  assert.equal(sharedSessionLink(undefined).kind, 'none')
})

test('the sidebar strip copies the shared address', async () => {
  copied.length = 0
  const multiDevice = {
    available: true,
    enabled: true,
    nodes: [{ id: 'nd_1', name: 'win-pc', online: true }],
    hub: { webUrl: 'http://192.168.1.5:3080' },
  }
  const tree = render(DevicesStrip, { multiDevice, actions: {}, wide: true })
  const [, copy] = tree.props.children
  assert.equal(copy.props['aria-label'], 'Copy session link')
  copy.props.onClick()
  await Promise.resolve()
  assert.deepEqual(copied, ['http://192.168.1.5:3080'])

  // A loopback server has no address another machine can open, so there is no copy button.
  const local = render(DevicesStrip, { multiDevice: { ...multiDevice, hub: { webUrl: 'http://127.0.0.1:3080' } }, actions: {}, wide: true })
  assert.equal(local.type, 'button')
})

test('joining asks first: no request is sent until the user replaces the team', async () => {
  const status = { available: true, enabled: false, hub: { state: 'off' }, nodes: [], requests: [], node: { paired: false } }
  const joined = []
  const actions = {
    multiDeviceStatus: () => Promise.resolve(status),
    multiDeviceScan: () => Promise.resolve({ hubs: [] }),
    multiDeviceJoin: url => { joined.push(url); return Promise.resolve(status) },
  }
  const mounted = mount({ roster: { multiDevice: status }, actions, run: promise => promise, Section: Frame, Row: Frame, Switch })
  // The address is the same field a machine with no discovery uses.
  findButton(mounted.tree, 'Advanced').props.onClick()
  let tree = mounted.again()
  findInput(tree).props.onChange({ target: { value: 'http://192.168.1.9:8787' } })
  tree = mounted.again()
  findButton(tree, 'Join').props.onClick()
  tree = mounted.again()

  const asked = texts(tree)
  assert.ok(asked.includes('Join 192.168.1.9:8787?'))
  assert.ok(asked.includes("This computer's Bots, memory and settings are replaced by the hub's. They are backed up first."))
  assert.deepEqual(buttons(tree).filter(label => label === 'Replace and join' || label === 'Cancel'), ['Replace and join', 'Cancel'])
  assert.deepEqual(joined, [], 'nothing is sent before the second button')

  // Cancel closes the question and sends nothing at all.
  findButton(tree, 'Cancel').props.onClick()
  tree = mounted.again()
  assert.equal(texts(tree).some(text => text.startsWith('Join 192.168.1.9')), false)
  assert.deepEqual(joined, [])

  // The second button is the one that joins.
  findButton(tree, 'Join').props.onClick()
  tree = mounted.again()
  await findButton(tree, 'Replace and join').props.onClick()
  assert.deepEqual(joined, ['http://192.168.1.9:8787'])
})

test('a machine that waits to join is shown even when the hub is not listening yet', () => {
  const request = { id: 'jr_1', name: 'mac-mini', hostname: 'Mac.lan', os: 'darwin', status: 'pending' }
  // The seconds after the switch is turned on: the hub is still binding.
  const starting = page({
    multiDevice: {
      available: true,
      enabled: true,
      hub: { state: 'starting' },
      nodes: [],
      requests: [request],
      node: { paired: false },
    },
  })
  assert.ok(texts(starting).includes('Waiting to join · 1'))
  assert.ok(texts(starting).includes('mac-mini wants to join'))
  assert.deepEqual(buttons(starting).filter(label => label === 'Allow' || label === 'Deny'), ['Allow', 'Deny'])

  // A hub whose switch is off still has to answer the machine that asked.
  const off = page({
    multiDevice: { available: true, enabled: false, hub: { state: 'off' }, nodes: [], requests: [request], node: { paired: false } },
  })
  assert.ok(texts(off).includes('mac-mini wants to join'))
})

test('a joined machine shows where its team was backed up', () => {
  const backup = 'C:\\Users\\me\\.ds-bot\\multi-device\\backups\\join-2026-11-08T10-30-00-000Z'
  const tree = page({
    multiDevice: {
      available: true,
      enabled: false,
      hub: { state: 'off' },
      nodes: [],
      node: { paired: true, hubName: 'Mac mini', hubUrl: 'http://192.168.1.5:8787', online: true, backup },
    },
  })
  assert.ok(texts(tree).includes('Backup'))
  assert.ok(texts(tree).includes(backup))
})
