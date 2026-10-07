import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, hashCanonicalInput, hashMip004Result, hashPaymentInput, hashPaymentResult, makeNonce,
  validateNonce } from '../src/payment/hash.mjs';
import { TIERS, USDM_PREPROD, deadlines, parseTier } from '../src/payment/tiers.mjs';
import { MpsError, buildPaymentPlan, createMpsClient, validateQuote, validateRegistration } from '../src/payment/mps.mjs';
import { buildMasumiPaymentEvent, createCoreClient, scopeCoreClient, validateReceipt } from '../src/payment/core.mjs';
import { canSubmitResult, isFundsLockedConfirmed, isResultAccepted, isResultSubmittedConfirmed, isWithdrawn,
  resultDeadlinePassed, withdrawalTxHash } from '../src/payment/flow.mjs';

const sha = (/** @type {string} */ s) => createHash('sha256').update(s, 'utf8').digest('hex');
const MIN = 60_000;
const NONCE = '01234567890123456789';
// Same fixtures as demo-agent-token2049 tests/payment.test.mjs.
const registration = { agentIdentifier: 'a'.repeat(56) + '01', policyId: 'a'.repeat(56),
  smartContractAddress: 'addr_test1wqqqqqq', sellerVkey: 'b'.repeat(56), sellerAddress: 'addr_test1qqqqqqq', supportedPaymentSourceIndex: 0 };
const task = { taskId: 'one', name: 'Tiny Eve', description: 'line\n"quote"' };
const TX = 'c'.repeat(64);

const plan = (tier = 'see') => buildPaymentPlan({ task, registration, tier });
function quote(p) {
  return { id: 'payment-one', blockchainIdentifier: 'signed-terms', agentIdentifier: registration.agentIdentifier,
    pricingType: 'Dynamic', inputHash: p.inputHash, payByTime: String(Date.parse(p.payByTime)),
    submitResultTime: String(Date.parse(p.submitResultTime)), unlockTime: String(Date.parse(p.unlockTime)),
    externalDisputeUnlockTime: String(Date.parse(p.externalDisputeUnlockTime)), sellerReturnAddress: null, buyerReturnAddress: null,
    forceLayer: null, RequestedFunds: [{ id: 'fund-1', amount: p.amount, unit: USDM_PREPROD }],
    SmartContractWallet: { id: 'wallet-1', walletVkey: registration.sellerVkey, walletAddress: registration.sellerAddress },
    PaymentSource: { id: 'source-1', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', policyId: registration.policyId,
      smartContractAddress: registration.smartContractAddress },
    onChainState: null, resultHash: '', NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null, resultHash: null },
    CurrentTransaction: null };
}
function locked(p) {
  return { ...quote(p), onChainState: 'FundsLocked',
    CurrentTransaction: { status: 'Confirmed', txHash: TX, confirmations: 1, newOnChainState: 'FundsLocked' } };
}

// ---------- hash.mjs ----------

test('docs/payment-hashing.md vectors: Core-compatible and MIP-004 result hashes', () => {
  // One real newline, two double quotes, one backslash: JSON "line\n\"next\"\\end".
  const result = 'line\n"next"\\end';
  assert.equal(result.length, 15);
  assert.equal(hashPaymentResult(NONCE, result), '36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3');
  assert.equal(hashMip004Result(NONCE, result), '7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd');
  assert.equal(hashPaymentResult(NONCE, result), sha(`${NONCE};line\\n\\"next\\"\\\\end`));
  assert.equal(hashMip004Result(NONCE, result), sha(`${NONCE};${result}`));
});

test('source vector: Core-compatible hash escapes the result after the nonce delimiter', () => {
  const result = 'hello\n"world"\\end';
  assert.equal(hashPaymentResult(NONCE, result), sha(`${NONCE};hello\\n\\\"world\\\"\\\\end`));
  assert.notEqual(hashPaymentResult(NONCE, result), sha(result));
  for (const text of ['hello\n"world"\\end', '😀\tline\r', 'plain text']) assert.equal(hashMip004Result(NONCE, text), sha(`${NONCE};${text}`));
  assert.equal(hashPaymentResult(NONCE, 'plain text'), hashMip004Result(NONCE, 'plain text'));
  assert.notEqual(hashMip004Result(NONCE, 'line\nnext'), hashPaymentResult(NONCE, 'line\nnext'));
  assert.throws(() => hashPaymentResult(NONCE, '\ud800'));
  assert.throws(() => hashMip004Result(NONCE, 42));
});

