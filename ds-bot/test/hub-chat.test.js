import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The hub chat view: components run as plain functions over a react stand-in whose
// useState/useRef keep state across renders, so the send path (which keeps an
// idempotency key until the send succeeds) is testable.
const { outputFiles } = await build({
  stdin: {
    contents: "export { HubChat, hubRows, applyHubReply, prependEarlier, HUB_CHAT_CSS } from './src/client/hub-chat.js'\nexport { conversationLeft } from './src/client/frame-layout.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let stateCells = []
let refCells = []
let effectCells = []
let stateAt = 0
let refAt = 0
let intervalCallbacks = []
const beginRender = () => { stateAt = 0; refAt = 0; effectCells = [] }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'Fragment',
  useState(initial) {
    const at = stateAt += 1
    if (stateCells[at] === undefined) stateCells[at] = typeof initial === 'function' ? initial() : initial
    return [stateCells[at], next => { stateCells[at] = typeof next === 'function' ? next(stateCells[at]) : next }]
  },
  useRef(initial) {
    const at = refAt += 1
    if (refCells[at] === undefined) refCells[at] = { current: initial }
    return refCells[at]
  },
  useCallback: fn => fn,
  useEffect: fn => { effectCells.push(fn) },
  useLayoutEffect: fn => { effectCells.push(fn) },
  useMemo: make => make(),
  useContext: ctx => ctx?.value,
  // deep-view's ViewUi.Provider sets its value and renders its children.
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useId: () => 'dv-id',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const require = (name) => {
  const platform = { react, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: 'MarkdownText' } }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require,
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length }, clearInterval: () => {},
  Intl, Date, URL, URLSearchParams, TextEncoder,
})
const { HubChat, hubRows, applyHubReply, prependEarlier, HUB_CHAT_CSS, conversationLeft } = module.exports

// A fresh component instance: state, refs, effects and timers reset, indices begin at zero.
const fresh = () => { stateCells = []; refCells = []; effectCells = []; intervalCallbacks = [] }

const minimalActions = () => ({
  hubChat: () => new Promise(() => {}),
  hubSend: () => new Promise(() => {}),
  hubEarlier: () => new Promise(() => {}),
  closeHubChat: () => {},
})

