// Local Preprod wallet files for the x402 buyer and seller keys.
// The file holds a mnemonic. It is written with mode 600 and never printed.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrivateKey } from '@evolution-sdk/evolution';
import { toMasumiSellerSigner } from '@x402/cardano';
import { NETWORK } from './core.mjs';

/** Address of a mnemonic (account 0), the same one the x402 reference signers use. @param {string} mnemonic */
export const addressOf = (mnemonic) => toMasumiSellerSigner({ mnemonic, network: NETWORK }).sellerAddress;

/**
 * Creates a new wallet file. Refuses to replace an existing one, because it may hold funds.
 * @param {string} path
 * @returns {{address: string}}
 */
export function createWalletFile(path) {
  if (existsSync(path)) throw new Error(`${path} already exists. It may hold funds, so it was not replaced.`);
  const mnemonic = PrivateKey.generateMnemonic(256);
  const address = addressOf(mnemonic);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = { network: NETWORK, address, mnemonic, createdAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { address };
}

/**
 * Reads a wallet file. Refuses a file that other users can read.
 * @param {string} path
 * @returns {{network: string, address: string, mnemonic: string}}
 */
export function readWalletFile(path) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must have mode 600. Run: chmod 600 ${path}`);
  let record;
  // A JSON.parse error quotes part of the text, which could be mnemonic words. Do not pass it on.
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${path} is not valid JSON.`); }
  if (record?.network !== NETWORK || typeof record.mnemonic !== 'string' || addressOf(record.mnemonic) !== record.address)
    throw new Error(`${path} is not a valid ${NETWORK} wallet file.`);
  return record;
}