test('source vector: task input hash uses canonical JSON of taskId, name and description only', () => {
  const canonical = '{"description":"line\\n\\\"quote\\\"","name":"Tiny Eve","taskId":"one"}';
  assert.equal(hashPaymentInput(NONCE, task), sha(`${NONCE};${canonical}`));
  assert.equal(hashPaymentInput(NONCE, task), '4707734b3c0ca8d93d23cb78b98fd192e6156de632b29514fe9f7a76dc54f7c4');
  assert.equal(hashPaymentInput(NONCE, { ...task, extra: 'ignored' }), hashPaymentInput(NONCE, task));
  assert.notEqual(hashPaymentInput(NONCE, { ...task, description: null }), hashPaymentInput(NONCE, task));
  for (const bad of [{ ...task, taskId: '' }, { ...task, name: 1 }, { taskId: 'one', name: 'x' }]) assert.throws(() => hashPaymentInput(NONCE, bad));
});

test('source vector: canonical JSON sorts nested keys, keeps array order, rejects non-JSON input', () => {
  const value = { z: [true, -0, { b: '😀', a: null }], a: 1.5 };
  const canonical = '{"a":1.5,"z":[true,0,{"a":null,"b":"😀"}]}';
  assert.equal(canonicalJson(value), canonical);
  assert.equal(hashCanonicalInput(NONCE, value), sha(`${NONCE};${canonical}`));
  assert.equal(hashCanonicalInput(NONCE, value), '41484ba1a1dc03d89b84b3c15418c2eb9309a386646ffccdfa11980e0a049275');
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: '\ud800' }, { '\udc00': 1 }, new Date(), [undefined],
    Object.create(null), { a: 1n }, { a: () => 1 }, new Map()]) assert.throws(() => canonicalJson(bad));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle));
  const shared = { k: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
});

test('nonce validation and deterministic 20-hex nonce like the source plan', () => {
  for (const ok of ['0'.repeat(14), 'f'.repeat(26), NONCE]) assert.equal(validateNonce(ok), ok);
  for (const bad of ['0'.repeat(13), '0'.repeat(27), 'ABCDEF01234567', 'g'.repeat(20), 12345678901234567890, undefined])
    assert.throws(() => validateNonce(bad));
  assert.throws(() => hashPaymentResult('xyz', 'a'));
  const nonce = makeNonce(task, registration.agentIdentifier);
  // Equals createPaymentPlan(task, source).identifierFromPurchaser in the source.
  assert.equal(nonce, 'cefabaf92639a5124206');
  assert.match(nonce, /^[0-9a-f]{20}$/);
  assert.equal(makeNonce({ ...task, extra: 1 }, registration.agentIdentifier), nonce);
  assert.notEqual(makeNonce({ ...task, taskId: 'two' }, registration.agentIdentifier), nonce);
  assert.notEqual(makeNonce(task, 'b'.repeat(58)), nonce);
});

// ---------- tiers.mjs ----------

test('tiers carry the agreed amounts, submit windows and labels', () => {
  assert.equal(USDM_PREPROD, '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d');
  assert.deepEqual(TIERS, {
    see: { amount: '1000000', submitMinutes: 20, label: 'See' },
    write: { amount: '5000000', submitMinutes: 45, label: 'Write' },
    audit: { amount: '20000000', submitMinutes: 1440, label: 'Audit' } });
  assert.throws(() => { TIERS.see.amount = '1'; });
});

