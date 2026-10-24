'use strict'

// Read-only checks. Nothing here ever sends a command to the switcher.

const STILL = 1 // atem-connection Enums.MediaSourceType.Still

/**
 * Inspect switcher state and report whether slot uploads will show up where the operator expects.
 * Slot N (1-based) = still index N-1 = Media Player N.
 */
function evaluateSafety(state) {
  const warnings = []
  const slots = {}
  if (!state) return { ok: false, warnings: ['No switcher state yet'], slots }

  const players = state.media?.players || []
  const pool = state.media?.stillPool || []

  for (const slot of [1, 2]) {
    const player = players[slot - 1]
    const still = pool[slot - 1]
    slots[slot] = {
      stillName: still?.isUsed ? still.fileName : '',
      playerOk: false,
    }
    if (!still && pool.length > 0) warnings.push(`Media pool has no still ${slot}`)
    if (!player) {
      warnings.push(`Media Player ${slot} not reported by the switcher`)
      continue
    }
    if (player.sourceType !== STILL) {
      warnings.push(`Media Player ${slot} is playing a clip, not Still ${slot}. Slot ${slot} uploads will not be seen.`)
    } else if (player.stillIndex !== slot - 1) {
      warnings.push(
        `Media Player ${slot} is on Still ${player.stillIndex + 1}, not Still ${slot}. Slot ${slot} uploads will not be seen.`
      )
    } else {
      slots[slot].playerOk = true
    }
  }

  return { ok: warnings.length === 0, warnings, slots }
}

module.exports = { evaluateSafety }
