export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384
export const CONFIG_FILENAME = 'model-router.json'
export const PROVIDER_NAME = 'router'
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000 // Base tier duration (5m). Escalation logic uses ESCALATION_COOLDOWN_* constants.

export const ESCALATION_TIER_1_MAX = 4
export const ESCALATION_TIER_2_MIN = 5
export const ESCALATION_TIER_2_MAX = 6
export const ESCALATION_TIER_3_MIN = 7
export const ESCALATION_COOLDOWN_TIER_1_MS = 300_000
export const ESCALATION_COOLDOWN_TIER_2_MS = 3_600_000
export const ESCALATION_COOLDOWN_TIER_3_MS = 21_600_000
