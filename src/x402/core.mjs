// Shared parts of the x402 channel: prices, input checks, request commitment,
// result hash, quote storage and the job journal. No network calls here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ERR_SETTLEMENT_DEFINITIVELY_REJECTED, ERR_SETTLEMENT_FAILED, buildSignedTerms, commitmentPartDigest, computeTermsDigest,
  masumiEscrowAddress } from '@x402/cardano';
import { MAX_CODE_BYTES, parseGithub } from '../engine/input.mjs';
import { quote as sizeQuote } from '../payment/pricing.mjs';
import { USDM_PREPROD, getTier } from '../payment/tiers.mjs';

const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

export const NETWORK = 'cardano:preprod';
export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);
export const LOVELACE = 'lovelace';
// The test USDM unit of the Sokosumi channel. The x402 channel charges tADA only.
export const USDM_ASSET = `${USDM_PREPROD.slice(0, 56)}.${USDM_PREPROD.slice(56)}`;
export const MAX_TIMEOUT_SECONDS = 600;
export const SCAN_TX = 'https://preprod.cardanoscan.io/transaction/';
export const RESULT_HASH_RULE = 'sha256(terms.buyerNonce + ";" + report)';

// The buyer picks a method. "native" is x402 assetTransferMethod "default": the payment goes
// straight to the seller address. "escrow" is "masumi": the payment locks in the Masumi V2 escrow.
export const METHODS = Object.freeze({ native: 'default', escrow: 'masumi' });
// Escrow over x402 stays off: MPS cannot submit results for these locks, so a buyer's payment
// would stay locked. Buyers who want escrow use the Sokosumi channel (Masumi escrow through MPS).
export const escrowEnabled = () => process.env.X402_ESCROW_ENABLED === 'true';

// Price in tADA by tier and contract size. The size steps come from src/payment/pricing.mjs.
// Both methods use the same table. The audit tier is not here: it needs a human sign-off.
export const PRICE_TADA = Object.freeze({
  see: Object.freeze({ small: 5, medium: 10, large: 15 }),
  write: Object.freeze({ small: 15, medium: 30, large: 45 }),
});
export const MAX_SPEND_ATOMIC = '50000000';
// Buyer spend controls: lovelace up to 50 tADA per payment.
export const BUYER_SPEND_CONTROLS = Object.freeze({
  allowedAssets: [{ network: NETWORK, asset: LOVELACE, maxAmountPerPayment: MAX_SPEND_ATOMIC }],
});

// Time an escrow job needs from the start of settlement to its on-chain result deadline.
export const RUN_BUDGET_MS = Object.freeze({ see: 8 * MINUTE, write: 30 * MINUTE });
export const SETTLE_ALLOWANCE_MS = 3 * MINUTE;
export const X402_TIERS = Object.freeze(Object.keys(PRICE_TADA));

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
 * Price, asset and (for escrow) deadlines of one option. Escrow deadlines follow tiers.mjs:
 * the result is due submitMinutes after the quote, then 16-minute gaps.
 * @param {string} tier @param {{size?: string, method?: string}} [choice]
 */
export function x402Offer(tier, { size = 'small', method = 'escrow' } = {}) {
  if (!X402_TIERS.includes(tier)) throw new HttpError(400, 'invalid_tier', 'tier must be "see" or "write".');
  if (!Object.hasOwn(METHODS, method)) throw new HttpError(400, 'invalid_method', 'method must be "native" or "escrow".');
  if (!Object.hasOwn(PRICE_TADA[tier], size)) throw new Error(`Unknown contract size: ${size}`);
  const priceTada = PRICE_TADA[/** @type {'see' | 'write'} */ (tier)][/** @type {'small'} */ (size)];
  const offer = { tier, size, method, transferMethod: METHODS[/** @type {'native' | 'escrow'} */ (method)], priceTada,
    amount: String(priceTada * 1_000_000), asset: LOVELACE, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    /** @type {null | {submitResultAfterPayByMs: number, unlockAfterPayByMs: number, externalDisputeUnlockAfterPayByMs: number}} */
    deadlines: null };
  if (method === 'escrow') {
    const submitAfterPayBy = getTier(tier).submitMinutes * MINUTE - MAX_TIMEOUT_SECONDS * 1000;
    offer.deadlines = {
      submitResultAfterPayByMs: submitAfterPayBy,
      unlockAfterPayByMs: submitAfterPayBy + 16 * MINUTE,
      externalDisputeUnlockAfterPayByMs: submitAfterPayBy + 32 * MINUTE,
    };
  }
  return offer;
}

