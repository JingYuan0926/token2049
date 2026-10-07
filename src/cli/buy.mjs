// Demo buyer agent: buys an Aiken audit over x402 and pays on Cardano Preprod (Masumi escrow).
//
//   node src/cli/buy.mjs --wallet-init                 create a new buyer wallet, print its address
//   node src/cli/buy.mjs --balance                     print the buyer balance (Blockfrost)
//   node src/cli/buy.mjs <contract.ak> --tier see      quote, pay, wait, save the report
//   node src/cli/buy.mjs <contract.ak> --dry-run       quote and verify only, no payment
//   node src/cli/buy.mjs --resume <job.json>           send a saved signed payment again (never pays twice)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MASUMI_MAX_DEADLINE_HORIZON_MS, USDM_PREPROD_ASSET, decodeCardanoTransaction, toClientCardanoSigner,
  verifyMasumiAuthorization } from '@x402/cardano';
import { ExactCardanoScheme as ExactCardanoClient } from '@x402/cardano/exact/client';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { BUYER_SPEND_CONTROLS, ESCROW_ADDRESS, MAX_SPEND_ATOMIC, NETWORK, SCAN_TX, USDM_ASSET, termsDigestOf, x402ResultHash } from '../x402/core.mjs';
import { createWalletFile, readWalletFile } from '../x402/wallet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WALLET = join(root, '.local/buyer-wallet.json');
const JOBS = join(root, '.local/buyer-jobs');
const BLOCKFROST = process.env.BLOCKFROST_PREPROD_URL || 'https://cardano-preprod.blockfrost.io/api/v0';
// Non-secret Preprod test project id, used when BLOCKFROST_PROJECT_ID is not set.
const BLOCKFROST_ID = process.env.BLOCKFROST_PROJECT_ID;
const MIN_LOVELACE = 5_000_000n;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'wallet-init': { type: 'boolean' }, balance: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    tier: { type: 'string', default: 'see' }, description: { type: 'string' }, github: { type: 'string' },
    server: { type: 'string', default: process.env.X402_SERVER_URL || 'http://127.0.0.1:3013' }, resume: { type: 'string' },
  },
});

const usdm = (/** @type {bigint | string} */ atomic) => `${Number(atomic) / 1e6} tUSDM`;
const ada = (/** @type {bigint} */ lovelace) => `${Number(lovelace) / 1e6} tADA`;
const fail = (/** @type {string} */ message) => { console.error(message); process.exit(1); };

