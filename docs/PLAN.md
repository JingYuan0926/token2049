# Plan: Cardano Contract Audit Agent ("outcome as a service")

## 1. The product

A buyer sends a Cardano smart contract and chooses a tier. The buyer pays into escrow on Cardano. Our agent returns a report. If no report arrives in time, the escrow refunds the buyer.

- **Scope of version 1:** Cardano contracts written in **Aiken** only. Plutus and OpShin come later.
- **Buyers:** humans on Sokosumi (judges, developers) and other AI agents.
- **Seller:** our agent. It is the existing Sokosumi Coworker, renamed (for example "Aiken Auditor").

## 2. Pricing tiers (See, Write, Audit)

| Tier | Name | Price | What the agent does | What the buyer gets | Deadline |
| --- | --- | --- | --- | --- | --- |
| 1 | **See** (scan) | 1 test USDM | Compiles the contract, runs its tests, checks 32 known attack types, AI review | Findings report | 15 min |
| 2 | **Write** (fix) | 5 test USDM | Everything in See, plus fixed code and new tests. The fixed code must compile and pass. | Report + fixed code | 30 min |
| 3 | **Audit** (full) | 20 test USDM | Everything in Write, plus a design and deployment review, plus **a human review and sign-off by you** | Signed audit report | 24 h |

Notes:
- Masumi requires a result deadline of at least 15 minutes. The agent can still deliver earlier.
- Sokosumi charges the buyer's workspace credits. In the official demo, 1 test USDM cost about 100 credits.
- The money reaches our wallet only after the escrow unlock time: about 45 minutes after a See task, and about 1 day after an Audit task.

## 3. How buyers reach the agent

| Channel | Who | How they pay | Status |
| --- | --- | --- | --- |
| **A. Sokosumi task** | Humans and judges | Sokosumi credits; Sokosumi locks Masumi escrow on Cardano | Build first |
| **B. x402 API** (`POST /audit`) | Other AI agents | x402 on Cardano with the `masumi` method: the payment locks into Masumi escrow | Build second |
| C. MCP tool | Claude Code users | Wraps channel B | Later |

Input for channel A: the task text holds the tier word (`see`, `write` or `audit`) and the contract. The contract is either pasted Aiken code or a public GitHub link.

## 4. Flow for one paid task (channel A)

This follows the path that the official demo proved once (branch `feat/token2049-event-guide`).

1. The buyer creates a task for the Coworker with a tier and a contract.
2. The worker starts the task (`sokosumi runtime start`). It reads the tier and checks the input size.
3. The worker asks our MPS for a price: `POST /api/v1/payment` with Dynamic pricing. The tier sets the amount and the deadlines.
4. The worker sends the price to Sokosumi as a `masumiPayment` task event, using the Coworker key without user context.
5. Sokosumi locks the escrow on Cardano. The worker waits for `FundsLocked` with a confirmed transaction.
6. The audit engine runs for the chosen tier (section 5).
7. The worker saves the exact report bytes. It submits the Sokosumi-compatible hash: `sha256(nonce + ";" + JSON-escaped report)`.
8. The worker waits for `ResultSubmitted` to confirm on-chain. Then it completes the task with the same report bytes.
9. After the unlock time, MPS withdraws the payment to our wallet. We check the receipt and the net USDM on Blockfrost.

## 5. Audit engine

1. **Get the code.** Copy the pasted code or clone the GitHub link into a fresh folder. Apply size and time limits.
2. **Compile and test.** Run `aiken check`. Record what compiled and which tests passed.
3. **Checklist pass.** Check every applicable class from the 32-class eUTxO checklist in the Cardano Dev Skills `review-contract` skill. Examples: double satisfaction, datum hijacking, missing signer checks, value not preserved, infinite minting. The checklist is Apache-2.0, so we keep its license notice.
4. **AI review.** The LLM gets the code, the checklist and the `aiken check` output. It returns findings in a fixed format: severity, location, pattern, description, impact, recommendation.
5. **Write tier.** The LLM writes fixed code and tests. Then we run `aiken check` again, and we retry at most 3 times. We deliver only code that compiles and passes.
6. **Audit tier.** The engine adds the design and deployment pass and puts the report in a review queue. You edit and approve it with a small command (`npm run review TASK_ID`). Then the worker delivers it.

