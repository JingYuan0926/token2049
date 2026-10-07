// Shared parts of the x402 channel: prices, input checks, request commitment,
// result hash, quote storage and the job journal. No network calls here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ERR_SETTLEMENT_DEFINITIVELY_REJECTED, ERR_SETTLEMENT_FAILED, buildSignedTerms, commitmentPartDigest, computeTermsDigest,
  masumiEscrowAddress } from '@x402/cardano';
import { MAX_CODE_BYTES, parseGithub } from '../engine/input.mjs';
import { TIERS, USDM_PREPROD, getTier } from '../payment/tiers.mjs';

const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

export const NETWORK = 'cardano:preprod';
export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);
// tiers.mjs keeps the unit as one hex string. x402 wants "policyId.assetNameHex".
export const USDM_ASSET = `${USDM_PREPROD.slice(0, 56)}.${USDM_PREPROD.slice(56)}`;
export const MAX_TIMEOUT_SECONDS = 600;
export const MAX_SPEND_ATOMIC = TIERS.audit.amount;
export const SCAN_TX = 'https://preprod.cardanoscan.io/transaction/';
// Buyer spend controls: this test USDM up to 20 per payment. Other default assets keep the $1 cap.
export const BUYER_SPEND_CONTROLS = Object.freeze({
  allowedAssets: [{ network: NETWORK, asset: USDM_ASSET, maxAmountPerPayment: MAX_SPEND_ATOMIC }],
});
export const RESULT_HASH_RULE = 'sha256(terms.buyerNonce + ";" + report)';

// Time a job needs from the start of settlement to its on-chain result deadline.
// The audit tier is not here: it needs a human sign-off, which an HTTP request cannot wait for.
export const RUN_BUDGET_MS = Object.freeze({ see: 8 * MINUTE, write: 30 * MINUTE });
export const SETTLE_ALLOWANCE_MS = 3 * MINUTE;
export const X402_TIERS = Object.freeze(Object.keys(RUN_BUDGET_MS));

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const sha256 = (/** @type {string} */ text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Price, asset and escrow deadlines for one tier. The deadlines follow tiers.mjs:
 * the result is due submitMinutes after the quote, then 16-minute gaps.
 * @param {string} tier
 */
export function x402Offer(tier) {
  if (!X402_TIERS.includes(tier)) throw new HttpError(400, 'invalid_tier', 'tier must be "see" or "write".');
  const { amount, submitMinutes } = getTier(tier);
  const submitAfterPayBy = submitMinutes * MINUTE - MAX_TIMEOUT_SECONDS * 1000;
  return {
    tier, amount, asset: USDM_ASSET, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    deadlines: {
      submitResultAfterPayByMs: submitAfterPayBy,
      unlockAfterPayByMs: submitAfterPayBy + 16 * MINUTE,
      externalDisputeUnlockAfterPayByMs: submitAfterPayBy + 32 * MINUTE,
    },
  };
}

const FIELDS = new Set(['tier', 'code', 'github', 'description']);

/**
 * Checks a POST /audit body. Throws HttpError before any quote is issued.
 * @param {unknown} body
 */
export function parseAuditRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body', 'Send a JSON object.');
  const record = /** @type {Record<string, unknown>} */ (body);
  const unknown = Object.keys(record).find((key) => !FIELDS.has(key));
  if (unknown) throw new HttpError(400, 'unknown_field', `Unknown field: ${unknown.slice(0, 40)}`);
  const { tier, code, github, description } = record;
  if (tier === 'audit') {
    throw new HttpError(400, 'tier_not_offered',
      'The audit tier needs a human sign-off within 24 hours. Buy it through Sokosumi. Over x402, choose "see" or "write".');
  }
  if (typeof tier !== 'string' || !X402_TIERS.includes(tier)) throw new HttpError(400, 'invalid_tier', 'tier must be "see" or "write".');
  if (description !== undefined && (typeof description !== 'string' || description.length > 4000 || !description.isWellFormed()))
    throw new HttpError(400, 'invalid_description', 'description must be text of 4000 characters or fewer.');
  if ((code === undefined) === (github === undefined)) throw new HttpError(400, 'invalid_source', 'Send exactly one of "code" or "github".');
  let source;
  if (code !== undefined) {
    if (typeof code !== 'string' || !code.trim() || !code.isWellFormed()) throw new HttpError(400, 'invalid_code', 'code must be Aiken source text.');
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new HttpError(413, 'code_too_large', `code must be ${MAX_CODE_BYTES} bytes or fewer.`);
    source = { kind: 'code', code };
  } else {
    const text = typeof github === 'string' ? github.trim() : '';
    const link = text.length <= 500 && text.startsWith('https://github.com/') && !/\s/.test(text) ? parseGithub(text) : null;
    // No "." or ".." path segments and no ref that git could read as an option.
    const segments = link ? link.display.slice('https://github.com/'.length).split('/') : [];
    if (!link || segments.some((s) => s === '.' || s === '..') || link.ref?.startsWith('-'))
      throw new HttpError(400, 'invalid_github', 'github must be a public https://github.com link.');
    source = { kind: 'github', ...link };
  }
  return { tier, source, buyerNotes: typeof description === 'string' ? description : '' };
}