/** @param {string} address */
async function balanceOf(address) {
  const res = await fetch(`${BLOCKFROST}/addresses/${address}`, { headers: { project_id: BLOCKFROST_ID }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return new Map();
  if (!res.ok) throw new Error(`Blockfrost answered HTTP ${res.status}`);
  const data = await res.json();
  return new Map(data.amount.map((/** @type {{unit: string, quantity: string}} */ a) => [a.unit, BigInt(a.quantity)]));
}

function printBalance(/** @type {string} */ address, /** @type {Map<string, bigint>} */ amounts) {
  const ours = amounts.get(USDM_ASSET.replace('.', '')) ?? 0n;
  const other = amounts.get(USDM_PREPROD_ASSET.replace('.', '')) ?? 0n;
  console.log(`Buyer ${address}`);
  console.log(`  ${ada(amounts.get('lovelace') ?? 0n)}`);
  console.log(`  ${usdm(ours)}  (unit ${USDM_ASSET}, the one this server charges)`);
  if (other) console.log(`  ${usdm(other)}  (unit ${USDM_PREPROD_ASSET}, a different test USDM that this server does not accept)`);
}

function signerFor(/** @type {unknown} */ body) {
  const { mnemonic } = readWalletFile(WALLET);
  return toClientCardanoSigner({
    mnemonic, network: NETWORK,
    provider: { blockfrost: { baseUrl: BLOCKFROST, projectId: BLOCKFROST_ID }, requestTimeoutMs: 30_000 },
    // The server does not echo our body, so the signer checks its digest against what we send.
    masumiRequestContent: { body },
  });
}

/** Sends the paid request and prints the outcome. @param {any} job journal record */
async function sendPaid(job, /** @type {string} */ journalPath) {
  console.log(`Sending the signed payment (tx ${job.txHash}). The server settles it, then runs the audit.`);
  const res = await fetch(new URL('/audit', job.server), {
    method: 'POST', body: job.bodyText,
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': job.paymentSignature },
  });
  const http = new x402HTTPClient(new x402Client());
  const settle = res.headers.get('payment-response') ? http.getPaymentSettleResponse((name) => res.headers.get(name)) : null;
  if (settle?.success) console.log(`Escrow locked: ${SCAN_TX}${settle.transaction}`);
  if (res.headers.get('x-audit-job')) console.log(`Job ${res.headers.get('x-audit-job')} (poll ${job.server}/jobs/<id> if this connection drops)`);
  const text = (await res.text()).trim();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: 'invalid_response', message: text.slice(0, 300) }; }
  writeFileSync(journalPath, `${JSON.stringify({ ...job, lastStatus: res.status, lastResponse: { ...data, report: undefined } }, null, 2)}\n`, { mode: 0o600 });

  if (res.status !== 200 || !data.report) {
    console.error(`No report. HTTP ${res.status}: ${data.error ?? ''} ${data.message ?? data.error ?? ''}`.trim());
    if (settle?.errorReason === 'settlement_pending' || data.error === 'settlement_pending' || data.error === 'in_progress')
      console.error(`Do not pay again. Later run: node src/cli/buy.mjs --resume ${journalPath}`);
    if (data.refund) console.error(data.refund);
    process.exit(1);
  }
  const reportPath = journalPath.replace(/\.json$/, '.report.md');
  writeFileSync(reportPath, data.report, { mode: 0o600 });
  const mine = x402ResultHash(data.buyerNonce ?? '', data.report);
  console.log(`Report: ${reportPath}`);
  console.log(`Escrow transaction: ${data.escrowTx?.url ?? 'unknown'}`);
  console.log(`Result hash: ${data.resultHash} (${mine === data.resultHash ? 'matches the report' : `MISMATCH, local ${mine}`})`);
  console.log(`Result hash on chain: ${data.resultSubmission?.status === 'accepted' ? 'submitted by the seller' : `no (${data.resultSubmission?.reason ?? data.resultSubmission?.status ?? 'unknown'})`}`);
  if (data.refund) console.log(data.refund);
}

