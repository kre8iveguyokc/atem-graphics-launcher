'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  atemAddress: '192.168.10.240',
  folder: '',
  defaultSlot: 1,
}

class Config {
  constructor(dir) {
    this._file = path.join(dir, 'settings.json')
    this._data = { ...DEFAULTS }
    try {
      Object.assign(this._data, JSON.parse(fs.readFileSync(this._file, 'utf8')))
    } catch {
      /* first run */
    }
  }

  get all() {
    return { ...this._data }
  }

  get(key) {
    return this._data[key]
  }

  set(partial) {
    Object.assign(this._data, partial)
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true })
      fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2))
    } catch (e) {
      console.error('Could not save settings', e)
    }
    return this.all
  }
}

module.exports = { Config, DEFAULTS }
