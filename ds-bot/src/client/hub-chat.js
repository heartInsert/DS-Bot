// The hub conversation a joined node shows in its own chat view. While this computer is
// a node, the normal DSH Session for a hub Bot or group is empty here; the conversation
// lives on the hub. This view reads the hub's replica through the node's worker and
// sends back through the one writer, so a Bot or a group chat opens as the hub's live
// conversation instead of a second, local one.
//
// It sits in the normal conversation area — not over the sidebar — so the user can keep
// switching Bots and group chats in the sidebar while it is open. Its poll sends the
// cursor of the replica it already holds, and the hub answers "unchanged" when nothing
// has moved, so the poll stays cheap.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { CloseIcon } from './icons.js'
import { SettledQuestion, PendingQuestion } from './questions.js'
import { AnsweredReply, WidgetCell, PendingView } from './widget-cell.js'
import { ApprovalCard } from './approval-queue.js'
import { t } from './i18n.js'

const POLL_MS = 1000

let messageSeq = 0
// A client id for a message the user is sending. It is kept for retries of that message
// until the send succeeds — the hub dedupes on it — and a fresh one is made for the next.
const newMessageId = () => `msg-${(messageSeq += 1)}-${Math.random().toString(36).slice(2, 8)}`

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

function itemKey(item, index) {
  return item?.id ?? `${item?.kind ?? 'item'}:${item?.seq ?? index}`
}

// The items to draw: the hub's list, with an optimistic send standing in for its message
// until the hub's own copy arrives. Keyed by the client's message id, so the same message
// is never drawn twice.
export function hubRows(items, pending) {
  const list = Array.isArray(items) ? items : []
  if (pending === null || pending === undefined) return list
  if (list.some(item => item?.kind === 'user' && item.text === pending.text)) return list
  return [...list, { id: pending.messageId, kind: 'user', text: pending.text, pending: true }]
}

// How a hub-chat reply updates the held view. A full answer replaces the items and
// advances the cursor; an "unchanged" answer carries no items and only refreshes the
// online flag, so the poll stays cheap. The cursor is null until a reply names an epoch.
// `earlier` is the paging cursor for "Load earlier"; it rides the snapshot so the view
// knows whether more history exists.
export function applyHubReply(view, reply) {
  const cursor = typeof reply?.epoch === 'string' ? { epoch: reply.epoch, revision: reply.revision } : null
  const earlier = reply?.earlier ?? null
  const offline = reply?.offline === true
  const cards = { approvals: Array.isArray(reply?.approvals) ? reply.approvals : [], ...(reply?.question === undefined ? {} : { question: reply.question }), ...(reply?.view === undefined ? {} : { view: reply.view }) }
  if (reply?.unchanged === true) {
    return { view: { ...(view ?? { items: [] }), offline, earlier: view?.earlier ?? earlier, ...cards }, cursor }
  }
  return { view: { offline, items: Array.isArray(reply?.items) ? reply.items : [], earlier, ...cards }, cursor }
}

// Prepend an earlier page to the held items, de-duped by the stable id every item
// carries, so a page that overlaps the tail never doubles a message.
export function prependEarlier(items, earlierItems) {
  const current = Array.isArray(items) ? items : []
  const incoming = Array.isArray(earlierItems) ? earlierItems : []
  const seen = new Set()
  const out = []
  for (const item of incoming) {
    if (item?.id === undefined || !seen.has(item.id)) {
      out.push(item)
      if (item?.id !== undefined) seen.add(item.id)
    }
  }
  for (const item of current) {
    if (item?.id === undefined || !seen.has(item.id)) {
      out.push(item)
      if (item?.id !== undefined) seen.add(item.id)
    }
  }
  return out
}

// A reply's markdown, through the same renderer the main conversation uses.
function Text({ text }) {
  return h(MarkdownText, { text: String(text ?? ''), variant: 'compact', labels: mdLabels() })
}

