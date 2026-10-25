// Hermes Portal client. No framework: a small state object, one render per change,
// and a WebSocket for live turns. Markdown from the agent is sanitized before it
// ever touches the DOM.
import { marked } from './vendor/marked.js'
import DOMPurify from './vendor/purify.js'

const $app = document.getElementById('app')
const MEDIA = /^MEDIA:(\/[^\r\n]+)$/gm

const state = {
  me: null,
  sessions: [],
  filter: '',
  current: null, // { session, title, messages, requests, running }
  live: null, // { text, tools: [], reasoning }
  connected: true,
  view: 'chats', // chats | settings
  passkeys: [],
  files: [],
  error: '',
  menu: false,
  sending: false
}

// ── helpers ──────────────────────────────────────────────────────────────────

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  clip: '<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>'
}

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(text) {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

async function api(path, { method = 'GET', body, form } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} }
  if (form) {
    options.body = form
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(path, options)
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (response.status === 401 && path !== '/api/me') {
    state.me = { ...(state.me || {}), signed_in: false }
    render()
  }
  if (!response.ok) {
    throw new Error(data?.error || `request failed (${response.status})`)
  }
  return data
}

function markdown(text) {
  const html = marked.parse(String(text || ''), { gfm: true, breaks: false })
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] })
}

function fileUrl(path) {
  return `/api/file?session=${encodeURIComponent(state.current.session)}&path=${encodeURIComponent(path)}`
}

function renderMedia(text) {
  const parts = []
  for (const [, path] of String(text || '').matchAll(MEDIA)) {
    const url = fileUrl(path)
    const name = esc(path.split('/').pop())
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
      parts.push(`<a href="${url}" target="_blank" rel="noopener"><img class="media" src="${url}" alt="${name}"></a>`)
    } else if (/\.(mp3|m4a|ogg|wav|opus)$/i.test(path)) {
      parts.push(`<audio class="media" controls src="${url}"></audio>`)
    } else if (/\.(mp4|webm|mov)$/i.test(path)) {
      parts.push(`<video class="media" controls src="${url}"></video>`)
    } else {
      parts.push(`<a class="file" href="${url}" download>${icon('file')}${name}</a>`)
    }
  }
  return parts.join('')
}

function withoutMedia(text) {
  return String(text || '').replace(MEDIA, '').trim()
}

function relative(seconds) {
  const age = Date.now() / 1000 - seconds
  if (age < 86400) return 'today'
  if (age < 2 * 86400) return 'yesterday'
  if (age < 7 * 86400) return 'this week'
  if (age < 30 * 86400) return 'this month'
  return 'older'
}

// ── socket ───────────────────────────────────────────────────────────────────

let socket = null
let socketRetry = 1000