test('deadlines satisfy every MPS rule for every tier', () => {
  const now = 1_790_000_000_000;
  for (const [tier, { submitMinutes }] of Object.entries(TIERS)) {
    const d = deadlines(tier, now);
    for (const value of Object.values(d)) assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const pay = Date.parse(d.payByTime), submit = Date.parse(d.submitResultTime);
    const unlock = Date.parse(d.unlockTime), dispute = Date.parse(d.externalDisputeUnlockTime);
    assert.ok(pay <= submit - 5 * MIN, `${tier}: payBy <= submit - 5min`);
    assert.ok(pay >= now, `${tier}: payBy >= now`);
    assert.ok(submit >= now + 15 * MIN, `${tier}: submit >= now + 15min`);
    assert.ok(unlock >= submit + 15 * MIN, `${tier}: unlock >= submit + 15min`);
    assert.ok(dispute >= unlock + 15 * MIN, `${tier}: dispute >= unlock + 15min`);
    assert.equal(pay, now + 15 * MIN);
    assert.equal(submit, now + submitMinutes * MIN);
  }
  // "see" reproduces the source schedule: 15, 20, 36 and 52 minutes.
  const see = deadlines('see', new Date(now));
  assert.deepEqual([see.payByTime, see.submitResultTime, see.unlockTime, see.externalDisputeUnlockTime].map(v => (Date.parse(v) - now) / MIN), [15, 20, 36, 52]);
  assert.throws(() => deadlines('gold', now), /Unknown payment tier/);
  assert.throws(() => deadlines('toString', now), /Unknown payment tier/);
  assert.throws(() => deadlines('see', 0), /clock/);
  assert.throws(() => deadlines('see', NaN), /clock/);
});

test('parseTier finds whole words see, write or audit, case-insensitive, default see', () => {
  const cases = [
    ['Please AUDIT this validator', 'audit'], ['write a short report', 'write'], ['Can you see what this does?', 'see'],
    ['Audit.', 'audit'], ['(write)', 'write'], ['Write it up, then audit it', 'write'], ['tier: audit', 'audit'],
    ['auditor review', 'see'], ['rewrite this', 'see'], ['overseen', 'see'], ['', 'see'], ['no tier here', 'see'],
    [null, 'see'], [undefined, 'see'], [42, 'see'], ['line one\nAUDIT', 'audit'],
  ];
  for (const [text, want] of cases) assert.equal(parseTier(text), want, JSON.stringify(text));
});

// ---------- mps.mjs: plan and quote guards ----------

test('buildPaymentPlan binds tier amount, nonce, input hash and deadlines', () => {
  const now = Date.now();
  const p = buildPaymentPlan({ task, registration, tier: 'audit', now });
  assert.equal(p.amount, '20000000');
  assert.equal(p.unit, USDM_PREPROD);
  assert.equal(p.identifierFromPurchaser, makeNonce(task, registration.agentIdentifier));
  assert.equal(p.inputHash, hashPaymentInput(p.identifierFromPurchaser, task));
  assert.deepEqual({ payByTime: p.payByTime, submitResultTime: p.submitResultTime, unlockTime: p.unlockTime,
    externalDisputeUnlockTime: p.externalDisputeUnlockTime }, deadlines('audit', now));
  assert.equal(p.supportedPaymentSourceIndex, 0);
  assert.throws(() => buildPaymentPlan({ task, registration: { ...registration, policyId: 'c'.repeat(56) }, tier: 'see' }), /policy/);
  assert.throws(() => buildPaymentPlan({ task, registration: { ...registration, sellerAddress: 'addr1mainnet' }, tier: 'see' }));
  assert.throws(() => buildPaymentPlan({ task, registration, tier: 'gold' }));
  assert.deepEqual(validateRegistration(registration), registration);
});

test('validateQuote accepts a fresh signed quote and an absent forceLayer', () => {
  for (const tier of Object.keys(TIERS)) {
    const p = plan(tier), q = quote(p);
    assert.equal(validateQuote(q, registration, p.amount, p), q);
    assert.equal(validateQuote(q, registration, TIERS[tier].amount), q);
  }
  const p = plan(), { forceLayer, ...noForceLayer } = quote(p);
  assert.equal(forceLayer, null);
  assert.doesNotThrow(() => validateQuote(noForceLayer, registration, p.amount, p));
  assert.doesNotThrow(() => validateQuote({ ...quote(p), paymentForceLayer: null }, registration, p.amount, p));
  assert.doesNotThrow(() => validateQuote(locked(p), registration, p.amount, { ...p, fresh: false }));
  assert.doesNotThrow(() => validateQuote(quote(p), registration, p.amount, { payByTime: quote(p).payByTime }));
});

