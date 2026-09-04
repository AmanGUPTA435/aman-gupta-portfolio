---
title: How an Ethereum Event Indexer Works
summary: A practical look at turning on-chain events into queryable application state, from block synchronization and event decoding to PostgreSQL and APIs.
date: 2026-09-03
dateLabel: Technical Note
tags: [Ethereum, Blockchain, Indexing, Rust, PostgreSQL, Backend, Distributed Systems]
draft: false
---

When I started building blockchain backends, one of the parts that interested me most was the gap between what exists on-chain and what an application actually needs to query.

A smart contract can emit an event, but an application usually does not want to scan the chain from the beginning every time it needs to answer a question. An indexer sits in between: it reads blockchain events, turns them into structured records, stores them in a database and exposes that state to the rest of the application.

I have worked on this from two different angles: in my own Ethereum RWA tokenization project, and professionally at Supra while working on a Rust-based governance tracker. The implementations are different, but the basic problem is the same.

## The basic flow

A useful mental model is:

```text
Blockchain
    |
    | blocks / events
    v
Event Source
    |
    | decode + transform
    v
Indexer
    |
    | database writes
    v
PostgreSQL
    |
    | queries
    v
Backend API / Application
```

The indexer's job is not simply to copy blockchain data into a database. It has to decide what events matter, how they map to application entities, what state should be materialized, where synchronization should resume, and what happens when processing fails.

## 1. Start with events, not with database tables

The first thing I try to understand is the event model of the contracts or protocol being indexed.

For the Ethereum RWA project, the important sources are the asset registry and the ERC-20/ERC-721 contracts. The indexer needs to understand events such as asset registration and token transfers.

A transfer event contains enough information to reconstruct useful application state:

```text
ERC-20
from + to + amount

ERC-721
from + to + tokenId
```

The raw event is historical information. The application usually needs something more convenient, such as:

```text
current balance
current NFT owner
asset status
transfer history
```

That distinction is one of the most important ideas in blockchain indexing:

> the chain gives you events and state, while the application often wants a queryable read model.

## 2. The indexer needs a synchronization strategy

A first version of an indexer can simply scan from block A to block B. The problem is that a real service needs to keep doing this over time and needs to recover after restarts.

In my Ethereum indexer, I process bounded block ranges rather than requesting an unlimited historical range in one call. The indexer keeps a checkpoint for the last successfully processed block.

The general loop looks like:

```text
last processed block
        |
        v
choose next block range
        |
        v
fetch events
        |
        v
process + write to DB
        |
        v
commit transaction
        |
        v
advance checkpoint
```

The important ordering is that the checkpoint should only move forward after the corresponding database work has succeeded.

Otherwise a failure can leave the database missing data while the checkpoint incorrectly tells the service that those blocks have already been processed.

## 3. Confirmation depth changes what "latest" means

For live indexing, there is a difference between the newest block and a block that is safe enough to index for application purposes.

My Ethereum indexer uses a confirmation depth before processing the newest part of the chain. The idea is simple:

```text
latest chain tip
       |
       | confirmation depth
       v
safe processing point
```

This reduces the amount of very recent chain activity that the indexer treats as final.

The exact policy depends on the chain and application. An indexer for an exchange, a dashboard and an accounting system may all choose different confirmation requirements.

## 4. Decode once, then create the application's model

The raw blockchain event is usually not the final shape that an API wants.

For example, in the RWA project a transfer event is converted into both historical and current-state records.

```text
Transfer event
      |
      +--------------------+
      |                    |
      v                    v
historical transfer     current state
      |                    |
      v                    v
 transfers table     token_balances /
                     token_ownership
```

That gives two different views of the same chain activity.

The historical record answers questions such as:

```text
What transfers happened?
When did they happen?
Which addresses were involved?
```

The materialized state answers:

```text
Who owns this NFT now?
How many tokens does this address hold now?
```

Without materialized state, the backend would need to replay an asset's full transfer history for many ordinary queries.

## 5. Different token standards can share an event shape

One interesting example from the RWA project is ERC-20 versus ERC-721 indexing.

Both standards expose a `Transfer` event, but the meaning is different.

For ERC-20:

```text
Transfer(from, to, amount)
```

For ERC-721:

```text
Transfer(from, to, tokenId)
```

So the indexer can share the event discovery mechanism while keeping the processing logic aware of the token standard.

Conceptually:

```text
                 Transfer event
                       |
                       v
              token address lookup
                       |
              +--------+--------+
              |                 |
             ERC-20           ERC-721
              |                 |
              v                 v
       update balance      update ownership
```

This is a useful pattern beyond token indexing: share the parts of a pipeline that are genuinely common, but preserve the semantics that differ.

## 6. My Supra work used the same problem in a different form

At Supra, I worked on a Rust-based governance tracker that turned governance events from the chain into queryable PostgreSQL state.

