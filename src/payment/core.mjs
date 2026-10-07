// Sokosumi Core client for paid Tasks, acting as the assigned Coworker.
// Ported from demo-agent-token2049 scripts/core-runtime.mjs and scripts/payment.ts.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { validateNonce } from './hash.mjs';
import { validateQuote } from './mps.mjs';
import { USDM_PREPROD } from './tiers.mjs';

const execute = promisify(execFile);
const REQUEST_TIMEOUT_MS = 30_000;
const MINUTE_MS = 60_000;
// The D7 fix was checked against this CLI version.
export const SOKOSUMI_CLI_VERSION = '1.0.4';

/** @param {unknown} value */
export function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid Task or Coworker ID.');
  return value;
}

// Load the CLI's own modules, the same way hi-agent/worker.mjs does.
export async function loadSokosumiRuntime() {
  const { stdout } = await execute('sokosumi', ['skills', 'path'], { timeout: REQUEST_TIMEOUT_MS });
  const root = dirname(stdout.trim());
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.version !== SOKOSUMI_CLI_VERSION)
    throw new Error(`Sokosumi CLI is ${metadata.version}, expected ${SOKOSUMI_CLI_VERSION}. Recheck Coworker runtime auth first.`);
  const load = (/** @type {string} */ path) => import(pathToFileURL(join(root, 'dist', 'src', path)).href);
  const [{ createCoworkerHttpClient }, { readRuntimeCredential }] = await Promise.all([
    load('api/http-client.js'), load('coworker/runtime-credentials.js')]);
  return { createCoworkerHttpClient, readRuntimeCredential };
}

/**
 * @param {string} coworkerId
 * @param {{loadRuntime?: typeof loadSokosumiRuntime, verify?: boolean}} [options]
 */
export async function createCoreClient(coworkerId, { loadRuntime = loadSokosumiRuntime, verify = true } = {}) {
  safeId(coworkerId);
  const { createCoworkerHttpClient, readRuntimeCredential } = await loadRuntime();
  // D7: pass apiKey only. contextUserId makes Core act as a user, and Core then
  // returns 422 "Only the assigned coworker can set masumiPayment".
  const http = createCoworkerHttpClient({ apiKey: readRuntimeCredential(coworkerId) });
  if (verify) {
    const identity = await http.get('/v1/coworkers/me', AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (identity?.data?.id !== coworkerId || identity.data.archivedAt !== null || !identity.data.capabilities?.includes('tasks'))
      throw new Error('Coworker runtime identity does not match this Coworker.');
  }
  return scopeCoreClient(http);
}

/** @param {any} error @param {string} action */
function coreError(error, action) {
  const status = typeof error?.status === 'number' ? error.status : undefined;
  // The CLI client already redacts its token in HTTP error messages.
  const message = status === undefined
    ? `Core ${action} outcome is uncertain. Inspect the Task before retrying.`
    : `Core ${action} failed with HTTP ${status}: ${String(error.message).slice(0, 300)}`;
  return Object.assign(new Error(message), { status, uncertain: status === undefined || status >= 500 });
}

/** @param {{get: Function, post: Function}} http a Coworker HTTP client from the Sokosumi CLI */
export function scopeCoreClient(http) {
  return {
    /** @param {string} taskId @param {object} masumiPayment the object from buildMasumiPaymentEvent */
    async postPaymentEvent(taskId, masumiPayment) {
      safeId(taskId);
      if (!masumiPayment || typeof masumiPayment !== 'object' || 'masumiPayment' in masumiPayment)
        throw new Error('Pass the inner masumiPayment object, not a wrapped event');
      let result;
      try {
        result = await http.post(`/v1/tasks/${taskId}/events`, { masumiPayment }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      } catch (error) { throw coreError(error, 'payment event'); }
      const event = result?.data;
      if (typeof event?.id !== 'string' || !event.id || (event.taskId !== undefined && event.taskId !== taskId))
        throw Object.assign(new Error('Core payment event outcome is uncertain: no matching event id. Inspect the Task before retrying.'), { uncertain: true });
      return event.id;
    },
    /** @param {string} taskId */
    async fetchReceipt(taskId) {
      safeId(taskId);
      let result;
      try {
        result = await http.get(`/v1/tasks/${taskId}/receipt`, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      } catch (error) { throw coreError(error, 'receipt read'); }
      return validateReceipt(result?.data);
    },
  };
}

const receiptSchema = z.object({ blockchainIdentifier: z.string().nullable(), claimStatus: z.string().nullable(),
  onChainState: z.string().nullable(), settled: z.boolean(), txHash: z.string().nullable(),
  withdrawnForSeller: z.array(z.object({ unit: z.string().nullable(), amount: z.string().nullable() })) });

/**
 * D8: an ordinary Withdrawn receipt can omit the payout summary. A disputed one cannot.
 * A settled receipt alone is not payment proof. Still check the seller's chain receipt.
 * @param {unknown} value
 */
export function validateReceipt(value) {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid Core receipt');
  const receipt = parsed.data;
  const payoutSummaryRequired = receipt.onChainState === 'DisputedWithdrawn' || receipt.withdrawnForSeller.length > 0;
  if (receipt.settled && (!receipt.blockchainIdentifier || !receipt.txHash || !/^[0-9a-f]{64}$/.test(receipt.txHash) ||
      !['Withdrawn', 'DisputedWithdrawn'].includes(receipt.onChainState ?? '') ||
      (payoutSummaryRequired && !receipt.withdrawnForSeller.some(fund => fund.unit === USDM_PREPROD && /^[1-9]\d*$/.test(fund.amount ?? '')))))
    throw new Error('Receipt does not prove a settled test USDM seller payout');
  return /** @type {any} */ (value);
}

/**
 * The masumiPayment object for a Core Task event, with the exact source field set.
 * Times stay as the quote's ms-epoch strings. Core cannot carry sellerReturnAddress or forceLayer,
 * so the quote must have them null. Run validateQuote with the tier amount before this call.
 * @param {any} quote fresh MPS quote
 * @param {any} registration seller registration (see validateRegistration)
 * @param {string} identifierFromPurchaser the plan nonce (MPS does not echo it)
 * @param {{now?: number}} [options]
 */
export function buildMasumiPaymentEvent(quote, registration, identifierFromPurchaser, { now = Date.now() } = {}) {
  validateNonce(identifierFromPurchaser);
  validateQuote(quote, registration, quote?.RequestedFunds?.[0]?.amount);
  if (Number(quote.payByTime) <= now || Number(quote.submitResultTime) < now + 15 * MINUTE_MS)
    throw new Error('Payment quote expired; do not replace a possibly charged quote');
  return { blockchainIdentifier: quote.blockchainIdentifier,
    identifierFromPurchaser, agentIdentifier: quote.agentIdentifier,
    sellerVkey: quote.SmartContractWallet.walletVkey, inputHash: quote.inputHash,
    payByTime: quote.payByTime, submitResultTime: quote.submitResultTime, unlockTime: quote.unlockTime,
    externalDisputeUnlockTime: quote.externalDisputeUnlockTime,
    Amounts: quote.RequestedFunds.map((/** @type {{amount: string, unit: string}} */ { amount, unit }) => ({ amount, unit })),
    paymentSourceType: quote.PaymentSource.paymentSourceType, supportedPaymentSourceIndex: registration.supportedPaymentSourceIndex,
    PaymentSource: { network: quote.PaymentSource.network, policyId: quote.PaymentSource.policyId,
      smartContractAddress: quote.PaymentSource.smartContractAddress } };
}
