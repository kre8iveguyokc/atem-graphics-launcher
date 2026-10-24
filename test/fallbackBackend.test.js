'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { FallbackBackend } = require('../src/main/backends/fallbackBackend')

class FakeBackend extends EventEmitter {
  constructor(name, behaviour, log) {
    super()
    this.name = name
    this.transport = name
    this.behaviour = behaviour // 'ok' | 'fail' | 'hang'
    this.log = log
    this.status = 'disconnected'
    this.address = ''
    this.state = { media: { players: [], stillPool: [] } }
  }
  async connect(address) {
    this.log.push(`connect:${this.name}`)
    this.address = address
    this.status = 'connecting'
    this.emit('connection', { status: 'connecting' })
    if (this.behaviour === 'ok') {
      setImmediate(() => {
        this.status = 'connected'
        this.emit('connection', { status: 'connected' })
      })
    } else if (this.behaviour === 'fail') {
      throw new Error(`${this.name} unavailable`)
    }
    // 'hang': never answers
  }
  async disconnect() {
    this.log.push(`disconnect:${this.name}`)
    this.status = 'disconnected'
  }
  getResolution() {
    return { width: 1920, height: 1080 }
  }
  async prepareFiles() {}
  async uploadFile(i, p) {
    this.log.push(`upload:${this.name}:${i}`)
  }
  drop() {
    this.status = 'connecting'
    this.emit('connection', { status: 'connecting', message: 'lost' })
  }
}

function chain(behaviours, log, opts = {}) {
  const made = []
  const fb = new FallbackBackend({
    attemptTimeoutMs: 60,
    retryDelayMs: 30,
    ...opts,
    candidates: behaviours.map(([name, b, needsAddress]) => ({
      name,
      needsAddress,
      create: () => {
        const beh = typeof b === 'function' ? b() : b
        const fake = new FakeBackend(name, beh, log)
        made.push(fake)
        return fake
      },
    })),
  })
  return { fb, made }
}

const until = (emitter, pred) =>
  new Promise((r) => {
    const f = (e) => pred(e) && (emitter.off('connection', f), r(e))
    emitter.on('connection', f)
  })

test('uses SDK USB first when it works', async () => {
  const log = []
  const { fb } = chain([['usb', 'ok'], ['sdk-net', 'ok', true], ['atem', 'ok', true]], log)
  const connected = until(fb, (e) => e.status === 'connected')
  await fb.connect('10.0.0.5')
  await connected
  assert.equal(fb.transport, 'usb')
  assert.deepEqual(log, ['connect:usb'])
  await fb.uploadFile(0, 'x.png', 'x')
  assert.ok(log.includes('upload:usb:0'))
  await fb.disconnect()
})

test('falls through USB failure and SDK timeout to atem-connection', async () => {
  const log = []
  const { fb } = chain([['usb', 'fail'], ['sdk-net', 'hang', true], ['atem', 'ok', true]], log)
  const connected = until(fb, (e) => e.status === 'connected')
  await fb.connect('10.0.0.5')
  const evt = await connected
  assert.equal(fb.transport, 'atem')
  assert.match(evt.message, /usb unavailable/)
  assert.match(evt.message, /no answer/)
  assert.ok(log.includes('disconnect:sdk-net'), 'timed-out backend is torn down')
  await fb.disconnect()
})

test('Ethernet candidates are skipped when no IP is set', async () => {
  const log = []
  const { fb } = chain([['usb', 'fail'], ['sdk-net', 'ok', true], ['atem', 'ok', true]], log)
  const err = until(fb, (e) => e.status === 'error')
  await fb.connect('')
  const e = await err
  assert.match(e.message, /no IP address set/)
  assert.deepEqual(log.filter((l) => l.startsWith('connect')), ['connect:usb'])
  await fb.disconnect()
})

test('when nothing connects it keeps retrying, then connects', async () => {
  const log = []
  let tries = 0
  const { fb } = chain([['usb', () => (++tries < 3 ? 'fail' : 'ok')]], log)
  const connected = until(fb, (e) => e.status === 'connected')
  await fb.connect('')
  await connected
  assert.equal(tries, 3)
  await fb.disconnect()
})

test('losing the active connection restarts the chain from USB', async () => {
  const log = []
  let usbUp = false
  const { fb, made } = chain([['usb', () => (usbUp ? 'ok' : 'fail')], ['atem', 'ok', true]], log)
  let connected = until(fb, (e) => e.status === 'connected')
  await fb.connect('10.0.0.5')
  await connected
  assert.equal(fb.transport, 'atem')
  usbUp = true // operator plugs the USB cable in, then Ethernet blips
  connected = until(fb, (e) => e.status === 'connected')
  made.find((m) => m.name === 'atem').drop()
  await connected
  assert.equal(fb.transport, 'usb')
  await fb.disconnect()
})

test('upload while searching fails fast and non-retryable', async () => {
  const log = []
  const { fb } = chain([['usb', 'hang']], log, { attemptTimeoutMs: 1000 })
  await fb.connect('')
  await assert.rejects(fb.uploadFile(0, 'x', 'x'), (e) => e.noRetry === true)
  await fb.disconnect()
})

test('disconnect during the search stops it', async () => {
  const log = []
  const { fb } = chain([['usb', 'hang'], ['atem', 'ok', true]], log)
  await fb.connect('10.0.0.5')
  await fb.disconnect()
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(!log.includes('connect:atem'))
  assert.equal(fb.status, 'disconnected')
})