/**
 * The request commitment. The escrow input_hash binds the payment to it.
 * "body" is the buyer's own JSON (not echoed, the buyer recomputes it).
 * "offer" is our content, echoed so the buyer can approve it before paying.
 * @param {unknown} body @param {string} tier
 */
export function commitmentFor(body, tier) {
  return [
    { name: 'body', canonicalization: /** @type {const} */ ('jcs'), mediaType: 'application/json', content: body, echoContent: false },
    { name: 'offer', canonicalization: /** @type {const} */ ('jcs'), mediaType: 'application/json',
      content: { service: 'aiken-auditor', tier, deliverable: 'Markdown audit report in the response body', resultHash: RESULT_HASH_RULE } },
  ];
}

/** True when the paid retry carries the same JSON body that the quote committed to. @param {any} requirements @param {unknown} body */
export function bodyMatchesQuote(requirements, body) {
  const part = requirements?.extra?.inputCommitment?.parts?.find((/** @type {any} */ p) => p.name === 'body');
  if (!part || part.canonicalization !== 'jcs') return false;
  try { return commitmentPartDigest({ canonicalization: 'jcs', content: body }) === part.digest; } catch { return false; }
}

/** termsDigest of an issued Masumi quote. It is the job key. @param {any} requirements */
export function termsDigestOf(requirements) {
  return computeTermsDigest(buildSignedTerms(requirements.extra, requirements));
}

/**
 * Checks a quote against this tier: network, escrow, asset, price, seller, no registry claim, deadline gaps.
 * Returns null when it matches, or the name of the first field that does not.
 * @param {any} requirements @param {string} tier @param {string} sellerAddress
 */
export function quoteProblem(requirements, tier, sellerAddress) {
  const offer = x402Offer(tier);
  const terms = requirements?.extra?.terms;
  if (requirements?.scheme !== 'exact' || requirements.network !== NETWORK) return 'network';
  if (requirements.payTo !== ESCROW_ADDRESS) return 'payTo';
  if (requirements.asset !== offer.asset || requirements.amount !== offer.amount) return 'price';
  if (requirements.maxTimeoutSeconds !== offer.maxTimeoutSeconds) return 'maxTimeoutSeconds';
  if (requirements.extra?.assetTransferMethod !== 'masumi' || !terms) return 'assetTransferMethod';
  if (terms.sellerAddress !== sellerAddress) return 'seller';
  if (terms.agentIdentifier != null && terms.agentIdentifier !== '') return 'agentIdentifier';
  const payBy = Number(terms.payByTime);
  const { deadlines } = offer;
  if (Number(terms.submitResultTime) - payBy !== deadlines.submitResultAfterPayByMs
    || Number(terms.unlockTime) - payBy !== deadlines.unlockAfterPayByMs
    || Number(terms.externalDisputeUnlockTime) - payBy !== deadlines.externalDisputeUnlockAfterPayByMs) return 'deadlines';
  return null;
}

/**
 * True only when the transaction can never reach the chain. Any other failure (a timeout, a gateway
 * error, a duplicate or unknown submission) may hide a broadcast, so the job stays resumable.
 * @param {{errorReason?: string, extra?: any}} settle
 */
