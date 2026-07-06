import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { _setDbForTesting, recordUsage, queryUsage, cleanupUsage } from './usage-tracker'
import { clearRateLimits } from './rate-limit-tracker'

describe('usage-tracker', () => {
  let memDb: DatabaseSync

  beforeEach(() => {
    memDb = new DatabaseSync(':memory:')
    // Create tables (same schema as rate-limit-tracker's getDb)
    memDb.exec(`CREATE TABLE IF NOT EXISTS cooldowns (
      model_ref TEXT PRIMARY KEY,
      error_type TEXT NOT NULL,
      expiry_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      consecutive INTEGER DEFAULT 1 CHECK(consecutive >= 1)
    )`)
    memDb.exec(`CREATE TABLE IF NOT EXISTS usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      router_ref    TEXT NOT NULL,
      model_ref     TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_input    REAL NOT NULL DEFAULT 0,
      cost_output   REAL NOT NULL DEFAULT 0,
      cost_total    REAL NOT NULL DEFAULT 0,
      timestamp     INTEGER NOT NULL
    )`)
    memDb.exec('CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp)')
    memDb.exec('CREATE INDEX IF NOT EXISTS idx_usage_router_ref ON usage(router_ref)')
    _setDbForTesting(memDb)
  })

  afterEach(() => {
    clearRateLimits()
    _setDbForTesting(undefined)
  })

  it('records a usage entry', () => {
    recordUsage('orc', 'openai/gpt-4', {
      input: 1000,
      output: 500,
      totalTokens: 1500,
      cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    })
    const rows = queryUsage()
    expect(rows).toHaveLength(1)
    expect(rows[0].routerRef).toBe('orc')
    expect(rows[0].modelRef).toBe('openai/gpt-4')
    expect(rows[0].inputTokens).toBe(1000)
    expect(rows[0].outputTokens).toBe(500)
    expect(rows[0].totalTokens).toBe(1500)
    expect(rows[0].costTotal).toBe(0.003)
  })

  it('queries with routerRef filter', () => {
    recordUsage('orc', 'model-a', { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } })
    recordUsage('worker', 'model-b', { input: 200, output: 100, totalTokens: 300, cost: { total: 0.002 } })

    const orcRows = queryUsage({ routerRef: 'orc' })
    expect(orcRows).toHaveLength(1)
    expect(orcRows[0].modelRef).toBe('model-a')

    const allRows = queryUsage()
    expect(allRows).toHaveLength(2)
  })

  it('queries with since filter', () => {
    const now = Date.now()
    recordUsage('orc', 'old', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, now - 100_000)
    recordUsage('orc', 'new', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, now)

    const recent = queryUsage({ since: now - 50_000 })
    expect(recent).toHaveLength(1)
    expect(recent[0].modelRef).toBe('new')
  })

  it('cleans up old records', () => {
    const now = Date.now()
    recordUsage('orc', 'old', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, now - 100_000)
    recordUsage('orc', 'new', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, now)

    const deleted = cleanupUsage(now - 50_000)
    expect(deleted).toBe(1)

    const remaining = queryUsage()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].modelRef).toBe('new')
  })

  it('handles all cleanup with MAX_SAFE_INTEGER', () => {
    recordUsage('orc', 'a', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } })
    recordUsage('worker', 'b', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } })

    const deleted = cleanupUsage(Number.MAX_SAFE_INTEGER)
    expect(deleted).toBe(2)

    expect(queryUsage()).toHaveLength(0)
  })

  it('fire-and-forget: does not throw on invalid usage', () => {
    expect(() => recordUsage('test', 'model', {} as any)).not.toThrow()
  })
})
