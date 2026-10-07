// Masumi Payment Service (MPS) client and quote guards.
// Ported from demo-agent-token2049 scripts/payment.ts and the live paid-task.mjs.
import { z } from 'zod';
import { hashPaymentInput, makeNonce, paymentTask, validateNonce } from './hash.mjs';
import { USDM_PREPROD, deadlines, getTier } from './tiers.mjs';

const MINUTE_MS = 60_000;
const DEADLINE_KEYS = /** @type {const} */ (['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime']);
const HEX64 = /^[0-9a-f]{64}$/;
const ATOMIC = /^[1-9]\d{0,18}$/;

const hexKey = z.string().regex(/^[0-9a-f]{56}$/);
const timestamp = z.string().regex(/^[1-9]\d{0,18}$/);
const preprodAddress = z.string().max(250).regex(/^addr_test1[023456789acdefghjklmnpqrstuvwxyz]+$/);

const registrationSchema = z.object({
  agentIdentifier: z.string().min(57).max(250).regex(/^[0-9a-f]+$/),
  policyId: hexKey,
  smartContractAddress: preprodAddress,
  sellerVkey: hexKey,
  sellerAddress: preprodAddress,
  supportedPaymentSourceIndex: z.number().int().min(0).max(24),
});

const quoteSchema = z.object({
  id: z.string().min(1), blockchainIdentifier: z.string().min(1).max(8000),
  agentIdentifier: z.string(), pricingType: z.literal('Dynamic'), inputHash: z.string(),
  payByTime: timestamp, submitResultTime: timestamp, unlockTime: timestamp, externalDisputeUnlockTime: timestamp,
  // sellerReturnAddress must be present (null). forceLayer may be absent: one live MPS build omits it.
  sellerReturnAddress: z.string().nullable(), buyerReturnAddress: z.string().nullable(),
  forceLayer: z.string().nullable().optional(), paymentForceLayer: z.string().nullable().optional(),
  RequestedFunds: z.array(z.object({ amount: z.string().regex(ATOMIC), unit: z.string() })).length(1),
  SmartContractWallet: z.object({ walletVkey: hexKey, walletAddress: preprodAddress }),
  PaymentSource: z.object({ network: z.literal('Preprod'), paymentSourceType: z.literal('Web3CardanoV2'),
    policyId: hexKey, smartContractAddress: preprodAddress }),
  onChainState: z.string().nullable(), resultHash: z.string().nullable(),
  NextAction: z.object({ requestedAction: z.string(), errorType: z.string().nullable(), resultHash: z.string().nullable().optional() }),
  CurrentTransaction: z.object({ txHash: z.string().regex(HEX64).nullable(), status: z.string(),
    confirmations: z.number().int().nonnegative().nullable(), layer: z.string().optional(),
    hydraHeadId: z.string().nullable().optional() }).nullable(),
});

/** @template T @param {z.ZodType<T>} schema @param {unknown} value @param {string} label @returns {T} */
function parseWith(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`${label}: ${issue.path.join('.') || '(root)'} ${issue.message}`);
}

/**
 * Seller registration: the agent and its Preprod V2 payment source.
 * @param {unknown} value
 */
export function validateRegistration(value) {
  const registration = parseWith(registrationSchema, value, 'Invalid seller registration');
  if (!registration.agentIdentifier.startsWith(registration.policyId)) throw new Error('Agent policy mismatch');
  return registration;
}

/**
 * Everything the worker needs to request one payment, with no network calls.
 * @param {{task: {taskId: string, name: string, description: string | null}, registration: unknown, tier: string, now?: number | Date}} options
 */
export function buildPaymentPlan({ task, registration, tier, amount: priced, now = Date.now() }) {
  const reg = validateRegistration(registration);
  const input = paymentTask(task);
  // A size-based price can replace the tier's fixed amount.
  const amount = priced ?? getTier(tier).amount;
  const identifierFromPurchaser = makeNonce(input, reg.agentIdentifier);
  return { tier, amount, unit: USDM_PREPROD, agentIdentifier: reg.agentIdentifier,
    supportedPaymentSourceIndex: reg.supportedPaymentSourceIndex, identifierFromPurchaser,
    inputHash: hashPaymentInput(identifierFromPurchaser, input), ...deadlines(tier, now) };
}

