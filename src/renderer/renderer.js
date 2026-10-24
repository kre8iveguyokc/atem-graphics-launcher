'use strict'

/* global agl */

const $ = (sel) => document.querySelector(sel)
const grid = $('#grid')
const empty = $('#empty')
const slotEls = { 1: $('.slot[data-slot="1"]'), 2: $('.slot[data-slot="2"]') }

const state = {
  slot: 1,
  testMode: false,
  files: [],
  folder: '',
  sampleFolder: '',
  cards: new Map(), // path -> element
  inSlot: { 1: null, 2: null }, // path last successfully uploaded by this app
  sending: { 1: null, 2: null }, // path currently on the wire
  queued: { 1: null, 2: null }, // path waiting
  failed: new Set(),
  slotTimers: { 1: null, 2: null },
  stillNames: { 1: '', 2: '' },
}

// ---------- slot selector ----------
function selectSlot(slot) {
  state.slot = slot
  for (const s of [1, 2]) slotEls[s].setAttribute('aria-pressed', String(s === slot))
}

for (const s of [1, 2]) slotEls[s].addEventListener('click', () => selectSlot(s))

function setSlotStatus(slot, stateName, text) {
  const el = slotEls[slot]
  el.dataset.state = stateName
  el.querySelector('[data-status]').textContent = text
}

function setSlotNow(slot) {
  const path = state.inSlot[slot]
  const name = path ? baseName(path) : state.stillNames[slot] ? `${state.stillNames[slot]} (on switcher)` : '—'
  slotEls[slot].querySelector('[data-now]').textContent = name
}

function startElapsed(slot, label) {
  clearInterval(state.slotTimers[slot])
  const t0 = performance.now()
  const tick = () => setSlotStatus(slot, 'uploading', `${label} ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  tick()
  state.slotTimers[slot] = setInterval(tick, 100)
}

function stopElapsed(slot) {
  clearInterval(state.slotTimers[slot])
  state.slotTimers[slot] = null
}

// ---------- grid ----------
function baseName(p) {
  return p.split(/[\\/]/).pop()
}

function thumbUrl(path) {
  return `thumb://local/?p=${encodeURIComponent(path)}`
}

function renderGrid() {
  grid.textContent = ''
  state.cards.clear()
  const frag = document.createDocumentFragment()
  for (const f of state.files) {
    const card = document.createElement('button')
    card.className = 'card'
    card.title = f.name
    card.dataset.path = f.path
    const img = document.createElement('img')
    img.className = 'thumb'
    img.loading = 'lazy'
    img.decoding = 'async'
    img.alt = ''
    img.src = thumbUrl(f.path)
    const badges = document.createElement('span')
    badges.className = 'badges'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = f.name.replace(/\.png$/i, '')
    card.append(img, badges, name)
    frag.append(card)
    state.cards.set(f.path, card)
  }
  grid.append(frag)
  empty.hidden = state.files.length > 0
  $('#folder-label').textContent = state.folder || 'No folder'
  $('#folder-label').title = state.folder
  applyFilter()
  refreshCards()
}

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card')
  if (!card) return
  const slot = e.shiftKey ? (state.slot === 1 ? 2 : 1) : state.slot
  agl.sendGraphic(slot, card.dataset.path).catch((err) => toast(String(err.message || err)))
})

function refreshCards() {
  for (const [path, card] of state.cards) {
    const badges = card.querySelector('.badges')
    badges.textContent = ''
    let inSlot = false
    let sending = false
    for (const s of [1, 2]) {
      if (state.inSlot[s] === path) {
        badges.append(badge(`S${s}`, ''))
        inSlot = true
      }
      if (state.sending[s] === path) {
        badges.append(badge(`→S${s}`, 'sending'))
        sending = true
      } else if (state.queued[s] === path) {
        badges.append(badge(`S${s} next`, 'queued'))
      }
    }
    card.classList.toggle('in-slot', inSlot && !sending)
    card.classList.toggle('sending', sending)
    card.classList.toggle('failed', state.failed.has(path))
  }
}

function badge(text, cls) {
  const b = document.createElement('span')
  b.className = `badge ${cls}`.trim()
  b.textContent = text
  return b
}

// ---------- filter ----------
const filter = $('#filter')
function applyFilter() {
  const q = filter.value.trim().toLowerCase()
  for (const [path, card] of state.cards) card.hidden = q !== '' && !baseName(path).toLowerCase().includes(q)
}
filter.addEventListener('input', applyFilter)

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement
  if (e.key === '/' && !typing) {
    e.preventDefault()
    filter.focus()
    return
  }
  if (e.key === 'Escape' && typing) {
    filter.value = ''
    applyFilter()
    filter.blur()
    return
  }
  if (typing) return
  if (e.key === '1') selectSlot(1)
  if (e.key === '2') selectSlot(2)
})

