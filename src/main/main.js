'use strict'

const { app, BrowserWindow, ipcMain, dialog, protocol, nativeImage, Menu } = require('electron')
const fs = require('fs')
const path = require('path')
const { Config } = require('./config')
const { Launcher } = require('./launcher')
const { AtemBackend } = require('./backends/atemBackend')
const { TestBackend } = require('./backends/testBackend')
const { HelperBackend } = require('./backends/helperBackend')
const { FallbackBackend } = require('./backends/fallbackBackend')

const args = process.argv.slice(1)
const SMOKE = args.includes('--smoke-test')
// Test mode is never saved: every normal launch starts in live mode, so a show
// can't accidentally run against the simulator.
let testMode = SMOKE || args.includes('--test-mode')

protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let win = null
let config = null
let launcher = null
const thumbCache = new Map()

function sampleFolder() {
  const packaged = path.join(process.resourcesPath || '', 'sample-graphics')
  if (app.isPackaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', '..', 'test', 'fixtures')
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function helperPath() {
  const exe = process.platform === 'win32' ? 'agl-helper.exe' : 'agl-helper'
  if (app.isPackaged) return path.join(process.resourcesPath, 'helper', exe)
  return path.join(__dirname, '..', '..', 'native', 'helper', 'dist', exe)
}

function makeBackend() {
  if (testMode) return new TestBackend()
  return new FallbackBackend({
    candidates: [
      { name: 'SDK USB', create: () => new HelperBackend({ transport: 'usb', helperPath: helperPath() }) },
      {
        name: 'SDK Ethernet',
        needsAddress: true,
        create: () => new HelperBackend({ transport: 'network', helperPath: helperPath() }),
      },
      { name: 'atem-connection', needsAddress: true, create: () => new AtemBackend() },
    ],
  })
}

async function applyMode() {
  await launcher.setBackend(makeBackend())
  if (launcher.folder) launcher.loadFolder(launcher.folder)
  await launcher.connect(testMode ? 'test-mode' : config.get('atemAddress'))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101114',
    title: 'ATEM Graphics Launcher',
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.on('closed', () => (win = null))
}

function registerThumbProtocol() {
  protocol.handle('thumb', async (request) => {
    const url = new URL(request.url)
    const filePath = url.searchParams.get('p') || ''
    // Only serve files from the loaded folder.
    if (!launcher.files.some((f) => f.path === filePath)) return new Response('not found', { status: 404 })
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    const key = `${filePath}|${stat.mtimeMs}`
    let png = thumbCache.get(key)
    if (!png) {
      const img = nativeImage.createFromPath(filePath)
      png = img.isEmpty() ? Buffer.alloc(0) : img.resize({ width: 384, quality: 'good' }).toPNG()
      thumbCache.set(key, png)
    }
    return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
  })
}

function wireLauncher() {
  launcher.on('upload', (evt) => {
    send('upload', {
      slot: evt.slot,
      state: evt.state,
      fileName: evt.fileName,
      filePath: evt.filePath,
      attempt: evt.attempt,
      error: evt.error,
      durationMs: evt.durationMs,
      jobId: evt.job?.id,
    })
  })
  launcher.on('connection', (evt) => send('connection', evt))
  launcher.on('safety', (evt) => send('safety', evt))
  launcher.on('prefetch', (evt) => send('prefetch', evt))
}

function loadFolder(folder) {
  const files = launcher.loadFolder(folder)
  config.set({ folder })
  return { folder, files }
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    config: config.all,
    testMode,
    version: app.getVersion(),
    sampleFolder: sampleFolder(),
    platform: process.platform,
    connection: {
      status: launcher.backend.status,
      address: launcher.backend.address,
      transport: launcher.backend.transport,
      testMode,
    },
  }))

  ipcMain.handle('settings:save', async (_e, partial) => {
    const next = {}
    if (typeof partial?.atemAddress === 'string') next.atemAddress = partial.atemAddress.trim()
    const saved = config.set(next)
    if (!testMode && next.atemAddress !== undefined) await launcher.connect(next.atemAddress)
    return saved
  })

  ipcMain.handle('connection:reconnect', async () => {
    await launcher.connect(testMode ? 'test-mode' : config.get('atemAddress'))
  })

  ipcMain.handle('mode:set', async (_e, value) => {
    testMode = Boolean(value)
    await applyMode()
    return testMode
  })

  ipcMain.handle('folder:choose', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose the graphics folder',
      properties: ['openDirectory'],
      defaultPath: config.get('folder') || undefined,
    })
    if (result.canceled || !result.filePaths[0]) return null
    return loadFolder(result.filePaths[0])
  })

  ipcMain.handle('folder:load', (_e, folder) => {
    if (!folder || !fs.existsSync(folder)) return null
    return loadFolder(folder)
  })

  ipcMain.handle('graphic:send', (_e, slot, filePath) => {
    if (!launcher.files.some((f) => f.path === filePath)) throw new Error('Unknown graphic')
    const job = launcher.send(Number(slot), filePath)
    return { jobId: job.id }
  })
}

