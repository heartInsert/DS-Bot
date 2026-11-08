// The node's card answers over the hub: the snapshot carries the pending approvals,
// question and view beside its items, and a device-token POST forwards an answer to the
// hub's existing answer paths. Every answer is idempotent by card id — a retry returns a
// clear result and changes nothing, an expired or already-resolved card is refused, and
// a node that cannot reach the hub refuses to send. Run against a fake team, as the other
// sync tests do, so the protocol is proven without DSH or a model key.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub } from '../src/host/multi-device/hub.js'
import { createSessionSync } from '../src/host/multi-device/session-sync.js'
import { createSessionClient } from '../src/host/multi-device/session-client.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-lan-cards-${name}-`))

// A Bot team with a group chat and the card state, without DSH. The card answer
// functions mirror channel.js: they resolve the Bot's chat part, claim the pending card
// before queueing, and refuse a card that is no longer open.
function fakeTeam() {
  const state = {
    bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's-b1' } },
    mainBotIds: ['b1'],
    rooms: { r1: { id: 'r1', name: 'Ops' } },
    questions: {},
    views: {},
  }
  const chats = new Map([['bot:b1', []], ['room:r1', []]])
  const sent = []
  const approvals = new Map()
  const approvalAnswers = []
  const answers = []
  let seq = 0
  const nextSeq = () => { seq += 1; return seq }
  const at = key => chats.get(key) ?? []
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  const sessionOf = botId => state.bots[botId]?.sessionId ?? botId
  return {
    state,
    sent,
    approvals,
    approvalAnswers,
    answers,
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    chatOf: botId => sessionOf(botId),
    own,
    async load() {},
    readOnly: () => undefined,
    async chatPage(botId) {
      return { sessionId: `s-${botId}`, items: at(`bot:${botId}`), cursor: null }
    },
    async roomPage(roomId) {
      return { sessionId: `s-${roomId}`, items: at(`room:${roomId}`), cursor: null }
    },
    async sendUser({ sessionId, content }) {
      const text = content[0].text
      sent.push({ sessionId, text })
      const key = state.rooms[sessionId] !== undefined ? `room:${sessionId}` : `bot:${sessionId}`
      at(key).push({ kind: 'user', text, seq: nextSeq() })
    },
    // Approvals are live DSH state: `approvalsView` lists them, `answerApproval`
    // resolves one. `answer` is stripped from the view, as approvals.js does.
    approvalsView: () => [...approvals.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined })),
    answerApproval(id, choice) {
      const entry = approvals.get(String(id ?? ''))
      if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
      const outcome = { allow: 'allowed-once', reject: 'rejected' }[choice]
      if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
      approvalAnswers.push({ id, choice })
      entry.answer(outcome)
      return undefined
    },
    async answerQuestion(botId, questionId, answer) {
      const question = own(state.questions, sessionOf(botId)) ? state.questions[sessionOf(botId)] : undefined
      if (question === undefined || question.id !== questionId) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
      if ((answer?.selected ?? []).length === 0 && typeof answer?.custom !== 'string') throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
      answers.push({ kind: 'question', id: questionId, answer })
      delete state.questions[sessionOf(botId)]
      return true
    },
    async dismissQuestion(botId) {
      if (own(state.questions, sessionOf(botId))) {
        answers.push({ kind: 'dismiss-question' })
        delete state.questions[sessionOf(botId)]
      }
      return true
    },
    async answerView(botId, viewId, action, values) {
      const view = own(state.views, sessionOf(botId)) ? state.views[sessionOf(botId)] : undefined
      if (view === undefined || view.id !== viewId) throw Object.assign(new Error('This view is no longer open'), { code: 'bot/stale' })
      answers.push({ kind: 'view', id: viewId, action, values })
      delete state.views[sessionOf(botId)]
      return true
    },
    async dismissView(botId) {
      if (own(state.views, sessionOf(botId))) {
        answers.push({ kind: 'dismiss-view' })
        delete state.views[sessionOf(botId)]
      }
      return true
    },
    // Seeders: a pending approval, question or view, and a cancel for an approval the
    // turn abandoned (an expired card, from the node's point of view).
    addApproval({ id = 'ap1', botId = 'b1', roomId } = {}) {
      const entry = { id, sessionId: sessionOf(botId), botId, ...(roomId === undefined ? {} : { roomId }), tool: 'run_on_device', reason: 'Run hostname?', detail: { text: 'hostname' }, at: Date.now() }
      entry.answer = () => { approvals.delete(id) }
      approvals.set(id, entry)
      return entry
    },
    addQuestion({ id = 'q1', botId = 'b1' } = {}) {
      const question = { id, question: 'Approve?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }
      state.questions[sessionOf(botId)] = question
      return question
    },
    addView({ id = 'v1', botId = 'b1' } = {}) {
      const view = { id, title: 'Pick', view: { type: 'options', id: 'pick', options: [{ label: 'A' }] } }
      state.views[sessionOf(botId)] = view
      return view
    },
  }
}