// A group round's non-message row, read-only: the same event text the live group chat
// draws for a reply, without the click that opens member details or the approval card.
function relayLabel(reply) {
  const name = reply?.name ?? reply?.botId ?? 'Bot'
  switch (reply?.kind) {
    case 'failed': return t('{name} stopped: {reason}. Switch its model or ask it to go on.', { name, reason: reply.text ?? reply.code ?? '' })
    case 'lookup': return reply.text ? t('{name} looked up its own chat for “{text}”', { name, text: reply.text }) : t('{name} looked up its own chat', { name })
    case 'missed': return t("{name} didn't answer in time", { name })
    case 'admin-passed': return t('{name} did not answer or call anyone; call a member with @Name', { name })
    case 'paused': return reply.idle
      ? t('{names} went back and forth {count} times without progress and paused. Write here to go on', { count: reply.count, names: [name, ...(reply.names ?? [])].join(t(' and ')) })
      : t('Paused after {count} Bot relays. Waiting: {names}', { count: reply.count, names: (reply.names ?? []).join(t(' and ')) })
    case 'resumed': return t('{name} was cut off by a restart and picked its work back up', { name })
    case 'cut': return t('{name} was cut off by a restart again and stopped', { name })
    case 'approval': return t('{name} paused for your approval', { name })
    case 'working': return t('{name} started on it', { name })
    case 'folder': return reply.text ?? ''
    case 'stopped': return t("You stopped {name}'s work", { name })
    case 'done': return t('{name} finished its work', { name })
    default: return null
  }
}

// A conversation item the hub served: a user message, a Bot reply, a group post, an
// event line or a divider. Settled question, view and answer cards reuse the same
// components the main conversation draws for history; the live cards (approvals,
// pending question, pending view) ride the snapshot beside the items, not inside them.
function Row({ item }) {
  const kind = item?.kind
  if (kind === 'divider') {
    return h('div', { className: 'bt-hub-divider' }, item.time ? new Date(item.time).toLocaleTimeString() : '')
  }
  if (kind === 'event') {
    const name = item.name ?? 'Bot'
    if (item.role === 'report') return h('div', { className: 'bt-hub-event' }, `${t('Replies from')} ${t('a group chat')}`)
    const prefix = { stopped: t('Stopped by'), reply: t('Reply from') }[item.role] ?? t('Message from')
    return h('div', { className: 'bt-hub-event' }, `${prefix} ${name}`)
  }
  if (kind === 'post') {
    const texts = Array.isArray(item.texts) && item.texts.length > 0 ? item.texts : [item.text]
    return h('div', { className: 'bt-hub-row bt-hub-bot' },
      h('div', { className: 'bt-hub-who' }, item.name ?? 'Bot'),
      h('div', { className: 'bt-hub-bubble' }, texts.map((text, index) => h(Text, { key: index, text }))))
  }
  if (kind === 'bot') {
    return h('div', { className: 'bt-hub-row bt-hub-bot' },
      h('div', { className: 'bt-hub-bubble' }, h(Text, { text: item.text })))
  }
  if (kind === 'user') {
    return h('div', { className: 'bt-hub-row bt-hub-user', 'data-pending': item.pending === true || undefined },
      h('div', { className: 'bt-hub-bubble' }, h(Text, { text: item.text })))
  }
  // A group round's event line, drawn like the main group conversation reads it.
  if (kind === 'relay') {
    const label = relayLabel(item.reply)
    return label === null ? null : h('div', { className: 'bt-hub-event' }, label)
  }
  // A question, view or handoff answered by a message: the settled card, read-only.
  if (kind === 'answer') {
    return h(AnsweredReply, { node: { data: item } })
  }
  // A display-only show_view replays from the blueprint the host kept on the call.
  if (kind === 'view') {
    return h(WidgetCell, { callId: item.callId, args: { text: name => name === 'title' ? item.title : undefined, value: name => name === 'view' ? item.view : undefined }, done: true, isError: false, roster: {}, actions: {} })
  }
  // A question or view card closed without an answer on it: the settled card, read-only.
  if (kind === 'closed') {
    if (item.question !== undefined) {
      return h('div', { className: 'bt-hub-card' }, h(SettledQuestion, { question: item.question, closed: item.closed }))
    }
    if (item.view !== undefined) {
      return h('div', { className: 'bt-hub-card' }, h(SettledQuestion, { question: { question: item.title || t('View') }, closed: item.closed }))
    }
  }
  return null
}

