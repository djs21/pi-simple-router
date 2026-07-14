import { getDb } from './rate-limit-tracker'
import { _setDbForTesting } from './rate-limit-tracker'

export { _setDbForTesting }

export interface UsageRow {
  id: number
  routerRef: string
  modelRef: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costInput: number
  costOutput: number
  costTotal: number
  timestamp: number
}

const TABLE = 'usage'

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

export function recordUsage(
  routerRef: string,
  modelRef: string,
  usage: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  },
  timestamp?: number,
): void {
  try {
    const db = getDb()
    const now = timestamp ?? Date.now()
    db.prepare(
      `INSERT INTO ${TABLE}
       (router_ref, model_ref, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_input, cost_output, cost_total, timestamp)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      routerRef,
      modelRef,
      toNum(usage.input),
      toNum(usage.output),
      toNum(usage.cacheRead),
      toNum(usage.cacheWrite),
      toNum(usage.totalTokens),
      toNum(usage.cost?.input),
      toNum(usage.cost?.output),
      toNum(usage.cost?.total),
      now,
    )
  } catch {
    // fire-and-forget — never fail the request
  }
}

export function queryUsage(opts?: { routerRef?: string; since?: number }): UsageRow[] {
  const db = getDb()
  const conditions: string[] = []
	const params: any[] = []

  if (opts?.routerRef) {
    conditions.push('router_ref = ?')
    params.push(opts.routerRef)
  }
  if (opts?.since) {
    conditions.push('timestamp >= ?')
    params.push(opts.since)
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  const rows = db.prepare(
    `SELECT id, router_ref, model_ref, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_input, cost_output, cost_total, timestamp
     FROM ${TABLE}${where} ORDER BY timestamp DESC`,
  ).all(...params) as any[]

  return rows.map((r: any) => ({
    id: r.id,
    routerRef: r.router_ref,
    modelRef: r.model_ref,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    totalTokens: r.total_tokens,
    costInput: r.cost_input,
    costOutput: r.cost_output,
    costTotal: r.cost_total,
    timestamp: r.timestamp,
  }))
}

export function cleanupUsage(before: number): number {
  const db = getDb()
  const result = db.prepare(`DELETE FROM ${TABLE} WHERE timestamp < ?`).run(before)
  return Number(result.changes ?? 0)
}