async function buy() {
  const file = positionals[0];
  if (!file && !opts.github) fail('Usage: node src/cli/buy.mjs <contract.ak> [--tier see|write] [--description text] [--dry-run]');
  const body = { tier: opts.tier, ...(opts.github ? { github: opts.github } : { code: readFileSync(file, 'utf8') }),
    ...(opts.description ? { description: opts.description } : {}) };
  const bodyText = JSON.stringify(body);
  const url = new URL('/audit', opts.server);

  // 1. Ask for a quote.
  const quote = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyText });
  const quoteBody = await quote.json().catch(() => ({}));
  if (quote.status !== 402) fail(`Expected HTTP 402, got ${quote.status}: ${quoteBody.message ?? quoteBody.error ?? ''}`);
  const http = new x402HTTPClient(new x402Client());
  const required = http.getPaymentRequiredResponse((name) => quote.headers.get(name), quoteBody);
  const offer = required.accepts.find((r) => r.network === NETWORK && r.extra?.assetTransferMethod === 'masumi');
  if (!offer) fail('The server offered no Masumi payment on Cardano Preprod.');
  if (offer.payTo !== ESCROW_ADDRESS || offer.asset !== USDM_ASSET || BigInt(offer.amount) > BigInt(MAX_SPEND_ATOMIC))
    fail(`Refused: unexpected escrow, asset or price (${offer.payTo}, ${offer.asset}, ${offer.amount}).`);

  // 2. Check the seller-signed terms, the same way the signer does before it signs.
  const check = await verifyMasumiAuthorization(/** @type {any} */ (offer.extra), offer,
    { localCommitmentContent: { body }, requireAllPartContent: true, maxDeadlineHorizonMs: MASUMI_MAX_DEADLINE_HORIZON_MS });
  if (!check.ok) fail(`Refused: the quote does not verify (${check.reason}: ${check.detail ?? ''}).`);
  const terms = /** @type {any} */ (offer.extra).terms;
  const at = (/** @type {string} */ ms) => new Date(Number(ms)).toISOString();
  console.log(`Quote: ${usdm(offer.amount)} for tier "${body.tier}", locked in Masumi escrow ${offer.payTo}`);
  console.log(`  seller ${terms.sellerAddress}`);
  console.log(`  pay by ${at(terms.payByTime)} · result due ${at(terms.submitResultTime)} · unlock ${at(terms.unlockTime)}`);
  console.log(`  seller signature and request commitment verified (terms digest ${check.termsDigest.slice(0, 16)}…)`);
  if (opts['dry-run']) { console.log('Dry run: no payment made.'); return; }

  // 3. Check funds, then build and sign the lock. The signer never broadcasts.
  const signer = signerFor(body);
  const amounts = await balanceOf(signer.getAddress());
  if ((amounts.get(USDM_ASSET.replace('.', '')) ?? 0n) < BigInt(offer.amount) || (amounts.get('lovelace') ?? 0n) < MIN_LOVELACE) {
    printBalance(signer.getAddress(), amounts);
    fail(`Not enough funds. Need ${usdm(offer.amount)} and about ${ada(MIN_LOVELACE)}. No payment made.`);
  }
  const client = new x402Client()
    .register(NETWORK, new ExactCardanoClient(signer))
    .setSpendControls(BUYER_SPEND_CONTROLS)
    .registerPolicy((_version, reqs) => reqs.filter((r) => r.network === NETWORK && r.payTo === ESCROW_ADDRESS
      && r.asset === USDM_ASSET && r.extra?.assetTransferMethod === 'masumi'));
  const paid = new x402HTTPClient(client);
  const payload = await paid.createPaymentPayload({ ...required, accepts: [offer] });
  const paymentSignature = paid.encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE'];
  if (!paymentSignature) fail('The x402 client did not produce a PAYMENT-SIGNATURE header.');
  const digest = termsDigestOf(payload.accepted);
  const txHash = decodeCardanoTransaction(/** @type {string} */ (payload.payload.transaction)).txHash;

  // 4. Save the signed payment before sending it, so a crash can resend it instead of paying twice.
  mkdirSync(JOBS, { recursive: true, mode: 0o700 });
  const journalPath = join(JOBS, `${digest}.json`);
  const job = { createdAt: new Date().toISOString(), server: opts.server, tier: body.tier, bodyText, paymentSignature, txHash,
    termsDigest: digest, blockchainIdentifier: /** @type {any} */ (offer.extra).blockchainIdentifier };
  writeFileSync(journalPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await sendPaid(job, journalPath);
}

async function main() {
  if (opts['wallet-init']) {
    const { address } = createWalletFile(WALLET);
    console.log(`Buyer address (Preprod): ${address}`);
    console.log(`Mnemonic saved to ${WALLET} (mode 600). It is not printed.`);
    console.log('Fund it with tADA: https://docs.cardano.org/cardano-testnets/tools/faucet/');
    console.log(`Fund it with tUSDM: https://tusdm.moneta.global (this server charges unit ${USDM_ASSET})`);
    return;
  }
  if (opts.balance) {
    const { address } = readWalletFile(WALLET);
    printBalance(address, await balanceOf(address));
    return;
  }
  if (opts.resume) {
    const journalPath = resolve(opts.resume);
    if (!existsSync(journalPath)) fail(`No such job file: ${journalPath}`);
    await sendPaid(JSON.parse(readFileSync(journalPath, 'utf8')), journalPath);
    return;
  }
  await buy();
}

main().catch((error) => fail(`buy failed: ${String(error?.message ?? error).slice(0, 500)}`));
