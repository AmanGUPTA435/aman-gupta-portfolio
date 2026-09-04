---
title: ChainTune
summary: A Web3 music platform built on Aptos with Move smart contracts for music NFTs, artist staking, listener and artist rewards, marketplace flows, and DAO governance.
role: Smart Contract Developer
date: 2024-01-01
dateLabel: "2024"
tags: [Move, Aptos, Smart Contracts, NFTs, DeFi, DAO, Petra Wallet, IPFS]
featured: true
draft: false
---

I worked on ChainTune as part of the Inter IIT Techfest 2023 and later the Aptos Winter School Hackathon in Goa in 2024. At the Inter IIT Techfest, ChainTune scored 2nd overall based on project points, and at the Aptos Winter School Hackathon, the project won the Best Use of Move track.

My main contribution to the project was building the Move smart contracts on Aptos. The contracts handled the core on-chain parts of the application, including artist staking, music and profile NFTs, marketplace functionality, artist and listener rewards, fungible asset management, epoch-based reward accounting, and DAO governance.

The rest of the application was built around those contracts with separate artist and listener applications, a Next.js/TypeScript frontend, MongoDB, IPFS/Pinata for content storage, and Petra wallet integration.

## What We Were Building

ChainTune was designed around a music platform where artists and listeners could interact with music through Web3 ownership and rewards.

The main ideas were:

- Artists stake APT before joining the platform.
- Artists can create music releases and mint them as NFTs.
- Listeners can purchase music or album NFTs and become owners.
- NFT ownership can provide loyalty rewards based on listening activity.
- Artists earn based on the number of listens their music receives.
- Music and artwork can be stored through IPFS.
- NFT holders can receive access to private artist communities.
- A DAO provides a governance layer for community proposals and voting.

The goal was to make the blockchain part of the actual application logic rather than using it only as a payment or wallet layer.

## My Main Contribution: Move Smart Contracts

My main responsibility was working on the Move contracts that implemented the application's core on-chain behaviour.

The contracts were organized into separate modules for different parts of the system:

```text
contracts/
├── marketplace
├── staking
├── revenue
├── dao
└── supporting modules
```

This separation made it possible to reason about the protocol as several smaller pieces rather than putting the entire application's logic into one large contract.

## Artist Staking

The staking contract was designed to make artists stake APT before becoming active on the platform.

The core flow was:

```text
Artist
  │
  ▼
Connect Aptos wallet
  │
  ▼
Stake APT
  │
  ▼
Locked on-chain
  │
  ▼
Artist can continue onboarding
  │
  ▼
Reach required listener threshold
  │
  ▼
Claim / unlock stake
```

The `CT_artist_staking` module maintains locked coins for each artist and associates the lock with an unlock threshold.

The contract tracks:

- active locks
- locked coin amounts
- unlock stream thresholds
- withdrawal address
- total active locks

Artists cannot create multiple active locks for the same sponsor/recipient pair.

The contract also emits events for actions such as lock creation, updates, claims and cancellations.

## Music NFTs and Marketplace

The marketplace contract was one of the larger Move modules in the project.

It handles the creation and trading of artist and music NFTs, including profile NFTs and release/song NFTs.

The contract contains functionality for:

- profile NFT minting
- collection configuration
- token minting
- listing and delisting
- buying listed items
- changing token prices
- making offers
- accepting offers
- cancelling offers
- auctions
- bidding
- claiming auctioned tokens
- claiming auction proceeds

The marketplace keeps track of collections, tokens, listings, auctions, offers and escrowed assets on-chain.

For example, the main marketplace flow can be represented as:

```text
Artist
  │
  ▼
Create release
  │
  ▼
Mint NFT
  │
  ▼
List token
  │
  ├───────────────┐
  ▼               ▼
Fixed-price       Auction / Offer
sale              flow
  │               │
  ▼               ▼
Buyer obtains NFT
```

I worked primarily on the Move-side implementation of these flows rather than the frontend experience around them.

## Revenue and Listening Rewards

Another major part of the smart-contract system was the reward model around artist and listener activity.

The revenue contracts maintain stream-based accounting for artists and listeners.

For artists, the `CT_artist_revenue` module tracks:

- registered artists
- monthly streams
- accumulated streams
- reward thresholds
- epoch information

The corresponding user-revenue module tracks listening/download activity and the rewards associated with that activity.

The basic model is:

```text
Listening / download activity
          │
          ▼
     Stream counts
          │
          ▼
     Epoch accounting
          │
          ▼
 Accumulated streams
          │
          ▼
     Reward claim
```

The contracts use epochs to separate periods of activity. Stream information for the current epoch is recorded separately and moved into accumulated totals when the epoch advances.

This was useful for keeping reward calculations on-chain while avoiding the need to recalculate all historical activity for every claim.

