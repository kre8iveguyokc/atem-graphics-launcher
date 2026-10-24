'use strict'

const { EventEmitter } = require('events')

/**
 * Tries switcher backends in order and uses the first that connects:
 *   1. Blackmagic SDK over USB-C
 *   2. Blackmagic SDK over Ethernet
 *   3. atem-connection over Ethernet
 *
 * If the active backend loses its connection, the whole chain is retried from the
 * top, so plugging the USB cable back in moves the app back to USB.
 *
 * Events: 'connection' ({ status, address, transport, message?, attempts? }), 'state', 'log'
 */
class FallbackBackend extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Array<{ name: string, create: () => object, needsAddress?: boolean }>} opts.candidates
   */
  constructor({ candidates, attemptTimeoutMs = 8000, retryDelayMs = 3000 }) {
    super()
    this._candidates = candidates
    this._attemptTimeoutMs = attemptTimeoutMs
    this._retryDelayMs = retryDelayMs
    this._active = null
    this._address = ''
    this._status = 'disconnected'
    this._run = 0
    this._retryTimer = null
    this.isTestMode = false
  }

  get status() {
    return this._status
  }

  get address() {
    return this._active ? this._active.address : this._address
  }

  get transport() {
    return this._active ? this._active.transport : 'Searching'
  }

  get state() {
    return this._active?.state
  }

  get active() {
    return this._active
  }

  _emitStatus(status, message, extra = {}) {
    this._status = status
    this.emit('connection', { status, address: this.address, transport: this.transport, message, ...extra })
  }

  async connect(address) {
    await this.disconnect()
    this._address = address || ''
    this._connectChain(++this._run)
  }

  async _connectChain(run) {
    clearTimeout(this._retryTimer)
    this._emitStatus('connecting', 'Looking for the switcher…')
    const attempts = []
    for (const cand of this._candidates) {
      if (run !== this._run) return
      if (cand.needsAddress && !this._address) {
        attempts.push(`${cand.name}: no IP address set`)
        continue
      }
      const backend = cand.create()
      try {
        await this._attempt(backend, run)
        if (run !== this._run) {
          await backend.disconnect()
          return
        }
        this._adopt(backend, run, attempts)
        return
      } catch (e) {
        attempts.push(`${cand.name}: ${e.message}`)
        this.emit('log', `${cand.name} failed: ${e.message}`)
        backend.removeAllListeners?.()
        await backend.disconnect().catch(() => {})
      }
    }
    if (run !== this._run) return
    this._emitStatus('error', `No connection. ${attempts.join(' · ')}`, { attempts })
    this._retryTimer = setTimeout(() => {
      if (run === this._run) this._connectChain(run)
    }, this._retryDelayMs)
  }

  /** Resolve when the backend reports 'connected', reject on error or timeout. */
  _attempt(backend, run) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        backend.off('connection', onConn)
        err ? reject(err) : resolve()
      }
      const onConn = (evt) => {
        if (evt.status === 'connected') finish()
        else if (evt.status === 'error') finish(new Error(evt.message || 'connection failed'))
      }
      const timer = setTimeout(() => finish(new Error(`no answer within ${this._attemptTimeoutMs / 1000}s`)), this._attemptTimeoutMs)
      backend.on('connection', onConn)
      Promise.resolve(backend.connect(this._address)).then(
        () => {
          if (backend.status === 'connected') finish()
        },
        (e) => finish(e)
      )
    })
  }

  _adopt(backend, run, attempts) {
    this._active = backend
    backend.on('state', (s) => {
      if (this._active === backend) this.emit('state', s)
    })
    backend.on('log', (m) => this.emit('log', m))
    backend.on('connection', (evt) => {
      if (this._active !== backend) return
      if (evt.status === 'connected') {
        this._emitStatus('connected', evt.message)
        return
      }
      // Lost it: drop this backend and search again from the top (USB first).
      this._active = null
      backend.removeAllListeners()
      backend.disconnect().catch(() => {})
      if (run === this._run) this._connectChain(run)
    })
    this._emitStatus('connected', attempts.length ? `Fallback after: ${attempts.join(' · ')}` : undefined)
    if (backend.state) this.emit('state', backend.state)
  }

  async disconnect() {
    this._run++
    clearTimeout(this._retryTimer)
    const active = this._active
    this._active = null
    if (active) {
      active.removeAllListeners()
      await active.disconnect().catch(() => {})
    }
    if (this._status !== 'disconnected') this._emitStatus('disconnected')
  }

  _require() {
    if (!this._active || this._status !== 'connected') {
      throw Object.assign(new Error('Not connected to the switcher'), { code: 'not_connected', noRetry: true })
    }
    return this._active
  }

  getResolution() {
    return this._active?.getResolution() ?? null
  }

  prepareFiles(paths, opts) {
    return this._active ? this._active.prepareFiles(paths, opts) : Promise.resolve({ done: 0 })
  }

  clearPrepared() {
    this._active?.clearPrepared?.()
  }

  async uploadFile(stillIndex, filePath, name, description) {
    return this._require().uploadFile(stillIndex, filePath, name, description)
  }
}

module.exports = { FallbackBackend }
