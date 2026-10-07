// Price tiers and MPS-safe payment deadlines.
export const USDM_PREPROD = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

const MINUTE_MS = 60_000;

/** Amounts are test USDM atomic units (6 decimals). */
export const TIERS = Object.freeze({
  see: Object.freeze({ amount: '1000000', submitMinutes: 20, label: 'See' }),
  write: Object.freeze({ amount: '5000000', submitMinutes: 45, label: 'Write' }),
  audit: Object.freeze({ amount: '20000000', submitMinutes: 24 * 60, label: 'Audit' }),
});

/** @param {unknown} tier */
export function getTier(tier) {
  if (typeof tier !== 'string' || !Object.hasOwn(TIERS, tier)) throw new Error(`Unknown payment tier: ${String(tier)}`);
  return TIERS[/** @type {keyof typeof TIERS} */ (tier)];
}

/**
 * MPS rules: payBy <= submit - 5 min, payBy >= now, submit >= now + 15 min,
 * unlock >= submit + 15 min, externalDisputeUnlock >= unlock + 15 min.
 * The source used 16-minute gaps after submit, so the "see" tier matches it exactly.
 * @param {string} tier
 * @param {number | Date} [now]
 */
export function deadlines(tier, now = Date.now()) {
  const { submitMinutes } = getTier(tier);
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('Invalid payment clock');
  const submit = nowMs + submitMinutes * MINUTE_MS;
  const payBy = Math.min(nowMs + 15 * MINUTE_MS, submit - 5 * MINUTE_MS);
  const unlock = submit + 16 * MINUTE_MS;
  const dispute = unlock + 16 * MINUTE_MS;
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  return { payByTime: iso(payBy), submitResultTime: iso(submit), unlockTime: iso(unlock), externalDisputeUnlockTime: iso(dispute) };
}

// The first whole word wins. No match means "see".
/** @param {unknown} text @returns {'see' | 'write' | 'audit'} */
export function parseTier(text) {
  if (typeof text !== 'string') return 'see';
  const match = text.match(/\b(see|write|audit)\b/i);
  return match ? /** @type {'see' | 'write' | 'audit'} */ (match[1].toLowerCase()) : 'see';
}