/** Size class of the Aiken sources, with the same steps as the Sokosumi channel. @param {{path: string, content: string}[]} files */
export function contractSize(files) {
  const { lines, size, files: count } = sizeQuote({ tier: 'see', files });
  return { files: count, lines, size };
}

/** Pasted code as the one source file the audit workspace gets. @param {string} code */
export const codeFiles = (code) => [{ path: 'validators/contract.ak', content: `${code.trim()}\n` }];

const TIER_TEXT = { see: 'Findings report', write: 'Findings report and fixed code' };

/**
 * The options POST /quote lists: every tier and every method that has a payee.
 * @param {string} size @param {{native?: string | null, escrow?: string | null}} payTo
 */
export function quoteOptions(size, payTo) {
  const options = [];
  for (const tier of X402_TIERS) {
    for (const method of /** @type {const} */ (['native', 'escrow'])) {
      if (!payTo[method] || (method === 'escrow' && !escrowEnabled())) continue;
      const offer = x402Offer(tier, { size, method });
      const how = method === 'native'
        ? `Pay ${offer.priceTada} tADA straight to the seller wallet. The payment is final.`
        : `Lock ${offer.priceTada} tADA in the Masumi V2 escrow. The seller collects only after the report hash is on chain. `
          + `The result is due within ${getTier(tier).submitMinutes} minutes, or the buyer can take a refund.`;
      options.push({ id: `${tier}-${method}`, tier, method, priceTada: offer.priceTada, amount: offer.amount, asset: LOVELACE,
        payTo: payTo[method], description: `${TIER_TEXT[tier]}. ${how}` });
    }
  }
  return options;
}

const SOURCE_FIELDS = ['code', 'github', 'files'];
const AUDIT_FIELDS = new Set(['tier', 'method', 'description', ...SOURCE_FIELDS]);
const QUOTE_FIELDS = new Set(['description', ...SOURCE_FIELDS]);
// validators/... or lib/... path of an .ak file. No "." or ".." segments.
const FILE_PATH = /^(?:validators|lib)(?:\/[A-Za-z0-9_][A-Za-z0-9_-]*)+\.ak$/;
const MAX_FILES = 100;

/** @param {unknown} files */
function parseFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
    throw new HttpError(400, 'invalid_files', `files must be a list of 1 to ${MAX_FILES} Aiken files.`);
  const seen = new Set();
  let total = 0;
  const out = files.map((file) => {
    const keys = file && typeof file === 'object' && !Array.isArray(file) ? Object.keys(file) : [];
    if (keys.length !== 2 || !keys.includes('path') || !keys.includes('content'))
      throw new HttpError(400, 'invalid_files', 'Each file must be {"path", "content"}.');
    const { path, content } = file;
    if (typeof path !== 'string' || path.length > 200 || !FILE_PATH.test(path) || seen.has(path))
      throw new HttpError(400, 'invalid_files', 'Each path must be a unique validators/... or lib/... .ak path.');
    if (typeof content !== 'string' || !content.isWellFormed()) throw new HttpError(400, 'invalid_files', `${path} must be text.`);
    seen.add(path);
    total += Buffer.byteLength(content);
    return { path, content };
  });
  if (total > MAX_CODE_BYTES) throw new HttpError(413, 'code_too_large', `The files must be ${MAX_CODE_BYTES} bytes or fewer in total.`);
  if (!out.some((f) => f.path.startsWith('validators/'))) throw new HttpError(400, 'invalid_files', 'Send at least one validators/ file.');
  return out;
}

