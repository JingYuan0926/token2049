// x402 channel (plan milestone M5): other AI agents buy an audit over HTTP and pay on Cardano Preprod.
// Payment: @x402/cardano "exact" scheme, assetTransferMethod "masumi". The buyer's transaction locks
// test USDM in the Masumi V2 escrow, so the buyer can take it back if no result arrives in time.
//
//   npm run x402                                 start on 127.0.0.1:3013
//   node src/x402/server.mjs --seller-init       create the x402 seller key (.local/x402-seller-wallet.json)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeCardanoTransaction, toMasumiSellerSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';
import { FacilitatorResponseError, HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { prepareWorkspace as enginePrepareWorkspace } from '../engine/aiken.mjs';
import { runAudit as engineRunAudit } from '../engine/index.mjs';
import { createMpsClient } from '../payment/mps.mjs';
import { ESCROW_ADDRESS, FileMasumiTermsStorage, HttpError, NETWORK, RESULT_HASH_RULE, RUN_BUDGET_MS, SCAN_TX, SETTLE_ALLOWANCE_MS,
  USDM_ASSET, X402_TIERS, bodyMatchesQuote, commitmentFor, createJournal, findSymlink, parseAuditRequest, quoteProblem,
  settleFailureIsFinal, termsDigestOf, x402Offer, x402ResultHash } from './core.mjs';
import { createWalletFile, readWalletFile } from './wallet.mjs';

export const HOSTED_FACILITATOR = 'https://x402.preprod.dev.ecosyseng.cf-deployments.org';
const MAX_BODY_BYTES = 256 * 1024;
const REPORT_PHASES = new Set(['report-ready', 'submit-pending', 'result-submitted', 'result-not-submitted']);
const RUNNABLE_PHASES = new Set(['settled', 'auditing', 'report-ready']);

export const INPUT_SCHEMA = Object.freeze({
  input_data: [
    { id: 'tier', type: 'option', name: 'Tier',
      data: { values: ['see', 'write', 'audit'],
        description: 'see: findings report, 1 tUSDM. write: report and fixed code, 5 tUSDM. audit: human-reviewed, 20 tUSDM, Sokosumi only.' },
      validations: [{ validation: 'min', value: '1' }, { validation: 'max', value: '1' }] },
    { id: 'code', type: 'textarea', name: 'Aiken code',
      data: { description: 'The validator source. Send code or github, not both.' },
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

/** @param {ReturnType<typeof x402Offer>} offer */
function unpaidBody(offer) {
  return {
    error: 'payment_required', tier: offer.tier,
    price: { amount: offer.amount, asset: offer.asset, display: `${Number(offer.amount) / 1e6} tUSDM` },
    howToPay: 'Read the PAYMENT-REQUIRED header (x402 v2). Pay with @x402/cardano "exact", assetTransferMethod "masumi". '
      + 'Then send the same JSON body again with the PAYMENT-SIGNATURE header.',
  };
}

/** Decodes a PAYMENT-SIGNATURE header into the job key and transaction id, or null. @param {string} value */
function paidJobKey(value) {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return { digest: termsDigestOf(payload.accepted), txHash: decodeCardanoTransaction(payload.payload.transaction).txHash };
  } catch { return null; }
}

/** Cardano proof section of the report. It is part of the hashed report. @param {any} job */
function proofSection(job) {
  const amount = Number(job.amount) / 1e6;
  return [
    `- **Payment:** ${amount} test USDM, paid with x402 on Cardano Preprod and locked in the Masumi V2 escrow \`${ESCROW_ADDRESS}\`.`,
    `- **Escrow transaction:** [${job.escrowTxHash.slice(0, 16)}…](${SCAN_TX}${job.escrowTxHash})`,
    `- **x402 terms digest:** \`${job.termsDigest}\` · **Request commitment (escrow input_hash):** \`${job.inputHash}\``,
    `- **Seller key that signed the terms:** \`${job.sellerAddress}\`. The quote makes no Masumi registry claim.`,
    `- **Report hash:** \`${RESULT_HASH_RULE}\`. The buyer nonce is ${job.buyerNonce ? `\`${job.buyerNonce}\`` : 'empty in this flow'}, so the text before the report is \`${job.buyerNonce};\`.`,
    `- **Check it yourself:** save this report as \`report.md\`, then run \`node -e 'const t=require("fs").readFileSync("report.md","utf8");console.log(require("crypto").createHash("sha256").update("${job.buyerNonce};"+t).digest("hex"))'\` and compare it with the result hash.`,
  ].join('\n');
}

/**
 * Builds the x402 HTTP server. Every dependency is injectable for tests.
 * @param {{
 *   facilitator: import('@x402/core/server').FacilitatorClient,
 *   seller: {sellerAddress: string, signTerms: Function} | null,
 *   mps?: {submitResult: (blockchainIdentifier: string, hash: string) => Promise<unknown>} | null,
 *   stateDir: string, publicUrl: string, runAudit?: typeof engineRunAudit, now?: () => number,
 *   log?: (line: string) => void, keepAliveMs?: number, quoteLimit?: {max: number, windowMs: number},
 *   prepareWorkspace?: typeof enginePrepareWorkspace,
 * }} options
 */
export function createX402Server({ facilitator, seller, mps = null, stateDir, publicUrl, runAudit = engineRunAudit,
  now = Date.now, log = (line) => console.log(`${new Date().toISOString()} ${line}`), keepAliveMs = 15_000,
  quoteLimit = { max: 30, windowMs: 10 * 60_000 }, prepareWorkspace = enginePrepareWorkspace }) {
  const journal = createJournal(join(stateDir, 'jobs'));
  const storage = new FileMasumiTermsStorage(join(stateDir, 'terms'));
  const resourceUrl = new URL('/audit', publicUrl).href;
  /** @type {Map<string, x402HTTPResourceServer>} */
  const gates = new Map();
  /** @type {Set<string>} */
  const active = new Set();
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const quotes = new Map();
  const short = (/** @type {string} */ digest) => digest.slice(0, 8);

  // One resource server per tier, because the escrow deadlines differ per tier.
  function gateFor(/** @type {string} */ tier) {
    const offer = x402Offer(tier);
    const scheme = new ExactCardanoScheme({
      masumiStorage: storage,
      masumi: {
        seller: /** @type {any} */ (seller),
        deadlines: offer.deadlines,
        commitment: ({ transportContext }) => commitmentFor(/** @type {any} */ (transportContext)?.request?.adapter?.getBody?.(), tier),
      },
    });
    const core = new x402ResourceServer(facilitator).register(NETWORK, scheme);
    return new x402HTTPResourceServer(core, {
      'POST /audit': {
        accepts: { scheme: 'exact', network: NETWORK, payTo: ESCROW_ADDRESS, price: { amount: offer.amount, asset: offer.asset },
          maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: { assetTransferMethod: 'masumi' } },
        resource: resourceUrl,
        description: `Aiken smart contract audit, ${tier} tier`,
        mimeType: 'application/json',
        unpaidResponseBody: () => ({ contentType: 'application/json', body: unpaidBody(offer) }),
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

  /** What the buyer gets back. Never includes the submitted code. @param {any} job */
  function view(job) {
    const path = journal.reportPath(job.termsDigest);
    const report = REPORT_PHASES.has(job.phase) && existsSync(path) ? readFileSync(path, 'utf8') : null;
    const onChain = job.phase === 'result-submitted';
    return {
      ok: report !== null, jobId: job.jobId, phase: job.phase, tier: job.tier,
      report, resultHash: job.resultHash ?? null, resultHashRule: RESULT_HASH_RULE, buyerNonce: job.buyerNonce,
      blockchainIdentifier: job.blockchainIdentifier, termsDigest: job.termsDigest,
      escrowTx: job.escrowTxHash ? { hash: job.escrowTxHash, url: `${SCAN_TX}${job.escrowTxHash}` } : null,
      payment: { network: NETWORK, amount: job.amount, asset: job.asset, payTo: ESCROW_ADDRESS, inputHash: job.inputHash },
      deadlines: { payByTime: job.payByTime, submitResultTime: job.submitResultTime, unlockTime: job.unlockTime,
        externalDisputeUnlockTime: job.externalDisputeUnlockTime },
      resultSubmission: job.resultSubmission ?? null,
      error: job.error ?? null,
      refund: onChain ? null : 'No result hash is on chain for this payment. After submitResultTime the buyer key can '
        + 'take the escrow back with a Masumi V2 WithdrawRefund transaction.',
    };
  }

  async function submitResult(/** @type {string} */ digest, /** @type {any} */ job) {
    if (!mps) return journal.save(digest, { ...job, phase: 'result-not-submitted',
      resultSubmission: { via: 'none', status: 'skipped', reason: 'MPS_URL and MPS_TOKEN are not set.' } });
    if (now() >= Number(job.submitResultTime)) return journal.save(digest, { ...job, phase: 'result-not-submitted',
      resultSubmission: { via: 'mps', status: 'skipped', reason: 'The result deadline passed.' } });
    job = journal.save(digest, { ...job, phase: 'submit-pending' });
    try {
      await mps.submitResult(job.blockchainIdentifier, job.resultHash);
      log(`${short(digest)} result hash accepted by MPS`);
      return journal.save(digest, { ...job, phase: 'result-submitted', resultSubmission: { via: 'mps', status: 'accepted' } });
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
    try {
      if (job.phase === 'settled' || job.phase === 'auditing') {
        if (Number(job.submitResultTime) - now() < RUN_BUDGET_MS[job.tier] - SETTLE_ALLOWANCE_MS) {
          job = journal.save(digest, { ...job, phase: 'failed', error: 'Too little time was left before the result deadline, so no audit ran.' });
          return view(job);
        }
        job = journal.save(digest, { ...job, phase: 'auditing', auditStartedAt: new Date(now()).toISOString() });
        log(`${short(digest)} audit started (${job.tier})`);
        const jobId = `x402-${digest.slice(0, 16)}`;
        // A cloned symlink could point at .local or .env, and the audit would read and quote that file.
        let workspace;
        if (job.source.kind === 'github') {
          workspace = await prepareWorkspace(job.source, jobId);
          if (findSymlink(workspace.dir)) throw new Error('The repository contains a symbolic link. Links are not followed, so no audit ran.');
        }
        const result = await runAudit({ tier: job.tier, source: job.source, jobId, workspace,
          buyerNotes: job.buyerNotes, proof: proofSection(job), log: (line) => log(`${short(digest)} ${line}`) });
        const resultHash = x402ResultHash(job.buyerNonce, result.report);
        writeFileSync(journal.reportPath(digest), result.report, { mode: 0o600 });
        job = journal.save(digest, { ...job, phase: 'report-ready', resultHash });
        log(`${short(digest)} report ready ${resultHash.slice(0, 16)}…`);
      }
      if (job.phase === 'report-ready') job = await submitResult(digest, job);
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
    const { res, body, input, gate, context, verified } = ctx;
    const { paymentPayload, paymentRequirements: requirements } = verified;
    const terms = requirements.extra.terms;
    if (!bodyMatchesQuote(requirements, body))
      return json(res, 400, { error: 'body_mismatch', message: 'This body differs from the one the quote committed to. Nothing was charged.' });
    // Our own check of price, escrow, seller and deadlines, so we do not rely only on the library's quote matching.
    const problem = quoteProblem(requirements, input.tier, /** @type {any} */ (seller).sellerAddress);
    if (problem) return json(res, 400, { error: 'quote_mismatch', message: `This quote does not fit the ${input.tier} tier (${problem}). Nothing was charged.` });
    const digest = termsDigestOf(requirements);
    const txHash = decodeCardanoTransaction(paymentPayload.payload.transaction).txHash;
    if (active.has(digest)) return json(res, 409, { error: 'in_progress', message: 'This payment is already being processed.' });
    const previous = journal.load(digest);
    if (previous && previous.txHash !== txHash) return json(res, 409, { error: 'terms_already_paid', message: 'These terms are bound to another transaction.' });
    // Another request settled this payment while ours waited for verify: answer from the journal, never settle again.
    if (previous && previous.phase !== 'settle-pending') return replay(res, previous);
    // Take the money only when the result deadline leaves room for the work.
    // A resumed settlement skips this gate: its transaction may already be on chain.
    if (!previous && Number(terms.submitResultTime) - now() < RUN_BUDGET_MS[input.tier])
      return json(res, 409, { error: 'quote_too_old', message: 'Too little time is left before the result deadline. Request a new quote. Nothing was charged.' });

    active.add(digest);
    try {
      let job = journal.save(digest, {
        ...previous, jobId: previous?.jobId ?? randomBytes(16).toString('hex'), phase: 'settle-pending', termsDigest: digest,
        tier: input.tier, source: input.source, buyerNotes: input.buyerNotes, txHash,
        blockchainIdentifier: requirements.extra.blockchainIdentifier, buyerNonce: terms.buyerNonce, inputHash: terms.inputHash,
        sellerAddress: terms.sellerAddress, amount: requirements.amount, asset: requirements.asset,
        payByTime: terms.payByTime, submitResultTime: terms.submitResultTime, unlockTime: terms.unlockTime,
        externalDisputeUnlockTime: terms.externalDisputeUnlockTime, createdAt: previous?.createdAt ?? new Date(now()).toISOString(),
      });
      log(`${short(digest)} payment verified, settling ${txHash.slice(0, 16)}…`);
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
      job = journal.save(digest, { ...job, phase: 'settled', escrowTxHash: settle.transaction, settleHeaders: settle.headers,
        settlement: settle.extra ?? null, settledAt: new Date(now()).toISOString() });
      log(`${short(digest)} escrow locked ${settle.transaction}`);
      await streamJob(res, digest, settle.headers);
    } finally { active.delete(digest); }
  }

  /** A PAYMENT-SIGNATURE we already settled: answer from the journal. Never settle or submit twice. */
  async function replay(/** @type {import('node:http').ServerResponse} */ res, /** @type {any} */ job) {
    const digest = job.termsDigest;
    if (active.has(digest)) return json(res, 409, { error: 'in_progress', jobId: job.jobId, message: 'Poll GET /jobs/<jobId>.' });
    if (job.phase === 'settle-failed') return json(res, 402, { error: 'payment_failed', reason: job.settleError ?? null, message: 'Request a new quote.' });
    if (!RUNNABLE_PHASES.has(job.phase)) return json(res, 200, view(job), { 'X-Audit-Job': job.jobId, ...(job.settleHeaders ?? {}) });
    active.add(digest);
    try { await streamJob(res, digest, job.settleHeaders ?? {}); } finally { active.delete(digest); }
  }

  async function audit(/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res, /** @type {URL} */ url) {
    const body = await readJson(req);
    const input = parseAuditRequest(body);
    if (!seller) throw new HttpError(503, 'seller_not_configured', 'The x402 seller key is not set up yet.');
    const gate = gates.get(input.tier);
    if (!gate) throw new HttpError(503, 'not_ready', 'The x402 server is still starting.');
    const header = req.headers['payment-signature'];
    const paymentHeader = Array.isArray(header) ? header[0] : header;
    const key = paymentHeader ? paidJobKey(paymentHeader) : null;
    const stored = key ? await storage.get(key.digest) : undefined;
    // Known: a retry for a quote we issued, with the body it committed to. The digest and the
    // transaction can be rebuilt from public chain data; the body cannot.
    const known = Boolean(key && stored && bodyMatchesQuote(stored.requirements, body));
    // Anything else can make the core issue and store a new signed quote, so it counts against the limit.
    if (!known && !allowQuote(req.socket.remoteAddress ?? 'unknown'))
      throw new HttpError(429, 'too_many_quotes', 'Too many unpaid quotes. Try again later.');
    if (known && key) {
      if (active.has(key.digest)) return json(res, 409, { error: 'in_progress', message: 'This payment is already being processed.' });
      const job = journal.load(key.digest);
      if (job && job.txHash === key.txHash && job.phase !== 'settle-pending') return replay(res, job);
    }
    const context = { adapter: adapterFor(req, url, body), path: url.pathname, method: 'POST', paymentHeader };
    const verified = await gate.processHTTPRequest(context);
    if (verified.type === 'payment-error') return sendInstructions(res, verified.response);
    if (verified.type !== 'payment-verified') throw new Error('POST /audit must require payment');
    return paidJob({ res, body, input, gate, context, verified });
  }

  const server = createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', publicUrl);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/availability') {
        return json(res, 200, {
          status: seller && gates.size ? 'available' : 'unavailable', type: 'masumi-agent',
          message: 'Aiken Auditor. Agents can buy an audit with x402 on Cardano Preprod: POST /audit.',
          x402: { endpoint: '/audit', network: NETWORK, scheme: 'exact', assetTransferMethod: 'masumi', escrow: ESCROW_ADDRESS,
            asset: USDM_ASSET, prices: Object.fromEntries(X402_TIERS.map((t) => [t, x402Offer(t).amount])) },
        });
      }
      if (req.method === 'GET' && url.pathname === '/input_schema') return json(res, 200, INPUT_SCHEMA);
      const jobPath = /^\/jobs\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === 'GET' && jobPath) {
        const job = journal.list().map((id) => journal.load(id)).find((j) => j?.jobId === jobPath[1]);
        return job ? json(res, 200, view(job)) : json(res, 404, { error: 'not_found' });
      }
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
    /** Fetches facilitator support and builds the per-tier routes. */
    async init() {
      if (!seller) return;
      for (const tier of X402_TIERS) {
        const gate = gateFor(tier);
        await gate.initialize();
        gates.set(tier, gate);
      }
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
  const mnemonic = process.env.X402_SELLER_MNEMONIC || (existsSync(sellerFile) ? readWalletFile(sellerFile).mnemonic : null);
  const seller = mnemonic ? toMasumiSellerSigner({ mnemonic, network: NETWORK }) : null;
  const port = Number(process.env.X402_PORT || 3013);
  const host = process.env.X402_HOST || '127.0.0.1';
  const app = createX402Server({
    facilitator: new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL || HOSTED_FACILITATOR, timeoutMs: 90_000 }),
    seller,
    mps: process.env.MPS_URL && process.env.MPS_TOKEN ? createMpsClient({ baseUrl: process.env.MPS_URL, token: process.env.MPS_TOKEN }) : null,
    stateDir: join(local, 'x402'),
    publicUrl: process.env.X402_PUBLIC_URL || `http://${host}:${port}`,
  });
  await app.init();
  app.recover();
  app.server.listen(port, host, () => {
    console.log(`Aiken Auditor x402 on http://${host}:${port} · ${NETWORK} · escrow ${ESCROW_ADDRESS}`);
    console.log(seller ? `x402 seller ${seller.sellerAddress}` : 'No x402 seller key: POST /audit answers 503. Run --seller-init.');
  });
  const stop = () => app.server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`x402 server failed: ${String(error?.message ?? error).slice(0, 500)}`); process.exit(1); });
}