test('validateQuote rejects each funds, identity, deadline, override, layer and freshness change', () => {
  const p = plan(), q = quote(p);
  const changes = {
    'amount': [{ RequestedFunds: [{ amount: '2000000', unit: USDM_PREPROD }] }, /funds/],
    'unit': [{ RequestedFunds: [{ amount: p.amount, unit: '' }] }, /funds/],
    'two fund entries': [{ RequestedFunds: [{ amount: p.amount, unit: USDM_PREPROD }, { amount: '1', unit: '' }] }, /RequestedFunds/],
    'no fund entries': [{ RequestedFunds: [] }, /RequestedFunds/],
    'pricingType Fixed': [{ pricingType: 'Fixed' }, /pricingType/],
    'agentIdentifier': [{ agentIdentifier: 'd'.repeat(58) }, /identity/],
    'walletVkey': [{ SmartContractWallet: { ...q.SmartContractWallet, walletVkey: 'd'.repeat(56) } }, /identity/],
    'walletAddress': [{ SmartContractWallet: { ...q.SmartContractWallet, walletAddress: 'addr_test1qzzzzzz' } }, /identity/],
    'network Mainnet': [{ PaymentSource: { ...q.PaymentSource, network: 'Mainnet' } }, /network/],
    'source type V1': [{ PaymentSource: { ...q.PaymentSource, paymentSourceType: 'Web3CardanoV1' } }, /paymentSourceType/],
    'contract address': [{ PaymentSource: { ...q.PaymentSource, smartContractAddress: 'addr_test1w22222' } }, /identity/],
    'policyId': [{ PaymentSource: { ...q.PaymentSource, policyId: 'e'.repeat(56) } }, /identity/],
    'inputHash': [{ inputHash: '0'.repeat(64) }, /identity/],
    'submitResultTime': [{ submitResultTime: '1790000000000' }, /deadline/],
    'payByTime': [{ payByTime: String(Number(q.payByTime) + 1) }, /deadline/],
    'non-numeric time': [{ unlockTime: 'soon' }, /unlockTime/],
    'sellerReturnAddress set': [{ sellerReturnAddress: registration.sellerAddress }, /overrides/],
    'sellerReturnAddress missing': [{ sellerReturnAddress: undefined }, /sellerReturnAddress/],
    'forceLayer L1': [{ forceLayer: 'L1' }, /overrides/],
    'paymentForceLayer Hydra': [{ paymentForceLayer: 'Hydra' }, /overrides/],
    'L2 layer': [{ CurrentTransaction: { status: 'Pending', txHash: null, confirmations: null, layer: 'L2' } }, /L1/],
    'hydra head': [{ CurrentTransaction: { status: 'Pending', txHash: null, confirmations: null, hydraHeadId: 'head' } }, /L1/],
    'already locked': [{ onChainState: 'FundsLocked' }, /fresh/],
    'buyer return address': [{ buyerReturnAddress: 'addr_test1qbuyer' }, /fresh/],
    'existing result': [{ resultHash: 'd'.repeat(64) }, /fresh/],
    'other next action': [{ NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: null } }, /fresh/],
    'action error': [{ NextAction: { requestedAction: 'WaitingForExternalAction', errorType: 'NetworkError', resultHash: null } }, /failed/],
    'empty id': [{ id: '' }, /id/],
  };
  for (const [name, [change, pattern]] of Object.entries(changes))
    assert.throws(() => validateQuote({ ...q, ...change }, registration, p.amount, p), pattern, name);
  assert.throws(() => validateQuote(q, registration, TIERS.write.amount, p), /funds/, 'tier amount mismatch');
  for (const amount of ['0', '-1', '1.5', '1e6', '100000000000000000000', 1000000, undefined])
    assert.throws(() => validateQuote(q, registration, amount), /amount/, String(amount));
  assert.throws(() => validateQuote(q, { ...registration, supportedPaymentSourceIndex: 25 }, p.amount), /registration/);
  assert.throws(() => validateQuote(null, registration, p.amount), /quote/);
});

// ---------- core.mjs: Masumi payment event ----------

