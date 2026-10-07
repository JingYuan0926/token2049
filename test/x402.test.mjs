// x402 channel tests. No network: the facilitator, the audit engine and MPS are stubs.
process.env.X402_ESCROW_ENABLED = 'true';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrivateKey } from '@evolution-sdk/evolution';
import { decodeCardanoTransaction, masumiEscrowAddress, toMasumiSellerSigner, verifyMasumiAuthorization } from '@x402/cardano';
import { BUYER_SPEND_CONTROLS, ESCROW_ADDRESS, FileMasumiTermsStorage, HttpError, LOVELACE, MAX_SPEND_ATOMIC, PRICE_TADA, bodyDigest,
  bodyMatchesQuote, contractSize, createJournal, findSymlink, parseAuditRequest, parseQuoteRequest, quoteOptions, quoteProblem,
  readAikenFolder, reportSummary, settleFailureIsFinal, termsDigestOf, transferMethodOf, x402Offer, x402ResultHash } from '../src/x402/core.mjs';
import { renderReport } from '../src/engine/report.mjs';
import { createX402Server } from '../src/x402/server.mjs';
import { readWalletFile } from '../src/x402/wallet.mjs';
import { MpsError } from '../src/payment/mps.mjs';
import { x402Client } from '@x402/core/client';

const MIN = 60_000;
const sha = (/** @type {string} */ s) => createHash('sha256').update(s, 'utf8').digest('hex');
const CODE = 'validator vault {\n  spend(_d: Option<Data>, _r: Data, _o: Data, _t: Data) {\n    True\n  }\n}\n';
const SUPPORTED = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'cardano:preprod',
  extra: { assetTransferMethods: ['default', 'masumi', 'script'], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } } }],
extensions: [], signers: { 'cardano:*': [] } };
const seller = toMasumiSellerSigner({ mnemonic: PrivateKey.generateMnemonic(256), network: 'cardano:preprod' });
// Stands in for the registered agent's selling wallet, which receives native payments.
const SELLING_WALLET = toMasumiSellerSigner({ mnemonic: PrivateKey.generateMnemonic(256), network: 'cardano:preprod' }).sellerAddress;
/** Aiken-like source with this many code lines. Only the line count matters to the price. */
const codeOf = (/** @type {number} */ lines) => `validator big {\n${'  let x = 1\n'.repeat(lines - 2)}}\n`;

// A minimal, valid Cardano transaction CBOR. Only its id matters to the server.
function fakeTx(seed = 'ab') {
  const cbor = `84a30081825820${seed.repeat(32)}00018182581d60${'cd'.repeat(28)}1a001e8480021a0002a000a0f5f6`;
  const transaction = Buffer.from(cbor, 'hex').toString('base64');
  return { transaction, nonce: `${seed.repeat(32)}#0`, txHash: decodeCardanoTransaction(transaction).txHash };
}