// Render the component once; stateCells/refCells persist across renders of one instance.
const renderHubChat = (over = {}) => {
  beginRender()
  return HubChat({ id: 'b', kind: 'bot', name: 'Chief', left: 0, actions: minimalActions(), ...over })
}
// Run the poll effect (refresh + interval) once.
const flushEffects = () => { const run = effectCells.splice(0); for (const fn of run) fn() }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// Evaluate function components on the way down, then test or collect a node. A view
// card's own components may return null for an unsupported node; those contribute nothing.
const find = (node, match) => {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found } return null }
  if (node === null || node === undefined || typeof node !== 'object') return null
  let current = node
  while (typeof current?.type === 'function') current = current.type(current.props)
  if (current === null || current === undefined || typeof current !== 'object') return null
  if (match(current)) return current
  for (const child of current?.children ?? []) { const found = find(child, match); if (found) return found }
  return null
}
const collect = (node, match, out = []) => {
  if (Array.isArray(node)) { for (const child of node) collect(child, match, out); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  let current = node
  while (typeof current?.type === 'function') current = current.type(current.props)
  if (current === null || current === undefined || typeof current !== 'object') return out
  if (match(current)) out.push(current)
  for (const child of current?.children ?? []) collect(child, match, out)
  return out
}

const sendButton = tree => find(tree, node => node.type === 'button' && String(node.props.className ?? '').split(' ').includes('bt-hub-send'))
const composer = tree => find(tree, node => node.type === 'textarea')
// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))

test('the hub conversation starts after the sidebar, in every mode', () => {
  assert.equal(conversationLeft({ viewport: 1280, sidebarWidth: 280, pref: 'open' }), 280)
  assert.equal(conversationLeft({ viewport: 1280, sidebarWidth: 360, pref: 'rail' }), 88)
  assert.equal(conversationLeft({ viewport: 1280, sidebarWidth: 280, pref: 'hidden' }), 0)
  // A drawer floats over the rail's place, so the chat starts at the rail width.
  assert.equal(conversationLeft({ viewport: 700, sidebarWidth: 320, pref: 'open', drawer: true }), 88)
})

test('the hub chat CSS keeps the sidebar clear instead of pinning the whole viewport', () => {
  assert.match(HUB_CHAT_CSS, /\.bt-hub\{[^}]*left:var\(--bt-hub-left/)
  assert.doesNotMatch(HUB_CHAT_CSS, /inset:0/)
  assert.doesNotMatch(HUB_CHAT_CSS, /z-index:400/)
  // Below the sidebar's own layer (25), so a floating drawer stays above and clickable.
  assert.match(HUB_CHAT_CSS, /z-index:20/)
})

test('HubChat places its root at the conversation area with the left prop', () => {
  fresh()
  const tree = renderHubChat({ left: 280 })
  assert.equal(tree.props.style['--bt-hub-left'], '280px')
})

test('a double submit sends one message with one idempotency key', () => {
  fresh()
  const sent = []
  const actions = minimalActions()
  actions.hubSend = (_id, _kind, text, messageId) => { sent.push({ text, messageId }); return new Promise(() => {}) }
  let tree = renderHubChat({ actions })
  composer(tree).props.onChange({ target: { value: 'hi' } })
  tree = renderHubChat({ actions })
  sendButton(tree).props.onClick()
  // The send is in flight; a repeated Enter or click sends nothing more.
  tree = renderHubChat({ actions })
  assert.equal(sendButton(tree).props.disabled, true)
  sendButton(tree).props.onClick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'hi')
  assert.ok(sent[0].messageId)
})

test('a failed send keeps its id so the retry writes once', async () => {
  fresh()
  const sent = []
  const actions = minimalActions()
  actions.hubSend = (_id, _kind, text, messageId) => { sent.push({ text, messageId }); return Promise.reject(new Error('offline')) }
  let tree = renderHubChat({ actions })
  composer(tree).props.onChange({ target: { value: 'hi' } })
  tree = renderHubChat({ actions })
  sendButton(tree).props.onClick()
  await flush()
  tree = renderHubChat({ actions })
  // The message was not sent: the text is back for the retry.
  assert.equal(composer(tree).props.value, 'hi')
  sendButton(tree).props.onClick()
  await flush()
  assert.equal(sent.length, 2)
  assert.ok(sent[0].messageId)
  assert.equal(sent[0].messageId, sent[1].messageId)
})

test('the optimistic send stands in for its message and yields to the hub copy', () => {
  assert.deepEqual(plain(hubRows([], { messageId: 'm1', text: 'hi' })), [{ id: 'm1', kind: 'user', text: 'hi', pending: true }])
  const server = [{ id: 's1', kind: 'user', text: 'hi' }]
  assert.deepEqual(plain(hubRows(server, { messageId: 'm1', text: 'hi' })), server)
  // A Bot reply with the same text is not the hub's copy of this message.
  assert.equal(hubRows([{ id: 's1', kind: 'bot', text: 'hi' }], { messageId: 'm1', text: 'hi' }).length, 2)
})

test('an unchanged reply keeps the items and advances the cursor', () => {
  const held = { offline: false, items: [{ id: 'a', kind: 'user', text: 'hi' }] }
  const next = applyHubReply(held, { unchanged: true, offline: false, epoch: 'e1', revision: 7 })
  assert.deepEqual(next.view.items, held.items)
  assert.deepEqual(plain(next.cursor), { epoch: 'e1', revision: 7 })
})

test('a full reply replaces the items and an offline reply keeps its flag', () => {
  assert.deepEqual(plain(applyHubReply(null, { epoch: 'e1', revision: 3, offline: false, items: [{ id: 'a' }] }).view), { offline: false, items: [{ id: 'a' }], earlier: null, approvals: [] })
  assert.deepEqual(plain(applyHubReply({ offline: false, items: [] }, { unchanged: true, offline: true, epoch: 'e1', revision: 3 }).view), { offline: true, items: [], earlier: null, approvals: [] })
})

test('the poll sends the cursor it received so an unchanged reply stays cheap', async () => {
  fresh()
  const calls = []
  const actions = minimalActions()
  actions.hubChat = (_id, _kind, cursor) => {
    calls.push(cursor)
    return Promise.resolve({ offline: false, epoch: 'e1', revision: 5, items: [{ id: 'a', kind: 'user', text: 'hi' }] })
  }
  renderHubChat({ actions })
  flushEffects()
  await flush()
  assert.deepEqual(plain(calls[0]), null)
  // The interval's next tick carries the cursor the first reply named.
  intervalCallbacks[0]()
  await flush()
  assert.deepEqual(plain(calls[1]), { epoch: 'e1', revision: 5 })
})

test('offline disables the composer and the send button', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: true, epoch: 'e1', revision: 1, items: [] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  assert.equal(composer(tree).props.disabled, true)
  assert.equal(sendButton(tree).props.disabled, true)
})