test('buildMasumiPaymentEvent carries the exact source field set', () => {
  const p = plan('write'), q = quote(p);
  const event = buildMasumiPaymentEvent(q, { ...registration, supportedPaymentSourceIndex: 3 }, p.identifierFromPurchaser);
  assert.deepEqual(Object.keys(event), ['blockchainIdentifier', 'identifierFromPurchaser', 'agentIdentifier', 'sellerVkey', 'inputHash',
    'payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime', 'Amounts', 'paymentSourceType',
    'supportedPaymentSourceIndex', 'PaymentSource']);
  assert.deepEqual(event, {
    blockchainIdentifier: 'signed-terms', identifierFromPurchaser: p.identifierFromPurchaser, agentIdentifier: registration.agentIdentifier,
    sellerVkey: registration.sellerVkey, inputHash: p.inputHash,
    payByTime: q.payByTime, submitResultTime: q.submitResultTime, unlockTime: q.unlockTime, externalDisputeUnlockTime: q.externalDisputeUnlockTime,
    Amounts: [{ amount: '5000000', unit: USDM_PREPROD }], paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: 3,
    PaymentSource: { network: 'Preprod', policyId: registration.policyId, smartContractAddress: registration.smartContractAddress } });
  assert.match(event.payByTime, /^\d{13}$/);
  for (const key of ['sellerReturnAddress', 'forceLayer', 'paymentForceLayer', 'credits', 'status', 'masumiPayment'])
    assert.equal(key in event, false, key);
  assert.deepEqual(Object.keys(event.PaymentSource), ['network', 'policyId', 'smartContractAddress']);
});

test('buildMasumiPaymentEvent refuses expired, overridden or unbound quotes', () => {
  const p = plan(), q = quote(p);
  assert.throws(() => buildMasumiPaymentEvent(q, registration, p.identifierFromPurchaser, { now: Number(q.payByTime) }), /expired/);
  assert.throws(() => buildMasumiPaymentEvent(q, registration, p.identifierFromPurchaser, { now: Number(q.submitResultTime) - 14 * MIN }), /expired/);
  assert.throws(() => buildMasumiPaymentEvent({ ...q, sellerReturnAddress: registration.sellerAddress }, registration, p.identifierFromPurchaser), /overrides/);
  assert.throws(() => buildMasumiPaymentEvent({ ...q, forceLayer: 'L1' }, registration, p.identifierFromPurchaser), /overrides/);
  assert.throws(() => buildMasumiPaymentEvent(locked(p), registration, p.identifierFromPurchaser), /fresh/);
  assert.throws(() => buildMasumiPaymentEvent(q, registration, 'not-a-nonce'), /nonce/);
  assert.throws(() => buildMasumiPaymentEvent(q, { ...registration, sellerVkey: 'f'.repeat(56) }, p.identifierFromPurchaser), /identity/);
});

// ---------- mps.mjs: HTTP client against a fake fetch ----------

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}
const SECRET = 'mps-secret-token';
const ok = data => ({ body: { status: 'success', data } });

test('MPS createPayment posts only the signed-terms fields with the token header', async () => {
  const p = plan('audit'), q = quote(p);
  for (const baseUrl of ['http://127.0.0.1:3012', 'http://127.0.0.1:3012/', 'http://127.0.0.1:3012/api/v1/']) {
    const { fetchImpl, calls } = fakeFetch([ok(q)]);
    const mps = createMpsClient({ baseUrl, token: SECRET, fetchImpl });
    assert.deepEqual(await mps.createPayment(p), q);
    assert.equal(calls[0].url, 'http://127.0.0.1:3012/api/v1/payment');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.token, SECRET);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.deepEqual(calls[0].body, { network: 'Preprod', paymentSourceType: 'Web3CardanoV2',
      agentIdentifier: registration.agentIdentifier, supportedPaymentSourceIndex: 0, inputHash: p.inputHash,
      identifierFromPurchaser: p.identifierFromPurchaser, RequestedFunds: [{ unit: USDM_PREPROD, amount: '20000000' }],
      payByTime: p.payByTime, submitResultTime: p.submitResultTime, unlockTime: p.unlockTime, externalDisputeUnlockTime: p.externalDisputeUnlockTime });
  }
});

test('MPS createPayment refuses an expired or malformed plan before any request', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const mps = createMpsClient({ baseUrl: 'https://mps.example', token: SECRET, fetchImpl });
  const p = plan();
  await assert.rejects(mps.createPayment(p, { now: Date.parse(p.payByTime) }), /expired/);
  await assert.rejects(mps.createPayment({ ...p, amount: '0' }), /amount/);
  await assert.rejects(mps.createPayment({ ...p, inputHash: 'x' }), /inputHash/);
  await assert.rejects(mps.createPayment({ ...p, identifierFromPurchaser: 'XYZ' }), /nonce/);
  await assert.rejects(mps.createPayment({ ...p, supportedPaymentSourceIndex: 25 }), /supportedPaymentSourceIndex/);
  await assert.rejects(mps.createPayment({ ...p, unlockTime: p.submitResultTime }), /deadlines/);
  assert.equal(calls.length, 0);
});

