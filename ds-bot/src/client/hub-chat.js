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
export function applyHubReply(view, reply) {
  const cursor = typeof reply?.epoch === 'string' ? { epoch: reply.epoch, revision: reply.revision } : null
  const offline = reply?.offline === true
  if (reply?.unchanged === true) {
    return { view: { ...(view ?? { items: [] }), offline }, cursor }
  }
  return { view: { offline, items: Array.isArray(reply?.items) ? reply.items : [] }, cursor }
}

// A reply's markdown, through the same renderer the main conversation uses.
function Text({ text }) {
  return h(MarkdownText, { text: String(text ?? ''), variant: 'compact', labels: mdLabels() })
}

// A conversation item the hub served: a user message, a Bot reply, a group post, an
// event line or a divider. Rendered with the same markdown helper the live view uses;
// the rich cells belong to the live DSH view and are not needed for a node's replica.
function Row({ item }) {
  const kind = item?.kind
  if (kind === 'divider') {
    return h('div', { className: 'bt-hub-divider' }, item.time ? new Date(item.time).toLocaleTimeString() : '')
  }
  if (kind === 'event') {
    return h('div', { className: 'bt-hub-event' }, `${item.role ?? ''} · ${item.name ?? ''}`.trim())
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
  return null
}

export function HubChat({ id, kind, name, left, actions }) {
  const [view, setView] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  // The replica's cursor, sent back so an unchanged poll answers without the item list.
  const cursorRef = useRef(null)
  // The view the last apply produced, kept beside the state so a reply applies against
  // the freshest items without re-subscribing the poll to them.
  const viewRef = useRef(null)
  const listRef = useRef(null)

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
    list.scrollTop = list.scrollHeight
  }, [view?.items?.length, pending])

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

  return h('div', { className: 'bt-hub', role: 'region', 'aria-label': t('Hub conversation'), style: { '--bt-hub-left': `${left}px` } },
    h('div', { className: 'bt-hub-head' },
      h('div', { className: 'bt-hub-title' },
        h('span', { className: 'bt-hub-name' }, name ?? (kind === 'room' ? 'Group' : 'Bot')),
        h('span', { className: 'bt-hub-badge' }, t('Hub'))),
      offline ? h('span', { className: 'bt-hub-offline' }, t('Offline — messages are not sent')) : null,
      h('button', { type: 'button', className: 'bt-hub-close', 'aria-label': t('Close'), onClick: () => actions.closeHubChat() }, h(CloseIcon))),
    h('div', { className: 'bt-hub-body', ref: listRef },
      error === null ? null : h('div', { className: 'bt-hub-error' }, error),
      offline && items.length === 0 ? h('div', { className: 'bt-hub-empty' }, t('This computer is not connected to the hub.')) : null,
      items.map((item, index) => h(Row, { key: itemKey(item, index), item }))),
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
.bt-hub-empty{align-self:center;margin:auto;font-size:13px;color:var(--bt-ink-2)}
.bt-hub-error{align-self:center;font-size:13px;color:var(--bt-danger)}
.bt-hub-composer{display:flex;align-items:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--bt-line)}
.bt-hub-input{flex:1;min-width:0;resize:none;padding:9px 12px;border-radius:12px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:14px;line-height:20px;max-height:120px}
.bt-hub-send{flex:none;padding:9px 16px;border-radius:12px;border:0;background:var(--bt-accent);color:var(--bt-main);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.bt-hub-send:disabled{opacity:.5;cursor:default}
`