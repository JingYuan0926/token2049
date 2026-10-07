# Aiken Auditor

An AI agent that audits Cardano smart contracts and gets paid on Cardano.

You send an Aiken contract and choose a tier. Your payment locks in a Masumi escrow contract on Cardano. The agent compiles and tests the contract, checks it against 32 known eUTxO attack types, and returns a report. Then it writes the hash of that exact report on-chain. It can collect the payment only after that step. If no report arrives in time, the escrow refunds you.

Built for the TOKEN2049 Origins Hackathon 2026, track "Agentic Payments on Cardano".

## Use it

1. Open https://preprod.sokosumi.com and switch to the TOKEN2049 Origins Hackathon 2026 workspace.
2. Create a new task for the Coworker **Aiken Auditor**.
3. In the task text, write a tier line, then paste your Aiken validator in a code block:

   ````
   tier: see

   This escrow lets a seller list an item for a fixed price.

   ```aiken
   validator escrow { ... }
   ```
   ````

   Instead of code, you can also give a public GitHub link to an Aiken project.
4. Wait a few minutes. The task completes with the report.

| Tier | Price | You get | Delivery |
| --- | --- | --- | --- |
| `see` | 1 test USDM | Findings report | about 2 to 5 minutes |
| `write` | 5 test USDM | Report and fixed code that compiles and passes `aiken check` | about 5 minutes |
| `audit` | 20 test USDM | Report checked and signed by a human reviewer | within 24 hours |

Describe what the contract is meant to do. The agent judges each finding against that intent.

## What is on Cardano

| Step | On-chain record |
| --- | --- |
| Agent identity | Masumi registry NFT, minted in [`89edb4e6…e28e`](https://preprod.cardanoscan.io/transaction/89edb4e66535c8e39143c2d63c74c8ff66fec6cff38b41dbbb81d0b55648e28e) |
| Payment | The buyer's test USDM locks in the Masumi escrow contract |
| Delivery | The report hash goes into the escrow datum. It proves which report was delivered. |
| Payout | After the unlock time, the escrow releases the payment to the seller wallet |

Every report ends with a "Cardano proof" section. It has the escrow transaction link and a one-line command that recomputes the report hash, so you can compare it with the on-chain hash.

## How it works

```
Buyer (Sokosumi task) ──► Worker ──► MPS: signed price (Dynamic pricing)
                            │  ──► Sokosumi: masumiPayment event ──► Sokosumi locks escrow on Cardano
                            │  ◄── escrow confirmed (FundsLocked)
                            │  ──► Audit engine: aiken check + review (gpt-6-luna) [+ fix] [+ human review]
                            │  ──► MPS: submit report hash on-chain (ResultSubmitted)
                            └──► Sokosumi: task completed with the report
```

| Folder | Content |
| --- | --- |
| `src/engine/` | Audit engine: input parsing, Aiken workspace and `aiken check`, model review, fix loop, report |
| `src/payment/` | Masumi payment: price, escrow checks, report hash, Sokosumi payment events |
| `src/worker.mjs` | Takes Sokosumi tasks and runs the paid flow. It saves each step before it writes, so a restart never repeats a payment step. |
| `src/cli/` | `audit` (offline run), `eval` (grade against fixtures), `review` (human sign-off), `mps-setup` (one-time seller setup) |
| `fixtures/` | Test contracts with known bugs and one safe contract |
| `vendor/review-contract/` | The 32-class eUTxO vulnerability checklist from the Cardano Foundation `cardano-dev-skills` (Apache-2.0) |
| `masumi-payment-service/` | The Masumi Payment Service (MPS), run locally as the seller node |

## Run it yourself

You need Node.js 24 or later, the Aiken CLI (`aikup`), the Sokosumi CLI 1.0.4, PostgreSQL, and a local MPS. Follow https://www.masumi.network/token2049 for the MPS and Sokosumi setup.

1. Install packages: `npm install`
2. Put `OPENAI_API_KEY=...` in `.env`.
3. Set up the seller once: `node --env-file=masumi-payment-service/.env src/cli/mps-setup.mjs`
4. Start the worker: `PAID_TASKS_ENABLED=true npm run worker`
5. Audit a file without payment: `npm run audit -- fixtures/escrow-double-satisfaction/contract.ak --tier see`
6. Grade the auditor: `npm run eval`
7. Approve an Audit-tier report: `npm run review -- list`, then `npm run review -- approve <taskId>`

## Results so far

- Eval: 4 of 4 fixtures pass. The agent finds double satisfaction (#1), a missing signer check (#4) and infinite minting (#10) at the right severity. It gives no false alarms on the safe vesting contract.
- Paid tasks on Cardano Preprod, personal workspace and TOKEN2049 workspace:
  - escrow [`f30f0547…`](https://preprod.cardanoscan.io/transaction/f30f054703712aa232531f4a44a94acd2044d64ed6d555fc749f8d51934e1768), report hash `d2801678…`
  - escrow [`c9fb50b1…`](https://preprod.cardanoscan.io/transaction/c9fb50b1d994b9dc21d0684326c691c774a3a85dd1d23fa2de31840c28c545ee), report hash `06543274…`

### Seller payment proof

| Item | Value |
| --- | --- |
| Task | `01a11680-3c29-77e0-a8ff-285409710ad9` (See tier) |
| Collection transaction | [`22f242036f5f6cb944067cf010b9ad0421bd2ff8a4dc765eebca9e504b1c403c`](https://preprod.cardanoscan.io/transaction/22f242036f5f6cb944067cf010b9ad0421bd2ff8a4dc765eebca9e504b1c403c) (block 5264635, 2026-10-07 14:02 UTC) |
| Seller address | `addr_test1qph0kwkrcf60gyyxwjpzpv9ptnfjx7rs8xa050hqs3znywhqs3wg7pagtvzv662fxwdjdrsdmkzyfpzhfljqcc9cfmwqc7mmrp` |
| Token unit | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` (test USDM) |
| Net amount received | 1 test USDM (`1000000`), measured on Blockfrost as outputs minus inputs at the seller address |
| Sokosumi receipt | `claimStatus: PURCHASED`, `onChainState: Withdrawn`, `settled: true`, same transaction hash |

A second paid task, created in the TOKEN2049 event workspace (`01a11684-4b92-75dc-a69e-c6a914178f86`), also settled: collection transaction [`bb0df605e751a436325d3a7542ff85089f84fdcd135805293831afb16eb4d432`](https://preprod.cardanoscan.io/transaction/bb0df605e751a436325d3a7542ff85089f84fdcd135805293831afb16eb4d432) (block 5264647), net 1 test USDM to the seller, receipt `settled: true`.

## Limits

- An AI audit lowers risk but does not guarantee safety. Get an independent audit before you lock real funds.
- This runs on Cardano Preprod with test tokens only.
- The worker runs on one computer. If that computer sleeps, tasks wait.
