/**
 * SQLite-backed rate-limit tracker.
 *
 * Keeps track of which model refs are currently rate-limited (in cooldown).
 * Persists to disk so cooldown state survives pi restarts and is shared
 * across multiple pi sessions on the same machine.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  ESCALATION_TIER_2_MIN,
  ESCALATION_TIER_3_MIN,
  ESCALATION_COOLDOWN_TIER_1_MS,
  ESCALATION_COOLDOWN_TIER_2_MS,
  ESCALATION_COOLDOWN_TIER_3_MS,
} from './constants'

// ---------------------------------------------------------------------------
// SQLite connection (lazy, module-level singleton)
// ---------------------------------------------------------------------------

let _db: DatabaseSync | null = null

/** Resolve the database file path, respecting XDG_DATA_HOME. */
function getDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, 'pi')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'model-router.db')
}

/**
 * Return the module-level SQLite connection, creating it lazily.
 */
function getDb(): DatabaseSync {
  if (_db) return _db
  _db = new DatabaseSync(getDbPath())
  _db.exec('PRAGMA journal_mode=WAL')
  _db.exec('PRAGMA busy_timeout=5000')
  _db.exec(`CREATE TABLE IF NOT EXISTS cooldowns (
    model_ref     TEXT PRIMARY KEY,
    error_type    TEXT NOT NULL,
    expiry_at     INTEGER NOT NULL,
    duration_ms   INTEGER NOT NULL,
    consecutive   INTEGER DEFAULT 1 CHECK(consecutive >= 1)
  )`)
  return _db
}

// ---------------------------------------------------------------------------
// Testing seam
// ---------------------------------------------------------------------------

/**
 * Override the module-level database connection for testing.
 *
 * Pass a `:memory:` database to isolate tests. Pass `null` or `undefined`
 * to reset to file-based lazy init.
 */
export function _setDbForTesting(db?: DatabaseSync | null): void {
  _db = db ?? null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Common error message patterns that indicate a rate limit / quota error. */
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'rate limited',
  '429',
  'too many requests',
  'quota exceeded',
  'try again later',
  'request limit',
  'retry after',
]

/**
 * Check whether an error message indicates a rate-limit or quota error.
 */
export function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return RATE_LIMIT_PATTERNS.some((p) => msg.includes(p))
}



// ---------------------------------------------------------------------------
// classifyError — new export for Slice 2, added now but not used yet
// ---------------------------------------------------------------------------

/**
 * Classify an error message into a category for cooldown escalation.
 *
 * Categories:
 * - `rate_limit` — 429 / quota / too many requests
 * - `server_error` — 5xx / upstream / origin errors
 * - `timeout` — connection timeout / timed out
 * - `auth` — 401 / 403 / unauthorized / auth failure
 * - `other` — everything else
 */
export function classifyError(error: string | unknown): 'rate_limit' | 'server_error' | 'timeout' | 'auth' | 'other' {
  const msg = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  // Rate limit / quota
  if (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('ratelimit') ||
    lower.includes('rate limited') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('quota exceeded') ||
    lower.includes('try again later') ||
    lower.includes('request limit') ||
    lower.includes('retry after')
  ) {
    return 'rate_limit'
  }

  // Auth / forbidden
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('auth') ||
    lower.includes('api key') ||
    lower.includes('invalid key') ||
    lower.includes('invalid authentication')
  ) {
    return 'auth'
  }

  // Timeout
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('network error') ||
    lower.includes('socket hang up')
  ) {
    return 'timeout'
  }

  // Server error
  if (
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('service unavailable') ||
    lower.includes('internal server error') ||
    lower.includes('gateway timeout') ||
    lower.includes('bad gateway') ||
    lower.includes('upstream') ||
    lower.includes('origin error') ||
    lower.includes('overloaded') ||
    lower.includes('temporarily') ||
    lower.includes('backend') ||
    lower.includes('provider returned error')
  ) {
    return 'server_error'
  }

  return 'other'
}

// ---------------------------------------------------------------------------
// computeCooldownMs — escalation tier calculation
// ---------------------------------------------------------------------------

/**
 * Compute cooldown duration based on consecutive same-type error count.
 *
 * Tiers:
 *   1–4  → 5 minutes (ESCALATION_COOLDOWN_TIER_1_MS)
 *   5–6  → 1 hour   (ESCALATION_COOLDOWN_TIER_2_MS)
 *   7+   → 6 hours  (ESCALATION_COOLDOWN_TIER_3_MS)
 *
 * Consecutive is capped at 12 to prevent unbounded growth.
 */
