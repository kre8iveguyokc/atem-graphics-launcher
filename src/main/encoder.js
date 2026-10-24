'use strict'

const fs = require('fs')
const { PNG } = require('pngjs')
// generateUploadBufferInfo is atem-connection's own encoder (RGBA -> YUVA 4:2:2 + RLE).
// It is what Atem.uploadStill() runs internally; calling it ahead of time just moves
// that work off the click path. It does NOT premultiply: RGB and alpha are passed
// straight through, so already-premultiplied PNGs arrive at the switcher unchanged.
const { generateUploadBufferInfo } = require('atem-connection/dist/dataTransfer/dataTransferUploadBuffer')

/** Decode a PNG to a raw RGBA buffer exactly as stored in the file (no colour management, no premultiply). */
function decodePng(fileBuffer) {
  const png = PNG.sync.read(fileBuffer)
  return { width: png.width, height: png.height, data: png.data }
}

/**
 * Encode a PNG file into the ATEM's native upload format for a given resolution.
 * @returns {{encodedData:Buffer, rawDataLength:number, isRleEncoded:boolean, hash:string}}
 */
function encodeFileForAtem(filePath, resolution) {
  const decoded = decodePng(fs.readFileSync(filePath))
  if (decoded.width !== resolution.width || decoded.height !== resolution.height) {
    const err = new Error(
      `Graphic is ${decoded.width}x${decoded.height} but the switcher is running ${resolution.width}x${resolution.height}`
    )
    err.noRetry = true
    throw err
  }
  return generateUploadBufferInfo(decoded.data, resolution, true)
}

/**
 * Cache of pre-encoded graphics so a click goes straight to the network.
 * Entries are keyed by file path + resolution and invalidated when the file's
 * size or modification time changes (e.g. a graphic re-exported mid-show).
 */
class EncodedCache {
  constructor({ encode = encodeFileForAtem, maxBytes = 1024 * 1024 * 1024, stat = fs.statSync } = {}) {
    this._encode = encode
    this._maxBytes = maxBytes
    this._stat = stat
    this._entries = new Map()
    this._bytes = 0
    this._prefetchToken = 0
  }

  get bytes() {
    return this._bytes
  }

  get size() {
    return this._entries.size
  }

  _key(filePath, resolution) {
    return `${resolution.width}x${resolution.height}|${filePath}`
  }

  _signature(filePath) {
    const s = this._stat(filePath)
    return `${s.size}:${s.mtimeMs}`
  }

  has(filePath, resolution) {
    const e = this._entries.get(this._key(filePath, resolution))
    if (!e) return false
    try {
      return e.sig === this._signature(filePath)
    } catch {
      return false
    }
  }

  /** Return the encoded buffer, encoding (and caching) if needed. */
  get(filePath, resolution) {
    const key = this._key(filePath, resolution)
    const sig = this._signature(filePath)
    const hit = this._entries.get(key)
    if (hit && hit.sig === sig) return hit.value
    if (hit) this._remove(key)
    const value = this._encode(filePath, resolution)
    const size = value.encodedData.length
    if (this._bytes + size <= this._maxBytes) {
      this._entries.set(key, { sig, value, size })
      this._bytes += size
    }
    return value
  }

  _remove(key) {
    const e = this._entries.get(key)
    if (e) {
      this._bytes -= e.size
      this._entries.delete(key)
    }
  }

  clear() {
    this._entries.clear()
    this._bytes = 0
    this._prefetchToken++
  }

  /**
   * Encode files in the background, one per event-loop turn.
   * Pauses while shouldPause() is true (an upload is on the wire) so it never
   * competes with a live transfer. Starting a new prefetch cancels the old one.
   */
  async prefetch(files, resolution, { shouldPause = () => false, onProgress = () => {} } = {}) {
    const token = ++this._prefetchToken
    let done = 0
    for (const file of files) {
      while (shouldPause()) {
        if (token !== this._prefetchToken) return { cancelled: true, done }
        await new Promise((r) => setTimeout(r, 50))
      }
      if (token !== this._prefetchToken) return { cancelled: true, done }
      if (this._bytes >= this._maxBytes) break
      try {
        if (!this.has(file, resolution)) this.get(file, resolution)
      } catch {
        // Bad file: it will surface a proper error if the operator clicks it.
      }
      done++
      onProgress(done, files.length)
      await new Promise((r) => setImmediate(r))
    }
    return { cancelled: false, done }
  }
}

module.exports = { decodePng, encodeFileForAtem, EncodedCache }
