'use strict'

const { EventEmitter } = require('events')
const path = require('path')
const { UploadController } = require('./uploadController')
const { EncodedCache } = require('./encoder')
const { evaluateSafety } = require('./safety')
const { listPngs, stillNameFor } = require('./library')

const DESCRIPTION = 'ATEM Graphics Launcher'

/**
 * Glue between the switcher backend, the pre-encode cache and the upload scheduler.
 * Kept free of Electron so it can be tested headless.
 *
 * Events: 'upload' (status event + fileName), 'connection', 'safety', 'prefetch'
 */
class Launcher extends EventEmitter {
  constructor({ backend, cache = new EncodedCache(), maxRetries = 2, retryDelayMs = 250 } = {}) {
    super()
    this.cache = cache
    this.files = []
    this.folder = ''
    this._resKey = ''
    this.controller = new UploadController({
      upload: (slot, job) => this._upload(slot, job),
      maxRetries,
      retryDelayMs,
    })
    this.controller.on('status', (evt) => {
      this.emit('upload', { ...evt, fileName: evt.job?.name, filePath: evt.job?.path })
    })
    this._onConnection = (evt) => {
      this.emit('connection', { ...evt, testMode: Boolean(this.backend?.isTestMode) })
    }
    this._onState = (state) => {
      this.emit('safety', evaluateSafety(state))
      this._maybePrefetch()
    }
    if (backend) this.setBackend(backend)
  }

  async setBackend(backend) {
    if (this.backend) {
      this.backend.off('connection', this._onConnection)
      this.backend.off('state', this._onState)
      this.controller.clearPending('switcher changed')
      await this.backend.disconnect()
    }
    this.backend = backend
    backend.on('connection', this._onConnection)
    backend.on('state', this._onState)
  }

  async connect(address) {
    await this.backend.connect(address)
  }

  loadFolder(folder) {
    this.folder = folder
    this.files = listPngs(folder)
    this._resKey = '' // force a fresh prefetch for the new folder
    this._maybePrefetch()
    return this.files
  }

  /** Operator clicked a graphic. Latest click per slot always wins. */
  send(slot, filePath) {
    if (slot !== 1 && slot !== 2) throw new Error('Slot must be 1 or 2')
    const name = path.basename(filePath)
    // A double-click on the graphic that is already going out is not a new request.
    const active = this.controller.activeJob
    if (active && active.slot === slot && active.job.path === filePath && !this.controller.hasPending(slot)) {
      return active.job
    }
    return this.controller.request(slot, { path: filePath, name })
  }

  async _upload(slot, job) {
    const resolution = this.backend.getResolution()
    if (!resolution) {
      const err = new Error('Switcher not ready (video mode unknown). Check the connection.')
      err.noRetry = this.backend.status !== 'connected'
      throw err
    }
    const encoded = this.cache.get(job.path, resolution)
    await this.backend.uploadStill(slot - 1, encoded, stillNameFor(job.name), DESCRIPTION)
  }

  _maybePrefetch() {
    const res = this.backend?.getResolution?.()
    if (!res || this.files.length === 0) return
    const key = `${res.width}x${res.height}|${this.folder}`
    if (key === this._resKey) return
    this._resKey = key
    const files = this.files.map((f) => f.path)
    this.cache
      .prefetch(files, res, {
        shouldPause: () => this.controller.busy,
        onProgress: (done, total) => this.emit('prefetch', { done, total }),
      })
      .catch(() => {})
  }

  async shutdown() {
    this.controller.clearPending('shutdown')
    if (this.backend) await this.backend.disconnect()
  }
}

module.exports = { Launcher }