export function HubChat({ id, kind, name, left, actions }) {
  const [view, setView] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  // An approval the hub no longer holds (answered elsewhere, expired): its card stays
  // here with the reason instead of being answered, so a stale answer reads clearly.
  const [approvalErrors, setApprovalErrors] = useState({})
  // The replica's cursor, sent back so an unchanged poll answers without the item list.
  const cursorRef = useRef(null)
  // The view the last apply produced, kept beside the state so a reply applies against
  // the freshest items without re-subscribing the poll to them.
  const viewRef = useRef(null)
  const listRef = useRef(null)
  // How far from the top the reader is, set before an earlier page is prepended so the
  // scroll position can be restored after the content above grows.
  const anchorRef = useRef(null)

  const refresh = useCallback(() => {
    const cursor = cursorRef.current
    void Promise.resolve(actions.hubChat(id, kind, cursor)).then(reply => {
      const next = applyHubReply(viewRef.current, reply)
      if (next.cursor !== null) cursorRef.current = next.cursor
      viewRef.current = next.view
      setView(next.view)
    }, () => {
      const offline = { ...(viewRef.current ?? { items: [] }), offline: true }
      viewRef.current = offline
      setView(offline)
    })
  }, [id, kind, actions])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    // A page of earlier items was prepended: keep the content the reader was on in
    // place instead of jumping to the bottom. Otherwise a new message scrolls to it.
    if (anchorRef.current !== null) {
      list.scrollTop = list.scrollHeight - anchorRef.current
      anchorRef.current = null
    } else {
      list.scrollTop = list.scrollHeight
    }
  }, [view?.items?.length, pending])

  const loadEarlier = () => {
    if (loadingEarlier) return
    setLoadingEarlier(true)
    setError(null)
    const list = listRef.current
    if (list !== null) anchorRef.current = list.scrollHeight - list.scrollTop
    void Promise.resolve(actions.hubEarlier(id, kind)).then(reply => {
      const earlierItems = Array.isArray(reply?.items) ? reply.items : []
      const merged = prependEarlier(viewRef.current?.items, earlierItems)
      const next = { ...(viewRef.current ?? { items: [] }), items: merged, earlier: reply?.cursor ?? null }
      viewRef.current = next
      setView(next)
      setLoadingEarlier(false)
    }, reason => {
      setLoadingEarlier(false)
      setError(reason?.message ?? String(reason))
    })
  }

  const send = () => {
    const value = text.trim()
    if (value === '' || sending) return
    // A message the user is retrying keeps the id the hub already saw for it.
    const messageId = pending !== null ? pending.messageId : newMessageId()
    setPending({ messageId, text: value })
    setSending(true)
    setText('')
    setError(null)
    void Promise.resolve(actions.hubSend(id, kind, value, messageId)).then(() => {
      setSending(false)
      setPending(null)
      refresh()
    }, reason => {
      setSending(false)
      setError(reason?.message ?? String(reason))
      // The message was not sent: put the text back so a retry reuses the same id.
      setText(value)
    })
  }

  const items = hubRows(view?.items, sending ? pending : null)
  const offline = view?.offline === true

  // The pending card's answer forwards through the hub, never against this node's own
  // (empty) Session: the node relays and the hub resolves, idempotently by card id.
  const cardActions = {
    answerApproval: (approvalId, choice) => actions.hubApprovalAnswer(approvalId, choice),
    reportApprovalFailure: (approval, failure) => setApprovalErrors(current => ({ ...current, [approval.id]: failure?.message ?? String(failure) })),
    dismissApproval: approval => setApprovalErrors(current => {
      const next = { ...current }
      delete next[approval.id]
      return next
    }),
    answerQuestion: (_sessionId, questionId, answer) => actions.hubQuestionAnswer(id, kind, questionId, answer),
    dismissQuestion: () => actions.hubQuestionDismiss(id, kind),
    answerView: (_sessionId, viewId, action, values) => actions.hubViewAnswer(id, kind, viewId, action, values),
    dismissView: () => actions.hubViewDismiss(id, kind),
    noteHeldCard: () => {},
  }

  const cards = [
    ...(view?.approvals ?? []).map(approval => h(ApprovalCard, {
      key: `approval-${approval.id}`,
      approval,
      bot: { id: approval.botId, name: approval.botName ?? 'Bot', color: 'gray' },
      actions: cardActions,
      error: approvalErrors[approval.id],
    })),
    ...(view?.question === undefined ? [] : [h(PendingQuestion, {
      key: `question-${view.question.id}`,
      sessionId: id,
      question: view.question,
      actions: cardActions,
      inline: true,
      enterToSend: true,
    })]),
    ...(view?.view === undefined ? [] : [h(PendingView, {
      key: `view-${view.view.id}`,
      sessionId: id,
      view: view.view,
      actions: cardActions,
      inline: true,
    })]),
  ]

  return h('div', { className: 'bt-hub', role: 'region', 'aria-label': t('Hub conversation'), style: { '--bt-hub-left': `${left}px` } },
    h('div', { className: 'bt-hub-head' },
      h('div', { className: 'bt-hub-title' },
        h('span', { className: 'bt-hub-name' }, name ?? (kind === 'room' ? 'Group' : 'Bot')),
        h('span', { className: 'bt-hub-badge' }, t('Hub'))),
      offline ? h('span', { className: 'bt-hub-offline' }, t('Offline — messages are not sent')) : null,
      h('button', { type: 'button', className: 'bt-hub-close', 'aria-label': t('Close'), onClick: () => actions.closeHubChat() }, h(CloseIcon))),
    h('div', { className: 'bt-hub-body', ref: listRef },
      view?.earlier ? h('div', { className: 'bt-hub-earlier' },
        h('button', { type: 'button', className: 'bt-hub-earlier-btn', disabled: loadingEarlier, onClick: loadEarlier }, loadingEarlier ? '…' : t('Load earlier'))) : null,
      error === null ? null : h('div', { className: 'bt-hub-error' }, error),
      offline && items.length === 0 ? h('div', { className: 'bt-hub-empty' }, t('This computer is not connected to the hub.')) : null,
      items.map((item, index) => h(Row, { key: itemKey(item, index), item })),
      cards.length === 0 ? null : h('div', { className: 'bt-hub-cards' }, cards)),
    h('div', { className: 'bt-hub-composer' },
      h('textarea', {
        className: 'bt-hub-input',
        value: text,
        disabled: offline || sending,
        placeholder: offline ? t('Offline') : t('Message'),
        rows: 1,
        onChange: event => setText(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        },
      }),
      h('button', { type: 'button', className: 'bt-hub-send', disabled: offline || sending || text.trim() === '', onClick: send }, sending ? '…' : t('Send'))))
}