test('MPS resolve and submitResult use the route bodies from the MPS source', async () => {
  const p = plan(), hash = hashPaymentResult(p.identifierFromPurchaser, 'answer');
  const { fetchImpl, calls } = fakeFetch([ok(locked(p)), ok(locked(p)), ok({ ...locked(p), NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: hash } })]);
  const mps = createMpsClient({ baseUrl: 'http://localhost:3012', token: SECRET, fetchImpl });
  assert.equal((await mps.resolve('signed-terms')).onChainState, 'FundsLocked');
  await mps.resolve('signed-terms', { smartContractAddress: registration.smartContractAddress });
  assert.equal((await mps.submitResult('signed-terms', hash)).NextAction.resultHash, hash);
  assert.deepEqual(calls.map(c => c.url), ['http://localhost:3012/api/v1/payment/resolve-blockchain-identifier',
    'http://localhost:3012/api/v1/payment/resolve-blockchain-identifier', 'http://localhost:3012/api/v1/payment/submit-result']);
  assert.deepEqual(calls[0].body, { network: 'Preprod', blockchainIdentifier: 'signed-terms', includeHistory: 'true' });
  assert.deepEqual(calls[1].body, { network: 'Preprod', blockchainIdentifier: 'signed-terms', includeHistory: 'true',
    filterSmartContractAddress: registration.smartContractAddress });
  assert.deepEqual(calls[2].body, { network: 'Preprod', blockchainIdentifier: 'signed-terms', submitResultHash: hash });
  await assert.rejects(mps.submitResult('signed-terms', hash.toUpperCase()), /64 lowercase hex/);
  await assert.rejects(mps.submitResult('', hash), /blockchainIdentifier/);
  await assert.rejects(mps.resolve(''), /blockchainIdentifier/);
  assert.equal(calls.length, 3);
});

test('MPS errors carry status codes and never echo the token', async () => {
  const p = plan();
  const cases = [
    [{ status: 400, body: { status: 'error', error: { message: `Pay by time must be before submit result time ${SECRET}` } } },
      e => e instanceof MpsError && e.status === 400 && !e.uncertain && /HTTP 400: Pay by time/.test(e.message)],
    [{ status: 404, body: { status: 'error', error: { message: 'Payment not found or in invalid state' } } },
      e => e.status === 404 && /\/api\/v1\/payment\/submit-result failed with HTTP 404: Payment not found/.test(e.message)],
    [{ status: 502, body: 'Bad gateway' }, e => e.status === 502 && e.uncertain && /HTTP 502$/.test(e.message)],
    [new Error(`socket closed ${SECRET}`), e => e.status === undefined && e.uncertain && /outcome unknown/.test(e.message)],
    [{ status: 200, body: { status: 'error', data: {} } }, e => e.uncertain && /success envelope/.test(e.message)],
    [{ status: 200, body: 'not json' }, e => e.uncertain && /success envelope/.test(e.message)],
  ];
  for (const [response, check] of cases) {
    const { fetchImpl } = fakeFetch([response]);
    const mps = createMpsClient({ baseUrl: 'https://mps.example', token: SECRET, fetchImpl });
    const call = response.status === 404 ? mps.submitResult('signed-terms', 'a'.repeat(64)) : mps.createPayment(p);
    await assert.rejects(call, e => !e.message.includes(SECRET) && check(e));
  }
});

test('MPS client accepts only HTTPS or loopback HTTP and a single-line token', () => {
  assert.throws(() => createMpsClient({ baseUrl: 'http://external.example', token: SECRET }), /HTTPS/);
  assert.throws(() => createMpsClient({ baseUrl: 'https://user:pw@mps.example', token: SECRET }), /HTTPS/);
  assert.throws(() => createMpsClient({ baseUrl: 'https://mps.example?x=1', token: SECRET }), /HTTPS/);
  assert.throws(() => createMpsClient({ baseUrl: 'https://mps.example', token: 'a\nb' }), /token/);
  assert.throws(() => createMpsClient({ baseUrl: 'https://mps.example', token: ' ' }), /token/);
  assert.doesNotThrow(() => createMpsClient({ baseUrl: 'http://[::1]:3012', token: SECRET }));
});

