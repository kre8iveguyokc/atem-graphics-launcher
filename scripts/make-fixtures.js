'use strict'

// Generates small 1920x1080 premultiplied-alpha lower thirds used by the tests,
// the smoke test, and as "sample graphics" in test mode.
// Run: npm run fixtures

const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')

const W = 1920
const H = 1080
const OUT = path.join(__dirname, '..', 'test', 'fixtures')

// 5x7 digit font for the big number on each sample.
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
}

function put(png, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  // Premultiplied: colour channels are already scaled by alpha.
  png.data[i] = Math.round((r * a) / 255)
  png.data[i + 1] = Math.round((g * a) / 255)
  png.data[i + 2] = Math.round((b * a) / 255)
  png.data[i + 3] = a
}

function lowerThird(n, color) {
  const png = new PNG({ width: W, height: H })
  png.data.fill(0)
  const x0 = 120
  const x1 = 1300
  const y0 = 820
  const y1 = 960
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Soft fade on the right edge exercises partial alpha.
      const fade = x > x1 - 160 ? Math.round(230 * ((x1 - x) / 160)) : 230
      put(png, x, y, color, fade)
    }
  }
  // Accent strip
  for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x1 - 160; x++) put(png, x, y, [255, 255, 255], 255)
  // Big digit
  const glyph = DIGITS[n]
  const scale = 14
  glyph.forEach((row, gy) => {
    ;[...row].forEach((bit, gx) => {
      if (bit !== '1') return
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) put(png, x0 + 30 + gx * scale + dx, y0 + 22 + gy * scale + dy, [255, 255, 255], 255)
    })
  })
  return PNG.sync.write(png)
}

const samples = [
  [1, 'blue', [30, 90, 200]],
  [2, 'red', [200, 40, 40]],
  [3, 'green', [30, 150, 80]],
  [4, 'purple', [120, 60, 180]],
]

fs.mkdirSync(OUT, { recursive: true })
for (const [n, label, color] of samples) {
  const file = path.join(OUT, `0${n}-lower-third-${label}.png`)
  fs.writeFileSync(file, lowerThird(n, color))
  console.log('wrote', path.relative(process.cwd(), file))
}
