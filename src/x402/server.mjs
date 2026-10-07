// x402 channel (plan milestone M5): other AI agents buy an audit over HTTP and pay in tADA on Cardano Preprod.
// Both payment methods use the @x402/cardano "exact" scheme:
//   native  assetTransferMethod "default": the buyer pays the registered agent's selling wallet. Final.
//   escrow  assetTransferMethod "masumi": the payment locks in the Masumi V2 escrow until the result is on chain.
// POST /quote prices a contract by size, with no payment. POST /audit sells the audit.
//
//   npm run x402                                 start on 127.0.0.1:3013
//   node src/x402/server.mjs --seller-init       create the x402 seller key (.local/x402-seller-wallet.json)
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeCardanoTransaction, toMasumiSellerSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';
import { FacilitatorResponseError, HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { WORK_DIR, collectSources, prepareWorkspace as enginePrepareWorkspace } from '../engine/aiken.mjs';
import { runAudit as engineRunAudit } from '../engine/index.mjs';
import { createMpsClient } from '../payment/mps.mjs';
import { ESCROW_ADDRESS, FileMasumiTermsStorage, HttpError, LOVELACE, METHODS, NETWORK, PRICE_TADA, RESULT_HASH_RULE,
  RUN_BUDGET_MS, SCAN_TX, SETTLE_ALLOWANCE_MS, X402_TIERS, bodyDigest, bodyMatchesQuote, codeFiles, commitmentFor,
  contractSize, createJournal, findSymlink, parseAuditRequest, parseQuoteRequest, quoteOptions, quoteProblem,
  settleFailureIsFinal, sha256, termsDigestOf, x402Offer, x402ResultHash } from './core.mjs';
import { createWalletFile, readWalletFile } from './wallet.mjs';

export const HOSTED_FACILITATOR = 'https://x402.preprod.dev.ecosyseng.cf-deployments.org';
const MAX_BODY_BYTES = 256 * 1024;
const REPORT_PHASES = new Set(['report-ready', 'submit-pending', 'result-submitted', 'result-not-submitted', 'delivered']);
const RUNNABLE_PHASES = new Set(['settled', 'auditing', 'report-ready']);
const INSPECT_TTL_MS = 20 * 60_000;
// Messages from the engine that are safe to show a buyer. Others may hold local paths.
const SAFE_INSPECT_ERROR = /^(No Aiken project|The repository is larger|The repository contains a symbolic link|The contract contains a symbolic link|The Aiken sources are larger|No validators found|The linked path is outside)/;

export const INPUT_SCHEMA = Object.freeze({
  input_data: [
    { id: 'tier', type: 'option', name: 'Tier',
      data: { values: ['see', 'write', 'audit'],
        description: 'see: findings report, 5/10/15 tADA by contract size. write: report and fixed code, 15/30/45 tADA. audit: human-reviewed, Sokosumi only.' },
      validations: [{ validation: 'min', value: '1' }, { validation: 'max', value: '1' }] },
    { id: 'method', type: 'option', name: 'Payment method',
      data: { values: ['native', 'escrow'],
        description: 'native: pay the seller wallet directly (final). escrow: lock in the Masumi V2 escrow (default).' },
      validations: [{ validation: 'optional', value: 'true' }, { validation: 'min', value: '1' }, { validation: 'max', value: '1' }] },
    { id: 'code', type: 'textarea', name: 'Aiken code',
      data: { description: 'The validator source. Send one of code, github or files.' },
      validations: [{ validation: 'optional', value: 'true' }, { validation: 'max', value: '200000' }] },
    { id: 'github', type: 'string', name: 'Public GitHub link',
      data: { description: 'A public https://github.com link to an Aiken project folder.' },
      validations: [{ validation: 'optional', value: 'true' }, { validation: 'format', value: 'url' }] },
    { id: 'description', type: 'textarea', name: 'Notes for the auditor',
      data: { description: 'Optional. What the contract should do.' },
      validations: [{ validation: 'optional', value: 'true' }, { validation: 'max', value: '4000' }] },
  ],
});

/** node:http request as the x402 core HTTPAdapter. @param {import('node:http').IncomingMessage} req @param {URL} url @param {unknown} body */
function adapterFor(req, url, body) {
  const header = (/** @type {string} */ name) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    getHeader: header,
    getMethod: () => req.method ?? 'GET',
    getPath: () => url.pathname,
    getUrl: () => url.href,
    getAcceptHeader: () => header('accept') ?? '',
    getUserAgent: () => header('user-agent') ?? '',
    getQueryParams: () => Object.fromEntries(url.searchParams),
    getQueryParam: (/** @type {string} */ name) => url.searchParams.get(name) ?? undefined,
    getBody: () => body,
  };
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', `The body must be ${MAX_BODY_BYTES} bytes or fewer.`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'The body must be JSON.'); }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Writes the response instructions from x402 core. @param {import('node:http').ServerResponse} res @param {any} out */
function sendInstructions(res, out) {
  res.writeHead(out.status, { 'Cache-Control': 'no-store', ...(out.isHtml ? {} : { 'Content-Type': 'application/json' }), ...out.headers });
  res.end(out.isHtml ? String(out.body ?? '') : JSON.stringify(out.body ?? {}));
}

/** @param {ReturnType<typeof x402Offer>} offer @param {any} project */
function unpaidBody(offer, project) {
  return {
    error: 'payment_required', tier: offer.tier, method: offer.method, project,
    price: { amount: offer.amount, asset: offer.asset, display: `${offer.priceTada} tADA` },
    howToPay: `Read the PAYMENT-REQUIRED header (x402 v2). Pay with @x402/cardano "exact", assetTransferMethod "${offer.transferMethod}". `
      + 'Then send the same JSON body again with the PAYMENT-SIGNATURE header.',
  };
}

/** Decodes a PAYMENT-SIGNATURE header into the job key and transaction id, or null. @param {string} value @param {string} method */
function paidJobKey(value, method) {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const txHash = decodeCardanoTransaction(payload.payload.transaction).txHash.toLowerCase();
    return { id: method === 'escrow' ? termsDigestOf(payload.accepted) : txHash, txHash };
  } catch { return null; }
}

