'use strict'

const { EventEmitter } = require('events')

/**
 * Latest-click-wins upload scheduler.
 *
 * - Each slot keeps at most ONE pending job: a new click on a slot replaces
 *   whatever was waiting for that slot (the old job is reported "superseded").
 * - Only one transfer runs at a time (the ATEM media pool has a single
 *   stills lock, so transfers are serialized anyway).
 * - A transfer already on the wire cannot be cancelled by the ATEM protocol,
 *   so it is allowed to finish; the newest pending job for that slot runs
 *   immediately afterwards.
 * - Failed uploads are retried, but only while no newer click is waiting
 *   for that slot. A stale graphic is never retried over a newer one.
 *
 * Status events: { slot, state, job, attempt?, error?, durationMs? }
 *   state = 'queued' | 'superseded' | 'uploading' | 'retrying' | 'done' | 'error'
 */
class UploadController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(slot:number, job:object) => Promise<void>} opts.upload performs one transfer
   * @param {number} [opts.maxRetries=2] extra attempts after the first failure
   * @param {number} [opts.retryDelayMs=250]
   */
  constructor({ upload, maxRetries = 2, retryDelayMs = 250 }) {
    super()
    if (typeof upload !== 'function') throw new Error('upload function required')
    this._upload = upload
    this._maxRetries = maxRetries
    this._retryDelayMs = retryDelayMs
    this._pending = new Map() // slot -> job
    this._seq = 0
    this._active = null // { slot, job }
    this._idleWaiters = []
  }

  get busy() {
    return this._active !== null
  }

  get activeJob() {
    return this._active
  }

  hasPending(slot) {
    return this._pending.has(slot)
  }

  /** Queue a graphic for a slot. Returns the job object. */
  request(slot, payload) {
    const job = { ...payload, id: ++this._seq, requestedAt: Date.now() }
    const previous = this._pending.get(slot)
    this._pending.set(slot, job)
    if (previous) this._emit({ slot, state: 'superseded', job: previous })
    this._emit({ slot, state: 'queued', job })
    this._pump()
    return job
  }

  /** Drop everything that has not started yet (e.g. on disconnect). */
  clearPending(reason = 'cleared') {
    for (const [slot, job] of this._pending) {
      this._emit({ slot, state: 'superseded', job, reason })
    }
    this._pending.clear()
  }

  /** Resolves when nothing is uploading and nothing is pending. */
  whenIdle() {
    if (!this._active && this._pending.size === 0) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  _emit(evt) {
    this.emit('status', evt)
  }

  _nextPending() {
    // Oldest request first across slots, so neither slot can starve the other.
    let pick = null
    for (const [slot, job] of this._pending) {
      if (!pick || job.id < pick.job.id) pick = { slot, job }
    }
    return pick
  }

  _hasNewer(slot, job) {
    const p = this._pending.get(slot)
    return Boolean(p && p.id > job.id)
  }

  async _pump() {
    if (this._active) return
    const next = this._nextPending()
    if (!next) {
      const waiters = this._idleWaiters.splice(0)
      waiters.forEach((w) => w())
      return
    }
    this._pending.delete(next.slot)
    this._active = next
    try {
      await this._run(next.slot, next.job)
    } finally {
      this._active = null
      // Defer so status listeners see a consistent "not busy" state.
      setImmediate(() => this._pump())
    }
  }

  async _run(slot, job) {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now()
      this._emit({ slot, state: attempt === 1 ? 'uploading' : 'retrying', job, attempt })
      try {
        await this._upload(slot, job)
        this._emit({ slot, state: 'done', job, attempt, durationMs: Date.now() - started })
        return
      } catch (error) {
        const canRetry = attempt <= this._maxRetries && !this._hasNewer(slot, job) && !error?.noRetry
        if (!canRetry) {
          this._emit({ slot, state: 'error', job, attempt, error: String(error?.message || error) })
          return
        }
        await new Promise((r) => setTimeout(r, this._retryDelayMs))
        if (this._hasNewer(slot, job)) {
          // Operator clicked something else while we waited: give up on the stale graphic.
          this._emit({ slot, state: 'superseded', job, reason: 'newer click during retry' })
          return
        }
      }
    }
  }
}

module.exports = { UploadController }
