'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { AtemBackend } = require('../src/main/backends/atemBackend')
const { Launcher } = require('../src/main/launcher')
const { getVideoModeInfo } = require('atem-connection/dist/lib/videoMode')
const { Enums, Atem } = require('atem-connection')

const ALLOWED = new Set(['connect', 'destroy', 'uploadStill', 'on', 'removeAllListeners'])

/**
 * Fake Atem that records every method call. Any call outside the allowed list
 * (cut, setDownstreamKeyOnAir, setMediaPlayerSource, …) fails the test.
 */
function makeFakeAtemClass(log) {
  return class FakeAtem extends EventEmitter {
    constructor(opts) {
      super()
      log.push(['constructor', opts])
      this.state = {
        settings: { videoMode: Enums.VideoMode.N1080p5994 },
        media: {
          players: [
            { sourceType: 1, stillIndex: 0 },
            { sourceType: 1, stillIndex: 1 },
          ],
          stillPool: [
            { isUsed: true, fileName: 'old' },
            { isUsed: false, fileName: '' },
          ],
        },
      }
      return new Proxy(this, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv)
          if (typeof v === 'function' && typeof prop === 'string' && !prop.startsWith('_')) {
            return (...args) => {
              const own = Object.prototype.hasOwnProperty.call(FakeAtem.prototype, prop)
              if (own || ['on', 'removeAllListeners'].includes(prop)) {
                if (!ALLOWED.has(prop)) throw new Error(`Forbidden ATEM call: ${prop}`)
                log.push([prop, ...args])
              }
              return v.apply(target, args)
            }
          }
          return v
        },
      })
    }
    async connect(address) {
      setImmediate(() => this.emit('connected'))
    }
    async destroy() {}
    async uploadStill(index, data, name, description) {}
    // Present so a mistaken call is caught rather than "not a function".
    async cut() {}
    async setDownstreamKeyOnAir() {}
    async setMediaPlayerSource() {}
    async autoTransition() {}
    async changeProgramInput() {}
  }
}

test('the real atem-connection Atem class has uploadStill with the expected signature', () => {
  assert.equal(typeof Atem.prototype.uploadStill, 'function')
  assert.equal(Atem.prototype.uploadStill.length, 5) // index, data, name, description, options
})

test('backend only connects, reads state and uploads stills', async () => {
  const log = []
  const backend = new AtemBackend({ AtemClass: makeFakeAtemClass(log), getVideoModeInfo })
  const launcher = new Launcher({ backend, retryDelayMs: 1 })
  const connected = new Promise((r) => backend.on('connection', (e) => e.status === 'connected' && r()))
  await launcher.connect('10.0.0.5')
  await connected

  assert.deepEqual(backend.getResolution(), { width: 1920, height: 1080 })
  const fixtures = path.join(__dirname, 'fixtures')
  const files = launcher.loadFolder(fixtures)
  launcher.send(1, files[0].path)
  launcher.send(2, files[1].path)
  await launcher.controller.whenIdle()
  await launcher.shutdown()

  const calls = log.map((c) => c[0])
  for (const c of calls) assert.ok(['constructor', ...ALLOWED].includes(c), `unexpected call ${c}`)
  const uploads = log.filter((c) => c[0] === 'uploadStill')
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0][1], 0, 'slot 1 -> still index 0')
  assert.equal(uploads[1][1], 1, 'slot 2 -> still index 1')
  assert.equal(uploads[0][3], '01-lower-third-blue')
  assert.equal(uploads[0][2].isRleEncoded, true)
  assert.equal(log.find((c) => c[0] === 'constructor')[1].disableMultithreaded, true)
})

test('upload while disconnected fails fast without retries', async () => {
  const log = []
  const backend = new AtemBackend({ AtemClass: makeFakeAtemClass(log), getVideoModeInfo })
  const launcher = new Launcher({ backend, retryDelayMs: 1 })
  const errors = []
  launcher.on('upload', (e) => e.state === 'error' && errors.push(e))
  launcher.files = [{ name: 'x.png', path: path.join(__dirname, 'fixtures', fs.readdirSync(path.join(__dirname, 'fixtures'))[0]) }]
  launcher.send(1, launcher.files[0].path)
  await launcher.controller.whenIdle()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].attempt, 1)
})

test('double-click on the graphic already sending does not queue a duplicate', async () => {
  let release
  const backend = new EventEmitter()
  Object.assign(backend, {
    status: 'connected',
    getResolution: () => ({ width: 1920, height: 1080 }),
    uploadStill: () => new Promise((r) => (release = r)),
    disconnect: async () => {},
  })
  const launcher = new Launcher({ backend })
  const files = launcher.loadFolder(path.join(__dirname, 'fixtures'))
  launcher.send(1, files[0].path)
  await new Promise((r) => setTimeout(r, 20))
  launcher.send(1, files[0].path)
  assert.equal(launcher.controller.hasPending(1), false)
  release()
  await launcher.controller.whenIdle()
})