## Fungible Reward Asset

The project also contains a managed fungible asset module, `CT_coin_mint`.

This module is responsible for minting and managing the project's reward asset.

It provides functionality for:

- minting
- burning
- freezing accounts
- unfreezing accounts
- withdrawals
- deposits

The revenue contracts interact with this module when rewards are distributed.

This gave us a dedicated on-chain asset for the platform's reward flows rather than representing rewards only as internal counters.

## Epoch-Based Accounting

The project has a separate `CT_epoch` module to provide the current epoch and support moving the system forward through epochs.

The epoch duration is approximately one month.

The revenue contracts use this to prevent rewards from being claimed or updated against the current epoch before it has ended.

Conceptually:

```text
Epoch N
  │
  ├── record monthly activity
  │
  ├── accumulate streams
  │
  └── wait for epoch transition
          │
          ▼
Epoch N+1
          │
          ├── finalize previous period
          └── begin new activity period
```

This was one of the more interesting parts of the contract design because reward accounting needed a clear boundary between the current period and accumulated historical activity.

## DAO Governance

ChainTune also includes a DAO module implemented in Move.

The `CT_music_dao` contract provides:

- DAO creation
- governance token setup
- proposal creation
- voting
- proposal resolution
- administrator management
- administrator veto
- DAO configuration updates

Voting is based on governance-token ownership and voting power.

A proposal has a voting period and can be resolved based on the configured threshold and voting statistics.

The contract also tracks different proposal outcomes, including:

```text
Pending
Resolved / Passed
Resolved / Not Passed
Resolved by Admin
Vetoed by Admin
```

The DAO implementation was useful for exploring how governance state, voting power, proposal lifecycle and administrator permissions can all be represented directly in Move resources.

## Move Resources and On-Chain State

A major part of working on ChainTune was getting comfortable with the Move resource model.

Rather than treating blockchain state as a collection of mutable database rows, the contracts maintain resources containing things such as:

- artist locks
- download streams
- artist revenue streams
- DAO state
- proposals
- marketplace data
- token and collection metadata
- escrowed coins and offers

For example, the staking system keeps a table mapping recipient addresses to locked resources, while the DAO keeps proposal and voting information in dedicated resources.

This forced me to think more carefully about ownership, resource movement and which account should actually control a particular piece of state.

## Frontend and Wallet Integration

The smart contracts were used by separate artist and listener applications.

The repository is structured as a monorepo with:

```text
apps/
├── artists
├── user
└── contracts
```

The frontend applications were built with Next.js and TypeScript.

Petra wallet integration was used for Aptos account connection and transaction interaction.

The artist flow included:

```text
Connect wallet
    │
    ▼
Stake APT
    │
    ▼
Artist onboarding
    │
    ▼
Create / manage releases
    │
    ▼
Mint and manage music NFTs
```

The listener side included browsing music, playing songs, purchasing NFTs, and viewing owned NFT collections.

## IPFS and Off-Chain Data

Music and artwork metadata were stored using IPFS through Pinata.

The frontend contains upload functionality that sends files to Pinata and retrieves the resulting IPFS hash.

The resulting content identifiers are then used by the application and stored alongside the relevant on-chain or off-chain records.

This gave the application a split between:

```text
Blockchain
  │
  ├── ownership
  ├── staking
  ├── rewards
  ├── marketplace state
  └── governance

Off-chain / IPFS
  │
  ├── audio
  ├── images
  └── metadata
```

## Hackathons

ChainTune was built across two hackathon settings.

The project was originally developed for the **Inter IIT Techfest 2023** and was later taken to the **Aptos Winter School Hackathon in Goa in 2024**.

At the Aptos Winter School Hackathon, the project won the **Best Use of Move** track.

That experience was particularly useful because the project had to be more than an isolated smart contract. We had to connect the Move contracts to an actual Web3 application with wallet flows, frontend interactions, content storage and different user roles.

## What I Learned

My biggest takeaway from ChainTune was getting comfortable designing application logic in Move rather than thinking about smart contracts only as individual functions.

I worked through problems around:

- Move resources and ownership
- tables and on-chain state
- access control
- NFT minting and ownership
- escrow and marketplace flows
- staking and locked assets
- epoch-based accounting
- reward distribution
- governance and voting
- wallet-driven transaction flows

The project also gave me a better understanding of how the contract layer needs to fit with everything around it. A smart contract can enforce ownership and financial rules, but the actual product still needs wallet integration, content storage, backend data and a usable application around it.

## Project Status

ChainTune was built as a hackathon project and is not intended to be presented as a production music platform.

The project remains valuable to me primarily because it was a substantial hands-on Move project where I worked on the core smart-contract layer and then integrated those contracts with a larger Web3 application.