// A hub with a paired node and a session client, over a free port and no discovery, so
// the test never touches the UDP discovery port.
async function bench(t, team = fakeTeam()) {
  const sync = createSessionSync({ rt: team })
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, sessionSync: sync, discovery: false, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const response = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.issueCode().code, device: { name: 'node-a' } }),
  })
  const paired = await response.json()
  const client = createSessionClient({ hubUrl: hub.url, dataDir: folder('node'), token: paired.token, bot: 'main', pollMs: 100, waitMs: 200, log: () => {} })
  t.after(() => client.stop())
  return { hub, team, sync, token: paired.token, client }
}

const auth = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const post = (url, token, body) => fetch(url, { method: 'POST', headers: auth(token), body: JSON.stringify(body) })

test('a card endpoint requires a known device token', async t => {
  const { hub } = await bench(t)
  for (const path of ['/session/approval', '/session/question', '/session/view', '/session/question-dismiss', '/session/view-dismiss']) {
    const without = await fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    assert.equal(without.status, 401, `${path} without a token is refused`)
    const wrong = await post(`${hub.url}${path}`, 'not-a-token', {})
    assert.equal(wrong.status, 401, `${path} with an unknown token is refused`)
  }
})

test('the snapshot carries the pending approvals, question and view beside its items', async t => {
  const { hub, team, token } = await bench(t)
  team.addApproval({ id: 'ap1' })
  team.addQuestion({ id: 'q1' })
  team.addView({ id: 'v1' })
  const response = await fetch(`${hub.url}/session?bot=b1&wait=0`, { headers: auth(token) })
  assert.equal(response.status, 200)
  const snapshot = await response.json()
  assert.equal(snapshot.approvals.length, 1)
  assert.equal(snapshot.approvals[0].id, 'ap1')
  assert.equal(snapshot.approvals[0].botName, 'Chief')
  assert.equal(snapshot.question.id, 'q1')
  assert.equal(snapshot.view.id, 'v1')
})

test('a group approval belongs to its room, not to the Bot chat', async t => {
  const { hub, team, token } = await bench(t)
  team.addApproval({ id: 'room-ap', botId: 'b1', roomId: 'r1' })
  const room = await (await fetch(`${hub.url}/session?room=r1&wait=0`, { headers: auth(token) })).json()
  assert.equal(room.approvals.length, 1)
  assert.equal(room.approvals[0].id, 'room-ap')
  const bot = await (await fetch(`${hub.url}/session?bot=b1&wait=0`, { headers: auth(token) })).json()
  assert.equal(bot.approvals.length, 0)
})

test('an approval answer is idempotent by id', async t => {
  const { hub, team, token } = await bench(t)
  team.addApproval({ id: 'ap1' })
  const first = await post(`${hub.url}/session/approval`, token, { approvalId: 'ap1', choice: 'allow' })
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, duplicate: false, outcome: 'allowed-once', choice: 'allow', node: 'node-a' })
  assert.equal(team.approvals.size, 0)

  const retry = await post(`${hub.url}/session/approval`, token, { approvalId: 'ap1', choice: 'allow' })
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).duplicate, true, 'a second decision returns a clear duplicate and changes nothing')
  assert.equal(team.approvalAnswers.length, 1, 'the resolution ran once')
})

