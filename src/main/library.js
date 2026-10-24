'use strict'

const fs = require('fs')
const path = require('path')

/** List PNG files in a folder (not recursive), sorted naturally by name. */
function listPngs(folder) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.png$/i.test(d.name) && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(folder, d.name) }))
    .sort((a, b) => collator.compare(a.name, b.name))
}

/** ATEM still names are short fixed-length fields; keep it readable and safe. */
function stillNameFor(fileName) {
  const base = fileName.replace(/\.png$/i, '')
  // ASCII only, the switcher field is not unicode-aware.
  const ascii = base.replace(/[^\x20-\x7E]/g, '_')
  return ascii.slice(0, 63)
}

module.exports = { listPngs, stillNameFor }
