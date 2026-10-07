// MARS Agent worker. For each Sokosumi Task it: takes payment through Masumi escrow,
// runs the audit, submits the report hash on-chain, and completes the Task.
// Every external write is journaled first, so a restart never repeats a payment step.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskInput } from './engine/input.mjs';
import { inspectContract, runAudit } from './engine/index.mjs';
import { renderReport } from './engine/report.mjs';
import { MODEL } from './engine/review.mjs';
import { buildMasumiPaymentEvent, createCoreClient, loadSokosumiRuntime } from './payment/core.mjs';
import { isFundsLockedConfirmed, isResultAccepted, isWithdrawn, resultDeadlinePassed, withdrawalTxHash } from './payment/flow.mjs';
import { hashPaymentResult } from './payment/hash.mjs';
import { buildPaymentPlan, createMpsClient, validateQuote } from './payment/mps.mjs';
import { quote as priceJob, quoteMessage } from './payment/pricing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = resolve(here, '../.local');
const TASKS = join(LOCAL, 'tasks');
const COWORKER_ID = process.env.COWORKER_ID || '01a11491-b02f-73f8-9d71-61aa920973a5';
const PAID = process.env.PAID_TASKS_ENABLED === 'true';
const POLL_MS = Number(process.env.POLL_MS || 10_000);
const SCAN = 'https://preprod.cardanoscan.io/transaction/';
mkdirSync(TASKS, { recursive: true, mode: 0o700 });

const registration = PAID ? JSON.parse(readFileSync(join(LOCAL, 'registration.json'), 'utf8')) : null;
const mps = PAID ? createMpsClient({ baseUrl: process.env.MPS_URL, token: process.env.MPS_TOKEN }) : null;
const core = PAID ? await createCoreClient(COWORKER_ID) : null;

const { readRuntimeCredential } = await loadSokosumiRuntime();
const runtimeRoot = join(dirname(execFileSync('sokosumi', ['skills', 'path'], { encoding: 'utf8' }).trim()), 'dist', 'src');
const { createCoworkerHttpClient } = await import(join(runtimeRoot, 'api/http-client.js'));
const { fetchTasks } = await import(join(runtimeRoot, 'api/services/task-service.js'));
const coworkerHttp = createCoworkerHttpClient({ apiKey: readRuntimeCredential(COWORKER_ID) });