test('an approval already resolved elsewhere is refused', async t => {
  const { hub, team, token } = await bench(t)
  team.addApproval({ id: 'ap1' })
  team.answerApproval('ap1', 'reject') // the hub's own browser answered first
  const response = await post(`${hub.url}/session/approval`, token, { approvalId: 'ap1', choice: 'allow' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'This approval is no longer open' })
  assert.equal(team.approvalAnswers.length, 1, 'nothing ran again')
})

test('an expired approval is refused without change', async t => {
  const { hub, team, token } = await bench(t)
  const approval = team.addApproval({ id: 'ap1' })
  approval.answer() // the turn abandoned it: the card expired
  const response = await post(`${hub.url}/session/approval`, token, { approvalId: 'ap1', choice: 'reject' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'This approval is no longer open' })
  assert.equal(team.approvalAnswers.length, 0)
})

test('an unknown approval id is refused', async t => {
  const { hub, token } = await bench(t)
  const response = await post(`${hub.url}/session/approval`, token, { approvalId: 'never-existed', choice: 'allow' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'This approval is no longer open' })
})

test('a question answer forwards and is idempotent, and a card answered elsewhere is refused', async t => {
  const { hub, team, token } = await bench(t)
  team.addQuestion({ id: 'q1' })
  const first = await post(`${hub.url}/session/question`, token, { botId: 'b1', questionId: 'q1', answer: { selected: ['Yes'] } })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).ok, true)
  assert.equal(team.answers.length, 1)

  const retry = await post(`${hub.url}/session/question`, token, { botId: 'b1', questionId: 'q1', answer: { selected: ['Yes'] } })
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).duplicate, true)
  assert.equal(team.answers.length, 1, 'the answer ran once')

  // A question answered by the hub's own browser is no longer open to the node.
  team.addQuestion({ id: 'q2' })
  await team.answerQuestion('b1', 'q2', { selected: ['No'] })
  const stale = await post(`${hub.url}/session/question`, token, { botId: 'b1', questionId: 'q2', answer: { selected: ['Yes'] } })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), { error: 'This question is no longer open' })
})

test('a view answer forwards and a view dismiss removes the card', async t => {
  const { hub, team, token } = await bench(t)
  team.addView({ id: 'v1' })
  const answer = await post(`${hub.url}/session/view`, token, { botId: 'b1', viewId: 'v1', action: 'submit', values: { inputs: { pick: 'A' } } })
  assert.equal(answer.status, 200)
  assert.equal(team.answers[0].kind, 'view')

  team.addView({ id: 'v2' })
  const dismiss = await post(`${hub.url}/session/view-dismiss`, token, { botId: 'b1' })
  assert.equal(dismiss.status, 200)
  assert.equal(team.answers[1].kind, 'dismiss-view')
  assert.equal(team.state.views['s-b1'], undefined)
})

test('a node forwards an approval answer through its session client', async t => {
  const { team, client } = await bench(t)
  team.addApproval({ id: 'ap1' })
  const answer = await client.answerApproval('ap1', 'allow')
  assert.equal(answer.ok, true)
  assert.equal(answer.duplicate, false)
  assert.equal(answer.outcome, 'allowed-once')
  assert.equal(answer.choice, 'allow')
  assert.equal(team.approvalAnswers.length, 1)
})

test('an unreachable hub refuses the node\'s card answer', async t => {
  const dataDir = folder('node')
  const client = createSessionClient({ hubUrl: 'http://127.0.0.1:1', dataDir, token: 'unused', bot: 'main', pollMs: 100, waitMs: 200, log: () => {} })
  t.after(() => client.stop())
  await assert.rejects(client.answerApproval('ap1', 'allow'), error => error?.code === 'hub/offline')
})