function connect() {
  if (socket && socket.readyState <= 1) return
  const url = new URL('/ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  socket = new WebSocket(url)
  socket.onopen = () => {
    socketRetry = 1000
    if (state.current) socket.send(JSON.stringify({ watch: state.current.session }))
  }
  socket.onmessage = event => onFrame(JSON.parse(event.data))
  socket.onclose = () => {
    socket = null
    if (!state.me?.signed_in) return
    setTimeout(connect, socketRetry)
    socketRetry = Math.min(socketRetry * 2, 15000)
  }
}

let listTimer = null
function refreshSoon() {
  clearTimeout(listTimer)
  listTimer = setTimeout(loadSessions, 400)
}

function onFrame(frame) {
  switch (frame.kind) {
    case 'hub.connected':
      state.connected = true
      loadSessions()
      if (state.current) openSession(state.current.session, { quiet: true })
      return render()
    case 'hub.disconnected':
      state.connected = false
      return render()
    case 'sessions.changed':
      return refreshSoon()
    case 'status': {
      const row = state.sessions.find(s => s.id === frame.session)
      if (row) row.status = frame.status
      if (state.current?.session === frame.session) state.current.status = frame.status
      return render()
    }
  }
  if (!state.current || frame.session !== state.current.session) return
  if (frame.kind === 'request') {
    state.current.requests = [...state.current.requests.filter(r => r.id !== frame.request.id), frame.request]
    render()
    return scrollDown()
  }
  if (frame.kind === 'request.closed') {
    state.current.requests = state.current.requests.filter(r => r.id !== frame.id)
    return render()
  }
  if (frame.kind !== 'event') return
  const payload = frame.payload || {}
  switch (frame.type) {
    case 'message.start':
      state.live = { text: '', tools: [], reasoning: false }
      state.current.running = true
      break
    case 'message.delta':
      state.live ??= { text: '', tools: [], reasoning: false }
      state.live.text += payload.text || ''
      break
    case 'reasoning.delta':
    case 'thinking.delta':
      state.live ??= { text: '', tools: [], reasoning: false }
      state.live.reasoning = true
      break
    case 'tool.start':
      state.live ??= { text: '', tools: [], reasoning: false }
      state.live.tools.push(toolLine(payload))
      break
    case 'message.interim':
    case 'message.complete':
      state.current.running = frame.type === 'message.interim'
      if (frame.type === 'message.complete') state.live = null
      else state.live = { text: '', tools: [], reasoning: false }
      openSession(state.current.session, { quiet: true })
      break
    case 'session.title':
      state.current.title = payload.title || state.current.title
      break
    case 'error':
      state.error = payload.message || 'something went wrong'
      break
  }
  scheduleLive()
}

function toolLine(payload) {
  const preview = String(payload.preview || payload.context || '').replace(/\s+/g, ' ').slice(0, 90)
  return `${payload.name || 'tool'}${preview ? ': ' + preview : ''}`
}

// Streamed deltas arrive many times a second; paint at most once per frame.
let livePending = false
function scheduleLive() {
  if (livePending) return
  livePending = true
  requestAnimationFrame(() => {
    livePending = false
    const nearBottom = isNearBottom()
    render()
    if (nearBottom) scrollDown()
  })
}

// ── data ─────────────────────────────────────────────────────────────────────

async function loadMe() {
  state.me = await api('/api/me')
}

async function loadSessions() {
  try {
    state.sessions = await api('/api/sessions')
    state.connected = true
  } catch (error) {
    if (/offline/i.test(error.message)) state.connected = false
  }
  render()
}

async function openSession(session, { quiet = false } = {}) {
  if (!quiet) {
    state.current = { session, title: titleOf(session), messages: [], requests: [], running: false, loading: true }
    state.live = null
    state.view = 'chats'
    state.menu = false
    history.replaceState(null, '', `#/c/${session}`)
    render()
  }
  socket?.readyState === 1 && socket.send(JSON.stringify({ watch: session }))
  try {
    const opened = await api(`/api/sessions/${encodeURIComponent(session)}`)
    if (state.current?.session !== session) return
    const keepLive = state.current.running && state.live
    state.current = { ...opened, title: opened.title || titleOf(session), loading: false }
    if (!opened.running && !keepLive) state.live = null
    render()
    if (!quiet) scrollDown()
  } catch (error) {
    state.error = error.message
    render()
  }
}

function titleOf(session) {
  return state.sessions.find(s => s.id === session)?.title || 'chat'
}

async function send(text) {
  const form = new FormData()
  form.set('text', text)
  for (const file of state.files) form.append('file', file, file.name)
  state.sending = true
  render()
  try {
    if (state.current) {
      await api(`/api/sessions/${encodeURIComponent(state.current.session)}/messages`, { method: 'POST', form })
      state.current.messages.push({ role: 'user', text, row_id: `pending-${Date.now()}` })
      state.current.running = true
      state.live ??= { text: '', tools: [], reasoning: false }
    } else {
      const created = await api('/api/sessions', { method: 'POST', form })
      await loadSessions()
      await openSession(created.session)
      state.current.running = true
      state.live = { text: '', tools: [], reasoning: false }
    }
    state.files = []
    clearDraft()
    return true
  } catch (error) {
    state.error = error.message
    return false
  } finally {
    state.sending = false
    render()
    scrollDown()
  }
}

// ── passkeys ─────────────────────────────────────────────────────────────────

async function register(setup) {
  const options = await api('/api/register/options', { method: 'POST', body: { setup } })
  const pk = options.publicKey
  const credential = await navigator.credentials.create({
    publicKey: {
      ...pk,
      challenge: unb64url(pk.challenge),
      user: { ...pk.user, id: unb64url(pk.user.id) },
      excludeCredentials: pk.excludeCredentials.map(c => ({ ...c, id: unb64url(c.id) }))
    }
  })
  await api('/api/register/finish', {
    method: 'POST',
    body: {
      challenge_id: options.challenge_id,
      label: deviceLabel(),
      credential: {
        id: b64url(credential.rawId),
        clientDataJSON: b64url(credential.response.clientDataJSON),
        attestationObject: b64url(credential.response.attestationObject)
      }
    }
  })
}

async function signIn() {
  const options = await api('/api/login/options', { method: 'POST' })
  const pk = options.publicKey
  const credential = await navigator.credentials.get({ publicKey: { ...pk, challenge: unb64url(pk.challenge) } })
  await api('/api/login/finish', {
    method: 'POST',
    body: {
      challenge_id: options.challenge_id,
      credential: {
        id: b64url(credential.rawId),
        clientDataJSON: b64url(credential.response.clientDataJSON),
        authenticatorData: b64url(credential.response.authenticatorData),
        signature: b64url(credential.response.signature)
      }
    }
  })
}

function deviceLabel() {
  const ua = navigator.userAgent
  if (/iPhone|iPad/.test(ua)) return 'iphone'
  if (/Android/.test(ua)) return 'android'
  if (/Mac/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return 'passkey'
}

// ── drafts survive reloads and switching chats ──────────────────────────────

function draftKey() {
  return `draft:${state.current?.session || 'new'}`
}

function clearDraft() {
  localStorage.removeItem(draftKey())
}

// ── rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!state.me) {
    $app.innerHTML = ''
    return
  }
  if (!state.me.signed_in) return renderGate()
  const keep = captureComposer()
  $app.innerHTML = `
    <div class="shell ${state.current || state.view === 'settings' ? 'chatting' : ''}">
      ${renderSide()}
      <main class="chat">${state.view === 'settings' ? renderSettings() : renderChat()}</main>
    </div>`
  restoreComposer(keep)
  bind()
}

