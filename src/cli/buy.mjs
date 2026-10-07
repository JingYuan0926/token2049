// Demo buyer agent: buys an Aiken audit over x402 and pays in tADA on Cardano Preprod.
//
//   node src/cli/buy.mjs --wallet-init                                   create a buyer wallet, print its address
//   node src/cli/buy.mjs --balance                                       print the buyer balance (Blockfrost)
//   node src/cli/buy.mjs <target> --quote                                price options as JSON, no payment
//   node src/cli/buy.mjs <target> --tier see --method native --yes       pay, wait, save the report
//   node src/cli/buy.mjs <target> --tier see --method escrow --dry-run   check the 402 only, no payment
//   node src/cli/buy.mjs --resume <job.json>                             send a saved signed payment again (never pays twice)
//
// <target> is a .ak file, an Aiken project folder, or a https://github.com link.
// --price <tADA> makes the payment refuse any other price (the price the user approved).
// --quote and the paying commands print one JSON line on stdout. Progress goes to stderr.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MASUMI_MAX_DEADLINE_HORIZON_MS, decodeCardanoTransaction, toClientCardanoSigner, verifyMasumiAuthorization } from '@x402/cardano';
import { ExactCardanoScheme as ExactCardanoClient } from '@x402/cardano/exact/client';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { BUYER_SPEND_CONTROLS, ESCROW_ADDRESS, LOVELACE, MAX_SPEND_ATOMIC, NETWORK, SCAN_TX, USDM_ASSET, quoteProblem,
  readAikenFolder, reportSummary, termsDigestOf, transferMethodOf, x402Offer, x402ResultHash } from '../x402/core.mjs';
import { createWalletFile, readWalletFile } from '../x402/wallet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WALLET = join(root, '.local/buyer-wallet.json');
const JOBS = join(root, '.local/buyer-jobs');
const BLOCKFROST = process.env.BLOCKFROST_PREPROD_URL || 'https://cardano-preprod.blockfrost.io/api/v0';
// The Blockfrost Preprod project id comes from .env (BLOCKFROST_PROJECT_ID).
const BLOCKFROST_ID = process.env.BLOCKFROST_PROJECT_ID;
// Room for the network fee, the change output and, for escrow, the refundable lock deposit.
const FEE_MARGIN = 5_000_000n;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'wallet-init': { type: 'boolean' }, balance: { type: 'boolean' }, quote: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' }, tier: { type: 'string' }, method: { type: 'string' }, price: { type: 'string' },
    description: { type: 'string' }, github: { type: 'string' }, resume: { type: 'string' },
    server: { type: 'string', default: process.env.X402_SERVER_URL || 'http://127.0.0.1:3013' },
  },
});

