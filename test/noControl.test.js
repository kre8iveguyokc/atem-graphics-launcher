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

// Blackmagic ATEM Switchers SDK methods that change what's on air or how it's routed.
// The helper may only use discovery, read-only getters, the media pool and stills upload.
const FORBIDDEN_SDK = [
  /\bSetSource\b/, // IBMDSwitcherMediaPlayer / inputs: re-routing
  /\bSetOnAir\b/, // downstream / upstream keyers
  /\bPerformAutoTransition\b/,
  /\bPerformCut\b/,
  /\bPerformFadeToBlack\b/,
  /\bSetProgramInput\b/,
  /\bSetPreviewInput\b/,
  /\bSetInputFill\b/,
  /\bSetInputCut\b/,
  /\bSetTie\b/,
  /\bSetPreviewTransition\b/,
  /\bPerformAutoMix\b/,
  /\bSetNextTransitionSelection\b/,
  /\bIBMDSwitcherMacroControl\b/,
  /\bSetPlaying\b/,
  /\bSetVideoMode\b/,
  /\bClear\s*\(/, // IBMDSwitcherStills::Clear would blank a still
]

function walkNative(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === 'third_party' || d.name === 'build' ? [] : walkNative(p)
    return /\.(c|cc|cpp|mm|h|hpp)$/.test(d.name) ? [p] : []
  })
}

test('native helper never calls SDK switching, keying or routing methods', () => {
  const offenders = []
  for (const file of walkNative(path.join(__dirname, '..', 'native', 'helper', 'src'))) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '') // ignore comments
    for (const re of FORBIDDEN_SDK) if (re.test(src)) offenders.push(`${path.basename(file)}: ${re}`)
  }
  assert.deepEqual(offenders, [])
})
