'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateSafety } = require('../src/main/safety')

const pool = [
  { isUsed: true, fileName: 'Pastor' },
  { isUsed: false, fileName: '' },
]

test('correct routing reports ok and still names', () => {
  const r = evaluateSafety({
    media: {
      players: [
        { sourceType: 1, stillIndex: 0 },
        { sourceType: 1, stillIndex: 1 },
      ],
      stillPool: pool,
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.slots[1].stillName, 'Pastor')
  assert.equal(r.slots[2].stillName, '')
})

test('player on the wrong still is flagged', () => {
  const r = evaluateSafety({
    media: {
      players: [
        { sourceType: 1, stillIndex: 4 },
        { sourceType: 1, stillIndex: 1 },
      ],
      stillPool: pool,
    },
  })
  assert.equal(r.ok, false)
  assert.match(r.warnings[0], /Media Player 1 is on Still 5/)
})

test('player on a clip is flagged', () => {
  const r = evaluateSafety({
    media: {
      players: [
        { sourceType: 1, stillIndex: 0 },
        { sourceType: 2, stillIndex: 1 },
      ],
      stillPool: pool,
    },
  })
  assert.equal(r.ok, false)
  assert.match(r.warnings[0], /Media Player 2 is playing a clip/)
})

test('missing state is not ok', () => {
  assert.equal(evaluateSafety(undefined).ok, false)
})