const ada = (/** @type {bigint | string} */ lovelace) => `${Number(lovelace) / 1e6} tADA`;
const progress = (/** @type {string} */ line) => console.error(line);
const iso = (/** @type {string | undefined} */ ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** Prints the one JSON result line and stops. @param {Record<string, unknown>} result @param {number} [code] */
function finish(result, code = result.ok ? 0 : 1) {
  console.log(JSON.stringify(result));
  process.exit(code);
}
const fail = (/** @type {string} */ error, /** @type {string} */ message, extra = {}) => finish({ ok: false, error, message, ...extra });

/** @param {string} address */
async function balanceOf(address) {
  const res = await fetch(`${BLOCKFROST}/addresses/${address}`, { headers: { project_id: BLOCKFROST_ID ?? '' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return new Map();
  if (!res.ok) throw new Error(`Blockfrost answered HTTP ${res.status}`);
  const data = await res.json();
  return new Map(data.amount.map((/** @type {{unit: string, quantity: string}} */ a) => [a.unit, BigInt(a.quantity)]));
}

/** The request source for a target: a GitHub link, an Aiken project folder, or one .ak file. @param {string} target */
function sourceOf(target) {
  if (/^https:\/\//.test(target)) return { body: { github: target }, target: { kind: 'github', url: target } };
  const path = resolve(target);
  if (!existsSync(path)) fail('target_not_found', `No such file or folder: ${path}`);
  if (statSync(path).isDirectory()) {
    const files = readAikenFolder(path);
    return { body: { files }, target: { kind: 'folder', path, files: files.map((f) => f.path) } };
  }
  return { body: { code: readFileSync(path, 'utf8') }, target: { kind: 'file', path } };
}

/** @param {string} path @param {unknown} body @param {Record<string, string>} [headers] @param {string} [server] */
function post(path, body, headers = {}, server = opts.server) {
  return fetch(new URL(path, server), { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers } });
}

async function readJsonResponse(/** @type {Response} */ res) {
  const text = (await res.text()).trim();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: 'invalid_response', message: text.slice(0, 300) }; }
}

function signerFor(/** @type {unknown} */ body, /** @type {string} */ method) {
  const { mnemonic } = readWalletFile(WALLET);
  return toClientCardanoSigner({
    mnemonic, network: NETWORK,
    provider: { blockfrost: { baseUrl: BLOCKFROST, projectId: BLOCKFROST_ID ?? '' }, requestTimeoutMs: 30_000 },
    // The server does not echo our body, so the signer checks its digest against what we send.
    ...(method === 'escrow' ? { masumiRequestContent: { body } } : {}),
  });
}

/** Sends the paid request, saves the report and prints the result line. @param {any} job journal record @param {string} journalPath */
async function sendPaid(job, journalPath) {
  progress(`Sending the signed payment (tx ${job.txHash}). The server settles it, then runs the audit.`);
  const res = await post('/audit', job.bodyText, { 'PAYMENT-SIGNATURE': job.paymentSignature }, job.server);
  const http = new x402HTTPClient(new x402Client());
  const settle = res.headers.get('payment-response') ? http.getPaymentSettleResponse((name) => res.headers.get(name)) : null;
  if (settle?.success) progress(`Payment on chain: ${SCAN_TX}${settle.transaction}`);
  if (res.headers.get('x-audit-job')) progress(`Job ${res.headers.get('x-audit-job')} (poll ${job.server}/jobs/<id> if this connection drops)`);
  const data = await readJsonResponse(res);
  writeFileSync(journalPath, `${JSON.stringify({ ...job, lastStatus: res.status, lastResponse: { ...data, report: undefined } }, null, 2)}\n`, { mode: 0o600 });

  const base = { method: job.method, tier: job.tier, priceTada: job.priceTada, paymentTx: job.txHash, paymentTxUrl: `${SCAN_TX}${job.txHash}`, journal: journalPath };
  if (res.status !== 200 || !data.report) {
    // Any failure except a final one may hide a payment on chain. Resending the same signature never pays twice.
    const final = data.error === 'payment_failed';
    fail(data.error ?? `http_${res.status}`, `No report. HTTP ${res.status}: ${data.message ?? data.error ?? ''}`.trim(), {
      ...base, httpStatus: res.status, jobId: data.jobId ?? res.headers.get('x-audit-job') ?? null,
      ...(final ? {} : { doNotPayAgain: true, resume: `npm run buy --silent -- --resume ${journalPath}` }),
      ...(data.refund ? { refund: data.refund } : {}),
    });
  }
  const reportPath = journalPath.replace(/\.json$/, '.md');
  writeFileSync(reportPath, data.report, { mode: 0o600 });
  // Hash with the buyer nonce we signed, not the one the server reports.
  let signedNonce = '';
  try { signedNonce = JSON.parse(Buffer.from(job.paymentSignature, 'base64').toString('utf8')).accepted.extra?.terms?.buyerNonce ?? ''; } catch { /* keep '' */ }
  const resultHash = x402ResultHash(signedNonce, data.report);
  const resultTx = data.resultTx?.hash ?? null;
  const { overallRisk, findings } = reportSummary(data.report);
  finish({
    ok: true, ...base, jobId: data.jobId, size: data.size ?? job.size, reportPath, resultHash,
    ...(resultHash === data.resultHash ? {} : { serverResultHash: data.resultHash, warning: 'The server result hash differs from the report.' }),
    ...(data.paymentTx?.hash && data.paymentTx.hash !== job.txHash ? { warning: `The server reports payment ${data.paymentTx.hash}.` } : {}),
    ...(resultTx ? { resultTx, resultTxUrl: `${SCAN_TX}${resultTx}` } : {}),
    ...(job.method === 'escrow' ? { escrow: {
      blockchainIdentifier: job.blockchainIdentifier, submitResultTime: iso(job.submitResultTime), unlockTime: iso(job.unlockTime),
      resultOnChain: data.resultSubmission?.status === 'accepted',
      ...(data.resultSubmission?.status === 'accepted' ? {} : { resultNote: data.resultSubmission?.reason ?? data.resultSubmission?.status ?? 'unknown' }),
    } } : {}),
    findings, overallRisk,
  });
}

async function quote() {
  const target = positionals[0] ?? opts.github;
  if (!target) fail('usage', 'Usage: node src/cli/buy.mjs <file.ak | folder | https://github.com/...> --quote');
  const { body, target: info } = sourceOf(/** @type {string} */ (target));
  const res = await post('/quote', { ...body, ...(opts.description ? { description: opts.description } : {}) });
  const data = await readJsonResponse(res);
  if (res.status !== 200) fail(data.error ?? `http_${res.status}`, data.message ?? `The server answered HTTP ${res.status}.`);
  finish({ ok: true, target: info, ...data });
}

async function buy() {
  const target = positionals[0] ?? opts.github;
  const { tier, method } = opts;
  if (!target || !tier || !method) fail('usage', 'Usage: node src/cli/buy.mjs <target> --tier see|write --method native|escrow --yes');
  const { body: source } = sourceOf(/** @type {string} */ (target));
  const body = { tier, method, ...source, ...(opts.description ? { description: opts.description } : {}) };
  const bodyText = JSON.stringify(body);

  // 1. The price options. The 402 must match the chosen option exactly.
  const quoteRes = await post('/quote', { ...source, ...(opts.description ? { description: opts.description } : {}) });
  const quoted = await readJsonResponse(quoteRes);
  if (quoteRes.status !== 200) fail(quoted.error ?? `http_${quoteRes.status}`, quoted.message ?? `POST /quote answered HTTP ${quoteRes.status}.`);
  const option = quoted.options?.find((/** @type {any} */ o) => o.tier === tier && o.method === method);
  if (!option) fail('option_not_offered', `The server does not offer ${tier} with ${method} payment now. Nothing was paid.`);
  let offer;
  try { offer = x402Offer(/** @type {string} */ (tier), { size: quoted.project?.size, method }); } catch (error) {
    fail('invalid_option', String(/** @type {any} */ (error).message));
  }
  offer = /** @type {ReturnType<typeof x402Offer>} */ (offer);
  if (option.amount !== offer.amount || option.asset !== LOVELACE)
    fail('price_table_mismatch', `The server price (${option.priceTada} tADA) differs from the published table (${offer.priceTada} tADA). Nothing was paid.`);
  if (opts.price !== undefined && Number(opts.price) !== offer.priceTada)
    fail('price_changed', `The price is now ${offer.priceTada} tADA, not ${opts.price} tADA. Nothing was paid.`, { priceTada: offer.priceTada });
  if (BigInt(offer.amount) > BigInt(MAX_SPEND_ATOMIC)) fail('over_spend_cap', `${offer.priceTada} tADA is over the 50 tADA cap. Nothing was paid.`);
  if (method === 'escrow' && option.payTo !== ESCROW_ADDRESS) fail('unexpected_payee', 'The escrow option does not pay the Masumi V2 escrow. Nothing was paid.');

  // 2. The 402 for that option.
  const res = await post('/audit', bodyText);
  const unpaid = await readJsonResponse(res);
  if (res.status !== 402) fail(unpaid.error ?? `http_${res.status}`, `Expected HTTP 402, got ${res.status}: ${unpaid.message ?? unpaid.error ?? ''}`);
  const http = new x402HTTPClient(new x402Client());
  const required = http.getPaymentRequiredResponse((name) => res.headers.get(name), unpaid);
  const accepts = required.accepts.filter((r) => r.network === NETWORK && transferMethodOf(r) === offer.transferMethod);
  if (accepts.length !== 1) fail('unexpected_quote', `Expected one ${method} payment option on ${NETWORK}, got ${accepts.length}. Nothing was paid.`);
  const accepted = accepts[0];
  const terms = /** @type {any} */ (accepted.extra)?.terms;
  const problem = quoteProblem(accepted, offer, method === 'escrow' ? { sellerAddress: terms?.sellerAddress } : { payTo: option.payTo });
  if (problem) fail('quote_mismatch', `The 402 does not match the ${tier} ${method} option (${problem}). Nothing was paid.`);
  if (method === 'escrow') {
    // Check the seller-signed terms, the same way the signer does before it signs.
    const check = await verifyMasumiAuthorization(/** @type {any} */ (accepted.extra), accepted,
      { localCommitmentContent: { body }, requireAllPartContent: true, maxDeadlineHorizonMs: MASUMI_MAX_DEADLINE_HORIZON_MS });
    if (!check.ok) fail('quote_not_verified', `The quote does not verify (${check.reason}: ${check.detail ?? ''}). Nothing was paid.`);
  }
  const summary = { method, tier, size: quoted.project.size, priceTada: offer.priceTada, payTo: accepted.payTo,
    ...(method === 'escrow' ? { escrow: { blockchainIdentifier: /** @type {any} */ (accepted.extra).blockchainIdentifier,
      submitResultTime: iso(terms.submitResultTime), unlockTime: iso(terms.unlockTime) } } : {}) };
  progress(`Quote: ${offer.priceTada} tADA, tier ${tier}, ${method} payment to ${accepted.payTo}`);
  if (opts['dry-run']) finish({ ok: true, dryRun: true, ...summary, message: 'The 402 matches the option. No payment made.' });
  if (!opts.yes) finish({ ok: false, error: 'not_confirmed', ...summary, message: 'Add --yes to pay. Nothing was paid.' });

  // 3. Check funds, then build and sign the payment. The signer never broadcasts.
  const signer = signerFor(body, /** @type {string} */ (method));
  const lovelace = (await balanceOf(signer.getAddress())).get(LOVELACE) ?? 0n;
  if (lovelace < BigInt(offer.amount) + FEE_MARGIN)
    fail('insufficient_funds', `The buyer has ${ada(lovelace)}. It needs about ${ada(BigInt(offer.amount) + FEE_MARGIN)}. No payment made.`,
      { address: signer.getAddress() });
  const client = new x402Client()
    .register(NETWORK, new ExactCardanoClient(signer))
    .setSpendControls(BUYER_SPEND_CONTROLS)
    .registerPolicy((_version, reqs) => reqs.filter((r) => r.network === NETWORK && r.payTo === accepted.payTo && r.asset === LOVELACE
      && r.amount === offer.amount && transferMethodOf(r) === offer.transferMethod));
  const paid = new x402HTTPClient(client);
  const payload = await paid.createPaymentPayload({ ...required, accepts: [accepted] });
  const paymentSignature = paid.encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE'];
  if (!paymentSignature) fail('no_signature', 'The x402 client did not produce a PAYMENT-SIGNATURE header. No payment made.');
  const txHash = decodeCardanoTransaction(/** @type {string} */ (payload.payload.transaction)).txHash.toLowerCase();
  const id = method === 'escrow' ? termsDigestOf(payload.accepted) : txHash;

  // 4. Save the signed payment before sending it, so a crash can resend it instead of paying twice.
  mkdirSync(JOBS, { recursive: true, mode: 0o700 });
  const journalPath = join(JOBS, `${id}.json`);
  const job = { createdAt: new Date().toISOString(), server: opts.server, bodyText, paymentSignature, txHash, ...summary,
    ...(method === 'escrow' ? { termsDigest: id, blockchainIdentifier: summary.escrow?.blockchainIdentifier,
      submitResultTime: terms.submitResultTime, unlockTime: terms.unlockTime } : {}) };
  writeFileSync(journalPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  progress(`Signed payment saved: ${journalPath}. If this run stops, resend it with --resume. Do not pay again.`);
  await sendPaid(job, journalPath);
}

async function main() {
  if (opts['wallet-init']) {
    const { address } = createWalletFile(WALLET);
    console.log(`Buyer address (Preprod): ${address}`);
    console.log(`Mnemonic saved to ${WALLET} (mode 600). It is not printed.`);
    console.log('Fund it with tADA: https://docs.cardano.org/cardano-testnets/tools/faucet/');
    return;
  }
  if (opts.balance) {
    const { address } = readWalletFile(WALLET);
    const amounts = await balanceOf(address);
    console.log(`Buyer ${address}`);
    console.log(`  ${ada(amounts.get(LOVELACE) ?? 0n)} (the x402 channel charges tADA)`);
    const usdm = amounts.get(USDM_ASSET.replace('.', ''));
    if (usdm) console.log(`  ${Number(usdm) / 1e6} tUSDM (not used by the x402 channel)`);
    return;
  }
  if (opts.resume) {
    const journalPath = resolve(opts.resume);
    if (!existsSync(journalPath)) fail('not_found', `No such job file: ${journalPath}`);
    await sendPaid(JSON.parse(readFileSync(journalPath, 'utf8')), journalPath);
    return;
  }
  if (opts.quote) return quote();
  await buy();
}

main().catch((error) => fail('buy_failed', `buy failed: ${String(error?.message ?? error).slice(0, 500)}`));