// ---------- core.mjs: Coworker client ----------

test('D7: Core client is built with apiKey only and checks the Coworker identity', async () => {
  let options, credentialFor;
  const calls = [];
  const loadRuntime = async () => ({
    readRuntimeCredential(id) { credentialFor = id; return 'coworker_test-only-key'; },
    createCoworkerHttpClient(value) {
      options = value;
      return {
        async get(path) { calls.push(path); return { data: { id: 'coworker_1', archivedAt: null, capabilities: ['tasks'] } }; },
        async post(path, body) { calls.push({ path, body }); return { data: { id: 'event_1', taskId: 'task_1' } }; },
      };
    },
  });
  const core = await createCoreClient('coworker_1', { loadRuntime });
  assert.equal(credentialFor, 'coworker_1');
  assert.deepEqual(options, { apiKey: 'coworker_test-only-key' });
  assert.equal('contextUserId' in options, false);
  assert.deepEqual(calls, ['/v1/coworkers/me']);
  assert.equal(await core.postPaymentEvent('task_1', { blockchainIdentifier: 'signed-terms' }), 'event_1');
  assert.deepEqual(calls[1], { path: '/v1/tasks/task_1/events', body: { masumiPayment: { blockchainIdentifier: 'signed-terms' } } });
  await assert.rejects(createCoreClient('other_coworker', { loadRuntime }), /identity/);
  await assert.rejects(createCoreClient('../x', { loadRuntime }), /Invalid/);
});

test('Core payment event and receipt calls validate input and report failures', async () => {
  const calls = [];
  const core = scopeCoreClient({
    async get(path) { calls.push(path); return { data: { blockchainIdentifier: null, claimStatus: null, onChainState: null, settled: false, txHash: null, withdrawnForSeller: [] } }; },
    async post(path, body) { calls.push({ path, body }); return { data: { id: 'event_2' } }; },
  });
  assert.equal((await core.fetchReceipt('01a10c8d-085c-767c-810c-e464c8f2a17b')).settled, false);
  assert.equal(calls[0], '/v1/tasks/01a10c8d-085c-767c-810c-e464c8f2a17b/receipt');
  await assert.rejects(core.postPaymentEvent('task_1', { masumiPayment: {} }), /inner masumiPayment/);
  await assert.rejects(core.postPaymentEvent('task/1', {}), /Invalid/);
  await assert.rejects(core.fetchReceipt('task/1'), /Invalid/);
  assert.equal(calls.length, 1);

  const http422 = Object.assign(new Error('Core API request failed with status 422: Only the assigned coworker can set masumiPayment on task events'), { status: 422 });
  const rejecting = scopeCoreClient({ post: async () => { throw http422; }, get: async () => { throw new Error('secret-token'); } });
  await assert.rejects(rejecting.postPaymentEvent('task_1', {}), e => e.status === 422 && !e.uncertain && /HTTP 422: .*assigned coworker/.test(e.message));
  await assert.rejects(rejecting.fetchReceipt('task_1'), e => e.uncertain && /uncertain/.test(e.message) && !e.message.includes('secret-token'));
  const noId = scopeCoreClient({ post: async () => ({ data: { taskId: 'task_1' } }) });
  await assert.rejects(noId.postPaymentEvent('task_1', {}), /uncertain/);
  const wrongTask = scopeCoreClient({ post: async () => ({ data: { id: 'event', taskId: 'task_2' } }) });
  await assert.rejects(wrongTask.postPaymentEvent('task_1', {}), /uncertain/);
});

test('D8: receipt validation accepts ordinary withdrawals and rejects false settlement proof', () => {
  const receipt = { blockchainIdentifier: 'signed-terms', claimStatus: 'PURCHASED', onChainState: 'Withdrawn',
    settled: true, txHash: TX, withdrawnForSeller: [{ unit: USDM_PREPROD, amount: '950000' }] };
  assert.equal(validateReceipt(receipt), receipt);
  assert.doesNotThrow(() => validateReceipt({ ...receipt, withdrawnForSeller: [] }));
  for (const patch of [{ txHash: null }, { txHash: 'xyz' }, { onChainState: 'FundsLocked' }, { blockchainIdentifier: null },
    { withdrawnForSeller: [{ unit: '', amount: '1000000' }] }, { withdrawnForSeller: [{ unit: USDM_PREPROD, amount: '0' }] },
    { onChainState: 'DisputedWithdrawn', withdrawnForSeller: [] }])
    assert.throws(() => validateReceipt({ ...receipt, ...patch }), /does not prove/, JSON.stringify(patch));
  assert.throws(() => validateReceipt({ ...receipt, settled: 'yes' }), /Invalid Core receipt/);
});

