'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { UploadController } = require('../src/main/uploadController')

function deferredUploader() {
  const calls = []
  const upload = (slot, job) =>
    new Promise((resolve, reject) => {
      calls.push({ slot, name: job.name, resolve, reject })
    })
  return { calls, upload }
}

const tick = () => new Promise((r) => setImmediate(r))

test('latest click wins: intermediate clicks are skipped', async () => {
  const { calls, upload } = deferredUploader()
  const c = new UploadController({ upload })
  const events = []
  c.on('status', (e) => events.push(`${e.state}:${e.job.name}`))

  c.request(1, { name: 'A' })
  c.request(1, { name: 'B' })
  c.request(1, { name: 'C' })
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'A') // A was already on the wire
  calls[0].resolve()
  await tick()
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].name, 'C') // B never uploads
  calls[1].resolve()
  await c.whenIdle()
  assert.ok(events.includes('superseded:B'))
  assert.ok(!events.includes('uploading:B'))
  assert.deepEqual(
    events.filter((e) => e.startsWith('done')),
    ['done:A', 'done:C']
  )
})

test('slots are independent and served oldest-first', async () => {
  const { calls, upload } = deferredUploader()
  const c = new UploadController({ upload })
  c.request(1, { name: 'A' })
  c.request(2, { name: 'X' })
  c.request(1, { name: 'B' })
  await tick()
  calls[0].resolve() // A
  await tick()
  await tick()
  assert.equal(calls[1].name, 'X') // slot 2's request is older than B
  calls[1].resolve()
  await tick()
  await tick()
  assert.equal(calls[2].name, 'B')
  calls[2].resolve()
  await c.whenIdle()
  assert.deepEqual(
    calls.map((x) => `${x.slot}${x.name}`),
    ['1A', '2X', '1B']
  )
})

test('only one transfer at a time', async () => {
  let inFlight = 0
  let max = 0
  const c = new UploadController({
    upload: async () => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    },
  })
  for (let i = 0; i < 10; i++) c.request((i % 2) + 1, { name: String(i) })
  await c.whenIdle()
  assert.equal(max, 1)
})

test('failed upload is retried when nothing newer is waiting', async () => {
  let n = 0
  const c = new UploadController({
    retryDelayMs: 1,
    upload: async () => {
      n++
      if (n < 3) throw new Error('boom')
    },
  })
  const states = []
  c.on('status', (e) => states.push(e.state))
  c.request(1, { name: 'A' })
  await c.whenIdle()
  assert.equal(n, 3)
  assert.deepEqual(states, ['queued', 'uploading', 'retrying', 'retrying', 'done'])
})

test('gives up after maxRetries and reports the error', async () => {
  const c = new UploadController({ retryDelayMs: 1, maxRetries: 2, upload: async () => Promise.reject(new Error('nope')) })
  const errors = []
  c.on('status', (e) => e.state === 'error' && errors.push(e))
  c.request(1, { name: 'A' })
  await c.whenIdle()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].attempt, 3)
  assert.match(errors[0].error, /nope/)
})

test('a stale graphic is never retried over a newer click', async () => {
  const uploaded = []
  let first = true
  const c = new UploadController({
    retryDelayMs: 20,
    upload: async (slot, job) => {
      if (first) {
        first = false
        throw new Error('fail A')
      }
      uploaded.push(job.name)
    },
  })
  const states = []
  c.on('status', (e) => states.push(`${e.state}:${e.job.name}`))
  c.request(1, { name: 'A' })
  await tick()
  c.request(1, { name: 'B' }) // arrives while A waits to retry
  await c.whenIdle()
  assert.deepEqual(uploaded, ['B'])
  assert.ok(!states.includes('retrying:A'))
})

test('noRetry errors fail immediately', async () => {
  let n = 0
  const c = new UploadController({
    retryDelayMs: 1,
    upload: async () => {
      n++
      const e = new Error('not connected')
      e.noRetry = true
      throw e
    },
  })
  c.request(1, { name: 'A' })
  await c.whenIdle()
  assert.equal(n, 1)
})

test('clearPending drops queued jobs but not the active one', async () => {
  const { calls, upload } = deferredUploader()
  const c = new UploadController({ upload })
  c.request(1, { name: 'A' })
  c.request(2, { name: 'X' })
  await tick()
  c.clearPending()
  calls[0].resolve()
  await c.whenIdle()
  assert.equal(calls.length, 1)
})