function renderGate() {
  const setup = new URLSearchParams(location.hash.slice(1)).get('setup')
  const first = setup && !state.me.has_passkeys
  $app.innerHTML = `
    <div class="gate">
      <h1>Hermes</h1>
      <p>${setup ? 'Create a passkey on this device. It is the only way in.' : 'Sign in with your passkey.'}</p>
      <div><button class="primary" id="gate-go">${setup ? 'Create passkey' : 'Sign in'}</button></div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
    </div>`
  document.getElementById('gate-go').onclick = async () => {
    state.error = ''
    try {
      if (setup) await register(setup)
      else await signIn()
      history.replaceState(null, '', '/')
      await boot()
    } catch (error) {
      state.error = error.name === 'NotAllowedError' ? 'Cancelled.' : error.message
      renderGate()
    }
  }
  void first
}

function renderSide() {
  const filter = state.filter.trim().toLowerCase()
  const rows = state.sessions.filter(s => !filter || s.title.toLowerCase().includes(filter))
  const pinned = rows.filter(s => s.pinned)
  const rest = rows.filter(s => !s.pinned)
  const groups = []
  if (pinned.length) groups.push(['pinned', pinned])
  for (const row of rest) {
    const label = relative(row.started_at)
    const group = groups.find(g => g[0] === label)
    group ? group[1].push(row) : groups.push([label, [row]])
  }
  const list = groups
    .map(
      ([label, items]) =>
        `<div class="group">${label}</div>` +
        items
          .map(
            s => `<button class="row ${state.current?.session === s.id ? 'active' : ''}" data-open="${esc(s.id)}">
              <span class="title">${esc(s.title)}</span>${statusDot(s.status)}</button>`
          )
          .join('')
    )
    .join('')
  return `
    <aside class="side">
      <div class="side-top">
        <input id="filter" type="search" placeholder="Search" value="${esc(state.filter)}" autocomplete="off">
        <button class="icon" id="new-chat" title="New chat" aria-label="New chat">${icon('plus')}</button>
      </div>
      <nav class="list">${list || '<div class="group">no chats yet</div>'}</nav>
      <div class="side-bottom">
        <span>${state.connected ? '' : 'hermes is offline'}</span>
        <button class="icon" id="open-settings" title="Settings" aria-label="Settings">${icon('gear')}</button>
      </div>
    </aside>`
}

function statusDot(status) {
  if (status === 'working') return '<span class="dot working" title="working"></span>'
  if (status === 'needs you') return '<span class="dot needs" title="needs you"></span>'
  if (status === 'failed') return '<span class="dot failed" title="failed"></span>'
  return ''
}

function renderChat() {
  const c = state.current
  const top = `
    <header class="chat-top">
      <button class="icon back" id="back" aria-label="Back">${icon('back')}</button>
      <h2>${esc(c ? c.title : 'New chat')}</h2>
      ${c ? `<button class="icon" id="chat-menu" aria-label="More">${icon('more')}</button>` : ''}
      ${c && state.menu ? renderMenu() : ''}
    </header>
    ${state.connected ? '' : '<div class="offline">hermes is offline. messages will work again once it reconnects.</div>'}`
  const body = c ? renderTranscript(c) : '<div class="empty"><div>what are we working on?</div></div>'
  return `${top}<section class="transcript" id="transcript">${body}</section>${renderComposer()}`
}

