'use strict'

// Guard rail: the app must only upload stills. This scans the shipped source for
// any atem-connection call that would switch, key or re-route the switcher.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const FORBIDDEN = [
  /\.cut\s*\(/,
  /\.autoTransition\s*\(/,
  /\.fadeToBlack\s*\(/,
  /\.changeProgramInput\s*\(/,
  /\.changePreviewInput\s*\(/,
  /\.setMediaPlayerSource\s*\(/,
  /\.setMediaPlayerSettings\s*\(/,
  /\.setDownstreamKey\w*\s*\(/,
  /\.setUpstreamKeyer\w*\s*\(/,
  /\.autoDownstreamKey\s*\(/,
  /\.setTransition\w*\s*\(/,
  /\.setAuxSource\s*\(/,
  /\.macroRun\s*\(/,
  /\.sendCommand\w*\s*\(/,
  /\.clearMediaPoolStill\s*\(/,
]

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []
  })
}

test('source never calls switcher control commands', () => {
  const offenders = []
  for (const file of walk(path.join(__dirname, '..', 'src'))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const re of FORBIDDEN) if (re.test(src)) offenders.push(`${path.basename(file)}: ${re}`)
  }
  assert.deepEqual(offenders, [])
})