/** Starts the server on a random port with stubs. */
async function start({ now = Date.now, audit, mps, settle, verify, prepareWorkspace, nativePayTo = SELLING_WALLET } = /** @type {any} */ ({})) {
  const calls = { verify: 0, settle: 0, audit: 0, mps: 0, phases: /** @type {string[]} */ ([]), auditArgs: /** @type {any[]} */ ([]) };
  const stateDir = mkdtempSync(join(tmpdir(), 'x402-test-'));
  /** @type {any} */
  let app;
  // Escrow jobs are keyed by terms digest, native jobs by transaction id.
  const phaseOf = (/** @type {any} */ req, /** @type {string} */ txHash) => app.journal.load(req.extra?.terms ? termsDigestOf(req) : txHash)?.phase;
  const facilitator = {
    getSupported: async () => SUPPORTED,
    verify: async () => {
      calls.verify += 1;
      if (verify) await verify(calls.verify);
      return { isValid: true, payer: 'addr_test1buyer' };
    },
    settle: async (/** @type {any} */ payload, /** @type {any} */ req) => {
      calls.settle += 1;
      const txHash = decodeCardanoTransaction(payload.payload.transaction).txHash;
      calls.phases.push(`settle:${phaseOf(req, txHash)}`);
      return settle ? settle(txHash) : { success: true, transaction: txHash, network: 'cardano:preprod', extra: { status: 'confirmed', confirmations: 1 } };
    },
  };
  app = createX402Server({
    facilitator, seller, nativePayTo, stateDir, publicUrl: 'http://127.0.0.1:3013', now, log: () => {}, keepAliveMs: 5,
    ...(prepareWorkspace ? { prepareWorkspace } : {}),
    runAudit: async (/** @type {any} */ args) => {
      calls.audit += 1;
      calls.auditArgs.push(args);
      if (audit) return audit(args);
      return { report: `# Report\n\ntier ${args.tier}\n\n## Cardano proof\n\n${args.proof}\n` };
    },
    mps: mps === null ? null : {
      submitResult: async (/** @type {string} */ id, /** @type {string} */ hash) => {
        calls.mps += 1;
        const digest = app.journal.list()[0];
        calls.phases.push(`mps:${app.journal.load(digest).phase}`);
        if (mps) return mps(id, hash);
        throw new MpsError('MPS POST /api/v1/payment/submit-result failed with HTTP 404', { status: 404, path: '/x', uncertain: false });
      },
    },
  });
  await app.init();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (/** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}, path = '/audit') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, base, post, calls, stateDir, stop: () => new Promise((resolve) => app.server.close(resolve)) };
}

/** Gets a 402 and builds the PAYMENT-SIGNATURE header a buyer would send. */
async function quoteAndPay(/** @type {any} */ srv, /** @type {any} */ body, seed = 'ab') {
  const res = await srv.post(body);
  assert.equal(res.status, 402);
  const required = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const accepted = required.accepts[0];
  const tx = fakeTx(seed);
  const payload = { x402Version: 2, resource: required.resource, accepted, payload: { transaction: tx.transaction, nonce: tx.nonce } };
  return { required, accepted, tx, header: Buffer.from(JSON.stringify(payload)).toString('base64') };
}

const readJob = async (/** @type {Response} */ res) => JSON.parse((await res.text()).trim());
const decode402 = (/** @type {Response} */ res) => JSON.parse(Buffer.from(/** @type {string} */ (res.headers.get('payment-required')), 'base64').toString('utf8'));
const encode = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64');

// ---------- prices and requirements ----------

test('prices are tADA by tier and contract size, the same for both methods', () => {
  assert.deepEqual(PRICE_TADA, { see: { small: 5, medium: 10, large: 15 }, write: { small: 15, medium: 30, large: 45 } });
  for (const method of ['native', 'escrow']) {
    for (const [tier, sizes] of Object.entries(PRICE_TADA)) {
      for (const [size, tada] of Object.entries(sizes)) {
        const offer = x402Offer(tier, { size, method });
        assert.equal(offer.amount, String(tada * 1_000_000));
        assert.equal(offer.asset, 'lovelace');
        assert.equal(offer.priceTada, tada);
        assert.equal(offer.transferMethod, method === 'native' ? 'default' : 'masumi');
        assert.equal(offer.deadlines === null, method === 'native');
      }
    }
  }
  assert.equal(MAX_SPEND_ATOMIC, '50000000');
  assert.ok(Object.values(PRICE_TADA).every((sizes) => Object.values(sizes).every((tada) => tada * 1e6 <= Number(MAX_SPEND_ATOMIC))));
  assert.throws(() => x402Offer('see', { method: 'card' }), (error) => error instanceof HttpError && error.code === 'invalid_method');
  assert.equal(ESCROW_ADDRESS, masumiEscrowAddress('cardano:preprod'));
  const registration = JSON.parse(readFileSync(new URL('../.local/registration.json', import.meta.url), 'utf8'));
  assert.equal(ESCROW_ADDRESS, registration.smartContractAddress);
});

test('contract size uses the Sokosumi steps: code lines only, 150 and 400 line limits', () => {
  const file = (/** @type {string} */ content) => [{ path: 'validators/a.ak', content }];
  assert.deepEqual(contractSize(file(codeOf(150))), { files: 1, lines: 150, size: 'small' });
  assert.equal(contractSize(file(codeOf(151))).size, 'medium');
  assert.equal(contractSize(file(codeOf(400))).size, 'medium');
  assert.equal(contractSize(file(codeOf(401))).size, 'large');
  assert.equal(contractSize(file(`// note\n\n${codeOf(150)}\n// end\n`)).size, 'small', 'comments and blank lines do not count');
  const options = quoteOptions('medium', { native: SELLING_WALLET, escrow: ESCROW_ADDRESS });
  assert.deepEqual(options.map((o) => [o.id, o.priceTada, o.amount, o.payTo]), [
    ['see-native', 10, '10000000', SELLING_WALLET], ['see-escrow', 10, '10000000', ESCROW_ADDRESS],
    ['write-native', 30, '30000000', SELLING_WALLET], ['write-escrow', 30, '30000000', ESCROW_ADDRESS],
  ]);
  assert.deepEqual(quoteOptions('small', { native: null, escrow: ESCROW_ADDRESS }).map((o) => o.id), ['see-escrow', 'write-escrow']);
});

test('escrow deadlines follow tiers.mjs (result due 20 and 45 minutes after the quote)', () => {
  for (const [tier, submitMinutes] of [['see', 20], ['write', 45]]) {
    const { deadlines, maxTimeoutSeconds } = x402Offer(tier);
    assert.equal(maxTimeoutSeconds * 1000 + deadlines.submitResultAfterPayByMs, submitMinutes * MIN);
    assert.equal(deadlines.unlockAfterPayByMs - deadlines.submitResultAfterPayByMs, 16 * MIN);
    assert.equal(deadlines.externalDisputeUnlockAfterPayByMs - deadlines.unlockAfterPayByMs, 16 * MIN);
  }
  assert.throws(() => x402Offer('audit'), HttpError);
});

test('result hash is raw MIP-004 with the signed buyer nonce (empty in this flow)', () => {
  const report = 'line one\n"quoted" \\ end';
  assert.equal(x402ResultHash('', report), sha(`;${report}`));
  assert.equal(x402ResultHash('0123456789abcd', report), sha(`0123456789abcd;${report}`));
  assert.throws(() => x402ResultHash('xyz', report));
  assert.throws(() => x402ResultHash('', '\ud800'));
});

test('buyer spend controls allow lovelace up to 50 tADA per payment and nothing else', async () => {
  const scheme = { scheme: 'exact', createPaymentPayload: async (/** @type {number} */ x402Version) => ({ x402Version, payload: {} }) };
  const client = new x402Client().register('cardano:preprod', /** @type {any} */ (scheme)).setSpendControls(BUYER_SPEND_CONTROLS);
  const required = (/** @type {string} */ amount, asset = LOVELACE) => ({ x402Version: 2, resource: { url: 'http://x/audit' },
    accepts: [{ scheme: 'exact', network: 'cardano:preprod', amount, asset, payTo: ESCROW_ADDRESS, maxTimeoutSeconds: 600, extra: {} }] });
  assert.equal((await client.createPaymentPayload(/** @type {any} */ (required('50000000')))).accepted.amount, '50000000');
  await assert.rejects(client.createPaymentPayload(/** @type {any} */ (required('50000001'))));
  await assert.rejects(client.createPaymentPayload(/** @type {any} */ (required('1000000', `${'1'.repeat(56)}.00`))));
});

// ---------- input validation ----------

test('parseAuditRequest accepts code, a GitHub link or uploaded files and rejects everything else', () => {
  assert.deepEqual(parseAuditRequest({ tier: 'see', code: CODE }), { tier: 'see', method: 'escrow', source: { kind: 'code', code: CODE }, buyerNotes: '' });
  assert.equal(parseAuditRequest({ tier: 'see', method: 'native', code: CODE }).method, 'native');
  const files = [{ path: 'validators/a.ak', content: CODE }, { path: 'lib/demo/util.ak', content: 'pub fn f() { 1 }\n' }];
  assert.deepEqual(parseAuditRequest({ tier: 'write', method: 'escrow', files }).source, { kind: 'files', files });
  assert.deepEqual(parseQuoteRequest({ code: CODE }), { source: { kind: 'code', code: CODE }, buyerNotes: '' });
  assert.throws(() => parseQuoteRequest({ tier: 'see', code: CODE }), (error) => error instanceof HttpError && error.code === 'unknown_field');
  const gh = parseAuditRequest({ tier: 'write', github: 'https://github.com/aiken-lang/stdlib', description: 'note' });
  assert.equal(gh.source.kind, 'github');
  assert.equal(gh.buyerNotes, 'note');
  const bad = [
    [{ tier: 'audit', code: CODE }, 400, 'tier_not_offered'],
    [{ tier: 'gold', code: CODE }, 400, 'invalid_tier'],
    [{ tier: 'see' }, 400, 'invalid_source'],
    [{ tier: 'see', code: CODE, github: 'https://github.com/a/b' }, 400, 'invalid_source'],
    [{ tier: 'see', code: '   ' }, 400, 'invalid_code'],
    [{ tier: 'see', code: 'x'.repeat(200_001) }, 413, 'code_too_large'],
    [{ tier: 'see', github: 'https://gitlab.com/a/b' }, 400, 'invalid_github'],
    [{ tier: 'see', github: 'https://github.com/a/b/tree/main/../../..' }, 400, 'invalid_github'],
    [{ tier: 'see', github: 'https://github.com/../../tree/main' }, 400, 'invalid_github'],
    [{ tier: 'see', github: 'https://github.com/a/b/tree/--upload-pack/x' }, 400, 'invalid_github'],
    [{ tier: 'see', github: 'https://github.com/a/b https://github.com/c/d' }, 400, 'invalid_github'],
    [{ tier: 'see', github: 'https://github.com.evil.io/a/b' }, 400, 'invalid_github'],
    [{ tier: 'see', code: CODE, extra: 1 }, 400, 'unknown_field'],
    [{ tier: 'see', code: CODE, description: 5 }, 400, 'invalid_description'],
    [{ tier: 'see', method: 'card', code: CODE }, 400, 'invalid_method'],
    [{ tier: 'see', code: CODE, files: [{ path: 'validators/a.ak', content: CODE }] }, 400, 'invalid_source'],
    [{ tier: 'see', files: [] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: 'validators/../../.env.ak', content: CODE }] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: '/etc/passwd.ak', content: CODE }] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: 'validators/a.ak', content: CODE, mode: 1 }] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: 'validators/a.ak', content: CODE }, { path: 'validators/a.ak', content: CODE }] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: 'lib/a.ak', content: CODE }] }, 400, 'invalid_files'],
    [{ tier: 'see', files: [{ path: 'validators/a.ak', content: 'x'.repeat(200_001) }] }, 413, 'code_too_large'],
    [[], 400, 'invalid_body'],
  ];
  for (const [body, status, code] of bad) {
    assert.throws(() => parseAuditRequest(body), (error) => error instanceof HttpError && error.status === status && error.code === code);
  }
});