export const HUB_CHAT_CSS = `
.bt-hub{position:fixed;top:var(--dsh-frame-chrome-top,0px);left:var(--bt-hub-left,0px);right:0;bottom:0;z-index:20;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink)}
.bt-hub-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:.5px solid var(--bt-line)}
.bt-hub-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.bt-hub-name{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-hub-badge{flex:none;font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2)}
.bt-hub-offline{flex:none;font-size:12px;color:var(--bt-danger)}
.bt-hub-close{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);cursor:pointer}
.bt-hub-close:hover{background:var(--bt-hover)}
.bt-hub-body{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.bt-hub-row{display:flex;flex-direction:column;gap:3px;max-width:72%}
.bt-hub-user{align-self:flex-end;align-items:flex-end}
.bt-hub-bot{align-self:flex-start;align-items:flex-start}
.bt-hub-who{font-size:11px;color:var(--bt-ink-2);padding:0 2px}
.bt-hub-bubble{padding:8px 12px;border-radius:12px;font-size:14px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-hub-user .bt-hub-bubble{background:var(--bt-accent);color:var(--bt-main)}
.bt-hub-bot .bt-hub-bubble{background:var(--bt-card);border:.5px solid var(--bt-line)}
.bt-hub-divider{align-self:center;font-size:11px;color:var(--bt-ink-3)}
.bt-hub-event{align-self:center;font-size:12px;color:var(--bt-ink-2)}
.bt-hub-card{flex:none;width:100%}
.bt-hub-cards{display:flex;flex-direction:column;gap:8px;flex:none}
.bt-hub-earlier{align-self:center;flex:none}
.bt-hub-earlier-btn{padding:6px 14px;border-radius:999px;border:0;background:var(--bt-hover);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-hub-earlier-btn:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-hub-earlier-btn:disabled{opacity:.5;cursor:default}
.bt-hub-empty{align-self:center;margin:auto;font-size:13px;color:var(--bt-ink-2)}
.bt-hub-error{align-self:center;font-size:13px;color:var(--bt-danger)}
.bt-hub-composer{display:flex;align-items:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--bt-line)}
.bt-hub-input{flex:1;min-width:0;resize:none;padding:9px 12px;border-radius:12px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:14px;line-height:20px;max-height:120px}
.bt-hub-send{flex:none;padding:9px 16px;border-radius:12px;border:0;background:var(--bt-accent);color:var(--bt-main);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.bt-hub-send:disabled{opacity:.5;cursor:default}
`