// ---------- flow.mjs ----------

test('flow checks follow the MPS state through lock, result and withdrawal', () => {
  const p = plan(), fresh = quote(p), lock = locked(p);
  const hash = hashPaymentResult(p.identifierFromPurchaser, 'answer');
  assert.equal(isFundsLockedConfirmed(fresh), false);
  assert.equal(isFundsLockedConfirmed(lock), true);
  assert.equal(isFundsLockedConfirmed({ ...lock, CurrentTransaction: { ...lock.CurrentTransaction, confirmations: 0 } }), false);
  assert.equal(isFundsLockedConfirmed({ ...lock, CurrentTransaction: { ...lock.CurrentTransaction, status: 'Pending' } }), false);
  assert.equal(isFundsLockedConfirmed({ ...lock, CurrentTransaction: { ...lock.CurrentTransaction, txHash: null } }), false);
  const fromHistory = { ...lock, CurrentTransaction: { status: 'Pending', txHash: null, confirmations: null },
    TransactionHistory: [{ status: 'Confirmed', txHash: TX, confirmations: 3, newOnChainState: 'FundsLocked' }] };
  assert.equal(isFundsLockedConfirmed(fromHistory), true);
  assert.equal(isFundsLockedConfirmed(null), false);

  assert.equal(canSubmitResult(lock), true);
  assert.equal(canSubmitResult(fresh), false);
  assert.equal(canSubmitResult({ ...lock, NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: hash } }), false);
  assert.equal(canSubmitResult({ ...lock, NextAction: { requestedAction: 'WaitingForExternalAction', errorType: 'NetworkError', resultHash: null } }), false);

  const queued = { ...lock, NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: hash } };
  assert.equal(isResultAccepted(queued, hash), true);
  assert.equal(isResultAccepted(lock, hash), false);
  assert.equal(isResultSubmittedConfirmed(queued, hash), false);
  const submitted = { ...lock, onChainState: 'ResultSubmitted', resultHash: hash,
    NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null, resultHash: null },
    CurrentTransaction: { status: 'Confirmed', txHash: 'e'.repeat(64), confirmations: 1, newOnChainState: 'ResultSubmitted' } };
  assert.equal(isResultSubmittedConfirmed(submitted, hash), true);
  assert.equal(isResultAccepted(submitted, hash), true);
  assert.equal(isResultSubmittedConfirmed(submitted, 'f'.repeat(64)), false);
  assert.equal(isResultSubmittedConfirmed({ ...submitted, CurrentTransaction: { ...submitted.CurrentTransaction, confirmations: 0 } }, hash), false);
  assert.equal(isWithdrawn(submitted), false);
  assert.equal(withdrawalTxHash(submitted), null);

  const withdrawn = { ...submitted, onChainState: 'Withdrawn',
    CurrentTransaction: { status: 'Confirmed', txHash: '9'.repeat(64), confirmations: 2, newOnChainState: 'Withdrawn' } };
  assert.equal(isWithdrawn(withdrawn), true);
  assert.equal(withdrawalTxHash(withdrawn), '9'.repeat(64));
  assert.equal(isWithdrawn({ ...withdrawn, onChainState: 'DisputedWithdrawn' }), false);
  assert.equal(isWithdrawn({ ...withdrawn, CurrentTransaction: { ...withdrawn.CurrentTransaction, status: 'Pending' } }), false);
});

test('D13: result deadline check fails closed', () => {
  const q = quote(plan());
  const deadline = Number(q.submitResultTime);
  assert.equal(resultDeadlinePassed(q, deadline - 1), false);
  assert.equal(resultDeadlinePassed(q, deadline), true);
  assert.equal(resultDeadlinePassed({}, 0), true);
  assert.equal(resultDeadlinePassed({ submitResultTime: 'soon' }, 0), true);
});