test('invalid requests get 4xx before any quote is issued', async () => {
  const srv = await start();
  try {
    const cases = [[{ tier: 'audit', code: CODE }, 400], [{ tier: 'see' }, 400], [{ tier: 'see', code: CODE, x: 1 }, 400]];
    for (const [body, status] of cases) {
      const res = await srv.post(body);
      assert.equal(res.status, status);
      assert.equal(res.headers.get('payment-required'), null);
    }
    const raw = await fetch(`${srv.base}/audit`, { method: 'POST', body: '{not json' });
    assert.equal(raw.status, 400);
    assert.equal(srv.app.storage.prune(Date.now() + 365 * 24 * 60 * MIN), 0);
  } finally { await srv.stop(); }
});

// ---------- the 402 ----------

test('an unpaid escrow POST /audit gets a seller-signed Masumi 402 in tADA that a buyer can verify', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', code: CODE };
    const res = await srv.post(body);
    assert.equal(res.status, 402);
    const json = await res.json();
    assert.equal(json.error, 'payment_required');
    assert.equal(json.price.amount, '5000000');
    assert.equal(json.price.display, '5 tADA');
    assert.deepEqual(json.project, { label: 'validators/contract.ak (pasted code)', files: 1, lines: 5, size: 'small' });
    const required = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
    assert.equal(required.x402Version, 2);
    assert.equal(required.resource.url, 'http://127.0.0.1:3013/audit');
    assert.equal(required.accepts.length, 1);
    const req = required.accepts[0];
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'cardano:preprod');
    assert.equal(req.payTo, ESCROW_ADDRESS);
    assert.equal(req.asset, 'lovelace');
    assert.equal(req.amount, '5000000');
    assert.equal(req.maxTimeoutSeconds, 600);
    assert.equal(req.extra.assetTransferMethod, 'masumi');
    assert.equal(req.extra.terms.sellerAddress, seller.sellerAddress);
    assert.equal(req.extra.terms.buyerNonce, '');
    assert.equal(req.extra.terms.agentIdentifier, undefined);
    assert.equal(Number(req.extra.terms.submitResultTime) - Number(req.extra.terms.payByTime), 10 * MIN);
    const parts = Object.fromEntries(req.extra.inputCommitment.parts.map((/** @type {any} */ p) => [p.name, p]));
    assert.equal(parts.body.content, undefined, 'the buyer body is not echoed');
    assert.equal(parts.offer.content.resultHash, 'sha256(terms.buyerNonce + ";" + report)');
    assert.equal(bodyMatchesQuote(req, body), true);
    assert.equal(bodyMatchesQuote(req, { ...body, code: `${CODE} ` }), false);
    // The checks the buyer's x402 client runs before it signs.
    const check = await verifyMasumiAuthorization(req.extra, req, { localCommitmentContent: { body }, requireAllPartContent: true });
    assert.equal(check.ok, true, JSON.stringify(check));
    const tampered = await verifyMasumiAuthorization(req.extra, req, { localCommitmentContent: { body: { ...body, tier: 'write' } }, requireAllPartContent: true });
    assert.equal(tampered.ok, false);
    // Each 402 is a fresh quote.
    const again = JSON.parse(Buffer.from((await srv.post(body)).headers.get('payment-required'), 'base64').toString('utf8'));
    assert.notEqual(again.accepts[0].extra.terms.sellerNonce, req.extra.terms.sellerNonce);
    // The write tier has its own price and a 45-minute result deadline.
    const write = JSON.parse(Buffer.from((await srv.post({ tier: 'write', code: CODE })).headers.get('payment-required'), 'base64').toString('utf8')).accepts[0];
    assert.equal(write.amount, '15000000');
    assert.equal(Number(write.extra.terms.submitResultTime) - Number(write.extra.terms.payByTime), 35 * MIN);
  } finally { await srv.stop(); }
});

test('unpaid quotes are rate limited per client', async () => {
  const srv = await start();
  try {
    for (let i = 0; i < 30; i += 1) assert.equal((await srv.post({ tier: 'see', code: CODE })).status, 402);
    const res = await srv.post({ tier: 'see', code: CODE });
    assert.equal(res.status, 429);
  } finally { await srv.stop(); }
});

