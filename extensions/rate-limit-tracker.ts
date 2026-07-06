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
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from './constants'

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

/** Patterns for transient server-side errors worth a cooldown. */
const TRANSIENT_PATTERNS = [
  ...RATE_LIMIT_PATTERNS,
  // Server errors
  '502', '503', '504',
  'service unavailable',
  'internal server error',
  'gateway timeout',
  'bad gateway',
  'upstream',
  'origin error',
  // Timeout / connection
  'timeout',
  'timed out',
  'econnrefused',
  'econnreset',
  'network error',
  'socket hang up',
  'overloaded',
  'temporarily',
  'backend',
  // Provider-level
  'provider returned error',
]

/**
 * Check whether an error is a transient server-side error.
 *
 * Transient errors (rate limits, 5xx, timeouts) get cooldown so the
 * model is skipped on subsequent turns. Permanent errors (model not
 * found, auth failure, invalid ref) do NOT get cooldown — they should
 * fail fast every time.
 */
export function isTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p))
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
 * @param ref        Canonical model ref (`"provider/model-id"`)
 * @param cooldownMs Cooldown duration in ms (default: 5 minutes)
 */
export function markRateLimited(ref: string, cooldownMs: number = DEFAULT_RATE_LIMIT_COOLDOWN_MS): void {
  const db = getDb()
  const expiry = Date.now() + cooldownMs
  db.prepare(
    `INSERT OR REPLACE INTO cooldowns(model_ref, error_type, expiry_at, duration_ms, consecutive)
     VALUES(?, 'other', ?, ?, 1)`,
  ).run(ref, expiry, cooldownMs)
}

/**
 * Return all currently active rate limits, sorted by ref.
 */
export function getActiveRateLimits(): Array<{ ref: string; remainingMs: number }> {
  const db = getDb()
  const now = Date.now()
  const rows = db.prepare('SELECT model_ref, expiry_at FROM cooldowns WHERE expiry_at > ? ORDER BY model_ref').all(now) as Array<{ model_ref: string; expiry_at: number }>

  // lazily clean up expired entries before returning
  db.prepare('DELETE FROM cooldowns WHERE expiry_at <= ?').run(now)

  return rows.map((r) => ({
    ref: r.model_ref,
    remainingMs: r.expiry_at - now,
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