const tada = (/** @type {string} */ lovelace) => Number(lovelace) / 1e6;
const isEscrow = (/** @type {any} */ job) => job.method !== 'native';
const keyOf = (/** @type {any} */ job) => job.key ?? job.termsDigest;
const txLink = (/** @type {string | undefined} */ hash) => (hash ? { hash, url: `${SCAN_TX}${hash}` } : null);

/** Cardano proof section of the report. It is part of the hashed report. @param {any} job */
function proofSection(job) {
  const tx = job.paymentTxHash ?? job.escrowTxHash;
  const check = `- **Check it yourself:** save this report as \`report.md\`, then run \`node -e 'const t=require("fs").readFileSync("report.md","utf8");console.log(require("crypto").createHash("sha256").update("${job.buyerNonce ?? ''};"+t).digest("hex"))'\` and compare it with the result hash.`;
  if (!isEscrow(job)) {
    return [
      `- **Payment:** ${tada(job.amount)} tADA, paid with x402 (native, address to address) on Cardano Preprod to the seller wallet \`${job.payTo}\`.`,
      `- **Payment transaction:** [${tx.slice(0, 16)}…](${SCAN_TX}${tx})`,
      `- **Request digest (JCS, SHA-256):** \`${job.bodyDigest}\`. This payment pays for this one request.`,
      '- **Report hash:** `sha256(";" + report)`. A native payment puts no result hash on chain.',
      check,
    ].join('\n');
  }
  return [
    `- **Payment:** ${tada(job.amount)} tADA, paid with x402 on Cardano Preprod and locked in the Masumi V2 escrow \`${ESCROW_ADDRESS}\`.`,
    `- **Escrow transaction:** [${tx.slice(0, 16)}…](${SCAN_TX}${tx})`,
    `- **x402 terms digest:** \`${job.termsDigest}\` · **Request commitment (escrow input_hash):** \`${job.inputHash}\``,
    `- **Seller key that signed the terms:** \`${job.sellerAddress}\`. The quote makes no Masumi registry claim.`,
    `- **Report hash:** \`${RESULT_HASH_RULE}\`. The buyer nonce is ${job.buyerNonce ? `\`${job.buyerNonce}\`` : 'empty in this flow'}, so the text before the report is \`${job.buyerNonce};\`.`,
    check,
  ].join('\n');
}

/**
 * Builds the x402 HTTP server. Every dependency is injectable for tests.
 * `nativePayTo` is the registered agent's selling wallet. Without it, native payments are off.
 * `mps.submitResult` may return `{txHash}` for the result transaction.
 * @param {{
 *   facilitator: import('@x402/core/server').FacilitatorClient,
 *   seller: {sellerAddress: string, signTerms: Function} | null,
 *   nativePayTo?: string | null,
 *   mps?: {submitResult: (blockchainIdentifier: string, hash: string) => Promise<any>} | null,
 *   stateDir: string, publicUrl: string, runAudit?: typeof engineRunAudit, now?: () => number,
 *   log?: (line: string) => void, keepAliveMs?: number, quoteLimit?: {max: number, windowMs: number},
 *   prepareWorkspace?: typeof enginePrepareWorkspace, maxClones?: number,
 * }} options
 */
