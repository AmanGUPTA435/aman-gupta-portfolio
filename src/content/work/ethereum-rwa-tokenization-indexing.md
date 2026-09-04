---
title: Ethereum RWA Tokenization & Indexing Platform
summary: A full-stack Ethereum project for tokenizing real-world assets, indexing on-chain activity, and exposing the resulting state through a backend API.
role: Independent Project
date: 2026-01-01
dateLabel: Ongoing
tags: [Solidity, Foundry, Ethereum, Node.js, Ethers.js, PostgreSQL, Indexing]
featured: true
draft: false
---

I built this project to explore what a real-world asset tokenization system looks like beyond the smart contract itself. It combines a Solidity asset registry with ERC-20 and ERC-721 token contracts, a Node.js indexer that processes on-chain events, PostgreSQL for indexed state, and an Express API for querying that data.

The main focus was understanding the full flow from asset registration and token transfers on Ethereum to the backend systems needed to index, store and serve that data.

## Architecture

The project is split into an on-chain protocol layer and an off-chain indexing and API layer.

```text
                          Ethereum / EVM
                                │
                         AssetRegistry
                                │
                   ┌────────────┴────────────┐
                   │                         │
             ERC-20 AssetToken         ERC-721 AssetNFT
                   │                         │
            Fractional ownership       Unique ownership
                   │                         │
                   └────────────┬────────────┘
                                │
                              Events
                                │
                                ▼
                         Node.js Indexer
                                │
                  ┌─────────────┼─────────────┐
                  │             │             │
                  ▼             ▼             ▼
               assets       transfers    ownership state
                                            │
                                  ┌─────────┴─────────┐
                                  │                   │
                           token_balances      token_ownership
                                  │                   │
                                  └─────────┬─────────┘
                                            ▼
                                        PostgreSQL
                                            │
                                            ▼
                                      Express REST API
                                            │
                                            ▼
                                      API consumers
```

The `AssetRegistry` remains the authoritative source for asset lifecycle and verification state. The database is a derived representation used for querying and application-facing APIs.

## Asset Registry

The `AssetRegistry` contract is responsible for registering and managing tokenized assets.

Each asset stores information such as:

- Asset ID
- Name
- Asset type
- Token standard
- Valuation
- Total token supply
- Token contract address
- Issuer
- Asset lifecycle status
- Verification state
- Document hash
- Verifier
- Verification expiry
- Status updater

The supported asset types are:

- Real estate
- Private equity
- Debt
- Commodity

The asset lifecycle currently includes:

```text
Pending
Active
Paused
Closed
Rejected
```

Verification has its own state machine:

```text
Pending
Verified
Rejected
Expired
```

The registry also controls authorized issuers and administrator-only verification and lifecycle operations.

I wanted the registry to handle more than token deployment. It acts as the place where the protocol keeps the authoritative state of the underlying asset and determines whether that asset can currently be transferred.

## ERC-20 and ERC-721 Tokenization

Each registered asset receives its own token contract based on the selected token standard.

### ERC-20

ERC-20 assets represent fractional ownership.

```text
Asset #1
Real Estate Asset
    │
    ▼
AssetToken
ERC-20
0x...
```

This gives each tokenized ERC-20 asset its own dedicated token contract.

### ERC-721

ERC-721 assets represent unique ownership.

```text
Asset #2
Unique Asset
    │
    ▼
AssetNFT
ERC-721
0x...
```

The current implementation represents the asset as a single NFT and uses the asset ID as the token ID.

The two standards share the same registry but model ownership differently. ERC-20 assets maintain fungible balances, while ERC-721 assets maintain ownership of a specific token ID.

ERC-1155 is being evaluated separately for future use cases involving multiple token classes or semi-fungible representations, but it is not currently part of the implementation.

## Transfer Restrictions

One of the parts I wanted to make explicit on-chain was the relationship between asset verification and token transfers.

Both token implementations consult:

```solidity
AssetRegistry.isAssetTransferable(assetId)
```

before allowing secondary transfers.

The asset must be:

```text
Active
+
Verified
+
Verification not expired
```

This means transferability is enforced by the token contracts themselves rather than relying on the backend or frontend to enforce the rule.

The administrator can also pause or close an asset, which prevents transfers even if the token holder otherwise has enough balance.

This makes the asset lifecycle part of the transfer rules instead of treating the token and the underlying asset as completely separate systems.

## Event-Driven Blockchain Indexer