// ---------- upload events ----------
agl.onUpload((evt) => {
  const { slot, fileName, filePath } = evt
  switch (evt.state) {
    case 'queued':
      state.queued[slot] = filePath
      state.failed.delete(filePath)
      if (!state.sending[slot]) setSlotStatus(slot, 'queued', `Queued: ${fileName}`)
      break
    case 'superseded':
      if (state.queued[slot] === filePath) state.queued[slot] = null
      break
    case 'uploading':
    case 'retrying':
      if (state.queued[slot] === filePath) state.queued[slot] = null
      state.sending[slot] = filePath
      startElapsed(slot, evt.state === 'retrying' ? `Retry ${evt.attempt - 1}: ${fileName}` : `Sending ${fileName}`)
      break
    case 'done':
      stopElapsed(slot)
      state.sending[slot] = null
      state.inSlot[slot] = filePath
      state.failed.delete(filePath)
      setSlotStatus(slot, 'done', `On slot ✓  ${(evt.durationMs / 1000).toFixed(2)}s`)
      setSlotNow(slot)
      break
    case 'error':
      stopElapsed(slot)
      state.sending[slot] = null
      state.failed.add(filePath)
      setSlotStatus(slot, 'error', `FAILED: ${evt.error}`)
      toast(`Slot ${slot}: ${fileName} failed. ${evt.error}`)
      break
  }
  refreshCards()
})

// ---------- connection & safety ----------
const connBtn = $('#conn')
agl.onConnection(renderConnection)
function renderConnection(c) {
  connBtn.dataset.status = c.status
  connBtn.dataset.test = String(Boolean(c.testMode))
  const where = c.testMode ? 'TEST MODE' : c.address
  const label =
    {
      connected: `Connected · ${where}`,
      connecting: `Connecting · ${where}`,
      disconnected: `Disconnected · ${where}`,
      error: `Error · ${where}`,
    }[c.status] || c.status
  $('#conn-text').textContent = label
  connBtn.title = c.message ? `${c.message}\nClick to reconnect` : 'Click to reconnect'
}
connBtn.addEventListener('click', () => agl.reconnect())

agl.onSafety((s) => {
  const box = $('#safety')
  for (const slot of [1, 2]) {
    state.stillNames[slot] = s.slots?.[slot]?.stillName || ''
    setSlotNow(slot)
  }
  if (s.ok) {
    box.hidden = true
    return
  }
  box.hidden = false
  box.textContent = ''
  const strong = document.createElement('strong')
  strong.textContent = 'Check the switcher: '
  box.append(strong, document.createTextNode(s.warnings.join('  ·  ')))
})

agl.onPrefetch(({ done, total }) => {
  $('#prefetch').textContent = done >= total ? `Ready: ${total} pre-encoded` : `Pre-encoding ${done}/${total}`
})

// ---------- toast ----------
let toastTimer = null
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 6000)
}

// ---------- folder ----------
function applyFolder(result) {
  if (!result) return
  state.folder = result.folder
  state.files = result.files
  state.inSlot = { 1: null, 2: null }
  state.failed.clear()
  renderGrid()
  for (const s of [1, 2]) setSlotNow(s)
}

$('#btn-folder').addEventListener('click', async () => applyFolder(await agl.chooseFolder()))
$('#empty-choose').addEventListener('click', async () => applyFolder(await agl.chooseFolder()))
$('#empty-sample').addEventListener('click', async () => applyFolder(await agl.loadFolder(state.sampleFolder)))
$('#btn-reload').addEventListener('click', async () => {
  if (!state.folder) return
  const keep = { ...state.inSlot }
  applyFolder(await agl.loadFolder(state.folder))
  state.inSlot = keep
  for (const s of [1, 2]) setSlotNow(s)
  refreshCards()
})

// ---------- settings ----------
const dlg = $('#settings')
$('#btn-settings').addEventListener('click', async () => {
  const info = await agl.init()
  $('#set-ip').value = info.config.atemAddress
  $('#set-test').checked = state.testMode
  dlg.showModal()
})

$('#settings-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return
  const ip = $('#set-ip').value.trim()
  const wantTest = $('#set-test').checked
  await agl.saveSettings({ atemAddress: ip })
  if (wantTest !== state.testMode) {
    state.testMode = await agl.setTestMode(wantTest)
    applyTestMode()
    if (state.folder) applyFolder(await agl.loadFolder(state.folder))
  }
})

function applyTestMode() {
  $('#test-banner').hidden = !state.testMode
  $('#empty-sample').hidden = !state.testMode
  document.title = state.testMode ? 'ATEM Graphics Launcher — TEST MODE' : 'ATEM Graphics Launcher'
}

// ---------- boot ----------
;(async function boot() {
  const info = await agl.init()
  state.testMode = info.testMode
  state.sampleFolder = info.sampleFolder
  $('#version').textContent = `v${info.version}`
  applyTestMode()
  renderConnection(info.connection)
  if (info.config.folder) {
    applyFolder(await agl.loadFolder(info.config.folder))
  }
  if (!state.files.length) {
    empty.hidden = false
  }
  selectSlot(info.config.defaultSlot === 2 ? 2 : 1)
})()
