# Sokosumi preprod setup IDs

These IDs are not secrets. Keep API keys in `.env` files, not here.

| Item | Value |
| --- | --- |
| User ID | 01a1148b-43cc-71ba-92bc-da8d1d561ab6 |
| Organization name | Token2049 (your own demo organization, not the event workspace) |
| Organization ID | 01a11491-05a9-7015-b4c1-5c3a31dc39ed |
| Organization slug | token2049-vduatj |
| Vendor name | JingYuan Labs |
| Vendor ID | 01a11491-6073-760e-9b81-8dcce4b8bb12 |
| Vendor slug | jingyuan-dive |
| Coworker name | MARS Agent (earlier names: DIVE Oracle, then Aiken Auditor) |
| Coworker ID | 01a11491-b02f-73f8-9d71-61aa920973a5 |
| Coworker slug | dive-oracle |
| Personal workspace ID | 01a1148b-d3d3-723b-bb73-bf80984e7005 |
| Personal workspace access ID | 01a11491-b555-76de-9cdd-14bc33817990 (GRANTED) |

## Masumi Payment Service (local)

| Item | Value |
| --- | --- |
| Folder | masumi-payment-service |
| Admin dashboard | http://127.0.0.1:3012/admin/ |
| Database | postgresql://127.0.0.1:5432/masumi_payment_service |
| Selling wallet (Preprod V2) | addr_test1qph0kwkrcf60gyyxwjpzpv9ptnfjx7rs8xa050hqs3znywhqs3wg7pagtvzv662fxwdjdrsdmkzyfpzhfljqcc9cfmwqc7mmrp |
| Purchasing wallet (Preprod V2) | addr_test1qqvsdvusuahqcxsjc6hdylq79p8nvucs8jahts9f93j3dasr29gu8daspaasjh7htt8th96mw3hrn4mcnryktczr6zps7qchhp |

The admin key is in `masumi-payment-service/.env` as `ADMIN_KEY`.

## TOKEN2049 event workspace

| Item | Value |
| --- | --- |
| Name | TOKEN2049 Origins Hackathon 2026 |
| Organization ID | 01a109d1-32a9-71a3-a0e3-658b2a7987cd |
| Slug | token2049-origins-hackathon-2026-nws2r7 |
| Your role | member |
| DIVE Oracle access ID | 01a114a1-672f-72fa-bf8c-e0b22c226350 |
| Coworker access status | GRANTED |

## Masumi registration (on-chain)

| Item | Value |
| --- | --- |
| Name | Aiken Auditor |
| State | RegistrationConfirmed |
| Agent identifier | 67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b107680304439b670a367f183e6ef21dd38206447107e17be131eacd22d000000 |
| Registration tx | 89edb4e66535c8e39143c2d63c74c8ff66fec6cff38b41dbbb81d0b55648e28e |
| Pricing | Dynamic (see 1, write 5, audit 20 test USDM) |
| Selling wallet funding | 10,000 tADA from the Cardano faucet, tx 2e69194f9b2706dcf70d54f6ece1343e80bcfb7b4f9321b9909fee0349777fba |

## Paid test tasks

| Task | Workspace | Escrow tx | Report hash |
| --- | --- | --- | --- |
| 01a11680-3c29-77e0-a8ff-285409710ad9 | Personal | f30f054703712aa232531f4a44a94acd2044d64ed6d555fc749f8d51934e1768 | d280167819f606381dc111ac3497f867f382c0c9526a97c8eb028cbfa9cdda39 |
| 01a11684-4b92-75dc-a69e-c6a914178f86 | TOKEN2049 event | c9fb50b1d994b9dc21d0684326c691c774a3a85dd1d23fa2de31840c28c545ee | 065432740bcb07f5… |

Payout for task 01a11680: collection tx 22f242036f5f6cb944067cf010b9ad0421bd2ff8a4dc765eebca9e504b1c403c. The seller received a net 1 test USDM (checked on Blockfrost). The Sokosumi receipt says settled: true with the same tx hash.

Payout for task 01a11684 (event workspace): collection tx bb0df605e751a436325d3a7542ff85089f84fdcd135805293831afb16eb4d432, net 1 test USDM, receipt settled: true.