test('server without a seller key answers 503 and reports unavailable', async () => {
  const app = createX402Server({ facilitator: /** @type {any} */ ({}), seller: null, stateDir: mkdtempSync(join(tmpdir(), 'x402-')),
    publicUrl: 'http://127.0.0.1:3013', log: () => {} });
  await app.init();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${/** @type {any} */ (app.server.address()).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await (await fetch(`${base}/availability`)).json()).status, 'unavailable');
    const schema = await (await fetch(`${base}/input_schema`)).json();
    assert.deepEqual(schema.input_data.map((/** @type {any} */ f) => f.id), ['tier', 'method', 'code', 'github', 'description']);
    const res = await fetch(`${base}/audit`, { method: 'POST', body: JSON.stringify({ tier: 'see', code: CODE }) });
    assert.equal(res.status, 503);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

// ---------- the paid flow and the journal ----------

test('a paid retry settles, audits, journals before each write, and returns the report', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', code: CODE, description: 'A vault.' };
    const { accepted, tx, header } = await quoteAndPay(srv, body);
    const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 200);
    const settlement = JSON.parse(Buffer.from(res.headers.get('payment-response'), 'base64').toString('utf8'));
    assert.equal(settlement.success, true);
    assert.equal(settlement.transaction, tx.txHash);
    const job = await readJob(res);
    assert.equal(job.ok, true);
    assert.equal(job.jobId, res.headers.get('x-audit-job'));
    assert.equal(job.escrowTx.hash, tx.txHash);
    assert.equal(job.escrowTx.url, `https://preprod.cardanoscan.io/transaction/${tx.txHash}`);
    assert.equal(job.blockchainIdentifier, accepted.extra.blockchainIdentifier);
    assert.equal(job.resultHash, sha(`;${job.report}`));
    assert.match(job.report, new RegExp(tx.txHash));
    assert.equal(job.resultSubmission.status, 'rejected');
    assert.equal(job.resultSubmission.httpStatus, 404);
    assert.deepEqual(srv.calls.phases, ['settle:settle-pending', 'mps:submit-pending']);
    const digest = termsDigestOf(accepted);
    const saved = srv.app.journal.load(digest);
    assert.equal(saved.phase, 'result-not-submitted');
    assert.equal(readFileSync(srv.app.journal.reportPath(digest), 'utf8'), job.report);
    assert.equal(JSON.stringify(job).includes('validator vault'), false, 'the response never echoes the code');
    const polled = await (await fetch(`${srv.base}/jobs/${job.jobId}`)).json();
    assert.equal(polled.resultHash, job.resultHash);
  } finally { await srv.stop(); }
});

test('sending the same paid request again never settles, audits or submits twice', async () => {
  const srv = await start({ mps: async () => ({}) });
  try {
    const body = { tier: 'see', code: CODE };
    const { header } = await quoteAndPay(srv, body);
    const first = await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }));
    assert.equal(first.resultSubmission.status, 'accepted');
    const second = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(second.status, 200);
    assert.ok(second.headers.get('payment-response'));
    const job = await readJob(second);
    assert.equal(job.resultHash, first.resultHash);
    assert.deepEqual([srv.calls.settle, srv.calls.audit, srv.calls.mps], [1, 1, 1]);
  } finally { await srv.stop(); }
});

test('a paid retry with a different body is refused before settlement', async () => {
  const srv = await start();
  try {
    const { header } = await quoteAndPay(srv, { tier: 'see', code: CODE });
    const res = await srv.post({ tier: 'see', code: `${CODE}\n// other` }, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'body_mismatch');
    assert.equal(srv.calls.settle, 0);
  } finally { await srv.stop(); }
});

test('a quote paid too close to its result deadline is refused before settlement', async () => {
  let clock = Date.now();
  const srv = await start({ now: () => clock });
  try {
    const body = { tier: 'see', code: CODE };
    const { accepted, header } = await quoteAndPay(srv, body);
    clock = Number(accepted.extra.terms.submitResultTime) - 7 * MIN;
    const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'quote_too_old');
    assert.equal(srv.calls.settle, 0);
  } finally { await srv.stop(); }
});

test('a failed audit reports the refund path and submits no hash', async () => {
  const srv = await start({ audit: async () => { throw new Error('aiken crashed'); } });
  try {
    const body = { tier: 'see', code: CODE };
    const { header } = await quoteAndPay(srv, body);
    const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 200);
    const job = await readJob(res);
    assert.equal(job.ok, false);
    assert.equal(job.phase, 'failed');
    assert.match(job.error, /aiken crashed/);
    assert.match(job.refund, /WithdrawRefund/);
    assert.equal(srv.calls.mps, 0);
  } finally { await srv.stop(); }
});

test('settlement_pending keeps the job open; the same signature resumes it', async () => {
  let pending = true;
  const srv = await start({ settle: (/** @type {string} */ txHash) => (pending
    ? { success: false, errorReason: 'settlement_pending', transaction: txHash, network: 'cardano:preprod', extra: { status: 'pending' } }
    : { success: true, transaction: txHash, network: 'cardano:preprod' }) });
  try {
    const body = { tier: 'see', code: CODE };
    const { accepted, header } = await quoteAndPay(srv, body);
    const first = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(first.status, 402);
    assert.equal((await first.json()).error, 'settlement_pending');
    assert.equal(srv.app.journal.load(termsDigestOf(accepted)).phase, 'settle-pending');
    assert.equal(srv.calls.audit, 0);
    pending = false;
    const second = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(second.status, 200);
    assert.equal((await readJob(second)).ok, true);
    assert.equal(srv.calls.audit, 1);
  } finally { await srv.stop(); }
});

test('after a restart, settled jobs resume and an unknown MPS outcome is never resubmitted', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'x402-recover-'));
  const journal = createJournal(join(stateDir, 'jobs'));
  const base = { tier: 'see', source: { kind: 'code', code: CODE }, buyerNotes: '', txHash: 'e'.repeat(64), escrowTxHash: 'e'.repeat(64),
    blockchainIdentifier: 'ab', buyerNonce: '', inputHash: 'f'.repeat(64), sellerAddress: seller.sellerAddress, amount: '5000000',
    asset: LOVELACE, payByTime: String(Date.now()), submitResultTime: String(Date.now() + 20 * MIN),
    unlockTime: String(Date.now() + 36 * MIN), externalDisputeUnlockTime: String(Date.now() + 52 * MIN) };
  const settled = 'a'.repeat(64);
  const unknown = 'b'.repeat(64);
  journal.save(settled, { ...base, jobId: '1'.repeat(32), termsDigest: settled, phase: 'settled' });
  journal.save(unknown, { ...base, jobId: '2'.repeat(32), termsDigest: unknown, phase: 'submit-pending', resultHash: 'c'.repeat(64) });
  let submits = 0;
  const app = createX402Server({ facilitator: /** @type {any} */ ({}), seller: null, stateDir, publicUrl: 'http://127.0.0.1:3013', log: () => {},
    runAudit: /** @type {any} */ (async () => ({ report: '# resumed\n' })), mps: { submitResult: async () => { submits += 1; } } });
  app.recover();
  for (let i = 0; i < 50 && journal.load(settled).phase !== 'result-submitted'; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(journal.load(settled).phase, 'result-submitted');
  assert.equal(journal.load(settled).resultHash, sha(';# resumed\n'));
  assert.equal(journal.load(unknown).phase, 'submit-pending');
  assert.equal(submits, 1);
});

