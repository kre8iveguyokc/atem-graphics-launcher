'use strict'

// Copies the shipped helper (never the mock) to native/helper/dist, which
// electron-builder packages as <resources>/helper and the app uses in development.

const fs = require('fs')
const path = require('path')

const exe = process.platform === 'win32' ? 'agl-helper.exe' : 'agl-helper'
const root = path.join(__dirname, '..', 'native', 'helper')
const candidates = [path.join(root, 'build', exe), path.join(root, 'build', 'Release', exe)]
const src = candidates.find((p) => fs.existsSync(p))
if (!src) {
  console.error(`agl-helper not built. Looked in:\n  ${candidates.join('\n  ')}\nRun: npm run helper:build`)
  process.exit(1)
}
const outDir = path.join(root, 'dist')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const dest = path.join(outDir, exe)
fs.copyFileSync(src, dest)
fs.chmodSync(dest, 0o755)
console.log(`staged ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`)