/** @param {any} plan @param {number} now */
function requireFreshPlan(plan, now) {
  const pay = Date.parse(plan.payByTime), submit = Date.parse(plan.submitResultTime);
  const unlock = Date.parse(plan.unlockTime), dispute = Date.parse(plan.externalDisputeUnlockTime);
  if (![pay, submit, unlock, dispute].every(Number.isFinite)) throw new Error('Payment plan needs four ISO deadlines');
  if (submit - pay < 5 * MINUTE_MS || unlock - submit < 15 * MINUTE_MS || dispute - unlock < 15 * MINUTE_MS)
    throw new Error('Invalid payment deadlines');
  if (pay <= now || submit < now + 15 * MINUTE_MS)
    throw new Error('Payment plan expired; do not replace a possibly charged plan');
}

/**
 * Mirrors the source guards. Pass `expected` (for example the plan) to also bind input hash and deadlines.
 * Set `expected.fresh` to false for a quote that is already paid or in progress.
 * @param {unknown} value MPS payment (the `data` of a create, resolve or submit-result response)
 * @param {unknown} registration
 * @param {string} amount atomic test USDM units
 * @param {{inputHash?: string, payByTime?: string, submitResultTime?: string, unlockTime?: string, externalDisputeUnlockTime?: string, fresh?: boolean}} [expected]
 */
export function validateQuote(value, registration, amount, expected = {}) {
  const reg = validateRegistration(registration);
  if (typeof amount !== 'string' || !ATOMIC.test(amount)) throw new Error('Invalid expected payment amount');
  const quote = parseWith(quoteSchema, value, 'Invalid MPS quote');
  if (quote.agentIdentifier !== reg.agentIdentifier ||
      quote.PaymentSource.policyId !== reg.policyId || quote.PaymentSource.smartContractAddress !== reg.smartContractAddress ||
      quote.SmartContractWallet.walletVkey !== reg.sellerVkey || quote.SmartContractWallet.walletAddress !== reg.sellerAddress)
    throw new Error('Unexpected payment identity or source');
  if (expected.inputHash !== undefined && quote.inputHash !== expected.inputHash) throw new Error('Unexpected payment identity or source');
  if (quote.RequestedFunds[0].unit !== USDM_PREPROD || quote.RequestedFunds[0].amount !== amount)
    throw new Error('Unexpected payment funds');
  for (const key of DEADLINE_KEYS) {
    const want = expected[key];
    if (want === undefined) continue;
    const ms = /^\d+$/.test(want) ? want : String(Date.parse(want));
    if (quote[key] !== ms) throw new Error(`Unexpected payment deadline: ${key}`);
  }
  if (quote.sellerReturnAddress !== null || quote.forceLayer != null || quote.paymentForceLayer != null)
    throw new Error('Core cannot forward signed payment overrides');
  if (quote.CurrentTransaction?.layer === 'L2' || quote.CurrentTransaction?.hydraHeadId != null)
    throw new Error('Expected an L1 payment');
  if ((expected.fresh ?? true) && (quote.buyerReturnAddress !== null || quote.onChainState !== null ||
      quote.CurrentTransaction !== null || (quote.resultHash !== null && quote.resultHash !== '') ||
      quote.NextAction.requestedAction !== 'WaitingForExternalAction'))
    throw new Error('Expected a fresh unpaid quote');
  if (quote.NextAction.errorType !== null) throw new Error('MPS payment action failed');
  return /** @type {any} */ (value);
}

export class MpsError extends Error {
  /** @param {string} message @param {{status?: number, path: string, uncertain: boolean}} info */
  constructor(message, { status, path, uncertain }) {
    super(message);
    this.name = 'MpsError';
    this.status = status;
    this.path = path;
    // True when MPS may have applied the write. Inspect the payment before any retry.
    this.uncertain = uncertain;
  }
}

/**
 * @param {{baseUrl: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * baseUrl is the MPS root, for example http://127.0.0.1:3012. A trailing /api/v1 is accepted.
 */
