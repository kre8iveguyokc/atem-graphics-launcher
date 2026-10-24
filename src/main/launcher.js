'use strict'

const { EventEmitter } = require('events')
const path = require('path')
const { UploadController } = require('./uploadController')
const { evaluateSafety } = require('./safety')
const { listPngs, stillNameFor } = require('./library')

const DESCRIPTION = 'ATEM Graphics Launcher'

/**
 * Glue between the switcher backend and the upload scheduler.
 * Kept free of Electron so it can be tested headless.
 *
 * A backend provides: status, address, state, transport, connect(address), disconnect(),
 * getResolution(), prepareFiles(paths, opts), clearPrepared(), uploadFile(stillIndex, path, name, description),
 * and emits 'connection' and 'state'.
 *
 * Events: 'upload' (status event + fileName), 'connection', 'safety', 'prefetch'
 */
class Launcher extends EventEmitter {
  constructor({ backend, maxRetries = 2, retryDelayMs = 250 } = {}) {
    super()
    this.files = []
    this.folder = ''
    this._prepKey = ''
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
      if (evt.status === 'connected') this._maybePrepare()
      else this._prepKey = '' // re-prepare after reconnect (it may be a different transport)
    }
    this._onState = (state) => {
      this.emit('safety', evaluateSafety(state))
      this._maybePrepare()
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
    this._prepKey = ''
    backend.on('connection', this._onConnection)
    backend.on('state', this._onState)
  }

  async connect(address) {
    await this.backend.connect(address)
  }

  loadFolder(folder) {
    this.folder = folder
    this.files = listPngs(folder)
    this._prepKey = '' // force a fresh prepare for the new folder
    this._maybePrepare()
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
    if (this.backend.status !== 'connected') {
      const err = new Error('Not connected to the switcher')
      err.noRetry = true
      throw err
    }
    await this.backend.uploadFile(slot - 1, job.path, stillNameFor(job.name), DESCRIPTION)
  }

  _maybePrepare() {
    const backend = this.backend
    if (!backend || backend.status !== 'connected' || this.files.length === 0) return
    const res = backend.getResolution?.()
    if (!res) return
    const key = `${backend.transport}|${res.width}x${res.height}|${this.folder}`
    if (key === this._prepKey) return
    this._prepKey = key
    const files = this.files.map((f) => f.path)
    Promise.resolve(
      backend.prepareFiles(files, {
        shouldPause: () => this.controller.busy,
        onProgress: (done, total) => this.emit('prefetch', { done, total }),
      })
    ).catch(() => {})
  }

  async shutdown() {
    this.controller.clearPending('shutdown')
    if (this.backend) await this.backend.disconnect()
  }
}

module.exports = { Launcher }