function renderMenu() {
  const row = state.sessions.find(s => s.id === state.current.session)
  return `<div class="menu">
    <button data-action="rename">Rename</button>
    <button data-action="pin">${row?.pinned ? 'Unpin' : 'Pin'}</button>
    <button data-action="archive">Archive</button>
  </div>`
}

function renderTranscript(c) {
  if (c.loading) return ''
  const out = []
  let tools = []
  const flushTools = () => {
    if (!tools.length) return
    out.push(`<details class="tools"><summary>${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}</summary><ul>${tools.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>`)
    tools = []
  }
  for (const m of c.messages) {
    if (m.role === 'tool') {
      tools.push(`${m.name || 'tool'}${m.context ? ': ' + String(m.context).replace(/\s+/g, ' ').slice(0, 90) : ''}`)
      continue
    }
    if (m.role === 'assistant' && !(m.text || '').trim()) continue
    flushTools()
    if (m.role === 'user') out.push(`<div class="msg user">${esc(m.text)}</div>`)
    else out.push(`<div class="msg assistant">${markdown(withoutMedia(m.text))}${renderMedia(m.text)}</div>`)
  }
  flushTools()
  if (state.live && c.running) {
    const tools = state.live.tools.slice(-4).map(t => `<div class="live-tool">${esc(t)}</div>`).join('')
    const text = state.live.text ? `<div class="msg assistant">${markdown(state.live.text)}</div>` : ''
    const thinking = !state.live.text ? `<div class="thinking">${state.live.reasoning ? 'thinking…' : 'working…'}</div>` : ''
    out.push(tools + text + thinking)
  }
  for (const r of c.requests) out.push(renderRequest(r))
  if (state.error) out.push(`<p class="error">${esc(state.error)}</p>`)
  return out.join('')
}

function renderRequest(r) {
  const p = r.params || {}
  if (r.method === 'approval') {
    const labels = { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' }
    return `<div class="card">
      <h3>Needs your ok</h3>
      ${p.description ? `<div>${esc(p.description)}</div>` : ''}
      ${p.command ? `<pre>${esc(p.command)}</pre>` : ''}
      <div class="choices">${(p.choices || [])
        .map(choice => `<button class="choice ${choice === 'deny' ? 'deny' : ''}" data-approve="${esc(r.id)}" data-choice="${esc(choice)}">${labels[choice] || esc(choice)}</button>`)
        .join('')}</div>
    </div>`
  }
  if (r.method === 'clarify') {
    return `<div class="card" data-clarify="${esc(r.id)}">
      <h3>A question</h3>
      ${(p.questions || [])
        .map(
          q => `<div class="question" data-qid="${esc(q.qid)}">
            <div>${esc(q.question)}</div>
            ${(q.choices || []).length ? `<div class="choices">${q.choices.map(choice => `<button class="choice" data-pick="${esc(q.qid)}" data-value="${esc(choice)}">${esc(choice)}</button>`).join('')}</div>` : ''}
            <input type="text" placeholder="Your answer" data-answer="${esc(q.qid)}">
          </div>`
        )
        .join('')}
      <div class="choices"><button class="primary" data-submit-clarify="${esc(r.id)}">Answer</button></div>
    </div>`
  }
  return `<div class="card"><h3>${esc(r.method)}</h3><div>this one needs the desktop app.</div></div>`
}

function renderComposer() {
  const running = state.current?.running
  const files = state.files.length
    ? `<div class="attached">${state.files.map((f, i) => `<span class="chip">${esc(f.name)}<button data-unattach="${i}" aria-label="Remove">×</button></span>`).join('')}</div>`
    : ''
  return `
    <footer class="composer">
      ${files}
      <div class="composer-box">
        <button class="icon" id="attach" aria-label="Attach">${icon('clip')}</button>
        <input type="file" id="file-input" multiple hidden>
        <textarea id="input" rows="1" placeholder="${running ? 'Steer or queue a message' : 'Message'}" enterkeyhint="send"></textarea>
        ${running ? `<button class="icon" id="stop" title="Stop" aria-label="Stop">${icon('stop')}</button>` : ''}
        <button class="icon send" id="send" aria-label="Send" ${state.sending ? 'disabled' : ''}>${icon('send')}</button>
      </div>
    </footer>`
}

function renderSettings() {
  return `
    <header class="chat-top">
      <button class="icon back" id="back" aria-label="Back">${icon('back')}</button>
      <h2>Settings</h2>
    </header>
    <section class="settings">
      <h3>Passkeys</h3>
      ${state.passkeys
        .map(
          k => `<div class="line"><span>${esc(k.label)}${k.current ? ' (this device)' : ''}</span>
            ${k.current ? '<span></span>' : `<button class="link-button" data-remove-key="${esc(k.id)}">remove</button>`}</div>`
        )
        .join('')}
      <div class="line"><span>Add a passkey on this device</span><button class="link-button" id="add-key">add</button></div>
      <h3>Notifications</h3>
      <div class="line"><span>Alerts when a turn finishes or needs you</span><button class="link-button" id="enable-push">${pushLabel()}</button></div>
      <h3>Account</h3>
      <div class="line"><span>Sign out of this device</span><button class="link-button" id="sign-out">sign out</button></div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
    </section>`
}

function pushLabel() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported here'
  if (Notification.permission === 'granted') return 'on'
  if (Notification.permission === 'denied') return 'blocked in browser settings'
  return 'turn on'
}