const statePath = (id) => join(TASKS, `${id}.json`);
const load = (id) => (existsSync(statePath(id)) ? JSON.parse(readFileSync(statePath(id), 'utf8')) : null);
const save = (id, state) => writeFileSync(statePath(id), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const log = (id, msg) => console.log(`${new Date().toISOString()} ${id.slice(0, 8)} ${msg}`);

function cli(args) {
  return JSON.parse(execFileSync('sokosumi', ['--preprod', ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }));
}
const scope = (task) => (task.organizationId ? ['--organization-id', task.organizationId] : ['--personal']);

function complete(id, state, text) {
  const file = join(TASKS, `${id}.result.md`);
  writeFileSync(file, text, { mode: 0o600 });
  save(id, { ...state, phase: 'complete-pending' });
  const done = cli(['runtime', 'complete', id, '--coworker-id', COWORKER_ID, '--result-file', file, ...scope(state.task)]);
  save(id, { ...state, phase: 'completed', completionEventId: done.eventId ?? null, completedAt: new Date().toISOString() });
  log(id, 'completed');
}

function proofSection(state) {
  if (!state.payment) return null;
  const p = state.payment;
  const amount = Number(state.plan.amount) / 1e6;
  return [
    `- **Payment:** ${amount} test USDM, locked in the Masumi escrow contract on Cardano Preprod.`,
    `- **Escrow transaction:** [${p.escrowTxHash.slice(0, 16)}…](${SCAN}${p.escrowTxHash})`,
    `- **Seller agent:** MARS Agent, registered on-chain in [${registration.registrationTxHash.slice(0, 16)}…](${SCAN}${registration.registrationTxHash})`,
    `- **Purchase nonce:** \`${p.nonce}\` · **Task input hash:** \`${p.inputHash}\``,
    '- **Report hash:** the seller submits the hash of this exact report to the escrow. Only then can it collect the payment, so the report cannot change after delivery.',
    `- **Check it yourself:** save this report as \`report.md\`, then run \`node -e 'const t=require("fs").readFileSync("report.md","utf8");console.log(require("crypto").createHash("sha256").update("${p.nonce};"+JSON.stringify(t).slice(1,-1)).digest("hex"))'\` and compare it with the result hash in your Sokosumi task receipt.`,
  ].join('\n');
}

const running = new Set();
const commentChains = new Map();

// Posts a short progress comment to the buyer's task.
function notify(id, text) {
  const next = (commentChains.get(id) ?? Promise.resolve())
    .then(() => coworkerHttp.post(`/v1/tasks/${id}/events`, { comment: text }, AbortSignal.timeout(20_000)))
    .catch((error) => log(id, `progress comment failed: ${String(error.message).slice(0, 120)}`));
  commentChains.set(id, next);
  return next;
}

const PROGRESS = [
  [/^Running aiken check/, () => '🔨 Building your contract with `aiken check`…'],
  [/^Build: /, (m) => `🔨 ${m.replace('Build: ', 'Build done: ')}.`],
  [/^Reviewing /, (m) => `🔍 ${m.replace('Reviewing', 'Checking')}…`],
  [/^Writing a fix/, (m) => `✍️ ${m}…`],
];

async function startTask(task) {
  const id = task.id;
  save(id, { phase: 'starting' });
  const started = cli(['runtime', 'start', id, '--coworker-id', COWORKER_ID, ...scope(task)]);
  const info = { id, name: started.name, description: started.description ?? null, organizationId: task.organizationId ?? null };
  let parsed;
  try {
    parsed = parseTaskInput(`${info.name}\n${info.description ?? ''}`);
  } catch (error) {
    save(id, { phase: 'started', task: info });
    complete(id, load(id), `# MARS Agent: no audit started\n\n${error.message}\n\nNo payment was taken. Create a new task with the contract and a tier line, for example \`tier: see\`.\n`);
    return;
  }
  let inspection;
  try {
    const { workspace, files } = await inspectContract({ source: parsed.source, jobId: id });
    inspection = { workspace, price: priceJob({ tier: parsed.tier, files }) };
  } catch (error) {
    save(id, { phase: 'started', task: info });
    complete(id, load(id), `# MARS Agent: no audit started\n\n${error.message}\n\nNo payment was taken.\n`);
    return;
  }
  save(id, { phase: 'started', task: info, tier: parsed.tier, source: parsed.source, ...inspection });
  log(id, `started, tier ${parsed.tier}, ${parsed.source.kind}, ${inspection.price.lines} lines -> ${inspection.price.usdm} USDM`);
}

async function requestPayment(id, state) {
  const plan = buildPaymentPlan({ task: { taskId: id, name: state.task.name, description: state.task.description }, registration, tier: state.tier, amount: state.price.amount });
  save(id, { ...state, phase: 'quote-pending', plan });
  // A clear rejection (not an unknown outcome) means no money moved: close the Task.
  const noCharge = (error) => {
    if (error.uncertain) throw error;
    log(id, `payment not set up: ${error.message}`);
    complete(id, load(id), `# MARS Agent: payment could not be set up\n\n${error.message}\n\nNo payment was taken. Please try again later.\n`);
  };
  let quote;
  try {
    quote = await mps.createPayment(plan);
    validateQuote(quote, registration, plan.amount, plan);
  } catch (error) { return noCharge(error); }
  const event = buildMasumiPaymentEvent(quote, registration, plan.identifierFromPurchaser);
  const next = { ...state, plan, quote, phase: 'event-pending' };
  save(id, next);
  let eventId;
  try { eventId = await core.postPaymentEvent(id, event, quoteMessage(state.tier, state.price)); } catch (error) { return noCharge(error); }
  save(id, { ...next, phase: 'awaiting-escrow', paymentEventId: eventId });
  log(id, `payment requested (${Number(plan.amount) / 1e6} USDM)`);
}

async function checkEscrow(id, state) {
  const resolved = await mps.resolve(state.quote.blockchainIdentifier, { smartContractAddress: registration.smartContractAddress });
  if (isFundsLockedConfirmed(resolved)) {
    const tx = resolved.CurrentTransaction?.newOnChainState === 'FundsLocked' ? resolved.CurrentTransaction
      : resolved.TransactionHistory.find((t) => t.newOnChainState === 'FundsLocked' && t.status === 'Confirmed');
    save(id, { ...state, phase: 'auditing', payment: { escrowTxHash: tx.txHash, nonce: state.plan.identifierFromPurchaser, inputHash: state.plan.inputHash } });
    log(id, `escrow locked ${tx.txHash}`);
    notify(id, `✅ Payment locked in Masumi escrow on Cardano: ${SCAN}${tx.txHash} — starting the audit.`);
  } else if (Date.now() > Number(state.quote.payByTime)) {
    complete(id, state, '# MARS Agent: payment did not arrive\n\nThe escrow was not funded before the payment deadline, so no audit ran and nothing was charged. Please create a new task.\n');
  }
}

async function audit(id, state) {
  if (state.quote && resultDeadlinePassed(state.quote)) throw new Error('The result deadline passed before the audit started.');
  const result = await runAudit({ tier: state.tier, source: state.source, jobId: id, workspace: state.workspace, buyerNotes: state.task.description ?? '', log: (m) => {
    log(id, m);
    const match = PROGRESS.find(([re]) => re.test(m));
    if (match) notify(id, match[1](m));
  } });
  const renderArgs = {
    tier: state.tier, label: result.workspace.label, inputHash: result.inputHash, model: MODEL, date: new Date().toISOString(),
    files: result.files, check: result.check, review: result.review, fix: result.fix,
  };
  const next = { ...load(id), renderArgs };
  if (state.tier === 'audit') {
    const draft = renderReport({ ...renderArgs, proof: proofSection(next) });
    writeFileSync(join(TASKS, `${id}.draft.md`), draft, { mode: 0o600 });
    save(id, { ...next, phase: 'review-pending' });
    log(id, 'draft ready: run `npm run review -- approve ' + id + '`');
  } else {
    save(id, { ...next, phase: 'report-ready' });
  }
}

function finalReport(id, state) {
  const approval = join(TASKS, `${id}.approved.json`);
  const humanReview = existsSync(approval) ? JSON.parse(readFileSync(approval, 'utf8')) : null;
  return renderReport({ ...state.renderArgs, humanReview, proof: proofSection(state) });
}

async function deliver(id, state) {
  const report = finalReport(id, state);
  if (!PAID) return complete(id, state, report);
  if (resultDeadlinePassed(state.quote)) throw new Error('The result deadline passed. The escrow will refund the buyer.');
  const resultHash = hashPaymentResult(state.payment.nonce, report);
  notify(id, '⛓️ Report ready. Writing its hash on Cardano, then I deliver it here…');
  writeFileSync(join(TASKS, `${id}.result.md`), report, { mode: 0o600 });
  save(id, { ...state, phase: 'submit-pending', resultHash });
  await mps.submitResult(state.quote.blockchainIdentifier, resultHash);
  save(id, { ...state, phase: 'result-submitted', resultHash });
  log(id, `result hash submitted ${resultHash.slice(0, 16)}…`);
}

async function confirmSubmitted(id, state) {
  const resolved = await mps.resolve(state.quote.blockchainIdentifier, { smartContractAddress: registration.smartContractAddress });
  if (isResultAccepted(resolved, state.resultHash)) complete(id, state, readFileSync(join(TASKS, `${id}.result.md`), 'utf8'));
}

async function trackSettlement(id, state) {
  if (Date.now() - Date.parse(state.lastSettlementCheck ?? 0) < 60_000) return;
  const resolved = await mps.resolve(state.quote.blockchainIdentifier, { smartContractAddress: registration.smartContractAddress });
  if (isWithdrawn(resolved)) {
    const receipt = await core.fetchReceipt(id).catch(() => null);
    save(id, { ...state, phase: 'settled', withdrawTxHash: withdrawalTxHash(resolved), receipt });
    log(id, `SETTLED: seller collected in ${withdrawalTxHash(resolved)}`);
  } else {
    save(id, { ...state, lastSettlementCheck: new Date().toISOString(), onChainState: resolved.onChainState });
  }
}

async function advance(id) {
  const state = load(id);
  if (!state || running.has(id)) return;
  const step = {
    started: () => (PAID ? requestPayment(id, state) : save(id, { ...state, phase: 'auditing' })),
    'awaiting-escrow': () => checkEscrow(id, state),
    auditing: () => {
      running.add(id);
      audit(id, state)
        .catch((error) => {
          log(id, `audit failed: ${error.message}`);
          const refund = state.quote
            ? 'No report hash was submitted, so the escrow refunds your payment automatically after the result deadline.'
            : 'No payment was taken.';
          complete(id, load(id), `# MARS Agent: the audit could not finish\n\n${error.message}\n\n${refund}\n`);
        })
        .finally(() => running.delete(id));
    },
    'review-pending': () => existsSync(join(TASKS, `${id}.approved.json`)) && deliver(id, state),
    'report-ready': () => deliver(id, state),
    'result-submitted': () => confirmSubmitted(id, state),
    completed: () => state.quote && trackSettlement(id, state),
  }[state.phase];
  if (step) await step();
  else if (state.phase.endsWith('-pending') || state.phase === 'starting') {
    if (!state.flagged) { log(id, `stopped in ${state.phase}: inspect before retrying`); save(id, { ...state, flagged: true }); }
  }
}

console.log(`MARS Agent worker: coworker ${COWORKER_ID}, paid tasks ${PAID ? 'ON' : 'OFF'}, model ${MODEL}`);
while (true) {
  try {
    const { tasks } = await fetchTasks(coworkerHttp, { coworkerId: COWORKER_ID, status: ['READY'] });
    for (const task of tasks) {
      if (task.coworkerId && task.coworkerId !== COWORKER_ID) continue;
      if (!load(task.id)) await startTask(task).catch((error) => log(task.id, `start failed: ${error.message}`));
    }
  } catch (error) {
    console.error('Task poll failed:', String(error.message).slice(0, 300));
  }
  for (const file of readdirSync(TASKS).filter((f) => /^[\w-]+\.json$/.test(f) && !f.includes('.approved'))) {
    const id = file.slice(0, -5);
    await advance(id).catch((error) => log(id, `step failed: ${String(error.message).slice(0, 300)}`));
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