The indexed entities were different from the Ethereum project. Instead of token transfers, the service dealt with governance proposals, votes and resolution events.

The pipeline looked roughly like:

```text
Supra chain events
      |
      +--> proposal creation
      +--> votes
      +--> resolution
      +--> proposal configuration
      |
      v
Rust event processing
      |
      +--> assemble event data
      +--> resolve block/timestamp information
      +--> group related updates
      v
PostgreSQL
      |
      +--> proposals
      +--> votes
      +--> resolutions
      +--> synchronization metadata
      |
      v
Axum API
```

This service also had both historical synchronization and a live polling path.

For historical data, the service could read from an archive database and process block ranges in batches. Once it was caught up, it switched to event-provider based processing for new events.

That separation is useful because bootstrapping historical data and staying synchronized with a live chain are related problems, but they have different operational characteristics.

## 7. Block ranges make failures easier to reason about

The Supra tracker processes blocks in bounded increments.

The simplified model is:

```text
0 ----10----20----30----40----50---->
      batch   batch   batch   batch
```

Each batch can be processed independently enough that failures are easier to localize.

The service keeps synchronization metadata in PostgreSQL and can load the last processed block when it starts.

A restart therefore becomes:

```text
read checkpoint
      |
      v
resume from known position
```

instead of starting the entire indexing process again.

## 8. Database transactions matter

An indexer usually performs more than one database operation for a single batch.

For example, processing votes may require:

```text
insert individual votes
        +
update proposal vote counts
```

Those changes should represent one logical indexing step.

Using a database transaction gives:

```text
BEGIN
  insert events
  update derived state
COMMIT
```

If something fails before the commit, the batch can be rolled back rather than leaving half of the derived state updated.

This is especially important when the synchronization checkpoint is also being advanced.

## 9. Duplicate events and idempotency

A blockchain indexer has to assume that the same logical work may be encountered more than once.

The exact strategy depends on the protocol and storage model, but the goal is to make reprocessing safe.

In the Ethereum RWA indexer, transfer records use the transaction hash and log index as part of the event identity. That gives the database a stable way to distinguish one event from another.

The broader pattern is:

```text
same event processed twice
          |
          v
same database identity
          |
          v
second application is a no-op
```

This matters because restart logic, retries and backfills naturally create situations where a service may encounter data it has already seen.

## 10. Historical indexing and live indexing are different modes

A production-oriented indexer often needs two paths.

### Historical sync

Used for bootstrapping:

```text
start block
    |
    v
large number of bounded ranges
    |
    v
populate database
```

### Live sync

Used after the database is close to the chain tip:

```text
current checkpoint
       |
       v
wait for new events
       |
       v
process next window
       |
       v
repeat
```

The Supra governance tracker explicitly supports this transition: it can first synchronize historical data from an archive source and then continue with a live event stream.

## 11. APIs should expose application state, not force every client to understand the chain

Once the data is indexed, the next problem is making it useful.

In the RWA project, the backend exposes endpoints for assets, transfers, balances and ownership.

In the governance tracker I worked on at Supra, the API exposes queries for:

- proposals
- votes for a proposal
- resolution history
- a voter's history
- voter statistics

The API therefore becomes a read layer over indexed state rather than making every consumer understand RPC calls, event formats and block scanning.

## 12. What I think about when building an indexer now

The implementation details vary from project to project, but I usually think about the same questions:

### What is the source of truth?

For a blockchain system, on-chain state and events are generally authoritative. The database should be treated as derived state unless the application has a different explicit trust model.

### What is the checkpoint?

The service needs a clear answer to: "What has been processed successfully?"

### What happens if the process crashes?

A restart should have a deterministic place to resume from.

### What happens if the same event is seen twice?

The data model should make duplicate processing safe where possible.

### What state should be materialized?

Store historical data when it is useful, but materialize common current-state queries so the API does not have to reconstruct them from scratch.

### What happens near the chain tip?

Recent blocks may not be as safe as older ones, so confirmation policy matters.

### How do historical backfills work?

A service that can only process the live tip is difficult to bootstrap and recover.

## What I learned

The main thing I took away from building and working on indexers is that indexing is much more than reading events and inserting rows into PostgreSQL.

The interesting part is designing a reliable translation between two different models of state:

```text
blockchain history + protocol state
                |
                v
        deterministic processing
                |
                v
       application read model
```

Working on the Ethereum RWA project gave me a chance to design this from scratch around ERC-20/ERC-721 events. Working on the governance tracker at Supra gave me experience with the same class of problem in a production Rust environment, including historical synchronization, live event processing, PostgreSQL transactions and application-facing APIs.

That is one of the areas of blockchain infrastructure I want to keep working on because it combines the parts of backend engineering I enjoy most: asynchronous services, data pipelines, state management, databases and working directly with the underlying chain.