// ---------- payment-safety regressions ----------

test('a duplicate paid request that waits in verify never settles, audits or submits a second time', async () => {
  /** @type {() => void} */
  let secondEntered = () => {};
  const bothIn = new Promise((resolve) => { secondEntered = () => resolve(undefined); });
  /** @type {() => void} */
  let release = () => {};
  const hold = new Promise((resolve) => { release = () => resolve(undefined); });
  // Verify 1 waits until request 2 is also in verify; verify 2 waits until request 1 has finished.
  const srv = await start({ mps: async () => ({}), verify: async (/** @type {number} */ n) => {
    if (n === 1) await bothIn;
    else { secondEntered(); await hold; }
  } });
  try {
    const body = { tier: 'see', code: CODE };
    const { header } = await quoteAndPay(srv, body);
    const requests = [srv.post(body, { 'PAYMENT-SIGNATURE': header }), srv.post(body, { 'PAYMENT-SIGNATURE': header })];
    const [index, firstRes] = await Promise.race(requests.map((p, i) => p.then((r) => /** @type {const} */ ([i, r]))));
    const first = await readJob(firstRes);
    assert.equal(first.phase, 'result-submitted');
    release();
    const second = await readJob(await requests[1 - index]);
    assert.equal(second.resultHash, first.resultHash);
    assert.deepEqual([srv.calls.settle, srv.calls.audit, srv.calls.mps], [1, 1, 1]);
  } finally { release(); await srv.stop(); }
});

test('the paid shortcut needs the committed body, so chain data alone cannot fetch a report', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', code: CODE };
    const { header } = await quoteAndPay(srv, body);
    assert.equal((await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }))).ok, true);
    // The terms digest and the transaction are public on chain. The body is not.
    const other = await srv.post({ tier: 'see', code: 'validator x { else(_) { True } }' }, { 'PAYMENT-SIGNATURE': header });
    assert.equal(other.status, 400);
    const json = await other.json();
    assert.equal(json.error, 'body_mismatch');
    assert.equal(json.report, undefined);
    assert.deepEqual([srv.calls.settle, srv.calls.audit], [1, 1]);
  } finally { await srv.stop(); }
});

test('an unknown settlement outcome keeps the job resumable; only a final rejection ends it', async () => {
  const outcomes = [
    () => { throw new Error('socket hang up'); },
    (/** @type {string} */ tx) => ({ success: false, errorReason: 'exact_cardano_settlement_failed', errorMessage: 'submit timed out', transaction: tx, network: 'cardano:preprod' }),
    (/** @type {string} */ tx) => ({ success: false, errorReason: 'duplicate_settlement', transaction: tx, network: 'cardano:preprod' }),
  ];
  let step = 0;
  const srv = await start({ settle: (/** @type {string} */ tx) => (step < outcomes.length ? outcomes[step++](tx)
    : { success: true, transaction: tx, network: 'cardano:preprod' }) });
  try {
    const body = { tier: 'see', code: CODE };
    const { accepted, header } = await quoteAndPay(srv, body);
    for (let i = 0; i < outcomes.length; i += 1) {
      const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
      assert.equal(res.status, 402);
      const json = await res.json();
      assert.equal(json.error, 'settlement_unknown');
      assert.match(json.message, /Do not pay again/);
      assert.equal(srv.app.journal.load(termsDigestOf(accepted)).phase, 'settle-pending');
    }
    assert.equal(srv.calls.audit, 0);
    const done = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(done.status, 200);
    assert.equal((await readJob(done)).ok, true);
    assert.equal(srv.calls.audit, 1);
  } finally { await srv.stop(); }

  const final = await start({ settle: (/** @type {string} */ tx) => ({ success: false, errorReason: 'exact_cardano_settlement_definitively_rejected', transaction: tx, network: 'cardano:preprod' }) });
  try {
    const body = { tier: 'see', code: CODE };
    const { accepted, header } = await quoteAndPay(final, body);
    assert.equal((await final.post(body, { 'PAYMENT-SIGNATURE': header })).status, 402);
    assert.equal(final.app.journal.load(termsDigestOf(accepted)).phase, 'settle-failed');
    const again = await final.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal((await again.json()).error, 'payment_failed');
    assert.deepEqual([final.calls.settle, final.calls.audit], [1, 0]);
  } finally { await final.stop(); }
  assert.equal(settleFailureIsFinal({ errorReason: 'exact_cardano_settlement_failed', extra: { status: 'expired' } }), true);
  assert.equal(settleFailureIsFinal({ errorReason: 'settlement_pending' }), false);
});

test('requests with a payment header for an unknown quote count against the quote limit', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', code: CODE };
    const { accepted } = await quoteAndPay(srv, body);
    // A decodable payment for a quote this server never issued.
    const forged = { ...accepted, extra: { ...accepted.extra, terms: { ...accepted.extra.terms, sellerNonce: 'f'.repeat(64) } } };
    const tx = fakeTx('cd');
    const forgedHeader = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'http://x/audit' }, accepted: forged,
      payload: { transaction: tx.transaction, nonce: tx.nonce } })).toString('base64');
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await srv.post(body, { 'PAYMENT-SIGNATURE': forgedHeader })).status);
    assert.equal(statuses.at(-1), 429);
    assert.ok(statuses.slice(0, 29).every((s) => s === 402));
    assert.ok(readdirSync(join(srv.stateDir, 'terms')).length <= 2 * 30, 'stored quotes stay bounded');
    assert.equal(srv.calls.settle, 0);
  } finally { await srv.stop(); }
});

