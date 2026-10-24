'use strict'

const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const fs = require('fs')
const readline = require('readline')

const NO_RETRY_CODES = new Set(['not_connected', 'size_mismatch', 'bad_file', 'bad_request', 'sdk_unavailable'])

/**
 * Backend that drives the native agl-helper process, which uses the official
 * Blackmagic ATEM Switchers SDK. Running the SDK in its own process means an SDK
 * crash or hang can never take down the operator UI.
 *
 * One helper process per backend instance; it is started on connect() and
 * killed on disconnect().
 *
 * Events: 'connection' ({ status, address, transport, message? }), 'state'
 */
class HelperBackend extends EventEmitter {
  /**
   * @param {object} opts
   * @param {'usb'|'network'} opts.transport
   * @param {string} opts.helperPath path to agl-helper(.exe)
   */
  constructor({
    transport,
    helperPath,
    spawnFn = spawn,
    env,
    connectTimeoutMs = 10000,
    requestTimeoutMs = 15000,
    uploadTimeoutMs = 30000,
  }) {
    super()
    if (transport !== 'usb' && transport !== 'network') throw new Error('transport must be usb or network')
    this._transport = transport
    this._helperPath = helperPath
    this._spawn = spawnFn
    this._env = env
    this._connectTimeoutMs = connectTimeoutMs
    this._requestTimeoutMs = requestTimeoutMs
    this._uploadTimeoutMs = uploadTimeoutMs
    this._proc = null
    this._pending = new Map()
    this._seq = 0
    this._status = 'disconnected'
    this._address = ''
    this._snapshot = null
    this._state = undefined
    this._prepToken = 0
    this.isTestMode = false
    this.transport = transport === 'usb' ? 'USB · Blackmagic SDK' : 'Ethernet · Blackmagic SDK'
    this.helperInfo = null
  }

  get status() {
    return this._status
  }

  get address() {
    return this._transport === 'usb' ? 'USB' : this._address
  }

  get state() {
    return this._state
  }

  _setStatus(status, message) {
    this._status = status
    this.emit('connection', { status, address: this.address, transport: this.transport, message })
  }

  // ---- process & protocol -------------------------------------------------
  _start() {
    if (!this._helperPath || !fs.existsSync(this._helperPath)) {
      throw Object.assign(new Error('SDK helper not found in this build'), { code: 'helper_missing' })
    }
    const proc = this._spawn(this._helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this._env ? { ...process.env, ...this._env } : process.env,
    })
    this._proc = proc
    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => this._onLine(line))
    proc.stderr.on('data', (d) => this.emit('log', String(d).trim()))
    proc.on('error', (e) => this._onExit(`helper failed to start: ${e.message}`))
    proc.on('exit', (code, signal) => this._onExit(`helper exited (${signal || code})`))
    proc.stdin.on('error', () => {})
  }

  _onExit(reason) {
    if (!this._proc) return
    this._proc = null
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer)
      reject(Object.assign(new Error(reason), { code: 'helper_exited' }))
    }
    this._pending.clear()
    if (this._status !== 'disconnected') this._setStatus('error', reason)
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.event) return this._onEvent(msg)
    const p = this._pending.get(msg.id)
    if (!p) return
    this._pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else {
      const err = new Error(msg.error || 'helper error')
      err.code = msg.code
      if (NO_RETRY_CODES.has(msg.code)) err.noRetry = true
      p.reject(err)
    }
  }

  _onEvent(msg) {
    if (msg.event === 'state') {
      this._applySnapshot(msg)
    } else if (msg.event === 'connection' && msg.status === 'disconnected' && this._status === 'connected') {
      this._setStatus('connecting', msg.message || 'Lost connection')
    } else if (msg.event === 'log') {
      this.emit('log', msg.message)
    }
  }

  _request(cmd, params = {}, timeoutMs = this._requestTimeoutMs) {
    if (!this._proc) return Promise.reject(Object.assign(new Error('helper not running'), { code: 'not_connected', noRetry: true }))
    const id = ++this._seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(Object.assign(new Error(`helper did not answer "${cmd}" in ${timeoutMs} ms`), { code: 'timeout' }))
      }, timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n')
    })
  }

  // Convert the helper snapshot to the shape the rest of the app (safety checks) uses.
  _applySnapshot(s) {
    this._snapshot = s
    this._state = {
      settings: { videoMode: `${s.width}x${s.height}` },
      productName: s.productName,
      media: {
        players: (s.players || []).map((p) => ({ sourceType: p.sourceType, stillIndex: p.stillIndex })),
        stillPool: (s.stills || []).map((st) => ({ isUsed: Boolean(st.used), fileName: st.name || '', hash: '' })),
      },
    }
    this.emit('state', this._state)
  }

  // ---- backend interface --------------------------------------------------
  async connect(address) {
    await this.disconnect()
    this._address = address || ''
    this._setStatus('connecting')
    try {
      this._start()
      this.helperInfo = await this._request('hello', {}, 5000)
      if (!this.helperInfo.sdkAvailable) {
        throw Object.assign(new Error(this.helperInfo.reason || 'Blackmagic SDK not available'), { code: 'sdk_unavailable' })
      }
      const snap = await this._request(
        'connect',
        { transport: this._transport, address: this._transport === 'usb' ? '' : this._address },
        this._connectTimeoutMs
      )
      this._applySnapshot(snap)
      this._setStatus('connected', snap.productName)
    } catch (e) {
      this._kill()
      this._setStatus('error', e.message)
      throw e
    }
  }

  _kill() {
    const proc = this._proc
    this._proc = null
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer)
      reject(Object.assign(new Error('disconnected'), { code: 'not_connected', noRetry: true }))
    }
    this._pending.clear()
    if (proc) {
      try {
        proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
        proc.stdin.end()
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => proc.kill(), 1500)
      proc.once('exit', () => clearTimeout(t))
    }
  }

  async disconnect() {
    this._prepToken++
    const wasActive = this._proc || this._status !== 'disconnected'
    this._kill()
    this._snapshot = null
    this._state = undefined
    if (wasActive) this._setStatus('disconnected')
  }

  getResolution() {
    return this._snapshot ? { width: this._snapshot.width, height: this._snapshot.height } : null
  }

  /** Ask the helper to decode and convert graphics ahead of time (one at a time, pausing during uploads). */
  async prepareFiles(paths, { shouldPause = () => false, onProgress = () => {} } = {}) {
    const token = ++this._prepToken
    let done = 0
    for (const p of paths) {
      while (shouldPause()) {
        if (token !== this._prepToken) return { cancelled: true, done }
        await new Promise((r) => setTimeout(r, 50))
      }
      if (token !== this._prepToken || this._status !== 'connected') return { cancelled: true, done }
      try {
        await this._request('prepare', { path: p })
      } catch (e) {
        if (e.code === 'helper_exited' || e.code === 'not_connected') return { cancelled: true, done }
      }
      done++
      onProgress(done, paths.length)
    }
    return { cancelled: false, done }
  }

  clearPrepared() {
    this._prepToken++
  }

  async uploadFile(stillIndex, filePath, name) {
    if (this._status !== 'connected') {
      throw Object.assign(new Error('Not connected to the switcher'), { code: 'not_connected', noRetry: true })
    }
    return this._request('upload', { stillIndex, path: filePath, name }, this._uploadTimeoutMs)
  }
}

module.exports = { HelperBackend }