test('a Bot reply renders through the shared markdown helper', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [{ id: 'a', kind: 'bot', text: '**done**' }] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const marks = collect(tree, node => node.type === 'MarkdownText')
  assert.equal(marks.length, 1)
  assert.equal(marks[0].props.text, '**done**')
})

test('a settled question, a closed view and an answered question render read-only', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [
    { id: 'q1', kind: 'closed', question: { question: 'Approve?', options: ['Yes', 'No'] }, closed: 'dismissed' },
    { id: 'v1', kind: 'closed', view: {}, title: 'A report', closed: 'dismissed' },
    { id: 'a1', kind: 'answer', questions: [{ id: 'q2', question: 'Which?', options: ['A', 'B'] }], answers: [{ id: 'q2', selected: ['A'] }] },
  ] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const settled = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').split(' ').includes('bt-q-settled'))
  assert.equal(settled.length, 3, 'the closed question, closed view and answered question all render as settled cards')
  // The read-only card names the question, and its options are not live buttons.
  assert.equal(settled[0].props['aria-label'], 'Approve?')
  assert.equal(collect(tree, node => node.type === 'button' && String(node.props.className ?? '').includes('bt-q-opt')).length, 0, 'no live option buttons on a read-only card')
})

test('prependEarlier prepends an earlier page and de-dupes it by id', () => {
  const earlier = [{ id: 'a', kind: 'user', text: 'old' }, { id: 'b', kind: 'bot', text: 'reply' }]
  const held = [{ id: 'b', kind: 'bot', text: 'reply' }, { id: 'c', kind: 'user', text: 'new' }]
  assert.deepEqual(plain(prependEarlier(held, earlier)), [{ id: 'a', kind: 'user', text: 'old' }, { id: 'b', kind: 'bot', text: 'reply' }, { id: 'c', kind: 'user', text: 'new' }])
  assert.deepEqual(plain(prependEarlier(undefined, earlier)), earlier)
  assert.deepEqual(plain(prependEarlier(held, undefined)), held)
})

test('the Load earlier button appears when the reply carries a paging cursor', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, earlier: { part: 1, beforeSeq: 40 }, items: [{ id: 'a', kind: 'user', text: 'hi' }] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const button = find(tree, node => node.type === 'button' && String(node.props.className ?? '').includes('bt-hub-earlier-btn'))
  assert.ok(button, 'a Load earlier button is shown')
})

test('Load earlier prepends the returned page and calls the action once', async () => {
  fresh()
  const called = []
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, earlier: { beforeSeq: 10 }, items: [{ id: 'b', kind: 'user', text: 'new' }] })
  actions.hubEarlier = () => { called.push(1); return Promise.resolve({ items: [{ id: 'a', kind: 'user', text: 'old' }], cursor: null }) }
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const button = find(tree, node => node.type === 'button' && String(node.props.className ?? '').includes('bt-hub-earlier-btn'))
  button.props.onClick()
  await flush()
  tree = renderHubChat({ actions })
  assert.equal(called.length, 1)
  const rows = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').split(' ').includes('bt-umsg'))
  assert.equal(rows.length, 2, 'the earlier message is prepended before the tail')
})