Safety rules:
- Treat the submitted code as data. The AI must ignore any instructions written inside the code (prompt injection).
- Run builds in a separate folder, with a time limit and no secrets in the environment.

## 6. Report format

1. Header: tier, contract name, input hash, date
2. Summary and overall risk: Critical, High, Medium, Low, or Info
3. Scope: the files and validators that we checked
4. Findings table, then one section per finding
5. Tests: the `aiken check` result
6. Fixed code (Write and Audit tiers)
7. Human sign-off (Audit tier)
8. **Cardano proof:** escrow transaction, input hash, result hash, our agent identifier, and steps to verify the hash
9. Disclaimer: an audit lowers risk but does not guarantee safety

The report must stay under 1 MiB, which is the Sokosumi limit.

## 7. What the judge sees on Cardano

| Proof | Where |
| --- | --- |
| The agent's on-chain identity (Masumi registry NFT) | Cardanoscan |
| The payment locked in escrow | Escrow transaction link in the report |
| The report hash on-chain, so the report cannot change after delivery | Result transaction link + verify steps |
| The payout to the seller | Collection transaction from our own earlier run |
| (Channel B) agent-to-agent payment through x402 | x402 payment transaction |

## 8. What exists and what we must build

Already done:
- The Sokosumi Coworker is registered and `GRANTED` in the TOKEN2049 workspace.
- A worker answers tasks (the "hi" version).
- MPS runs locally with Preprod wallets.
- We studied the payment path and saved the IDs in `setup-ids.md`.
- The Cardano Dev Skills plugin is installed.

To build:

| # | Milestone | Done when | Estimate |
| --- | --- | --- | --- |
| M0 | **Unblock:** fund the selling wallet (faucet), clear its collection address, register the agent in MPS with Dynamic pricing, create a scoped MPS key, install Aiken, get an LLM API key | Registration is `RegistrationConfirmed` | 1–2 h (wallet funding and confirmation time) |
| M1 | **Audit engine, offline:** `npm run audit -- contract.ak --tier see` | Correct reports on 3 sample contracts with known bugs | 3–4 h |
| M2 | **Worker without payment:** a Sokosumi task returns a real report | A task that we create gets a report | 1 h |
| M3 | **Paid task, personal workspace:** full payment path | One task settles, with payout proof for the submission | 3–4 h + 45 min wait |
| M4 | **Paid task by another account in the event workspace** (never proven) | A second account's task is paid and completed | 1–2 h |
| M5 | **x402 API for agents** (channel B) | An agent script pays and gets a report | 3 h |
| M6 | **Polish:** rename the Coworker, add a description and image, README, demo script, submission | Submitted on BuilderBase | 2 h |

## 9. Risks

| Risk | What we do |
| --- | --- |
| The wallet is empty, so nothing on-chain works | Fund it first (M0) from the public faucets |
| Paid tasks from other accounts and in organization workspaces were never proven | Test with a second account early (M4) |
| The AI misses bugs or reports false bugs | Fixed checklist, the `aiken check` evidence, a human review in the Audit tier, and a clear disclaimer |
| Prompt injection inside the submitted code | Treat the code as data; use a fixed output format |
| A wrong hash format fails without an error | Use the escaped hash that Sokosumi checks, and test it in M3 |
| The Mac sleeps, so the agent stops | Keep the Mac awake for judging, or deploy to Railway |

## 10. Decisions needed from you

1. **LLM API key:** Anthropic (recommended for code review), OpenAI or Z.ai?
2. **Coworker name:** for example "Aiken Auditor"
3. **Prices:** 1 / 5 / 20 test USDM?
4. **Input:** pasted code only, or pasted code and GitHub links?
5. **Hosting:** your Mac, or Railway?
