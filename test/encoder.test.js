'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PNG } = require('pngjs')
const { decodePng, encodeFileForAtem, EncodedCache } = require('../src/main/encoder')
const { generateUploadBufferInfo } = require('atem-connection/dist/dataTransfer/dataTransferUploadBuffer')
const { getVideoModeInfo } = require('atem-connection/dist/lib/videoMode')
const { Enums } = require('atem-connection')

const RES_1080 = { width: 1920, height: 1080 }
const FIXTURES = path.join(__dirname, 'fixtures')
const fixture = (n) => path.join(FIXTURES, fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.png')).sort()[n])

function tmpPng(width, height, fill) {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) fill(png.data, i)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agl-')), 'g.png')
  fs.writeFileSync(file, PNG.sync.write(png))
  return { file, raw: Buffer.from(png.data) }
}

test('atem-connection reports 1920x1080 for 1080p modes (sanity check of the dependency)', () => {
  const info = getVideoModeInfo(Enums.VideoMode.N1080p5994)
  assert.equal(info.width, 1920)
  assert.equal(info.height, 1080)
})

test('PNG decode returns the stored RGBA bytes exactly (no premultiply, no colour management)', () => {
  // A semi-transparent, already-premultiplied pixel: colour <= alpha.
  const { file, raw } = tmpPng(64, 36, (d, i) => {
    d[i] = 40
    d[i + 1] = 80
    d[i + 2] = 120
    d[i + 3] = 128
  })
  const decoded = decodePng(fs.readFileSync(file))
  assert.equal(decoded.width, 64)
  assert.ok(decoded.data.equals(raw), 'decoded pixels must be byte-identical to the file')
})

test('encoded output is byte-identical to atem-connection encoding the raw pixels itself', () => {
  const file = fixture(0)
  const raw = decodePng(fs.readFileSync(file)).data
  const ours = encodeFileForAtem(file, RES_1080)
  const theirs = generateUploadBufferInfo(raw, RES_1080, true)
  assert.equal(ours.isRleEncoded, true)
  assert.equal(ours.rawDataLength, 1920 * 1080 * 4)
  assert.ok(ours.encodedData.equals(theirs.encodedData))
  assert.equal(ours.hash, theirs.hash)
})

test('lower thirds compress heavily with RLE (small transfers)', () => {
  const enc = encodeFileForAtem(fixture(0), RES_1080)
  assert.ok(enc.encodedData.length < enc.rawDataLength / 10, `encoded ${enc.encodedData.length} bytes`)
})

test('size mismatch gives a clear, non-retryable error', () => {
  const { file } = tmpPng(1280, 720, () => {})
  assert.throws(
    () => encodeFileForAtem(file, RES_1080),
    (e) => /1280x720/.test(e.message) && e.noRetry === true
  )
})

test('cache: second get is a hit, changed file is re-encoded', () => {
  let encodes = 0
  const cache = new EncodedCache({
    encode: (f, r) => {
      encodes++
      return encodeFileForAtem(f, r)
    },
  })
  const { file } = tmpPng(1920, 1080, (d, i) => {
    d[i + 3] = 0
  })
  const a = cache.get(file, RES_1080)
  const b = cache.get(file, RES_1080)
  assert.equal(encodes, 1)
  assert.equal(a, b)
  // Rewrite the file with different content and a later mtime.
  const png = new PNG({ width: 1920, height: 1080 })
  png.data.fill(255)
  fs.writeFileSync(file, PNG.sync.write(png))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  const c = cache.get(file, RES_1080)
  assert.equal(encodes, 2)
  assert.notEqual(c.hash, a.hash)
})

test('cache respects its memory budget', () => {
  const cache = new EncodedCache({ maxBytes: 1 })
  cache.get(fixture(0), RES_1080)
  assert.equal(cache.size, 0)
})

test('prefetch encodes every file and pauses while an upload is busy', async () => {
  const cache = new EncodedCache()
  const files = [0, 1, 2, 3].map(fixture)
  let busy = true
  setTimeout(() => (busy = false), 120)
  const started = Date.now()
  const result = await cache.prefetch(files, RES_1080, { shouldPause: () => busy })
  assert.equal(result.done, 4)
  assert.ok(Date.now() - started >= 100, 'should have waited for the busy upload')
  for (const f of files) assert.ok(cache.has(f, RES_1080))
})
