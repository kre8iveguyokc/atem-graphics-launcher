'use strict'

// Drives the real agl-helper-mock binary (native/helper, simulated switcher).
// Run `npm run helper:build` first. In CI AGL_REQUIRE_HELPER=1 turns a missing binary into a failure.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { HelperBackend } = require('../src/main/backends/helperBackend')
const { Launcher } = require('../src/main/launcher')
const { listPngs } = require('../src/main/library')

const exe = process.platform === 'win32' ? '.exe' : ''
const buildDir = path.join(__dirname, '..', 'native', 'helper', 'build')
const find = (name) =>
  [path.join(buildDir, name + exe), path.join(buildDir, 'Release', name + exe)].find((p) => fs.existsSync(p))
const MOCK = find('agl-helper-mock')
const NOSDK = find('agl-helper')
const skip = !MOCK && process.env.AGL_REQUIRE_HELPER !== '1' ? 'helper not built (npm run helper:build)' : false
const FIXTURES = path.join(__dirname, 'fixtures')
const files = listPngs(FIXTURES)

// Every helper process started by a test is shut down at the end, even if an assertion failed.
const started = []
test.after(() => Promise.all(started.map((b) => b.disconnect().catch(() => {}))))

function mock(env = {}, transport = 'usb', opts = {}) {
  const b = new HelperBackend({ transport, helperPath: MOCK, env, ...opts })
  started.push(b)
  return b
}

test('mock helper binary exists when required', { skip: process.env.AGL_REQUIRE_HELPER !== '1' }, () => {
  assert.ok(MOCK, 'agl-helper-mock not built')
  assert.ok(NOSDK, 'agl-helper not built')
})

test('connects over USB and reports state in the app shape', { skip }, async () => {
  const b = mock()
  const states = []
  b.on('state', (s) => states.push(s))
  await b.connect('')
  assert.equal(b.status, 'connected')
  assert.equal(b.transport, 'USB · Blackmagic SDK')
  assert.deepEqual(b.getResolution(), { width: 1920, height: 1080 })
  assert.equal(states[0].media.players[0].stillIndex, 0)
  assert.equal(states[0].media.stillPool.length, 20)
  await b.disconnect()
})

test('upload replaces the still and pushes a state update', { skip }, async () => {
  const b = mock()
  await b.connect('')
  const updated = new Promise((r) => b.on('state', (s) => s.media.stillPool[1].isUsed && r(s)))
  const res = await b.uploadFile(1, files[0].path, 'blue')
  assert.ok(res.transferMs >= 50)
  const s = await updated
  assert.equal(s.media.stillPool[1].fileName, 'blue')
  await b.disconnect()
})

test('prepared graphics skip decoding at click time', { skip }, async () => {
  const b = mock({ AGL_MOCK_UPLOAD_MS: '5' })
  await b.connect('')
  await b.prepareFiles(files.map((f) => f.path))
  const res = await b.uploadFile(0, files[2].path, 'x')
  assert.equal(res.prepared, true)
  await b.disconnect()
})

test('USB failure is a clean error, network then connects', { skip }, async () => {
  const usb = mock({ AGL_MOCK_USB: '0' })
  await assert.rejects(usb.connect(''), /no switcher on USB/)
  assert.equal(usb.status, 'error')
  const net = mock({ AGL_MOCK_USB: '0' }, 'network')
  await net.connect('10.0.0.9')
  assert.equal(net.transport, 'Ethernet · Blackmagic SDK')
  await net.disconnect()
})

test('missing Blackmagic runtime is reported as sdk_unavailable', { skip }, async () => {
  const b = mock({ AGL_MOCK_UNAVAILABLE: '1' })
  await assert.rejects(b.connect(''), (e) => e.code === 'sdk_unavailable')
})

test('no-SDK helper build declines cleanly', { skip: !NOSDK && 'helper not built' }, async () => {
  const b = new HelperBackend({ transport: 'usb', helperPath: NOSDK })
  await assert.rejects(b.connect(''), (e) => e.code === 'sdk_unavailable')
})

test('missing helper binary fails fast', async () => {
  const b = new HelperBackend({ transport: 'usb', helperPath: path.join(__dirname, 'nope') })
  await assert.rejects(b.connect(''), (e) => e.code === 'helper_missing')
})

test('helper crash mid-upload rejects the upload and reports an error', { skip }, async () => {
  const b = mock({ AGL_MOCK_CRASH_ON_UPLOAD: '1' })
  await b.connect('')
  const statuses = []
  b.on('connection', (e) => statuses.push(e.status))
  await assert.rejects(b.uploadFile(0, files[0].path, 'x'), (e) => e.code === 'helper_exited')
  assert.ok(statuses.includes('error'))
})

test('size mismatch and bad files are non-retryable', { skip }, async () => {
  const b = mock()
  await b.connect('')
  const bogus = path.join(__dirname, 'helperBackend.test.js')
  await assert.rejects(b.uploadFile(0, bogus, 'x'), (e) => e.code === 'bad_file' && e.noRetry)
  await b.disconnect()
})

test('connection drop after upload is reported', { skip }, async () => {
  const b = mock({ AGL_MOCK_DROP_AFTER: '1' })
  await b.connect('')
  const dropped = new Promise((r) => b.on('connection', (e) => e.status === 'connecting' && r()))
  await b.uploadFile(0, files[0].path, 'x')
  await dropped
  await b.disconnect()
})

async function launcherWith(t, env) {
  const b = mock(env)
  const launcher = new Launcher({ backend: b, retryDelayMs: 10 })
  t.after(() => launcher.shutdown())
  await launcher.connect('')
  launcher.loadFolder(FIXTURES)
  const log = { done: [], retrying: [], error: [] }
  launcher.on('upload', (e) => log[e.state]?.push(e.fileName))
  return { b, launcher, log }
}

test('launcher + helper: latest click wins with one transfer at a time', { skip }, async (t) => {
  const { b, launcher, log } = await launcherWith(t, { AGL_MOCK_UPLOAD_MS: '80' })
  for (const f of files) launcher.send(1, f.path)
  await launcher.controller.whenIdle()
  assert.deepEqual(log.done, [files[0].name, files[files.length - 1].name])
  // The helper pushes the new still name as a state event just after confirming the upload.
  const expected = files[files.length - 1].name.replace(/\.png$/i, '')
  const deadline = Date.now() + 3000
  while (b.state.media.stillPool[0].fileName !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(b.state.media.stillPool[0].fileName, expected)
})

test('launcher + helper: a failed transfer is retried when nothing newer is waiting', { skip }, async (t) => {
  const { launcher, log } = await launcherWith(t, { AGL_MOCK_FAIL_UPLOADS: '1' })
  launcher.send(2, files[1].path)
  await launcher.controller.whenIdle()
  assert.deepEqual(log.retrying, [files[1].name])
  assert.deepEqual(log.done, [files[1].name])
})

test('launcher + helper: a failed transfer is NOT retried over a newer click', { skip }, async (t) => {
  const { launcher, log } = await launcherWith(t, { AGL_MOCK_FAIL_UPLOADS: '1', AGL_MOCK_UPLOAD_MS: '80' })
  launcher.send(1, files[0].path)
  launcher.send(1, files[3].path)
  await launcher.controller.whenIdle()
  assert.deepEqual(log.retrying, [])
  assert.deepEqual(log.error, [files[0].name])
  assert.deepEqual(log.done, [files[3].name])
})