test('a GitHub clone with a symbolic link is refused before the audit reads any file', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'x402-secret-'));
  writeFileSync(join(outside, 'wallet.json'), '{"mnemonic":"not a real one"}');
  const clone = (/** @type {boolean} */ withLink) => {
    const dir = mkdtempSync(join(tmpdir(), 'x402-clone-'));
    mkdirSync(join(dir, 'validators'));
    writeFileSync(join(dir, 'aiken.toml'), 'name = "a/b"\n');
    writeFileSync(join(dir, 'validators/a.ak'), CODE);
    if (withLink) symlinkSync(join(outside, 'wallet.json'), join(dir, 'validators/b.ak'));
    return { dir, root: dir, label: 'test clone' };
  };
  assert.equal(findSymlink(clone(false).dir), null);
  assert.equal(findSymlink(clone(true).dir), join('validators', 'b.ak'));

  let withLink = true;
  const srv = await start({ prepareWorkspace: async () => clone(withLink) });
  try {
    const body = { tier: 'see', github: 'https://github.com/a/b' };
    // The price check clones first, so a link is refused before any quote or payment.
    const refused = await srv.post(body);
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).message, /symbolic link/);
    assert.equal(refused.headers.get('payment-required'), null);
    // A link that appears after the quote is still refused before the audit reads any file.
    withLink = false;
    const { header } = await quoteAndPay(srv, body);
    withLink = true;
    const job = await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }));
    assert.equal(job.ok, false);
    assert.equal(job.phase, 'failed');
    assert.match(job.error, /symbolic link/);
    assert.equal(srv.calls.audit, 0);
    assert.equal(srv.calls.mps, 0);
    withLink = false;
    const clean = await quoteAndPay(srv, body, 'ef');
    assert.equal((await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': clean.header }))).ok, true);
    assert.equal(srv.calls.auditArgs[0].workspace.label, 'test clone');
  } finally { await srv.stop(); }
});

test('quoteProblem accepts only the option\'s price, payee, method, seller, deadlines and no registry claim', async () => {
  const srv = await start();
  try {
    const offer = (/** @type {string} */ tier, method = 'escrow', size = 'small') => x402Offer(tier, { size, method });
    const escrow = { sellerAddress: seller.sellerAddress };
    const { accepted: see } = await quoteAndPay(srv, { tier: 'see', code: CODE });
    const { accepted: write } = await quoteAndPay(srv, { tier: 'write', code: CODE });
    assert.equal(quoteProblem(see, offer('see'), escrow), null);
    assert.equal(quoteProblem(write, offer('write'), escrow), null);
    assert.equal(quoteProblem(see, offer('write'), escrow), 'price');
    assert.equal(quoteProblem(see, offer('see', 'escrow', 'medium'), escrow), 'price');
    assert.equal(quoteProblem({ ...write, amount: see.amount }, offer('see'), escrow), 'deadlines');
    assert.equal(quoteProblem({ ...see, payTo: 'addr_test1other' }, offer('see'), escrow), 'payTo');
    assert.equal(quoteProblem({ ...see, asset: `${'1'.repeat(56)}.00` }, offer('see'), escrow), 'price');
    assert.equal(quoteProblem({ ...see, network: 'cardano:mainnet' }, offer('see'), escrow), 'network');
    assert.equal(quoteProblem(see, offer('see'), { sellerAddress: 'addr_test1someoneelse' }), 'seller');
    const claim = { ...see, extra: { ...see.extra, terms: { ...see.extra.terms, agentIdentifier: 'ab'.repeat(30) } } };
    assert.equal(quoteProblem(claim, offer('see'), escrow), 'agentIdentifier');

    const { accepted: native } = await quoteAndPay(srv, { tier: 'see', method: 'native', code: CODE });
    assert.equal(quoteProblem(native, offer('see', 'native'), { payTo: SELLING_WALLET }), null);
    assert.equal(quoteProblem(native, offer('see', 'native'), { payTo: 'addr_test1other' }), 'payTo');
    assert.equal(quoteProblem(native, offer('see', 'native'), {}), 'payTo');
    assert.equal(quoteProblem(native, offer('see'), escrow), 'payTo');
    assert.equal(quoteProblem(see, offer('see', 'native'), { payTo: ESCROW_ADDRESS }), 'assetTransferMethod');
    assert.equal(quoteProblem({ ...native, extra: { ...native.extra, terms: see.extra.terms } }, offer('see', 'native'), { payTo: SELLING_WALLET }), 'assetTransferMethod');
  } finally { await srv.stop(); }
});

test('a broken wallet file error never quotes the file text', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'x402-wallet-')), 'w.json');
  writeFileSync(path, 'abandon ability able about above absent', { mode: 0o600 });
  assert.throws(() => readWalletFile(path), (error) => error instanceof Error && !/abandon|ability/.test(error.message));
});

test('file quote storage updates atomically and prunes only unpaid, expired quotes', async () => {
  const storage = new FileMasumiTermsStorage(mkdtempSync(join(tmpdir(), 'x402-terms-')));
  const quote = (/** @type {number} */ payBy) => ({ requirements: { extra: { terms: { payByTime: String(payBy) } } } });
  const old = 'a'.repeat(64);
  const paid = 'b'.repeat(64);
  const fresh = 'c'.repeat(64);
  assert.equal((await storage.updateTerms(old, (cur) => cur ?? { termsDigest: old, ...quote(1000) })).status, 'updated');
  assert.equal((await storage.updateTerms(old, (cur) => cur ?? { termsDigest: old, ...quote(5) })).status, 'unchanged');
  await storage.updateTerms(paid, () => ({ termsDigest: paid, ...quote(1000), claimedTxHash: 'd'.repeat(64) }));
  await storage.updateTerms(fresh, () => ({ termsDigest: fresh, ...quote(Date.now()) }));
  const claims = await Promise.all([1, 2, 3].map((n) => storage.updateTerms(old, (cur) => (cur.claimedTxHash ? cur : { ...cur, claimedTxHash: String(n) }))));
  assert.deepEqual(claims.map((c) => c.terms.claimedTxHash), ['1', '1', '1']);
  await storage.updateTerms(old, (cur) => ({ ...cur, claimedTxHash: undefined }));
  assert.equal(storage.prune(Date.now()), 1);
  assert.equal(await storage.get(old), undefined);
  assert.ok(await storage.get(paid));
  assert.ok(await storage.get(fresh));
  assert.throws(() => storage.path('../etc'), /Invalid terms digest/);
});

// ---------- native x402 (assetTransferMethod "default") ----------