export function createMpsClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))))
    throw new Error('MPS URL must use HTTPS or local loopback HTTP');
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Missing or invalid MPS token');
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/';
  const redact = (/** @type {string} */ text) => text.split(token).join('[redacted]').slice(0, 300);

  /** @param {string} route @param {object} body */
  async function post(route, body) {
    const path = `/api/v1/${route}`;
    let response, text;
    try {
      response = await fetchImpl(new URL(`api/v1/${route}`, base), { method: 'POST', redirect: 'error',
        headers: { token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch {
      throw new MpsError(`MPS POST ${path} outcome unknown (no complete response). Inspect the payment before retrying.`,
        { path, uncertain: true, status: response?.status });
    }
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!response.ok) {
      const detail = typeof json?.error?.message === 'string' ? json.error.message : typeof json?.message === 'string' ? json.message : '';
      throw new MpsError(`MPS POST ${path} failed with HTTP ${response.status}${detail ? `: ${redact(detail)}` : ''}`,
        { path, status: response.status, uncertain: response.status >= 500 });
    }
    if (json?.status !== 'success' || json.data === undefined)
      throw new MpsError(`MPS POST ${path} returned HTTP ${response.status} without a success envelope`,
        { path, status: response.status, uncertain: true });
    return json.data;
  }

  return {
    /**
     * Request signed terms. Only these fields are sent: no sellerReturnAddress, forceLayer or metadata.
     * @param {ReturnType<typeof buildPaymentPlan>} plan
     */
    async createPayment(plan, { now = Date.now() } = {}) {
      if (typeof plan?.agentIdentifier !== 'string' || !/^[0-9a-f]{57,250}$/.test(plan.agentIdentifier)) throw new Error('Plan needs a hex agentIdentifier');
      if (!Number.isInteger(plan.supportedPaymentSourceIndex) || plan.supportedPaymentSourceIndex < 0 || plan.supportedPaymentSourceIndex > 24)
        throw new Error('Plan needs supportedPaymentSourceIndex 0..24');
      if (typeof plan.inputHash !== 'string' || !HEX64.test(plan.inputHash)) throw new Error('Plan needs a 64-hex inputHash');
      if (typeof plan.amount !== 'string' || !ATOMIC.test(plan.amount)) throw new Error('Plan needs a positive atomic amount');
      validateNonce(plan.identifierFromPurchaser);
      requireFreshPlan(plan, now);
      return post('payment', { network: 'Preprod', paymentSourceType: 'Web3CardanoV2',
        agentIdentifier: plan.agentIdentifier, supportedPaymentSourceIndex: plan.supportedPaymentSourceIndex,
        inputHash: plan.inputHash, identifierFromPurchaser: plan.identifierFromPurchaser,
        RequestedFunds: [{ unit: USDM_PREPROD, amount: plan.amount }], payByTime: plan.payByTime,
        submitResultTime: plan.submitResultTime, unlockTime: plan.unlockTime, externalDisputeUnlockTime: plan.externalDisputeUnlockTime });
    },
    /** @param {string} blockchainIdentifier @param {{smartContractAddress?: string}} [options] */
    async resolve(blockchainIdentifier, { smartContractAddress } = {}) {
      if (typeof blockchainIdentifier !== 'string' || !blockchainIdentifier || blockchainIdentifier.length > 8000) throw new Error('Invalid blockchainIdentifier');
      return post('payment/resolve-blockchain-identifier', { network: 'Preprod', blockchainIdentifier, includeHistory: 'true',
        ...(smartContractAddress ? { filterSmartContractAddress: smartContractAddress } : {}) });
    },
    /** @param {string} blockchainIdentifier @param {string} hash */
    async submitResult(blockchainIdentifier, hash) {
      if (typeof blockchainIdentifier !== 'string' || !blockchainIdentifier || blockchainIdentifier.length > 8000) throw new Error('Invalid blockchainIdentifier');
      if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error('Result hash must be 64 lowercase hex characters');
      return post('payment/submit-result', { network: 'Preprod', blockchainIdentifier, submitResultHash: hash });
    },
  };
}
