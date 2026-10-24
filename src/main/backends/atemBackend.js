'use strict'

const { EventEmitter } = require('events')

/**
 * Real hardware backend built on atem-connection.
 *
 * This class deliberately exposes ONLY: connect, disconnect, read state, and
 * uploadStill. It never sends switching commands (no keyers, program/preview,
 * transitions or media-player assignments). test/noControl.test.js enforces that.
 *
 * Events: 'connection' ({ status, address, message? }), 'state' (AtemState)
 */
class AtemBackend extends EventEmitter {
  constructor({ AtemClass, getVideoModeInfo } = {}) {
    super()
    if (!AtemClass || !getVideoModeInfo) {
      const lib = require('atem-connection')
      AtemClass = AtemClass || lib.Atem
      getVideoModeInfo = getVideoModeInfo || require('atem-connection/dist/lib/videoMode').getVideoModeInfo
    }
    this._AtemClass = AtemClass
    this._getVideoModeInfo = getVideoModeInfo
    this._atem = null
    this._address = ''
    this._status = 'disconnected'
    this.isTestMode = false
  }

  get status() {
    return this._status
  }

  get address() {
    return this._address
  }

  get state() {
    return this._atem?.state
  }

  _setStatus(status, message) {
    this._status = status
    this.emit('connection', { status, address: this._address, message })
  }

  async connect(address) {
    await this.disconnect()
    this._address = address
    // Single-threaded socket: simplest and most robust inside a packaged Electron app.
    const atem = new this._AtemClass({ disableMultithreaded: true })
    this._atem = atem
    atem.on('connected', () => {
      if (this._atem !== atem) return
      this._setStatus('connected')
      this.emit('state', atem.state)
    })
    atem.on('disconnected', () => {
      if (this._atem !== atem) return
      this._setStatus('connecting', 'Lost connection, retrying…')
    })
    atem.on('stateChanged', (state, paths) => {
      if (this._atem !== atem) return
      if (paths.some((p) => p.startsWith('media') || p.startsWith('settings'))) this.emit('state', state)
    })
    atem.on('error', (msg) => {
      if (this._atem !== atem) return
      this.emit('connection', { status: this._status, address, message: String(msg) })
    })
    this._setStatus('connecting')
    try {
      await atem.connect(address)
    } catch (e) {
      this._setStatus('error', String(e?.message || e))
    }
  }

  async disconnect() {
    const atem = this._atem
    this._atem = null
    if (atem) {
      atem.removeAllListeners()
      try {
        await atem.destroy()
      } catch {
        /* ignore */
      }
      this._setStatus('disconnected')
    }
  }

  /** { width, height } of the switcher's current video mode, or null if unknown. */
  getResolution() {
    const mode = this._atem?.state?.settings?.videoMode
    if (mode === undefined) return null
    const info = this._getVideoModeInfo(mode)
    return info ? { width: info.width, height: info.height } : null
  }

  /**
   * Replace a media-pool still.
   * @param {number} stillIndex 0-based (slot 1 = 0)
   * @param {object} bufferInfo pre-encoded UploadBufferInfo from encoder.js
   */
  async uploadStill(stillIndex, bufferInfo, name, description) {
    if (this._status !== 'connected' || !this._atem) {
      const err = new Error('Not connected to the switcher')
      err.noRetry = true
      throw err
    }
    await this._atem.uploadStill(stillIndex, bufferInfo, name, description)
  }
}

module.exports = { AtemBackend }