test('an unpaid native POST /audit gets a plain x402 402 that pays the selling wallet in tADA', async () => {
  const srv = await start();
  try {
    const res = await srv.post({ tier: 'see', method: 'native', code: CODE });
    assert.equal(res.status, 402);
    const json = await res.json();
    assert.equal(json.method, 'native');
    assert.equal(json.price.display, '5 tADA');
    const required = decode402(res);
    assert.equal(required.accepts.length, 1);
    const req = required.accepts[0];
    assert.deepEqual([req.scheme, req.network, req.payTo, req.asset, req.amount, req.maxTimeoutSeconds],
      ['exact', 'cardano:preprod', SELLING_WALLET, 'lovelace', '5000000', 600]);
    // x402 core leaves "default" off the wire: no method means address-to-address.
    assert.equal(req.extra.assetTransferMethod, undefined);
    assert.equal(transferMethodOf(req), 'default');
    assert.equal(req.extra.terms, undefined);
    assert.equal(req.extra.inputCommitment, undefined);
    // The price follows the contract size: a large contract costs 15 tADA (see) and 45 tADA (write).
    assert.equal(decode402(await srv.post({ tier: 'see', method: 'native', code: codeOf(401) })).accepts[0].amount, '15000000');
    assert.equal(decode402(await srv.post({ tier: 'write', method: 'native', code: codeOf(401) })).accepts[0].amount, '45000000');
    assert.equal(readdirSync(join(srv.stateDir, 'terms')).length, 0, 'native quotes store no terms');
  } finally { await srv.stop(); }
});

test('a native payment settles, runs the audit, and returns the report with no escrow step', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', method: 'native', code: CODE, description: 'A vault.' };
    const { tx, header } = await quoteAndPay(srv, body);
    const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 200);
    const settlement = JSON.parse(Buffer.from(/** @type {string} */ (res.headers.get('payment-response')), 'base64').toString('utf8'));
    assert.equal(settlement.transaction, tx.txHash);
    const job = await readJob(res);
    assert.equal(job.ok, true);
    assert.equal(job.method, 'native');
    assert.equal(job.phase, 'delivered');
    assert.deepEqual(job.paymentTx, { hash: tx.txHash, url: `https://preprod.cardanoscan.io/transaction/${tx.txHash}` });
    assert.deepEqual([job.escrowTx, job.deadlines, job.blockchainIdentifier, job.refund, job.resultTx], [null, null, null, null, null]);
    assert.deepEqual([job.payment.payTo, job.payment.priceTada, job.payment.assetTransferMethod], [SELLING_WALLET, 5, 'default']);
    assert.equal(job.resultHash, sha(`;${job.report}`));
    assert.match(job.report, new RegExp(tx.txHash));
    assert.match(job.report, /native, address to address/);
    assert.deepEqual(srv.calls.phases, ['settle:settle-pending']);
    assert.equal(srv.calls.mps, 0);
    const saved = srv.app.journal.load(tx.txHash);
    assert.equal(saved.phase, 'delivered');
    assert.equal(saved.bodyDigest, bodyDigest(body));
    assert.equal(JSON.stringify(job).includes('validator vault'), false, 'the response never echoes the code');
    assert.equal((await (await fetch(`${srv.base}/jobs/${job.jobId}`)).json()).resultHash, job.resultHash);
  } finally { await srv.stop(); }
});

test('one native transaction pays for one request: a replay comes from the journal, another body is refused', async () => {
  const srv = await start();
  try {
    const body = { tier: 'see', method: 'native', code: CODE };
    const { header } = await quoteAndPay(srv, body);
    const first = await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }));
    const again = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(again.status, 200);
    assert.equal((await readJob(again)).resultHash, first.resultHash);
    for (const other of [{ ...body, code: `${CODE}\n// other` }, { ...body, tier: 'write' }]) {
      const res = await srv.post(other, { 'PAYMENT-SIGNATURE': header });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, 'payment_already_used');
    }
    assert.deepEqual([srv.calls.verify, srv.calls.settle, srv.calls.audit], [1, 1, 1]);
  } finally { await srv.stop(); }
});

test('a native payment that claims a lower price than the contract size sets is refused before verify', async () => {
  const srv = await start();
  try {
    const body = { tier: 'write', method: 'native', code: codeOf(401) };
    const { required, accepted, tx } = await quoteAndPay(srv, body);
    assert.equal(accepted.amount, '45000000');
    const header = encode({ x402Version: 2, resource: required.resource, accepted: { ...accepted, amount: '15000000' },
      payload: { transaction: tx.transaction, nonce: tx.nonce } });
    const res = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(res.status, 402);
    assert.deepEqual([srv.calls.verify, srv.calls.settle, srv.calls.audit], [0, 0, 0]);
  } finally { await srv.stop(); }
});

test('a pending native settlement resumes with the same signature; a failed audit says the payment is final', async () => {
  let pending = true;
  const srv = await start({ settle: (/** @type {string} */ txHash) => (pending
    ? { success: false, errorReason: 'settlement_pending', transaction: txHash, network: 'cardano:preprod', extra: { status: 'pending' } }
    : { success: true, transaction: txHash, network: 'cardano:preprod' }),
  audit: async () => { throw new Error('aiken crashed'); } });
  try {
    const body = { tier: 'see', method: 'native', code: CODE };
    const { tx, header } = await quoteAndPay(srv, body);
    const first = await srv.post(body, { 'PAYMENT-SIGNATURE': header });
    assert.equal(first.status, 402);
    assert.equal((await first.json()).error, 'settlement_pending');
    assert.equal(srv.app.journal.load(tx.txHash).phase, 'settle-pending');
    pending = false;
    const job = await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }));
    assert.equal(job.ok, false);
    assert.equal(job.phase, 'failed');
    assert.match(job.refund, /final/);
    // x402 core retries a pending settlement once itself, so the first request settles twice.
    assert.deepEqual([srv.calls.settle, srv.calls.audit, srv.calls.mps], [3, 1, 0]);
  } finally { await srv.stop(); }
});

test('a server without the selling wallet answers 503 for native and offers only escrow', async () => {
  const srv = await start({ nativePayTo: null });
  try {
    const res = await srv.post({ tier: 'see', method: 'native', code: CODE });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'native_not_configured');
    const quote = await (await srv.post({ code: CODE }, {}, '/quote')).json();
    assert.deepEqual(quote.options.map((/** @type {any} */ o) => o.id), ['see-escrow', 'write-escrow']);
    const availability = await (await fetch(`${srv.base}/availability`)).json();
    assert.equal(availability.x402.methods.native.available, false);
    assert.equal(availability.x402.methods.escrow.available, true);
  } finally { await srv.stop(); }
});

// ---------- POST /quote and uploaded projects ----------

