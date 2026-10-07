// One-time MPS setup for the seller: clear the collection address,
// register Aiken Auditor with Dynamic pricing, and create a scoped runtime key.
// Run with the MPS env file so ADMIN_KEY is available; secrets are never printed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const privateDir = resolve(here, '../../.local');
const baseUrl = process.env.MPS_URL || 'http://127.0.0.1:3012/api/v1';
const adminKey = process.env.ADMIN_KEY;
if (!adminKey) throw new Error('ADMIN_KEY is missing. Run with the MPS env file.');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });

const REGISTRATION_NAME = 'Aiken Auditor';

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { token: adminKey, 'content-type': 'application/json' },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || String(json.status).toLowerCase() !== 'success') {
    throw new Error(`MPS ${options.method || 'GET'} ${route} failed: HTTP ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data;
}

const { PaymentSources } = await request('/payment-source?take=100');
const source = PaymentSources.find((s) => s.network === 'Preprod' && s.paymentSourceType === 'Web3CardanoV2');
if (!source) throw new Error('No Preprod Web3CardanoV2 payment source found.');

const { Wallets } = await request(`/wallet/list?paymentSourceId=${source.id}&take=100`);
const sellers = Wallets.filter((w) => w.type === 'Selling');
if (sellers.length !== 1) throw new Error(`Expected one selling wallet, found ${sellers.length}.`);
const seller = sellers[0];

// Core cannot forward a signed sellerReturnAddress, and MPS fills it from collectionAddress.
if (seller.collectionAddress !== null) {
  await request('/wallet', { method: 'PATCH', body: JSON.stringify({ id: seller.id, newCollectionAddress: null }) });
  console.log('Cleared the selling wallet collection address.');
}

const registry = await request('/registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=100');
const entries = registry.Assets || registry.RegistryEntries || registry.entries || [];
let entry = entries.find((e) => e.name === REGISTRATION_NAME && !String(e.state).startsWith('Deregistration'));
if (!entry) {
  entry = await request('/registry', {
    method: 'POST',
    body: JSON.stringify({
      network: 'Preprod',
      type: 'Standard',
      sellingWalletVkey: seller.walletVkey,
      name: REGISTRATION_NAME,
      description: 'Audits Cardano smart contracts written in Aiken. Tiers: see (findings report), write (report + fixed code), audit (human-reviewed report). Paid per task through Masumi escrow.',
      apiBaseUrl: 'http://127.0.0.1:3013',
      Capability: { name: 'aiken-audit', version: '0.1.0' },
      Author: { name: 'JingYuan Labs' },
      Tags: ['cardano', 'aiken', 'audit', 'security', 'smart-contracts'],
      ExampleOutputs: [],
      supportedPaymentSources: [{
        chain: 'Cardano',
        network: 'Preprod',
        paymentSourceType: 'Web3CardanoV2',
        address: source.smartContractAddress,
        pricing: { pricingType: 'Dynamic' },
      }],
    }),
  });
  console.log('Registration requested.');
}

const runtimePath = resolve(privateDir, 'mps-runtime.env');
if (!existsSync(runtimePath)) {
  const key = await request('/api-key', {
    method: 'POST',
    body: JSON.stringify({
      canRead: true, canPay: true, canAdmin: false,
      usageLimited: 'false', UsageCredits: [],
      NetworkLimit: ['Preprod'], ChainIdLimit: [],
      walletScopeEnabled: true, WalletScopeHotWalletIds: [seller.id],
      x402WalletScopeEnabled: true, X402WalletScopeEvmWalletIds: [],
    }),
  });
  if (key.canAdmin || !key.canRead || !key.canPay || !key.walletScopeEnabled) {
    throw new Error('The runtime key has an unexpected scope.');
  }
  writeFileSync(runtimePath, `MPS_URL=${baseUrl}\nMPS_TOKEN=${key.token}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Stored a scoped runtime key in .local/mps-runtime.env.');
}

const status = {
  checkedAt: new Date().toISOString(),
  paymentSourceId: source.id,
  policyId: source.policyId,
  smartContractAddress: source.smartContractAddress,
  sellerWalletId: seller.id,
  sellerVkey: seller.walletVkey,
  sellerAddress: seller.walletAddress,
  registration: {
    id: entry.id,
    name: entry.name,
    state: entry.state,
    agentIdentifier: entry.agentIdentifier ?? null,
    txHash: entry.CurrentTransaction?.txHash ?? null,
  },
};
writeFileSync(resolve(privateDir, 'payment-status.json'), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(status, null, 2));

// The worker reads this once the agent identity NFT is confirmed on-chain.
if (entry.state === 'RegistrationConfirmed' && entry.agentIdentifier) {
  const sources = entry.supportedPaymentSources || entry.SupportedPaymentSources || [];
  const index = sources.findIndex((s) => s.address === source.smartContractAddress || s.smartContractAddress === source.smartContractAddress);
  const registration = {
    agentIdentifier: entry.agentIdentifier,
    policyId: source.policyId,
    smartContractAddress: source.smartContractAddress,
    sellerVkey: seller.walletVkey,
    sellerAddress: seller.walletAddress,
    supportedPaymentSourceIndex: index >= 0 ? index : 0,
    registrationTxHash: entry.CurrentTransaction?.txHash ?? null,
  };
  writeFileSync(resolve(privateDir, 'registration.json'), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved .local/registration.json (payment source index ${registration.supportedPaymentSourceIndex}).`);
}