The off-chain side of the project is a Node.js indexer built with `ethers`.

The indexer continuously turns blockchain events into queryable PostgreSQL state.

It indexes:

- `AssetRegistered`
- ERC-20 `Transfer`
- ERC-721 `Transfer`
- Asset verification updates
- Asset status updates

A simplified flow looks like:

```text
Ethereum blocks
      │
      ▼
Node.js indexer
      │
      ├── AssetRegistered
      ├── VerificationUpdated
      ├── StatusUpdated
      └── Transfer
              │
              ▼
         PostgreSQL
```

Instead of knowing every token contract in advance, the indexer discovers newly registered token addresses from the `AssetRegistry`.

It also tracks the token standard for each token address so the same ERC-20/ERC-721 `Transfer` event signature can be decoded and processed according to the correct ownership model.

## Block Processing

The indexer processes blockchain data in bounded ranges rather than attempting to scan an arbitrary historical range in one operation.

The current implementation processes blocks in batches of 1000 and uses a five-block confirmation depth before indexing a block range.

The basic flow is:

```text
latest block
     │
     ▼
subtract confirmation depth
     │
     ▼
safe block
     │
     ▼
process bounded block range
     │
     ▼
commit database changes
     │
     ▼
store checkpoint
```

The last processed block is stored in the `indexer_state` table, allowing the indexer to resume from its previous checkpoint after a restart.

Each batch is processed transactionally. If processing fails, database writes are rolled back and the checkpoint remains unchanged, allowing the batch to be retried.

The indexer also uses duplicate protection for transfer events through `(transaction_hash, log_index)`, and the materialized balance updates are applied only when a new transfer record is inserted.

## Transfer Indexing

ERC-20 and ERC-721 transfers use the same `Transfer` event topic, but the event has different semantics for the two standards.

The indexer therefore maintains a token-address-to-standard mapping and processes the event according to the registered token type.

For ERC-20 transfers, the indexer reads:

```text
from
 to
amount
```

and updates the materialized balance state.

For ERC-721 transfers, the event contains a token ID and the indexer updates the current owner of that specific NFT.

Transfer records are identified using:

```text
(transaction_hash, log_index)
```

so an already-indexed log is not inserted again.

Transfer discovery uses filtered `eth_getLogs` queries across the token contracts discovered through the registry rather than issuing a separate transfer query for every token contract.

## PostgreSQL

The database stores both historical blockchain activity and derived current state.

### `assets`

Stores the latest indexed state of each asset, including its token standard, metadata, lifecycle state, verification state, token address, issuer and verification information.

### `transfers`

Stores historical transfer events for both ERC-20 and ERC-721 assets.

Each record includes:

- Block number
- Transaction hash
- Log index
- Token address
- Sender
- Recipient
- Amount

For ERC-20 transfers, `amount` represents the transferred fungible quantity.

For ERC-721 transfers, it is stored as `1`.

### `token_balances`

Stores current materialized ERC-20 balances:

```text
(token_address, holder_address) → balance
```

This allows holder and balance queries without reconstructing the complete transfer history for every request.

### `token_ownership`

Stores current ERC-721 ownership:

```text
(token_address, token_id) → owner_address
```

### `indexer_state`

Stores the last processed block used by the indexer as its synchronization checkpoint.

## REST API

The API is currently read-oriented and exposes the indexed blockchain state through Express.

### Assets

```http
GET /assets
GET /assets/:id
```

Asset discovery supports pagination and filtering by things such as:

- Token standard
- Asset type
- Issuer
- Asset status
- Verification status

For example:

```http
GET /assets?token_standard=ERC20
GET /assets?token_standard=ERC721
GET /assets?limit=50&offset=0
GET /assets?asset_status=Active
GET /assets?verification_status=Verified
GET /assets?asset_type=RealEstate
GET /assets?issuer=0x...
```

Filters can also be combined.

Pagination responses include the configured limit and offset, the total number of matching results, and whether another page is available.

### Asset Transfers

```http
GET /assets/:id/transfers
```

Returns paginated transfer history for a specific asset.

### Asset Holders

```http
GET /assets/:id/holders
GET /assets/:id/holders/:address
```

The ownership API uses the underlying token standard to determine what ownership data is returned.

For ERC-20 assets, holder queries expose current balances.

For ERC-721 assets, they expose the current owner of the NFT.

### Global Transfers

```http
GET /transfers
```

Global transfer history supports pagination and filtering by sender, recipient and token address:

```http
GET /transfers?from=0x...
GET /transfers?to=0x...
GET /transfers?token=0x...
```

### Address Transfer History

```http
GET /addresses/:address/transfers
```

Returns indexed transfers in which the address participated as either the sender or recipient.

### Token Balances

```http
GET /balances/:token/:address
```

Returns the current materialized balance for a holder for a specific token contract.

### API Validation

The API validates inputs such as:

- Ethereum addresses
- Pagination parameters
- Asset types
- Asset lifecycle status
- Verification status

Invalid requests return structured error responses rather than passing invalid values directly to the database layer.

## Local Development & Integration Testing

The project uses:

- Anvil for local Ethereum execution
- PostgreSQL for indexed blockchain data
- Foundry for Solidity compilation, scripting and testing
- Node.js for the indexer
- Express for the REST API

There is also a local integration script that automates the main blockchain-to-database flow.

```text
scripts/test-local.sh
```

The script resets indexed database state, deploys a fresh test registry, registers and verifies an asset, performs transfers, captures the deployed registry address, runs the indexer and prints the indexed results and checkpoint.

This gives the project a repeatable local path for testing the interaction between the contracts, indexer, database and API.

## Testing

The Solidity side of the project uses Foundry across multiple testing layers.

### Deterministic tests

The test suite covers:

- Asset registration
- Input validation
- Issuer authorization
- Administrator authorization
- Verification and rejection
- Lifecycle transitions
- Transfer restrictions
- Verification expiry
- Token configuration
- Terminal states
- Supply boundaries

### Fuzz testing

Fuzz tests explore different registration inputs, transfer amounts, transfer attempts before verification, transfer attempts after expiry and token-supply boundaries.

### Invariant testing

Stateful invariant tests validate protocol properties such as:

- Total token supply conservation
- Holder balance conservation
- Transfer restrictions while assets are paused
- Consistency between asset and verification states across randomized lifecycle operations

These tests are useful for a stateful protocol because correctness depends on sequences of operations rather than isolated function calls.

## Security Review

I also ran Slither against the Solidity contracts and reviewed the reported findings individually.

The protocol's main trust assumptions are explicit in the current V1 design.

The administrator can:

- Authorize issuers
- Verify assets
- Reject assets
- Pause or close assets

Authorized issuers can register assets but cannot independently verify, reject or alter the lifecycle state of those assets.

The current design intentionally treats the administrator as a trusted authority. A production deployment could replace the single administrator with multisig or more granular role-based governance.

## Design Decisions

### On-chain state vs off-chain state

The contracts remain authoritative for asset lifecycle, verification and transferability.

PostgreSQL is treated as a derived read model rather than the source of truth.

This keeps protocol rules on-chain while allowing the backend to provide efficient application-facing queries.

### Historical events vs materialized state

The project stores both original transfer events and current ownership/balance state.

Historical events are useful for activity and audit-style queries, while materialized state makes common balance and ownership queries much simpler.

### Token-standard-aware indexing

ERC-20 and ERC-721 both emit `Transfer`, but the meaning of the event differs between the two standards.

Tracking the token standard for each registered contract lets the indexer share the same discovery pipeline while still applying the correct ownership logic.

### Batch processing

Processing blocks in bounded ranges makes synchronization easier to restart and reason about.

The persistent checkpoint and transactional database writes allow a failed batch to be retried without advancing the checkpoint prematurely.

## What I Learned

The part I found most useful was working through the boundary between the smart contracts and the backend.

Deploying an ERC-20 or ERC-721 contract is only one part of the problem. Once an application needs to search assets, show transfer history, query balances or determine current ownership, you need infrastructure that can continuously turn blockchain events into useful application state.

Building the indexer made me think much more carefully about things like:

- Block checkpoints
- Confirmation depth
- Event identity
- Batching
- Transactional database writes
- Replaying historical events
- Materialized state
- Keeping on-chain and off-chain state aligned

It also made the difference between historical blockchain data and application-friendly state much clearer to me.

## Current Status

The project is ongoing.

The core tokenization, asset registry, indexing, PostgreSQL and REST API pieces are implemented, along with Foundry unit tests, fuzz tests, invariant tests and static analysis.

Current work includes improving reorg handling, historical backfill tooling, observability, integration coverage and production-oriented operational concerns.

ERC-1155 is also being evaluated separately for future use cases involving multiple token classes or semi-fungible asset representations, but it is not currently part of the implementation.