export function createX402Server({ facilitator, seller, nativePayTo = null, mps = null, stateDir, publicUrl, runAudit = engineRunAudit,
  now = Date.now, log = (line) => console.log(`${new Date().toISOString()} ${line}`), keepAliveMs = 15_000,
  quoteLimit = { max: 30, windowMs: 10 * 60_000 }, prepareWorkspace = enginePrepareWorkspace, maxClones = 4 }) {
  const journal = createJournal(join(stateDir, 'jobs'));
  const storage = new FileMasumiTermsStorage(join(stateDir, 'terms'));
  const resourceUrl = new URL('/audit', publicUrl).href;
  /** @type {Map<string, x402HTTPResourceServer>} */
  const gates = new Map();
  /** @type {Set<string>} */
  const active = new Set();
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const quotes = new Map();
  /** @type {Map<string, {project: any, expiresAt: number}>} */
  const inspections = new Map();
  let cloning = 0;
  const short = (/** @type {string} */ digest) => digest.slice(0, 8);
  const payee = (/** @type {string} */ method) => (method === 'escrow' ? ESCROW_ADDRESS : nativePayTo);

  /** The priced offer that audit() puts on the request context. */
  function offerOf(/** @type {any} */ ctx, /** @type {string} */ tier, /** @type {string} */ method) {
    const offer = ctx?.auditOffer;
    if (!offer || offer.tier !== tier || offer.method !== method) throw new Error('POST /audit needs a priced offer');
    return offer;
  }

  // One resource server per tier and method: escrow deadlines differ per tier, the payee per method.
  function gateFor(/** @type {string} */ tier, /** @type {string} */ method) {
    const sample = x402Offer(tier, { method });
    const scheme = method === 'escrow'
      ? new ExactCardanoScheme({
        masumiStorage: storage,
        masumi: {
          seller: /** @type {any} */ (seller),
          deadlines: /** @type {any} */ (sample.deadlines),
          commitment: ({ transportContext }) => commitmentFor(/** @type {any} */ (transportContext)?.request?.adapter?.getBody?.(), tier),
        },
      })
      : new ExactCardanoScheme();
    const core = new x402ResourceServer(facilitator).register(NETWORK, scheme);
    return new x402HTTPResourceServer(core, {
      'POST /audit': {
        accepts: { scheme: 'exact', network: NETWORK, payTo: /** @type {string} */ (payee(method)),
          // The price depends on the contract size, which audit() measures before x402 runs.
          price: (ctx) => { const offer = offerOf(ctx, tier, method); return { amount: offer.amount, asset: offer.asset }; },
          maxTimeoutSeconds: sample.maxTimeoutSeconds, extra: { assetTransferMethod: sample.transferMethod } },
        resource: resourceUrl,
        description: `Aiken smart contract audit, ${tier} tier, ${method} payment`,
        mimeType: 'application/json',
        unpaidResponseBody: (ctx) => ({ contentType: 'application/json',
          body: unpaidBody(offerOf(ctx, tier, method), /** @type {any} */ (ctx).auditProject) }),
      },
    });
  }

  function allowQuote(/** @type {string} */ ip) {
    const t = now();
    if (quotes.size > 10_000) for (const [key, entry] of quotes) if (entry.resetAt <= t) quotes.delete(key);
    const entry = quotes.get(ip);
    if (!entry || entry.resetAt <= t) { quotes.set(ip, { count: 1, resetAt: t + quoteLimit.windowMs }); return true; }
    entry.count += 1;
    return entry.count <= quoteLimit.max;
  }

  /** @param {unknown} error */
  function inspectError(error) {
    if (error instanceof HttpError) return error;
    const message = String(/** @type {any} */ (error)?.message ?? error);
    log(`inspection failed: ${message.slice(0, 200)}`);
    return new HttpError(422, 'cannot_inspect', SAFE_INSPECT_ERROR.test(message) ? message.slice(0, 300)
      : 'The contract could not be read. Check that the GitHub link is public and points to an Aiken project.');
  }

  /**
   * Reads the contract and measures its size, before any payment. A GitHub source is cloned,
   * checked for links and deleted again. Results are cached for a short time.
   * @param {any} source
   */
  async function inspect(source) {
    const cacheKey = sha256(JSON.stringify(source));
    const hit = inspections.get(cacheKey);
    if (hit && hit.expiresAt > now()) return hit.project;
    let project;
    if (source.kind === 'github') {
      if (cloning >= maxClones) throw new HttpError(503, 'busy', 'Too many contracts are being fetched. Try again in a minute.');
      cloning += 1;
      const inspectId = `x402-inspect-${randomBytes(8).toString('hex')}`;
      /** @type {{dir: string, root: string, label: string} | undefined} */
      let workspace;
      try {
        workspace = await prepareWorkspace(source, inspectId);
        if (findSymlink(workspace.dir)) throw new Error('The repository contains a symbolic link. Links are not followed, so it cannot be audited.');
        project = { label: workspace.label, ...contractSize(collectSources(workspace.root)) };
      } catch (error) {
        throw inspectError(error);
      } finally {
        cloning -= 1;
        rmSync(workspace?.dir ?? join(WORK_DIR, inspectId), { recursive: true, force: true });
      }
    } else {
      const files = source.kind === 'code' ? codeFiles(source.code) : source.files;
      const label = source.kind === 'code' ? 'validators/contract.ak (pasted code)' : `${files.length} uploaded .ak file(s)`;
      try { project = { label, ...contractSize(files) }; } catch (error) { throw inspectError(error); }
    }
    if (inspections.size >= 500) inspections.delete(/** @type {string} */ (inspections.keys().next().value));
    inspections.set(cacheKey, { project, expiresAt: now() + INSPECT_TTL_MS });
    return project;
  }

  /** The workspace the paid audit runs in. Undefined lets the engine build one for pasted code. */
  async function workspaceFor(/** @type {any} */ job, /** @type {string} */ jobId) {
    const { source } = job;
    if (source.kind === 'github') {
      // A cloned symlink could point at .local or .env, and the audit would read and quote that file.
      const workspace = await prepareWorkspace(source, jobId);
      if (findSymlink(workspace.dir)) throw new Error('The repository contains a symbolic link. Links are not followed, so no audit ran.');
      const current = contractSize(collectSources(workspace.root));
      if (job.size && current.size !== job.size) {
        log(`${short(keyOf(job))} repository changed after the quote: ${job.size} -> ${current.size}`);
        journal.save(keyOf(job), { ...journal.load(keyOf(job)), scopeAtAudit: current });
      }
      return workspace;
    }
    if (source.kind === 'files') {
      const workspace = await prepareWorkspace({ kind: 'code', code: source.files[0].content }, jobId);
      rmSync(join(workspace.root, 'validators/contract.ak'), { force: true });
      for (const file of source.files) {
        const target = resolve(workspace.root, file.path);
        if (!target.startsWith(`${resolve(workspace.root)}/`)) throw new Error('Unexpected file path');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      return { ...workspace, label: `${source.files.length} uploaded .ak file(s)` };
    }
    return undefined;
  }

  /** What the buyer gets back. Never includes the submitted code. @param {any} job */
  function view(job) {
    const escrow = isEscrow(job);
    const path = journal.reportPath(keyOf(job));
    const report = REPORT_PHASES.has(job.phase) && existsSync(path) ? readFileSync(path, 'utf8') : null;
    const payTx = job.paymentTxHash ?? job.escrowTxHash;
    let refund = null;
    if (escrow && job.phase !== 'result-submitted') {
      refund = 'No result hash is on chain for this payment. After submitResultTime the buyer key can '
        + 'take the escrow back with a Masumi V2 WithdrawRefund transaction.';
    } else if (!escrow && report === null) {
      refund = 'A native x402 payment goes straight to the seller wallet and is final. No escrow holds it, so there is no on-chain refund.';
    }
    return {
      ok: report !== null, jobId: job.jobId, phase: job.phase, tier: job.tier, method: escrow ? 'escrow' : 'native',
      size: job.size ?? null, lines: job.lines ?? null,
      report, resultHash: job.resultHash ?? null, resultHashRule: RESULT_HASH_RULE, buyerNonce: job.buyerNonce ?? '',
      paymentTx: txLink(payTx),
      payment: { network: NETWORK, assetTransferMethod: escrow ? METHODS.escrow : METHODS.native, amount: job.amount, asset: job.asset,
        priceTada: tada(job.amount), payTo: job.payTo ?? payee(escrow ? 'escrow' : 'native'), ...(escrow ? { inputHash: job.inputHash } : {}) },
      blockchainIdentifier: job.blockchainIdentifier ?? null, termsDigest: job.termsDigest ?? null,
      escrowTx: escrow ? txLink(payTx) : null,
      deadlines: escrow ? { payByTime: job.payByTime, submitResultTime: job.submitResultTime, unlockTime: job.unlockTime,
        externalDisputeUnlockTime: job.externalDisputeUnlockTime } : null,
      resultSubmission: job.resultSubmission ?? null,
      resultTx: txLink(job.resultSubmission?.txHash),
      error: job.error ?? null,
      refund,
    };
  }

  async function submitResult(/** @type {string} */ digest, /** @type {any} */ job) {
    if (!mps) return journal.save(digest, { ...job, phase: 'result-not-submitted',
      resultSubmission: { via: 'none', status: 'skipped', reason: 'MPS_URL and MPS_TOKEN are not set.' } });
    if (now() >= Number(job.submitResultTime)) return journal.save(digest, { ...job, phase: 'result-not-submitted',
      resultSubmission: { via: 'mps', status: 'skipped', reason: 'The result deadline passed.' } });
    job = journal.save(digest, { ...job, phase: 'submit-pending' });
    try {
      const out = await mps.submitResult(job.blockchainIdentifier, job.resultHash);
      const txHash = typeof out?.txHash === 'string' && /^[0-9a-f]{64}$/.test(out.txHash) ? out.txHash : undefined;
      log(`${short(digest)} result hash accepted${txHash ? ` in ${txHash}` : ' by MPS'}`);
      return journal.save(digest, { ...job, phase: 'result-submitted',
        resultSubmission: { via: typeof out?.via === 'string' ? out.via : 'mps', status: 'accepted', ...(txHash ? { txHash } : {}) } });
    } catch (error) {
      const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 300);
      if (/** @type {any} */ (error)?.uncertain) {
        log(`${short(digest)} MPS submit-result outcome unknown: inspect before retrying`);
        return journal.save(digest, { ...job, flagged: true, resultSubmission: { via: 'mps', status: 'unknown', reason } });
      }
      log(`${short(digest)} MPS rejected the result hash: ${reason}`);
      return journal.save(digest, { ...job, phase: 'result-not-submitted',
        resultSubmission: { via: 'mps', status: 'rejected', httpStatus: /** @type {any} */ (error)?.status ?? null, reason } });
    }
  }

  /** Runs the paid work for a settled job. Returns the buyer view and never throws. @param {string} digest */
  async function runJob(digest) {
    let job = journal.load(digest);
    const escrow = isEscrow(job);
    try {
      if (job.phase === 'settled' || job.phase === 'auditing') {
        if (escrow && Number(job.submitResultTime) - now() < RUN_BUDGET_MS[job.tier] - SETTLE_ALLOWANCE_MS) {
          job = journal.save(digest, { ...job, phase: 'failed', error: 'Too little time was left before the result deadline, so no audit ran.' });
          return view(job);
        }
        job = journal.save(digest, { ...job, phase: 'auditing', auditStartedAt: new Date(now()).toISOString() });
        log(`${short(digest)} audit started (${job.tier}, ${escrow ? 'escrow' : 'native'})`);
        const jobId = `x402-${digest.slice(0, 16)}`;
        const workspace = await workspaceFor(job, jobId);
        const result = await runAudit({ tier: job.tier, source: job.source, jobId, workspace,
          buyerNotes: job.buyerNotes, proof: proofSection(job), log: (line) => log(`${short(digest)} ${line}`) });
        const resultHash = x402ResultHash(job.buyerNonce ?? '', result.report);
        writeFileSync(journal.reportPath(digest), result.report, { mode: 0o600 });
        job = journal.save(digest, { ...journal.load(digest), phase: 'report-ready', resultHash });
        log(`${short(digest)} report ready ${resultHash.slice(0, 16)}…`);
      }
      if (job.phase === 'report-ready') job = escrow ? await submitResult(digest, job) : journal.save(digest, { ...job, phase: 'delivered' });
    } catch (error) {
      log(`${short(digest)} audit failed: ${String(/** @type {any} */ (error)?.message).slice(0, 300)}`);
      job = journal.save(digest, { ...journal.load(digest), phase: 'failed',
        error: `The audit could not finish: ${String(/** @type {any} */ (error)?.message).slice(0, 300)}` });
    }
    return view(job);
  }

  /** Sends 200 at once, keeps the connection alive with newlines, then sends the job JSON. */
  async function streamJob(/** @type {import('node:http').ServerResponse} */ res, /** @type {string} */ digest, /** @type {Record<string, string>} */ headers) {
    const job = journal.load(digest);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Audit-Job': job.jobId, ...headers });
    const timer = setInterval(() => { if (!res.destroyed) res.write('\n'); }, keepAliveMs);
    try {
      const out = await runJob(digest);
      if (!res.destroyed) res.end(JSON.stringify(out));
    } finally { clearInterval(timer); }
  }

  async function paidJob(/** @type {any} */ ctx) {
    const { res, body, input, gate, context, verified, offer, project } = ctx;
    const { paymentPayload, paymentRequirements: requirements } = verified;
    const escrow = input.method === 'escrow';
    if (escrow && !bodyMatchesQuote(requirements, body))
      return json(res, 400, { error: 'body_mismatch', message: 'This body differs from the one the quote committed to. Nothing was charged.' });
    // Our own check of price, payee, seller and deadlines, so we do not rely only on the library's quote matching.
    const problem = quoteProblem(requirements, offer, { sellerAddress: seller?.sellerAddress, payTo: nativePayTo });
    if (problem) return json(res, 400, { error: 'quote_mismatch', message: `This quote does not fit the ${input.tier} ${input.method} option (${problem}). Nothing was charged.` });
    const txHash = decodeCardanoTransaction(paymentPayload.payload.transaction).txHash.toLowerCase();
    // Escrow: one job per seller-signed quote. Native: one job per transaction.
    const digest = escrow ? termsDigestOf(requirements) : txHash;
    const requestDigest = bodyDigest(body);
    if (active.has(digest)) return json(res, 409, { error: 'in_progress', message: 'This payment is already being processed.' });
    const previous = journal.load(digest);
    if (previous && previous.txHash !== txHash) return json(res, 409, { error: 'terms_already_paid', message: 'These terms are bound to another transaction.' });
    if (previous && !escrow && previous.bodyDigest !== requestDigest)
      return json(res, 409, { error: 'payment_already_used', message: 'This transaction already paid for another request.' });
    // Another request settled this payment while ours waited for verify: answer from the journal, never settle again.
    if (previous && previous.phase !== 'settle-pending') return replay(res, previous);
    const terms = requirements.extra?.terms;
    // Take an escrow payment only when the result deadline leaves room for the work.
    // A resumed settlement skips this gate: its transaction may already be on chain.
    if (escrow && !previous && Number(terms.submitResultTime) - now() < RUN_BUDGET_MS[input.tier])
      return json(res, 409, { error: 'quote_too_old', message: 'Too little time is left before the result deadline. Request a new quote. Nothing was charged.' });

    active.add(digest);
    try {
      let job = journal.save(digest, {
        ...previous, key: digest, jobId: previous?.jobId ?? randomBytes(16).toString('hex'), phase: 'settle-pending',
        method: input.method, tier: input.tier, size: project.size, lines: project.lines, label: project.label, fileCount: project.files,
        source: input.source, buyerNotes: input.buyerNotes, txHash, bodyDigest: requestDigest,
        amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo,
        ...(escrow ? {
          termsDigest: digest, blockchainIdentifier: requirements.extra.blockchainIdentifier, buyerNonce: terms.buyerNonce,
          inputHash: terms.inputHash, sellerAddress: terms.sellerAddress, payByTime: terms.payByTime,
          submitResultTime: terms.submitResultTime, unlockTime: terms.unlockTime, externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
        } : { buyerNonce: '' }),
        createdAt: previous?.createdAt ?? new Date(now()).toISOString(),
      });
      log(`${short(digest)} ${input.method} payment verified, settling ${txHash.slice(0, 16)}…`);
      const settle = await gate.processSettlement(paymentPayload, requirements, verified.declaredExtensions, { request: context });
      if (!settle.success) {
        const reason = String(settle.errorReason ?? 'unknown').slice(0, 200);
        if (settleFailureIsFinal(settle)) {
          journal.save(digest, { ...job, phase: 'settle-failed', settleError: reason });
          log(`${short(digest)} settlement failed: ${reason}`);
          return sendInstructions(res, { ...settle.response, body: { error: settle.errorReason,
            message: 'This transaction can never reach the chain. Request a new quote.' } });
        }
        // Not final: the transaction may be on chain. Keep the job resumable with the same signature.
        journal.save(digest, { ...job, phase: 'settle-pending', settleError: reason });
        log(`${short(digest)} settlement not confirmed: ${reason}`);
        return sendInstructions(res, { ...settle.response, body: {
          error: reason === 'settlement_pending' ? 'settlement_pending' : 'settlement_unknown', reason,
          message: 'The payment may already be on chain. Send the same PAYMENT-SIGNATURE again. Do not pay again.' } });
      }
      if (settle.transaction !== txHash) {
        journal.save(digest, { ...job, phase: 'settle-mismatch', flagged: true, settleTransaction: settle.transaction });
        log(`${short(digest)} facilitator reported another transaction: inspect`);
        return json(res, 502, { error: 'settlement_mismatch', message: 'The facilitator reported an unexpected transaction. No audit ran.' });
      }
      job = journal.save(digest, { ...job, phase: 'settled', paymentTxHash: settle.transaction,
        ...(escrow ? { escrowTxHash: settle.transaction } : {}), settleHeaders: settle.headers,
        settlement: settle.extra ?? null, settledAt: new Date(now()).toISOString() });
      log(`${short(digest)} ${escrow ? 'escrow locked' : 'payment confirmed'} ${settle.transaction}`);
      await streamJob(res, digest, settle.headers);
    } finally { active.delete(digest); }
  }

  /** A PAYMENT-SIGNATURE we already settled: answer from the journal. Never settle or submit twice. */
  async function replay(/** @type {import('node:http').ServerResponse} */ res, /** @type {any} */ job) {
    const digest = keyOf(job);
    if (active.has(digest)) return json(res, 409, { error: 'in_progress', jobId: job.jobId, message: 'Poll GET /jobs/<jobId>.' });
    if (job.phase === 'settle-failed') return json(res, 402, { error: 'payment_failed', reason: job.settleError ?? null, message: 'Request a new quote.' });
    if (!RUNNABLE_PHASES.has(job.phase)) return json(res, 200, view(job), { 'X-Audit-Job': job.jobId, ...(job.settleHeaders ?? {}) });
    active.add(digest);
    try { await streamJob(res, digest, job.settleHeaders ?? {}); } finally { active.delete(digest); }
  }

  /** True for a retry of a payment this server already knows, with the body it was made for. */
  async function knownPayment(/** @type {{id: string, txHash: string} | null} */ key, /** @type {string} */ method, /** @type {unknown} */ body) {
    if (!key) return false;
    if (method === 'escrow') {
      const stored = await storage.get(key.id);
      return Boolean(stored && bodyMatchesQuote(stored.requirements, body));
    }
    const job = journal.load(key.id);
    return Boolean(job && job.method === 'native' && job.bodyDigest === bodyDigest(body));
  }

  async function audit(/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res, /** @type {URL} */ url) {
    const body = await readJson(req);
    const input = parseAuditRequest(body);
    if (input.method === 'escrow' && !seller) throw new HttpError(503, 'seller_not_configured', 'The x402 seller key is not set up yet.');
    if (input.method === 'native' && !nativePayTo) throw new HttpError(503, 'native_not_configured', 'Native payments are not set up on this server.');
    const gate = gates.get(`${input.tier}:${input.method}`);
    if (!gate) throw new HttpError(503, 'not_ready', 'The x402 server is still starting.');
    const header = req.headers['payment-signature'];
    const paymentHeader = Array.isArray(header) ? header[0] : header;
    const key = paymentHeader ? paidJobKey(paymentHeader, input.method) : null;
    if (key && input.method === 'native') {
      const used = journal.load(key.id);
      if (used && used.bodyDigest !== bodyDigest(body))
        return json(res, 409, { error: 'payment_already_used', message: 'This transaction already paid for another request.' });
    }
    // Known: a retry for a payment we know, with the body it was made for. The escrow digest and the
    // transaction can be rebuilt from public chain data; the body cannot.
    const known = await knownPayment(key, input.method, body);
    // Anything else can make the server clone a repository and issue a quote, so it counts against the limit.
    if (!known && !allowQuote(req.socket.remoteAddress ?? 'unknown'))
      throw new HttpError(429, 'too_many_quotes', 'Too many unpaid quotes. Try again later.');
    const pending = known && key ? journal.load(key.id) : null;
    if (known && key) {
      if (active.has(key.id)) return json(res, 409, { error: 'in_progress', message: 'This payment is already being processed.' });
      if (pending && pending.txHash === key.txHash && pending.phase !== 'settle-pending') return replay(res, pending);
    }
    // A resumed settlement keeps the price it was made with, even if the repository changed since.
    const project = pending?.phase === 'settle-pending' && pending.size
      ? { label: pending.label, files: pending.fileCount, lines: pending.lines, size: pending.size }
      : await inspect(input.source);
    const offer = x402Offer(input.tier, { size: project.size, method: input.method });
    const context = { adapter: adapterFor(req, url, body), path: url.pathname, method: 'POST', paymentHeader, auditOffer: offer, auditProject: project };
    const verified = await gate.processHTTPRequest(context);
    if (verified.type === 'payment-error') return sendInstructions(res, verified.response);
    if (verified.type !== 'payment-verified') throw new Error('POST /audit must require payment');
    return paidJob({ res, body, input, gate, context, verified, offer, project });
  }

  /** POST /quote: the contract's size and every option with its price. No payment. */
  async function quote(/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) {
    const input = parseQuoteRequest(await readJson(req));
    if (!allowQuote(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, 'too_many_quotes', 'Too many unpaid quotes. Try again later.');
    const project = await inspect(input.source);
    const open = (/** @type {string} */ method) => X402_TIERS.every((tier) => gates.has(`${tier}:${method}`));
    const options = quoteOptions(project.size, { native: open('native') ? nativePayTo : null, escrow: open('escrow') ? ESCROW_ADDRESS : null });
    return json(res, 200, { project, options, network: NETWORK, asset: LOVELACE,
      howToBuy: 'POST /audit with the same source plus "tier" and "method". Pay the 402 with x402 (@x402/cardano "exact").' });
  }

  const server = createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', publicUrl);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/availability') {
        return json(res, 200, {
          status: gates.size ? 'available' : 'unavailable', type: 'masumi-agent',
          message: 'MARS Agent. Agents can buy an audit with x402 on Cardano Preprod: POST /quote, then POST /audit.',
          x402: { endpoint: '/audit', quote: '/quote', network: NETWORK, scheme: 'exact', asset: LOVELACE, pricesTada: PRICE_TADA,
            methods: {
              native: { assetTransferMethod: METHODS.native, payTo: nativePayTo, available: gates.has('see:native') },
              escrow: { assetTransferMethod: METHODS.escrow, payTo: ESCROW_ADDRESS, available: gates.has('see:escrow') },
            } },
        });
      }
      if (req.method === 'GET' && url.pathname === '/input_schema') return json(res, 200, INPUT_SCHEMA);
      const jobPath = /^\/jobs\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === 'GET' && jobPath) {
        const job = journal.list().map((id) => journal.load(id)).find((j) => j?.jobId === jobPath[1]);
        return job ? json(res, 200, view(job)) : json(res, 404, { error: 'not_found' });
      }
      if (req.method === 'POST' && url.pathname === '/quote') return await quote(req, res);
      if (req.method === 'POST' && url.pathname === '/audit') return await audit(req, res, url);
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) return json(res, error.status, { error: error.code, message: error.message });
      if (error instanceof FacilitatorResponseError) {
        log(`facilitator error: ${String(error.message).slice(0, 200)}`);
        return json(res, 502, { error: 'facilitator_error', message: 'The x402 facilitator did not answer correctly. Try again.' });
      }
      log(`internal error: ${String(/** @type {any} */ (error)?.message).slice(0, 300)}`);
      return json(res, 500, { error: 'internal_error' });
    }
  });

  return {
    server, journal, storage,
    /** Fetches facilitator support and builds the routes for each tier and method that has a payee. */
    async init() {
      for (const tier of X402_TIERS) {
        for (const method of ['native', 'escrow']) {
          if (method === 'escrow' ? !seller : !nativePayTo) continue;
          const gate = gateFor(tier, method);
          await gate.initialize();
          gates.set(`${tier}:${method}`, gate);
        }
      }
      if (!seller) return;
      storage.prune(now());
      // Unpaid quotes are files on disk. Remove expired ones every hour, not only at start.
      setInterval(() => { try { storage.prune(now()); } catch { /* retry next hour */ } }, 60 * 60_000).unref();
    },
    /** After a restart: finish settled jobs, flag jobs that stopped in an unknown state. */
    recover() {
      for (const digest of journal.list()) {
        const job = journal.load(digest);
        if (RUNNABLE_PHASES.has(job.phase) && !active.has(digest)) {
          active.add(digest);
          runJob(digest).finally(() => active.delete(digest));
        } else if ((job.phase === 'submit-pending' || job.phase === 'settle-pending' || job.flagged) && !job.reported) {
          log(`${short(digest)} stopped in ${job.phase}: inspect before retrying`);
          journal.save(digest, { ...job, reported: true });
        }
      }
    },
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const local = join(root, '.local');
  const sellerFile = join(local, 'x402-seller-wallet.json');
  if (process.argv.includes('--seller-init')) {
    const { address } = createWalletFile(sellerFile);
    console.log(`x402 seller address (Preprod): ${address}`);
    console.log(`Key saved to ${sellerFile} (mode 600). It signs x402 quotes and receives escrow payouts.`);
    return;
  }

  const registration = JSON.parse(readFileSync(join(local, 'registration.json'), 'utf8'));
  if (registration.smartContractAddress !== ESCROW_ADDRESS)
    throw new Error('The registered escrow address differs from the canonical Masumi V2 Preprod escrow.');
  // Native payments go to the registered agent's selling wallet.
  const nativePayTo = typeof registration.sellerAddress === 'string' && /^addr_test1[02-9ac-hj-np-z]+$/.test(registration.sellerAddress)
    ? registration.sellerAddress : null;
  const mnemonic = process.env.X402_SELLER_MNEMONIC || (existsSync(sellerFile) ? readWalletFile(sellerFile).mnemonic : null);
  const seller = mnemonic ? toMasumiSellerSigner({ mnemonic, network: NETWORK }) : null;
  const port = Number(process.env.X402_PORT || 3013);
  const host = process.env.X402_HOST || '127.0.0.1';
  const app = createX402Server({
    facilitator: new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL || HOSTED_FACILITATOR, timeoutMs: 90_000 }),
    seller, nativePayTo,
    mps: process.env.MPS_URL && process.env.MPS_TOKEN ? createMpsClient({ baseUrl: process.env.MPS_URL, token: process.env.MPS_TOKEN }) : null,
    stateDir: join(local, 'x402'),
    publicUrl: process.env.X402_PUBLIC_URL || `http://${host}:${port}`,
  });
  await app.init();
  app.recover();
  app.server.listen(port, host, () => {
    console.log(`MARS Agent x402 on http://${host}:${port} · ${NETWORK} · prices in tADA`);
    console.log(nativePayTo ? `native payments to ${nativePayTo}` : 'No sellerAddress in registration.json: native payments are off.');
    console.log(seller ? `escrow payments: x402 seller ${seller.sellerAddress}, escrow ${ESCROW_ADDRESS}`
      : 'No x402 seller key: escrow payments answer 503. Run --seller-init.');
  });
  const stop = () => app.server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`x402 server failed: ${String(error?.message ?? error).slice(0, 500)}`); process.exit(1); });
}