export function computeCooldownMs(consecutive: number): number {
  const capped = Math.min(consecutive, 12)
  if (capped >= ESCALATION_TIER_3_MIN) return ESCALATION_COOLDOWN_TIER_3_MS   // 6h
  if (capped >= ESCALATION_TIER_2_MIN) return ESCALATION_COOLDOWN_TIER_2_MS   // 1h
  return ESCALATION_COOLDOWN_TIER_1_MS                                          // 5m
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a model ref is currently in cooldown.
 * Lazily cleans up expired entries.
 */
export function isRateLimited(ref: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT expiry_at FROM cooldowns WHERE model_ref = ?').get(ref) as { expiry_at: number } | undefined
  if (!row) return false
  if (Date.now() >= row.expiry_at) {
    db.prepare('DELETE FROM cooldowns WHERE model_ref = ?').run(ref)
    return false
  }
  return true
}

/**
 * Mark a model ref as rate-limited with a cooldown period.
 *
 * If the same model ref already has an active entry with the same error type,
 * the consecutive counter is incremented and an escalated cooldown is applied.
 * A different error type resets the counter to 1.
 *
 * @param ref        Canonical model ref (`"provider/model-id"`)
 * @param cooldownMs Base cooldown duration in ms (default: 5 minutes). Used
 *                   when the counter is reset (new or different error type).
 * @param errorType  Error category for escalation tracking (default: `'other'`).
 */
export function markRateLimited(ref: string, cooldownMs: number = DEFAULT_RATE_LIMIT_COOLDOWN_MS, errorType?: string): void {
  const db = getDb()
  const now = Date.now()
  const errType = errorType ?? 'other'

  const existing = db.prepare(
    'SELECT error_type, consecutive FROM cooldowns WHERE model_ref = ?',
  ).get(ref) as { error_type: string; consecutive: number } | undefined

  if (existing) {
    if (existing.error_type === errType) {
      // Same error type → increment consecutive and escalate
      const consecutive = Math.min(existing.consecutive + 1, 12)
      const duration = computeCooldownMs(consecutive)
      const expiry = now + duration
      db.prepare('UPDATE cooldowns SET error_type = ?, expiry_at = ?, duration_ms = ?, consecutive = ? WHERE model_ref = ?')
        .run(errType, expiry, duration, consecutive, ref)
      return
    }
    // Different error type → reset to 1 with base duration
    const expiry = now + cooldownMs
    db.prepare('INSERT OR REPLACE INTO cooldowns(model_ref, error_type, expiry_at, duration_ms, consecutive) VALUES(?, ?, ?, ?, 1)')
      .run(ref, errType, expiry, cooldownMs)
    return
  }

  // No existing entry → insert with consecutive=1
  const expiry = now + cooldownMs
  db.prepare('INSERT OR REPLACE INTO cooldowns(model_ref, error_type, expiry_at, duration_ms, consecutive) VALUES(?, ?, ?, ?, 1)')
    .run(ref, errType, expiry, cooldownMs)
}

/**
 * Reset cooldown for a model ref — clears the entry entirely.
 * The next call to `markRateLimited` will start at consecutive=1.
 *
 * Safe to call on non-existent refs (no-op).
 */
export function resetCooldown(ref: string): void {
  const db = getDb()
  db.prepare('DELETE FROM cooldowns WHERE model_ref = ?').run(ref)
}

/**
 * Return all currently active rate limits, sorted by ref.
 * Includes error type and consecutive count for display.
 */
export function getActiveRateLimits(): Array<{ ref: string; remainingMs: number; errorType: string; consecutive: number }> {
  const db = getDb()
  const now = Date.now()
  const rows = db.prepare(
    'SELECT model_ref, expiry_at, error_type, consecutive FROM cooldowns WHERE expiry_at > ? ORDER BY model_ref',
  ).all(now) as Array<{ model_ref: string; expiry_at: number; error_type: string; consecutive: number }>

  // lazily clean up expired entries before returning
  db.prepare('DELETE FROM cooldowns WHERE expiry_at <= ?').run(now)

  return rows.map((r) => ({
    ref: r.model_ref,
    remainingMs: r.expiry_at - now,
    errorType: r.error_type,
    consecutive: r.consecutive,
  }))
}

/**
 * Clear all rate-limit entries (for testing / manual reset).
 */
export function clearRateLimits(): void {
  const db = getDb()
  db.exec('DELETE FROM cooldowns')
}

/**
 * Get remaining cooldown time for a model ref, or null if not in cooldown.
 */
export function getRemainingCooldownMs(ref: string): number | null {
  const db = getDb()
  const row = db.prepare('SELECT expiry_at FROM cooldowns WHERE model_ref = ?').get(ref) as { expiry_at: number } | undefined
  if (!row) return null
  const remaining = row.expiry_at - Date.now()
  if (remaining > 0) return remaining
  // lazy cleanup
  db.prepare('DELETE FROM cooldowns WHERE model_ref = ?').run(ref)
  return null
}
