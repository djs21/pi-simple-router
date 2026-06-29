/**
 * In-memory rate-limit tracker.
 *
 * Keeps track of which model refs are currently rate-limited (in cooldown).
 * Resets when pi restarts (no persistence).
 *
 * Each entry stores the expiry timestamp. Once expired, the entry is
 * lazily cleaned up on next check.
 */

import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from './constants'

const RATE_LIMITED = new Map<string, number>() // ref → expiry timestamp

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a model ref is currently in cooldown.
 * Lazily cleans up expired entries.
 */
export function isRateLimited(ref: string): boolean {
  const expiry = RATE_LIMITED.get(ref)
  if (expiry === undefined) return false
  if (Date.now() >= expiry) {
    RATE_LIMITED.delete(ref)
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
  RATE_LIMITED.set(ref, Date.now() + cooldownMs)
}

/**
 * Return all currently active rate limits, sorted by ref.
 */
export function getActiveRateLimits(): Array<{ ref: string; remainingMs: number }> {
  const now = Date.now()
  const result: Array<{ ref: string; remainingMs: number }> = []
  for (const [ref, expiry] of RATE_LIMITED) {
    const remaining = expiry - now
    if (remaining > 0) {
      result.push({ ref, remainingMs: remaining })
    } else {
      RATE_LIMITED.delete(ref) // lazy cleanup
    }
  }
  return result.sort((a, b) => a.ref.localeCompare(b.ref))
}

/**
 * Clear all rate-limit entries (for testing / manual reset).
 */
export function clearRateLimits(): void {
  RATE_LIMITED.clear()
}

/**
 * Get remaining cooldown time for a model ref, or null if not in cooldown.
 */
export function getRemainingCooldownMs(ref: string): number | null {
  const expiry = RATE_LIMITED.get(ref)
  if (expiry === undefined) return null
  const remaining = expiry - Date.now()
  return remaining > 0 ? remaining : null
}