async function runSmokeTest() {
  const fail = (msg) => {
    console.error(`SMOKE TEST FAILED: ${msg}`)
    app.exit(1)
  }
  const timer = setTimeout(() => fail('timed out'), 45000)
  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    const rendererOk = await win.webContents.executeJavaScript('Boolean(window.agl && document.querySelector("#grid"))')
    if (!rendererOk) return fail('renderer did not initialise')
    // Prove the real hardware library (incl. its native module) loads in this build.
    const lib = require('atem-connection')
    if (typeof lib.Atem.prototype.uploadStill !== 'function') return fail('atem-connection uploadStill missing')
    const real = new AtemBackend()
    if (real.getResolution() !== null) return fail('unexpected resolution on an unconnected switcher')
    // Prove the SDK helper is bundled and answers. Without hardware the connect
    // must fail cleanly (sdk_unavailable / connect_failed), never hang or crash.
    const helper = new HelperBackend({ transport: 'usb', helperPath: helperPath(), connectTimeoutMs: 8000 })
    let helperNote
    try {
      await helper.connect('')
      helperNote = 'helper connected (unexpected without hardware)'
      await helper.disconnect()
    } catch (e) {
      if (e.code === 'helper_missing' && process.env.AGL_REQUIRE_HELPER === '1') return fail(`helper missing at ${helperPath()}`)
      if (e.code === 'timeout') return fail('helper did not answer')
      helperNote = `helper ${helper.helperInfo ? `sdk=${helper.helperInfo.sdk}` : 'absent'}: ${e.message}`
    }
    console.log(`SMOKE: ${helperNote}`)
    const { files } = loadFolder(sampleFolder())
    if (files.length < 2) return fail('sample graphics missing')
    // Rapid clicks: only the first (already started) and the last should upload.
    const done = []
    launcher.on('upload', (e) => e.state === 'done' && done.push(e.fileName))
    for (const f of files) launcher.send(1, f.path)
    await launcher.controller.whenIdle()
    const last = files[files.length - 1].name
    const stillName = launcher.backend.state.media.stillPool[0].fileName
    if (done[done.length - 1] !== last) return fail(`last upload was ${done[done.length - 1]}, expected ${last}`)
    if (done.length > 2) return fail(`expected latest-click-wins to skip intermediates, uploaded ${done.length}`)
    if (!stillName) return fail('still 1 was not written')
    console.log(`SMOKE TEST PASSED: ${files.length} clicks -> ${done.length} uploads, still 1 = "${stillName}"`)
    clearTimeout(timer)
    app.exit(0)
  } catch (e) {
    fail(e?.stack || String(e))
  }
}

app.whenReady().then(async () => {
  config = new Config(app.getPath('userData'))
  launcher = new Launcher({ backend: makeBackend() })
  wireLauncher()
  registerThumbProtocol()
  registerIpc()
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  createWindow()
  await launcher.connect(testMode ? 'test-mode' : config.get('atemAddress'))
  if (SMOKE) runSmokeTest()
})

app.on('window-all-closed', async () => {
  if (launcher) await launcher.shutdown()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