test('a display-only view renders through the shared view card', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [
    { id: 'v1', kind: 'view', title: 'Progress', view: { type: 'metric', label: 'Progress', value: '70%' }, callId: 'c1' },
  ] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const inline = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').split(' ').includes('bt-q-inline'))
  assert.equal(inline.length, 1, 'the view renders as a card, not nothing')
})

test('group round events render as event lines', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [
    { id: 'r1', kind: 'relay', reply: { kind: 'done', botId: 'b1', name: 'Chief' } },
    { id: 'r2', kind: 'relay', reply: { kind: 'working', botId: 'b2', name: 'Writer' } },
  ] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const events = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('bt-event'))
  assert.equal(events.length, 2, 'each relay row renders one event line')
})

test('a pending approval renders interactively and a double click answers once', async () => {
  fresh()
  const answered = []
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [], approvals: [
    { id: 'ap1', botId: 'b1', botName: 'Chief', tool: 'run_on_device', reason: 'Run hostname?', detail: { text: 'hostname' }, answerable: true },
  ] })
  actions.hubApprovalAnswer = (id, choice) => { answered.push({ id, choice }); return new Promise(() => {}) }
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const allowButton = () => find(tree, node => node.type === 'button' && String(node.props.className ?? '').split(' ').includes('bt-aq-go'))
  let allow = allowButton()
  assert.ok(allow, 'an Allow once button is shown')
  allow.props.onClick()
  tree = renderHubChat({ actions })
  allow = allowButton()
  assert.equal(allow.props.disabled, true, 'the card is busy after the first click')
  allow.props.onClick()
  assert.equal(answered.length, 1, 'a double click forwards one request')
  assert.deepEqual(answered[0], { id: 'ap1', choice: 'allow' })
})

test('a pending question answers through the hub and a pending view renders', async () => {
  fresh()
  const answered = []
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [], question: { id: 'q1', question: 'Approve?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false } })
  actions.hubQuestionAnswer = (id, kind, questionId, answer) => { answered.push({ id, questionId, answer }); return Promise.resolve({ ok: true }) }
  actions.hubQuestionDismiss = () => Promise.resolve({ ok: true })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const option = find(tree, node => node.type === 'button' && String(node.props.className ?? '').split(' ').includes('bt-q-opt'))
  assert.ok(option, 'the pending question renders its options')
  option.props.onClick()
  await flush()
  assert.equal(answered.length, 1, 'choosing an option forwards the answer to the hub')
  assert.equal(answered[0].questionId, 'q1')
  assert.equal(answered[0].answer.selected[0], 'Yes')
})

test('a pending view answers through the hub', async () => {
  fresh()
  const answered = []
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [], view: { id: 'v1', title: 'Pick', view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] } } })
  actions.hubViewAnswer = (id, kind, viewId, action, values) => { answered.push({ viewId, action, values }); return Promise.resolve({ ok: true }) }
  actions.hubViewDismiss = () => Promise.resolve({ ok: true })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const view = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('bt-q-inline'))
  assert.equal(view.length, 1, 'the pending view renders as a card')
})

test('a settled answer card stays read-only with no live buttons', async () => {
  fresh()
  const actions = minimalActions()
  actions.hubChat = () => Promise.resolve({ offline: false, epoch: 'e1', revision: 1, items: [
    { id: 'a1', kind: 'answer', questions: [{ id: 'q2', question: 'Which?', options: ['A', 'B'] }], answers: [{ id: 'q2', selected: ['A'] }] },
    { id: 'c1', kind: 'closed', question: { question: 'Gone?', options: ['Yes'] }, closed: 'dismissed' },
  ] })
  let tree = renderHubChat({ actions })
  flushEffects()
  await flush()
  tree = renderHubChat({ actions })
  const settled = collect(tree, node => node.type === 'div' && String(node.props.className ?? '').split(' ').includes('bt-q-settled'))
  assert.equal(settled.length, 2, 'the answered question and the closed question render settled')
  assert.equal(collect(tree, node => node.type === 'button' && String(node.props.className ?? '').includes('bt-q-opt')).length, 0, 'no live option buttons on a settled card')
})
