---
name: audit
description: Buy an Aiken smart-contract audit from MARS Agent and pay with x402 on Cardano Preprod, then show the report. Use when the user says "help me audit my contract", "audit my smart contract", "check my Aiken contract", "pay for an audit", or types /audit with or without a GitHub link, a folder, or a .ak file.
argument-hint: [github-url | folder | file.ak]
---

# /audit: buy an audit with x402

You act as the **buyer agent**. MARS Agent is the **seller agent**. You pay it with x402 on Cardano Preprod, from the buyer wallet in `.local/buyer-wallet.json`. Run every command from the project root.

## Step 1: check the seller

Run `curl -s http://127.0.0.1:3013/health`.
If it does not return `{"ok":true}`, start the seller in the background with `npm run x402` and check again.

## Step 1b: find the contract

If the user gave a GitHub link, a folder or a `.ak` file, use it as `<target>`.
If not, search the current project for Aiken projects:

```
find . -name aiken.toml -not -path '*/build/*' -not -path './node_modules/*' -not -path './masumi-payment-service/*'
```

- One project found: use its folder as `<target>` and tell the user which one.
- Several found: list them and ask which one.
- None found: ask the user for a GitHub link or a path.

## Step 2: get the price options (no payment)

Run:

```
npm run buy --silent -- <target> --quote
```

`<target>` is the user's argument: a `https://github.com/...` link, a folder, or a `.ak` file.

Show the user:
1. The project that the agent found: its path, number of files, code lines and size.
2. A numbered table of the **native** options only: tier, price in tADA, and what they get. Skip any escrow option in the quote.
   - Payment method: native x402. The payment goes straight to the agent's registered wallet. It is instant and final.
   - **see**: findings report. **write**: report and fixed code.
   - Buyers who want escrow protection can use the Sokosumi channel, which pays through Masumi escrow.
3. The buyer balance: run `npm run buy --silent -- --balance`.

Then ask: "Reply with the option number to pay and start the audit."
**Stop here. Do not pay until the user replies with a number.**

## Step 3: pay and run (only after the user picks a number)

Run, with the tier and method of the chosen option:

```
npm run buy --silent -- <target> --tier <see|write> --method native --yes
```

The last line of the output is one JSON object. Show the user:
1. **x402 payment:** the price and the `paymentTxUrl` link (Cardanoscan).
2. **Result:** the overall risk, then a table of findings (severity and title).
3. **Report:** the `reportPath`. Offer to open it.
4. One short line on what happened: "Claude Code (buyer agent) paid MARS Agent (seller agent) with x402 on Cardano."

## Rules

- Never run a command with `--yes` unless the user chose that option in this conversation.
- Never run the same `--yes` command twice. If it fails with a message that says to resend, run `npm run buy --silent -- --resume <journal file>` as the message says. Do not pay again.
- If the balance is too low, tell the user to fund the buyer address from https://docs.cardano.org/cardano-testnets/tools/faucet/ (Preprod).
- Never print the content of `.env` or of any wallet file.
