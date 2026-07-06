/**
 * Unit tests for SQLite-backed rate-limit tracker.
 *
 * Each test creates its own `:memory:` database via `_setDbForTesting()`
 * in `beforeEach` and cleans up in `afterEach`, ensuring full isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  _setDbForTesting,
  isRateLimited,
  markRateLimited,
  getActiveRateLimits,
  clearRateLimits,
  getRemainingCooldownMs,
  classifyError,
  isRateLimitError,
  resetCooldown,
  computeCooldownMs,
} from './rate-limit-tracker'

describe('rate-limit-tracker (SQLite)', () => {
  let memDb: DatabaseSync

  beforeEach(() => {
    memDb = new DatabaseSync(':memory:')
    // create the table — _setDbForTesting sets the connection but doesn't init
    memDb.exec(`CREATE TABLE IF NOT EXISTS cooldowns (
      model_ref     TEXT PRIMARY KEY,
      error_type    TEXT NOT NULL,
      expiry_at     INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL,
      consecutive   INTEGER DEFAULT 1 CHECK(consecutive >= 1)
    )`)
    _setDbForTesting(memDb)
  })

  afterEach(() => {
    _setDbForTesting(null)
  })

  // -----------------------------------------------------------------------
  // classifyError
  // -----------------------------------------------------------------------

  it('classifyError("429 Too Many Requests") returns "rate_limit"', () => {
    expect(classifyError('429 Too Many Requests')).toBe('rate_limit')
  })

  it('classifyError("502 Bad Gateway") returns "server_error"', () => {
    expect(classifyError('502 Bad Gateway')).toBe('server_error')
  })

  it('classifyError("timeout reading response") returns "timeout"', () => {
    expect(classifyError('timeout reading response')).toBe('timeout')
  })

  it('classifyError("401 Unauthorized") returns "auth"', () => {
    expect(classifyError('401 Unauthorized')).toBe('auth')
  })

  it('classifyError("Model not found") returns "other"', () => {
    expect(classifyError('Model not found')).toBe('other')
  })

  // -----------------------------------------------------------------------
  // CRUD — markRateLimited + isRateLimited
  // -----------------------------------------------------------------------

  it('markRateLimited + isRateLimited roundtrip via :memory: SQLite', () => {
    expect(isRateLimited('provider/model-a')).toBe(false)
    markRateLimited('provider/model-a', 300_000)
    expect(isRateLimited('provider/model-a')).toBe(true)
  })

  it('isRateLimited returns false after expiry', () => {
    markRateLimited('provider/model-a', -1) // already expired
    expect(isRateLimited('provider/model-a')).toBe(false)
  })

  it('getActiveRateLimits returns only non-expired entries', () => {
    markRateLimited('provider/model-a', 300_000)
    markRateLimited('provider/model-b', -1) // expired immediately

    const limits = getActiveRateLimits()
    expect(limits.length).toBe(1)
    expect(limits[0].ref).toBe('provider/model-a')
  })

  it('clearRateLimits deletes all rows', () => {
    markRateLimited('provider/model-a', 300_000)
    markRateLimited('provider/model-b', 300_000)
    expect(getActiveRateLimits().length).toBe(2)

    clearRateLimits()
    expect(getActiveRateLimits().length).toBe(0)
  })

  it('getRemainingCooldownMs returns correct value', () => {
    markRateLimited('provider/model-a', 100_000)
    const remaining = getRemainingCooldownMs('provider/model-a')
    expect(remaining).not.toBeNull()
    expect(remaining!).toBeGreaterThan(0)
    expect(remaining!).toBeLessThanOrEqual(100_000)
  })

  it('getRemainingCooldownMs returns null for unknown ref', () => {
    expect(getRemainingCooldownMs('nonexistent')).toBeNull()
  })

  it('getRemainingCooldownMs returns null for expired entry', () => {
    markRateLimited('provider/model-a', -1)
    expect(getRemainingCooldownMs('provider/model-a')).toBeNull()
  })

  it('multiple models tracked independently', () => {
    markRateLimited('provider/model-a', 300_000)
    markRateLimited('provider/model-b', 600_000)

    expect(isRateLimited('provider/model-a')).toBe(true)
    expect(isRateLimited('provider/model-b')).toBe(true)
    expect(isRateLimited('provider/model-c')).toBe(false)

    const limits = getActiveRateLimits()
    expect(limits.length).toBe(2)
    expect(limits[0].ref).toBe('provider/model-a')
    expect(limits[1].ref).toBe('provider/model-b')
  })

  it('_setDbForTesting(null) resets state', () => {
    markRateLimited('provider/model-a', 300_000)
    expect(isRateLimited('provider/model-a')).toBe(true)

    // reset to null — next call to _setDbForTesting will set a new db
    _setDbForTesting(null)

    // After reset, the old db is gone. But getDb() won't create a new one
    // until we set one for testing or it falls back to file. For unit test
    // purposes, re-set
    const newDb = new DatabaseSync(':memory:')
    newDb.exec(`CREATE TABLE IF NOT EXISTS cooldowns (
      model_ref TEXT PRIMARY KEY,
      error_type TEXT NOT NULL,
      expiry_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      consecutive INTEGER DEFAULT 1 CHECK(consecutive >= 1)
    )`)
    _setDbForTesting(newDb)

    // Old data is gone — new db is empty
    expect(isRateLimited('provider/model-a')).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Legacy helpers (unchanged)
  // -----------------------------------------------------------------------

  it('isRateLimitError matches 429', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true)
  })

  it('isRateLimitError does not match generic errors', () => {
    expect(isRateLimitError(new Error('Model not found'))).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Escalation — consecutive counting, tiers, reset
  // -----------------------------------------------------------------------

  it('same error type 5x escalates cooldown to 1h tier', () => {
    for (let i = 0; i < 5; i++) {
      markRateLimited('test/model', 300_000, 'rate_limit')
    }
    const limits = getActiveRateLimits()
    expect(limits.length).toBe(1)
    expect(limits[0].consecutive).toBe(5)
    // 1h = 3,600,000 — remaining should be close to that
    expect(limits[0].remainingMs).toBeGreaterThan(3_500_000)
  })

  it('different error types reset consecutive to 1', () => {
    markRateLimited('test/model', 300_000, 'auth')
    markRateLimited('test/model', 300_000, 'rate_limit')  // different type → resets to 1
    expect(getActiveRateLimits()[0].consecutive).toBe(1)

    markRateLimited('test/model', 300_000, 'rate_limit')  // same type → increments to 2
    expect(getActiveRateLimits()[0].consecutive).toBe(2)
  })

  it('resetCooldown clears entry, next mark starts at consecutive=1', () => {
    markRateLimited('test/model', 300_000, 'rate_limit')
    markRateLimited('test/model', 300_000, 'rate_limit')
    expect(getActiveRateLimits()[0].consecutive).toBe(2)

    resetCooldown('test/model')
    expect(getActiveRateLimits().length).toBe(0)

    markRateLimited('test/model', 300_000, 'rate_limit')
    expect(getActiveRateLimits()[0].consecutive).toBe(1)
  })

  it('consecutive caps at 12', () => {
    for (let i = 0; i < 15; i++) {
      markRateLimited('test/model', 300_000, 'rate_limit')
    }
    const limits = getActiveRateLimits()
    expect(limits[0].consecutive).toBe(12)
  })

  it('expired entry with same error type increments consecutive', () => {
    vi.useFakeTimers()
    markRateLimited('test/model', 1000, 'rate_limit') // consecutive=1
    vi.advanceTimersByTime(2000) // past expiry

    // Same error type, existing entry has consecutive=1 (even though expired)
    markRateLimited('test/model', 300_000, 'rate_limit')
    const limits = getActiveRateLimits()
    expect(limits[0].consecutive).toBe(2)

    vi.useRealTimers()
  })

  it('computeCooldownMs returns correct tier values', () => {
    expect(computeCooldownMs(1)).toBe(300_000)
    expect(computeCooldownMs(4)).toBe(300_000)
    expect(computeCooldownMs(5)).toBe(3_600_000)
    expect(computeCooldownMs(6)).toBe(3_600_000)
    expect(computeCooldownMs(7)).toBe(21_600_000)
    expect(computeCooldownMs(12)).toBe(21_600_000)
    expect(computeCooldownMs(20)).toBe(21_600_000) // capped at 12
  })
})