export function settleFailureIsFinal(settle) {
  return settle.errorReason === ERR_SETTLEMENT_DEFINITIVELY_REJECTED
    || (settle.errorReason === ERR_SETTLEMENT_FAILED && settle.extra?.status === 'expired');
}

/** First symbolic link inside a cloned repository (outside .git), or null. @param {string} dir */
export function findSymlink(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = /** @type {string} */ (stack.pop());
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) return relative(dir, path);
      if (entry.isDirectory() && !(current === dir && entry.name === '.git')) stack.push(path);
    }
  }
  return null;
}

/**
 * Result hash for this channel: MIP-004 (raw, not the Sokosumi escaped form) with the
 * signed buyer nonce. The x402 scheme issues an empty buyer nonce, so it is sha256(";" + report).
 * @param {string} buyerNonce @param {string} report
 */
export function x402ResultHash(buyerNonce, report) {
  if (typeof buyerNonce !== 'string' || !/^(|(?:[0-9a-f]{2}){7,13})$/.test(buyerNonce)) throw new Error('Invalid buyer nonce');
  if (typeof report !== 'string' || !report.isWellFormed()) throw new Error('Report must be valid Unicode text');
  return sha256(`${buyerNonce};${report}`);
}

/** @param {string} path @param {unknown} value */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Per-key promise chain, so updates of one key never interleave in this process. */
function keyedLock() {
  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map();
  return async (/** @type {string} */ key, /** @type {() => any} */ fn) => {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  };
}

/**
 * MasumiTermsStorage on disk, so a paid retry still matches its quote after a restart.
 * Atomic only inside one process. Run one server process per directory.
 */
export class FileMasumiTermsStorage {
  /** @param {string} dir */
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.lock = keyedLock();
  }

  /** @param {string} digest */
  path(digest) {
    if (typeof digest !== 'string' || !HEX64.test(digest)) throw new Error('Invalid terms digest');
    return join(this.dir, `${digest}.json`);
  }

  /** @param {string} digest */
  async get(digest) {
    const path = this.path(digest);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  }

  /** @param {string} digest @param {(current: any) => any} update */
  async updateTerms(digest, update) {
    return this.lock(digest, async () => {
      const current = await this.get(digest);
      const next = update(current);
      if (next === current) return { terms: current, status: 'unchanged' };
      if (!next) {
        if (current) unlinkSync(this.path(digest));
        return { terms: undefined, status: current ? 'deleted' : 'unchanged' };
      }
      writeJsonAtomic(this.path(digest), next);
      return { terms: next, status: 'updated' };
    });
  }

  /** Deletes unpaid quotes one hour after their pay-by time. @param {number} [now] */
  prune(now = Date.now()) {
    let removed = 0;
    for (const file of readdirSync(this.dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))) {
      try {
        const record = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
        const payBy = Number(record?.requirements?.extra?.terms?.payByTime);
        if (!record.claimedTxHash && Number.isFinite(payBy) && payBy + 60 * MINUTE < now) {
          unlinkSync(join(this.dir, file));
          removed += 1;
        }
      } catch { /* leave unreadable files for a human */ }
    }
    return removed;
  }
}

/**
 * One JSON file per paid job, named by termsDigest. Save before every external write.
 * @param {string} dir
 */
export function createJournal(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (/** @type {string} */ id) => {
    if (typeof id !== 'string' || !HEX64.test(id)) throw new Error('Invalid job key');
    return join(dir, `${id}.json`);
  };
  return {
    dir,
    /** @param {string} id */
    load: (id) => (existsSync(path(id)) ? JSON.parse(readFileSync(path(id), 'utf8')) : null),
    /** @param {string} id @param {Record<string, unknown>} state */
    save: (id, state) => {
      const next = { ...state, updatedAt: new Date().toISOString() };
      writeJsonAtomic(path(id), next);
      return next;
    },
    list: () => readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).map((f) => f.slice(0, -5)),
    /** @param {string} id */
    reportPath: (id) => path(id).replace(/\.json$/, '.report.md'),
  };
}
