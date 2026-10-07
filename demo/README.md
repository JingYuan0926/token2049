# Demo contracts

Two small Aiken validators for trying the Aiken Auditor.

| Validator | What it does |
| --- | --- |
| `validators/vesting.ak` | The owner locks ADA for a beneficiary. The beneficiary can claim after `lock_until`. The owner can cancel at any time. |
| `validators/marketplace.ak` | A seller lists an item for a fixed price in lovelace. A buyer pays the seller the price and takes the item. The seller can cancel. |

Run the tests:

```
aiken check
```

All 12 tests pass. Passing tests do not prove that a contract is safe. Ask the Aiken Auditor to check it.