// The composer is re-rendered with everything else; keep its text, caret and focus.
function captureComposer() {
  const input = document.getElementById('input')
  if (!input) return null
  return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input, scroll: document.getElementById('transcript')?.scrollTop }
}

function restoreComposer(keep) {
  const input = document.getElementById('input')
  const transcript = document.getElementById('transcript')
  if (input) {
    input.value = keep ? keep.value : localStorage.getItem(draftKey()) || ''
    grow(input)
    if (keep?.focused) {
      input.focus()
      input.setSelectionRange(keep.start, keep.end)
    }
  }
  if (transcript && keep?.scroll != null) transcript.scrollTop = keep.scroll
}

function grow(input) {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

function isNearBottom() {
  const t = document.getElementById('transcript')
  return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 120
}

function scrollDown() {
  const t = document.getElementById('transcript')
  if (t) t.scrollTop = t.scrollHeight
}

// ── events ───────────────────────────────────────────────────────────────────

function bind() {
  const on = (id, handler) => {
    const el = document.getElementById(id)
    if (el) el.onclick = handler
  }
  on('new-chat', () => {
    state.current = null
    state.live = null
    state.view = 'chats'
    history.replaceState(null, '', '#/new')
    render()
    document.getElementById('input')?.focus()
  })
  on('open-settings', async () => {
    state.view = 'settings'
    state.current = null
    history.replaceState(null, '', '#/settings')
    state.passkeys = await api('/api/passkeys').catch(() => [])
    render()
  })
  on('back', () => {
    state.current = null
    state.view = 'chats'
    history.replaceState(null, '', '#/')
    render()
  })
  on('chat-menu', () => {
    state.menu = !state.menu
    render()
  })
  on('attach', () => document.getElementById('file-input').click())
  on('stop', () => api(`/api/sessions/${encodeURIComponent(state.current.session)}/stop`, { method: 'POST' }).catch(e => (state.error = e.message)))
  on('send', submit)
  on('add-key', async () => {
    try {
      await register(null)
      state.passkeys = await api('/api/passkeys')
    } catch (error) {
      state.error = error.name === 'NotAllowedError' ? 'Cancelled.' : error.message
    }
    render()
  })
  on('sign-out', async () => {
    await api('/api/logout', { method: 'POST' })
    location.replace('/')
  })
  on('enable-push', enablePush)

  const filter = document.getElementById('filter')
  if (filter) {
    filter.oninput = () => {
      state.filter = filter.value
      const pos = filter.selectionStart
      render()
      const again = document.getElementById('filter')
      again.focus()
      again.setSelectionRange(pos, pos)
    }
  }

  const fileInput = document.getElementById('file-input')
  if (fileInput) {
    fileInput.onchange = () => {
      state.files.push(...fileInput.files)
      render()
    }
  }

  const input = document.getElementById('input')
  if (input) {
    input.oninput = () => {
      grow(input)
      localStorage.setItem(draftKey(), input.value)
    }
    input.onkeydown = event => {
      const touch = matchMedia('(pointer: coarse)').matches
      if (event.key === 'Enter' && !event.shiftKey && !touch && !event.isComposing) {
        event.preventDefault()
        submit()
      }
    }
    input.onpaste = event => {
      const pasted = [...(event.clipboardData?.files || [])]
      if (pasted.length) {
        state.files.push(...pasted)
        render()
      }
    }
  }

  for (const el of $app.querySelectorAll('[data-open]')) el.onclick = () => openSession(el.dataset.open)
  for (const el of $app.querySelectorAll('[data-unattach]'))
    el.onclick = () => {
      state.files.splice(Number(el.dataset.unattach), 1)
      render()
    }
  for (const el of $app.querySelectorAll('[data-approve]'))
    el.onclick = () => answer(el.dataset.approve, { choice: el.dataset.choice })
  for (const el of $app.querySelectorAll('[data-pick]'))
    el.onclick = () => {
      const field = $app.querySelector(`[data-answer="${CSS.escape(el.dataset.pick)}"]`)
      field.value = el.dataset.value
      const card = el.closest('[data-clarify]')
      if (card.querySelectorAll('.question').length === 1) answer(card.dataset.clarify, { answers: { [el.dataset.pick]: el.dataset.value } })
    }
  for (const el of $app.querySelectorAll('[data-submit-clarify]'))
    el.onclick = () => {
      const card = el.closest('[data-clarify]')
      const answers = {}
      for (const field of card.querySelectorAll('[data-answer]')) answers[field.dataset.answer] = field.value.trim() || null
      answer(el.dataset.submitClarify, { answers })
    }
  for (const el of $app.querySelectorAll('[data-action]')) el.onclick = () => chatAction(el.dataset.action)
  for (const el of $app.querySelectorAll('[data-remove-key]'))
    el.onclick = async () => {
      if (!confirm('Remove this passkey? That device will be signed out.')) return
      await api(`/api/passkeys/${el.dataset.removeKey}/remove`, { method: 'POST' })
      state.passkeys = await api('/api/passkeys')
      render()
    }
}

async function submit() {
  const input = document.getElementById('input')
  const text = input.value.trim()
  if ((!text && !state.files.length) || state.sending) return
  state.error = ''
  input.value = ''
  if (!(await send(text))) {
    const again = document.getElementById('input')
    if (again) {
      again.value = text
      grow(again)
    }
  }
}

async function answer(id, result) {
  try {
    await api(`/api/requests/${encodeURIComponent(id)}`, { method: 'POST', body: { result } })
    state.current.requests = state.current.requests.filter(r => r.id !== id)
  } catch (error) {
    state.error = error.message
  }
  render()
}

async function chatAction(action) {
  const session = state.current.session
  state.menu = false
  try {
    if (action === 'rename') {
      const title = prompt('Rename chat', state.current.title)
      if (title?.trim()) {
        await api(`/api/sessions/${encodeURIComponent(session)}/title`, { method: 'POST', body: { title: title.trim() } })
        state.current.title = title.trim()
      }
    } else if (action === 'pin') {
      const row = state.sessions.find(s => s.id === session)
      await api(`/api/sessions/${encodeURIComponent(session)}/pin`, { method: 'POST', body: { pinned: !row?.pinned } })
    } else if (action === 'archive') {
      await api(`/api/sessions/${encodeURIComponent(session)}/archive`, { method: 'POST', body: { archived: true } })
      state.current = null
      history.replaceState(null, '', '#/')
    }
    await loadSessions()
  } catch (error) {
    state.error = error.message
    render()
  }
}

// ── notifications ────────────────────────────────────────────────────────────

async function enablePush() {
  try {
    const registration = await navigator.serviceWorker.ready
    const { key } = await api('/api/push/key')
    if (!key) throw new Error('notifications are not set up on the server')
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') throw new Error('notifications were not allowed')
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(key) })
    await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() })
  } catch (error) {
    state.error = error.message
  }
  render()
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  state.error = ''
  await loadMe()
  if (!state.me.signed_in) return render()
  connect()
  await loadSessions()
  const route = location.hash.match(/^#\/c\/([\w.-]+)/)
  if (route) await openSession(route[1])
  else if (location.hash === '#/settings') document.getElementById('open-settings')?.click()
  else render()
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

window.addEventListener('hashchange', () => {
  const route = location.hash.match(/^#\/c\/([\w.-]+)/)
  if (route && route[1] !== state.current?.session) openSession(route[1])
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me?.signed_in) {
    connect()
    loadSessions()
    if (state.current) openSession(state.current.session, { quiet: true })
  }
})

document.addEventListener('click', event => {
  if (state.menu && !event.target.closest('.menu') && !event.target.closest('#chat-menu')) {
    state.menu = false
    render()
  }
})

boot()