test('POST /quote lists each tier and method with its tADA price, and each 402 matches it', async () => {
  const srv = await start();
  try {
    const res = await srv.post({ code: codeOf(200) }, {}, '/quote');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('payment-required'), null);
    const json = await res.json();
    assert.deepEqual(json.project, { label: 'validators/contract.ak (pasted code)', files: 1, lines: 200, size: 'medium' });
    assert.deepEqual(json.options.map((/** @type {any} */ o) => [o.id, o.tier, o.method, o.priceTada]),
      [['see-native', 'see', 'native', 10], ['see-escrow', 'see', 'escrow', 10], ['write-native', 'write', 'native', 30], ['write-escrow', 'write', 'escrow', 30]]);
    assert.ok(json.options.every((/** @type {any} */ o) => o.description.length > 30));
    for (const o of json.options) {
      const req = decode402(await srv.post({ tier: o.tier, method: o.method, code: codeOf(200) })).accepts[0];
      assert.deepEqual([req.amount, req.asset, req.payTo], [o.amount, 'lovelace', o.payTo]);
    }
    assert.equal((await srv.post({ tier: 'see', code: CODE }, {}, '/quote')).status, 400);
    assert.equal(srv.calls.verify + srv.calls.settle, 0);
  } finally { await srv.stop(); }
});

test('POST /quote counts against the unpaid quote limit', async () => {
  const srv = await start();
  try {
    for (let i = 0; i < 30; i += 1) assert.equal((await srv.post({ code: CODE }, {}, '/quote')).status, 200);
    assert.equal((await srv.post({ code: CODE }, {}, '/quote')).status, 429);
    assert.equal((await srv.post({ tier: 'see', method: 'native', code: CODE })).status, 429);
  } finally { await srv.stop(); }
});

test('an uploaded project is priced by all its files and written into the audit workspace', async () => {
  const work = mkdtempSync(join(tmpdir(), 'x402-work-'));
  const srv = await start({ prepareWorkspace: async (/** @type {any} */ source, /** @type {string} */ jobId) => {
    const dir = join(work, jobId);
    mkdirSync(join(dir, 'validators'), { recursive: true });
    writeFileSync(join(dir, 'validators/contract.ak'), source.code);
    return { dir, root: dir, label: 'template' };
  } });
  try {
    const files = [{ path: 'validators/vault.ak', content: CODE }, { path: 'lib/vault/math.ak', content: codeOf(160) }];
    const quote = await (await srv.post({ files }, {}, '/quote')).json();
    assert.deepEqual(quote.project, { label: '2 uploaded .ak file(s)', files: 2, lines: 165, size: 'medium' });
    const body = { tier: 'see', method: 'escrow', files };
    const { accepted, header } = await quoteAndPay(srv, body);
    assert.equal(accepted.amount, '10000000');
    const job = await readJob(await srv.post(body, { 'PAYMENT-SIGNATURE': header }));
    assert.equal(job.ok, true);
    const { workspace } = srv.calls.auditArgs[0];
    assert.equal(readFileSync(join(workspace.root, 'validators/vault.ak'), 'utf8'), CODE);
    assert.equal(readFileSync(join(workspace.root, 'lib/vault/math.ak'), 'utf8'), codeOf(160));
    assert.equal(existsSync(join(workspace.root, 'validators/contract.ak')), false);
  } finally { await srv.stop(); }
});

// ---------- buyer helpers ----------

test('the buyer reads the overall risk and findings from a real report', () => {
  const report = renderReport({ tier: 'see', label: 'x', inputHash: 'h', model: 'm', date: 'd', files: [{ path: 'validators/a.ak', content: CODE }],
    check: { ok: true, warnings: 0, passed: 0, tests: 0 }, fix: null, proof: 'proof',
    review: { overall_risk: 'High', contract_purpose: 'p', summary: 's', checked_patterns: [], design_observations: [], findings: [
      { severity: 'Low', title: 'Missing doc', location: 'a.ak:1', pattern_id: null, pattern: 'p', description: 'd', impact: 'i', recommendation: 'r' },
      { severity: 'High', title: 'Anyone | can claim', location: 'a.ak:2', pattern_id: 3, pattern: 'p', description: 'd', impact: 'i', recommendation: 'r' },
    ] } });
  assert.deepEqual(reportSummary(report), { overallRisk: 'High',
    findings: [{ severity: 'High', title: 'Anyone | can claim' }, { severity: 'Low', title: 'Missing doc' }] });
  assert.deepEqual(reportSummary('not a report'), { overallRisk: null, findings: [] });
});

test('the buyer sends a local Aiken folder as files and refuses links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x402-project-'));
  writeFileSync(join(dir, 'aiken.toml'), 'name = "a/b"\n');
  for (const sub of ['validators', 'lib/demo', 'build/packages', '.git']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'validators/a.ak'), CODE);
  writeFileSync(join(dir, 'validators/notes.md'), 'not code');
  writeFileSync(join(dir, 'lib/demo/util.ak'), 'pub fn f() { 1 }\n');
  writeFileSync(join(dir, 'build/packages/dep.ak'), 'ignored');
  assert.deepEqual(readAikenFolder(dir).map((f) => f.path), ['validators/a.ak', 'lib/demo/util.ak']);
  const demo = readAikenFolder(new URL('../demo', import.meta.url).pathname);
  assert.deepEqual(demo.map((f) => f.path), ['validators/marketplace.ak', 'validators/vesting.ak']);
  assert.throws(() => readAikenFolder(mkdtempSync(join(tmpdir(), 'x402-empty-'))), /aiken\.toml/);
  const outside = join(mkdtempSync(join(tmpdir(), 'x402-secret-')), 'key.ak');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(dir, 'validators/b.ak'));
  assert.throws(() => readAikenFolder(dir), /symbolic link/);
});

test('escrow over x402 is off unless X402_ESCROW_ENABLED is true', async () => {
  const core = await import('../src/x402/core.mjs');
  const saved = process.env.X402_ESCROW_ENABLED;
  try {
    delete process.env.X402_ESCROW_ENABLED;
    const options = core.quoteOptions('small', { native: 'addr_test1native', escrow: 'addr_test1escrow' });
    assert.ok(options.length > 0 && options.every((o) => o.method === 'native'));
    assert.throws(() => core.parseAuditRequest({ tier: 'see', method: 'escrow', code: 'validator v { spend(_d, _r, _o, _t) { True } }' }),
      (e) => e.code === 'method_not_offered');
  } finally {
    if (saved === undefined) delete process.env.X402_ESCROW_ENABLED; else process.env.X402_ESCROW_ENABLED = saved;
  }
});