/** Checks the source and notes fields shared by POST /quote and POST /audit. @param {Record<string, unknown>} record */
function parseSource(record) {
  const { code, github, files, description } = record;
  if (description !== undefined && (typeof description !== 'string' || description.length > 4000 || !description.isWellFormed()))
    throw new HttpError(400, 'invalid_description', 'description must be text of 4000 characters or fewer.');
  if ([code, github, files].filter((v) => v !== undefined).length !== 1)
    throw new HttpError(400, 'invalid_source', 'Send exactly one of "code", "github" or "files".');
  let source;
  if (code !== undefined) {
    if (typeof code !== 'string' || !code.trim() || !code.isWellFormed()) throw new HttpError(400, 'invalid_code', 'code must be Aiken source text.');
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new HttpError(413, 'code_too_large', `code must be ${MAX_CODE_BYTES} bytes or fewer.`);
    source = { kind: 'code', code };
  } else if (files !== undefined) {
    source = { kind: 'files', files: parseFiles(files) };
  } else {
    const text = typeof github === 'string' ? github.trim() : '';
    const link = text.length <= 500 && text.startsWith('https://github.com/') && !/\s/.test(text) ? parseGithub(text) : null;
    // No "." or ".." path segments and no ref that git could read as an option.
    const segments = link ? link.display.slice('https://github.com/'.length).split('/') : [];
    if (!link || segments.some((s) => s === '.' || s === '..') || link.ref?.startsWith('-'))
      throw new HttpError(400, 'invalid_github', 'github must be a public https://github.com link.');
    source = { kind: 'github', ...link };
  }
  return { source, buyerNotes: typeof description === 'string' ? description : '' };
}

/** @param {unknown} body @param {Set<string>} fields */
function asRecord(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body', 'Send a JSON object.');
  const record = /** @type {Record<string, unknown>} */ (body);
  const unknown = Object.keys(record).find((key) => !fields.has(key));
  if (unknown) throw new HttpError(400, 'unknown_field', `Unknown field: ${unknown.slice(0, 40)}`);
  return record;
}

/** Checks a POST /quote body. @param {unknown} body */
export const parseQuoteRequest = (body) => parseSource(asRecord(body, QUOTE_FIELDS));

/**
 * Checks a POST /audit body. Throws HttpError before any quote is issued.
 * "method" is optional and defaults to "escrow", the first method this channel had.
 * @param {unknown} body
 */
export function parseAuditRequest(body) {
  const record = asRecord(body, AUDIT_FIELDS);
  const { tier, method = 'escrow' } = record;
  if (tier === 'audit') {
    throw new HttpError(400, 'tier_not_offered',
      'The audit tier needs a human sign-off within 24 hours. Buy it through Sokosumi. Over x402, choose "see" or "write".');
  }
  if (typeof tier !== 'string' || !X402_TIERS.includes(tier)) throw new HttpError(400, 'invalid_tier', 'tier must be "see" or "write".');
  if (typeof method !== 'string' || !Object.hasOwn(METHODS, method)) throw new HttpError(400, 'invalid_method', 'method must be "native" or "escrow".');
  if (method === 'escrow' && !escrowEnabled()) {
    throw new HttpError(400, 'method_not_offered', 'Escrow is not offered over x402. Use method "native", or buy through Sokosumi for Masumi escrow.');
  }
  return { tier, method, ...parseSource(record) };
}

/** SHA-256 of the JCS form of a request body, the same digest the escrow commitment uses. @param {unknown} body */
export const bodyDigest = (body) => commitmentPartDigest({ canonicalization: 'jcs', content: body });

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
  try { return bodyDigest(body) === part.digest; } catch { return false; }
}

