'use strict'

const { EventEmitter } = require('events')
const { EncodedCache } = require('../encoder')

/**
 * TEST MODE ONLY. A stand-in switcher for rehearsing the UI without hardware.
 * It never touches the network or USB. The UI shows a TEST MODE banner whenever this is active.
 *
 * Simulates: a 1080p switcher, media players 1/2 on stills 1/2, and transfer time
 * proportional to the encoded size. Files are really decoded and encoded so bad
 * graphics fail the same way they would live.
 */
class TestBackend extends EventEmitter {
  constructor({ bytesPerSecond = 20 * 1024 * 1024, baseLatencyMs = 150, failRate = 0, cache = new EncodedCache() } = {}) {
    super()
    this._bps = bytesPerSecond
    this._base = baseLatencyMs
    this._failRate = failRate
    this._cache = cache
    this._status = 'disconnected'
    this._address = 'test-mode'
    this.isTestMode = true
    this.transport = 'Simulated'
    this._state = {
      settings: { videoMode: 'simulated-1080p' },
      media: {
        players: [
          { sourceType: 1, stillIndex: 0, clipIndex: 0, playing: false, loop: false, atBeginning: true, clipFrame: 0 },
          { sourceType: 1, stillIndex: 1, clipIndex: 0, playing: false, loop: false, atBeginning: true, clipFrame: 0 },
        ],
        stillPool: Array.from({ length: 20 }, () => ({ isUsed: false, hash: '', fileName: '' })),
        clipPool: [],
      },
    }
  }

  get status() {
    return this._status
  }

  get address() {
    return this._address
  }

  get state() {
    return this._state
  }

  async connect() {
    this._status = 'connected'
    this.emit('connection', {
      status: 'connected',
      address: this._address,
      transport: this.transport,
      message: 'Simulated switcher',
    })
    this.emit('state', this._state)
  }

  async disconnect() {
    this._status = 'disconnected'
    this.emit('connection', { status: 'disconnected', address: this._address, transport: this.transport })
  }

  getResolution() {
    return { width: 1920, height: 1080 }
  }

  prepareFiles(paths, opts = {}) {
    return this._cache.prefetch(paths, this.getResolution(), opts)
  }

  clearPrepared() {
    this._cache.clear()
  }

  async uploadFile(stillIndex, filePath, name) {
    const encoded = this._cache.get(filePath, this.getResolution())
    const ms = this._base + (encoded.encodedData.length / this._bps) * 1000
    await new Promise((r) => setTimeout(r, ms))
    if (this._failRate && Math.random() < this._failRate) throw new Error('Simulated transfer failure')
    this._state.media.stillPool[stillIndex] = { isUsed: true, hash: encoded.hash || '', fileName: name }
    this.emit('state', this._state)
  }
}

module.exports = { TestBackend }
