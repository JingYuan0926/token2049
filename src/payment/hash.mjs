// Masumi payment hashes, ported from demo-agent-token2049 scripts/payment.ts.
// That code settled 1 test USDM on Cardano Preprod.
import { createHash } from 'node:crypto';

/** @param {string} value */
export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * RFC 8785 style JSON: sorted keys, JSON values only.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('Payment data contains invalid Unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Payment input must contain only finite JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Payment input must use plain JSON objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item, ancestors)).join(',')}]`;
    const record = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.keys(record).sort().map(key => `${canonicalJson(key)}:${canonicalJson(record[key], ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally { ancestors.delete(value); }
}

/** @param {unknown} nonce */
export function validateNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{14,26}$/.test(nonce)) throw new Error('Invalid purchaser nonce');
  return nonce;
}

/**
 * Keep only the three task fields, in the source key order.
 * @param {{taskId: string, name: string, description: string | null}} input
 */
export function paymentTask(input) {
  const { taskId, name, description } = input ?? {};
  if (typeof taskId !== 'string' || !taskId || typeof name !== 'string' || !name ||
      !(typeof description === 'string' || description === null)) throw new Error('Payment task needs taskId, name and description (string or null)');
  return { taskId, name, description };
}

/** @param {string} nonce @param {unknown} input */
export function hashCanonicalInput(nonce, input) {
  validateNonce(nonce);
  return sha256(`${nonce};${canonicalJson(input)}`);
}

/** @param {string} nonce @param {{taskId: string, name: string, description: string | null}} input */
export function hashPaymentInput(nonce, input) {
  return hashCanonicalInput(nonce, paymentTask(input));
}

/** @param {unknown} text */
function requireText(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('Seller result must be valid Unicode text');
  return text;
}

// Core-compatible result hash. It escapes the text like JSON.stringify without the outer quotes.
// This is the hash that settled on Preprod. It differs from MIP-004 for newlines, quotes and backslashes.
/** @param {string} nonce @param {string} text */
export function hashPaymentResult(nonce, text) {
  validateNonce(nonce);
  return sha256(`${nonce};${JSON.stringify(requireText(text)).slice(1, -1)}`);
}

// Raw MIP-004 result hash, for the Standard agent API only.
/** @param {string} nonce @param {string} text */
export function hashMip004Result(nonce, text) {
  validateNonce(nonce);
  return sha256(`${nonce};${requireText(text)}`);
}

/**
 * Deterministic 20-hex purchaser nonce, same formula as the source.
 * @param {{taskId: string, name: string, description: string | null}} input
 * @param {string} agentIdentifier
 */
export function makeNonce(input, agentIdentifier) {
  if (typeof agentIdentifier !== 'string' || !agentIdentifier) throw new Error('Missing agent identifier');
  return sha256(JSON.stringify({ input: paymentTask(input), agentIdentifier, network: 'Preprod' })).slice(0, 20);
}