/** termsDigest of an issued Masumi quote. It is the escrow job key. @param {any} requirements */
export function termsDigestOf(requirements) {
  return computeTermsDigest(buildSignedTerms(requirements.extra, requirements));
}

/** x402 core leaves "default" off the wire, so a missing method means "default". @param {any} requirements */
export const transferMethodOf = (requirements) => requirements?.extra?.assetTransferMethod ?? METHODS.native;

/**
 * Checks payment requirements against one offer: network, payee, asset, price, method, and for
 * escrow the seller, no registry claim and the deadline gaps.
 * Returns null when they match, or the name of the first field that does not.
 * @param {any} requirements @param {ReturnType<typeof x402Offer>} offer
 * @param {{sellerAddress?: string | null, payTo?: string | null}} expected escrow: the seller key; native: the payee
 */
export function quoteProblem(requirements, offer, { sellerAddress, payTo } = {}) {
  if (requirements?.scheme !== 'exact' || requirements.network !== NETWORK) return 'network';
  const payee = offer.method === 'escrow' ? ESCROW_ADDRESS : payTo;
  if (!payee || requirements.payTo !== payee) return 'payTo';
  if (requirements.asset !== offer.asset || requirements.amount !== offer.amount) return 'price';
  if (requirements.maxTimeoutSeconds !== offer.maxTimeoutSeconds) return 'maxTimeoutSeconds';
  const terms = requirements.extra?.terms;
  if (transferMethodOf(requirements) !== offer.transferMethod) return 'assetTransferMethod';
  if (offer.method === 'native') return terms === undefined ? null : 'assetTransferMethod';
  if (!terms) return 'assetTransferMethod';
  if (!sellerAddress || terms.sellerAddress !== sellerAddress) return 'seller';
  if (terms.agentIdentifier != null && terms.agentIdentifier !== '') return 'agentIdentifier';
  const payBy = Number(terms.payByTime);
  const deadlines = /** @type {NonNullable<typeof offer.deadlines>} */ (offer.deadlines);
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
 * Reads the .ak files of a local Aiken project (validators/ and lib/) for a "files" request.
 * Refuses symbolic links, so a link cannot send a file from outside the folder.
 * @param {string} dir
 */
export function readAikenFolder(dir) {
  const root = resolve(dir);
  if (!existsSync(join(root, 'aiken.toml'))) throw new Error(`${root} has no aiken.toml. Give the folder of an Aiken project.`);
  /** @type {{path: string, content: string}[]} */
  const files = [];
  const walk = (/** @type {string} */ rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'build') continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`${path} is a symbolic link. Links are not sent.`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ak')) files.push({ path, content: readFileSync(join(root, path), 'utf8') });
    }
  };
  for (const top of ['validators', 'lib']) if (existsSync(join(root, top))) walk(top);
  if (!files.length) throw new Error(`${root} has no .ak files in validators/ or lib/.`);
  return parseFiles(files);
}

/** Overall risk and findings from a report made by src/engine/report.mjs. @param {string} report */
export function reportSummary(report) {
  const overallRisk = /\*\*Overall risk: ([A-Za-z]+)\*\*/.exec(report)?.[1] ?? null;
  const findings = [...report.matchAll(/^### \d+\. \[(Critical|High|Medium|Low|Info)\] (.+)$/gm)]
    .map((m) => ({ severity: m[1], title: m[2].trim() }));
  return { overallRisk, findings };
}

/**
 * Result hash for this channel: MIP-004 (raw, not the Sokosumi escaped form) with the
 * signed buyer nonce. The x402 scheme issues an empty buyer nonce, so it is sha256(";" + report).
 * A native payment has no nonce, so it uses the same empty-nonce rule.
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
 * One JSON file per paid job. Escrow jobs are named by termsDigest, native jobs by transaction id.
 * Save before every external write.
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
