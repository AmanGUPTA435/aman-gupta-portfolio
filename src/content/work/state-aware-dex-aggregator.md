---
title: DEX Aggregator
summary: Building a DEX routing system with pool state, graph-based route discovery, split allocation, and atomic on-chain execution
role: Independent Project
date: 2026-09-08
dateLabel: Ongoing
tags: [Rust, Solidity, Ethereum, DeFi, DEX, AMM, Routing, Alloy, Foundry, Tokio, Blockchain]
featured: true
draft: false
---

I am building this project to understand the engineering behind a DEX aggregator rather than treating routing as a simple "find the pool with the best price" problem.

The system has two main parts. A Rust routing engine discovers candidate swap paths, synchronizes pool reserves from the blockchain, simulates competing allocations against mutable pool state, and turns the selected plan into ABI-encoded execution steps. A Solidity execution layer then validates the targets and executes the complete plan in one transaction.

The most interesting part of the project is the interaction between route selection and changing liquidity. Two apparently independent routes can share a downstream pool, so consuming liquidity on one route changes the price available to the other. The current implementation models that shared state explicitly and uses it during split allocation.

## What I Wanted to Build

The basic problem is:

```text
Given:
    input token
    output token
    input amount

Find:
    one or more useful swap routes
    an allocation across those routes
    an execution order

Such that:
    simulated output is high
    shared pool state is respected
    the resulting plan can be executed atomically on-chain
```

A single-path router can quote a route against the current reserves and stop there. A split router has a harder problem because each executed swap changes the reserves that later swaps depend on.

This project is structured around that problem.

## Architecture

The current architecture is split between an off-chain Rust engine and a Solidity execution layer.

```text
                         Blockchain / RPC
                               |
                         read pool state
                               |
                               v
                     +---------------------+
                     | Rust Routing Engine  |
                     +---------------------+
                               |
                +--------------+--------------+
                |                             |
                v                             v
          Token / pool graph          Pool synchronization
                |                             |
                +--------------+--------------+
                               v
                    Candidate route discovery
                               |
                               v
                    Route dependency graph
                               |
                               v
                  State-aware split allocation
                         + simulation
                               |
                               v
                      Ordered execution plan
                               |
                               v
                       ABI calldata builder
                               |
                               v
                  +-------------------------+
                  | Solidity QuoteAggregator|
                  +-------------------------+
                               |
                         approved pools
                               |
                               v
                     Atomic multi-hop swaps
                               |
                               v
                          Final output
```

The Rust side is responsible for routing intelligence. The Solidity side is deliberately generic: it receives encoded execution steps and performs them against approved pool contracts.

## Rust Module Structure

```text
aggregator/src/
├── cli.rs
├── constants.rs
├── contracts.rs
├── execute.rs
├── graph.rs
├── lib.rs
├── main.rs
├── quote.rs
├── scoring.rs
├── simulation.rs
├── state.rs
└── types.rs
```

The main responsibilities are:

| Module | Responsibility |
|---|---|
| `cli.rs` | CLI arguments, RPC configuration and environment address helpers |
| `constants.rs` | Router gas constants |
| `contracts.rs` | Alloy-generated Solidity bindings |
| `types.rs` | Pools, graph edges, routes and execution-plan types |
| `state.rs` | Read and synchronize pool reserves from the chain |
| `graph.rs` | Token graph construction, bounded route discovery and route dependencies |
| `quote.rs` | AMM quote calculations |
| `scoring.rs` | Route score calculation using output value and gas cost |
| `simulation.rs` | Mutable pool-state simulation and split allocation |
| `execute.rs` | Execution-step creation, ABI encoding and transaction submission |
| `main.rs` | End-to-end orchestration |

## 1. Load Pool State From the Chain

The aggregator starts from a set of configured AMM pool addresses.

For each pool, the Rust service reads:

```text
pool address
    |
    +--> tokenA()
    +--> tokenB()
    +--> getReserves()
```

The resulting data is represented locally as:

```rust
pub struct Pool {
    pub address: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: U256,
    pub reserve_b: U256,
}
```

Route edges then store reserves from the perspective of the direction in which the swap is being considered.

For example, a pool containing `A/B` becomes two graph edges:

```text
A -> B
B -> A
```

The same physical pool therefore supports both swap directions while retaining the correct input-side and output-side reserves.

## 2. Build a Token Graph

Once the pool data is available, the router constructs a token graph where tokens are nodes and pools are directed swap edges.

For example:

```text
          AMM1
      A ---------> B
      |             |
  AMM3|             |AMM4
      |             |
      v             v
      C <-----------
```

The current local topology contains:

```text
AMM1: A / B
AMM2: A / B
AMM3: A / C
AMM4: B / C
```

This intentionally creates multiple ways to reach the same destination.

## 3. Discover Candidate Routes With Bounded DFS

Candidate paths are discovered using depth-first search with a visited-token set and a hop limit.

The current router allows up to three hops.

For the test topology, that produces routes such as:

```text
Route 0:
A -> B -> C
AMM1     AMM4

Route 1:
A -> B -> C
AMM2     AMM4

Route 2:
A -> C
AMM3
```

The important distinction is that Route 0 and Route 1 have the same token path but use different liquidity for the first hop.

They are therefore different routes from the allocator's perspective.

The route search also carries the current amount through the path, so later hops can be quoted using the output of the previous hop.

## 4. Quote Each Route Using the AMM Invariant

The current test AMM uses a constant-product style formula with a 0.3% swap fee.

The quote calculation is:

```text
amountInWithFee = amountIn × 997

amountOut =
    (amountInWithFee × reserveOut)
    /
    (reserveIn × 1000 + amountInWithFee)
```

A multi-hop quote is evaluated one hop at a time:

```text
A -> B
     |
     | output becomes next input
     v
B -> C
     |
     v
final C output
```

The important part is that the output of one hop is not just a display value. It becomes the exact simulated input for the next hop.

## 5. Synchronize Route Reserves With the Current Chain State

Routes are first discovered from the configured pool topology, but the aggregator does not rely on the reserves that were present when the graph was created.

Before allocation, it refreshes the relevant pool state from the blockchain:

```text
candidate routes
      |
      v
read getReserves()
      |
      v
rebuild directional edge reserves
      |
      v
state synchronized with chain
```

This gives the simulator a concrete starting state for the current transaction attempt.

## 6. Model Shared Liquidity Explicitly

This is the core part of the project.

Consider:

```text
Route 0: A -> B via AMM1 -> B -> C via AMM4
Route 1: A -> B via AMM2 -> B -> C via AMM4
```

Both routes use `AMM4` for the final hop.

A naive split allocator might quote Route 0 and Route 1 independently against the same original `B/C` reserves:

```text
original AMM4 state
      |
      +--> quote Route 0
      |
      +--> quote Route 1
```

That is not what happens during execution. Once Route 0 consumes liquidity from AMM4, the reserves seen by Route 1 have changed.

This project therefore keeps a mutable simulated state and updates every route's view of a shared pool after each simulated swap.

## 7. Simulate Candidate Allocations Against Mutable State

The allocator processes the input amount in fixed-size chunks.

For every chunk, it evaluates each candidate route from the same current state.

Conceptually:

```text
Current state S0
      |
      +---- candidate Route 0 ----> S0'
      |
      +---- candidate Route 1 ----> S0''
      |
      +---- candidate Route 2 ----> S0'''
      |
      v
 choose best candidate
      |
      v
 commit winning state S1
```

Each candidate starts from a clone of the current state.

That matters because a candidate route represents a hypothetical choice. Testing Route 0 must not permanently modify the state before Route 1 is evaluated.

Only the winning candidate state is committed for the next chunk.

For a simulated swap:

```text
reserveIn  += amountIn
reserveOut -= amountOut
```

The reverse directional edge for the same physical pool is updated as well.

So if one route changes a pool from:

```text
A -> B
```

the corresponding:

```text
B -> A
```

view sees the same underlying reserve change.

## 8. Greedy Split Allocation

The current allocator is intentionally simple and explicit rather than pretending to be a globally optimal optimizer.

The input is divided into chunks:

```text
amountIn
  |
  +--> chunk 1
  +--> chunk 2
  +--> chunk 3
  +--> ...
```

For each chunk, every route is simulated and the route producing the best incremental output is selected.

The result contains both total allocation and execution order.

For example:

```text
Allocations
-----------
Route 0: 30
Route 1: 50
Route 2: 20

Execution plan
--------------
Route 1 / 10
Route 0 / 10
Route 1 / 10
Route 2 / 10
...
```

The order is important because the first swap changes the state used to evaluate later swaps.

The current implementation therefore treats allocation and execution ordering as related problems rather than producing a split and then arbitrarily executing it.

The tradeoff is that the current chunk-based greedy algorithm does not guarantee a globally optimal allocation across all routes.

## 9. Route Scoring and Gas Model

The router also calculates a simple route score based on expected output value minus an estimated gas cost.

Conceptually:

```text
output value in USD
        -
gas estimate × gas price × native-token price
        =
route score
```

The current implementation uses coarse constants for router and hop gas costs and fixed example prices in the local test setup.

The score is useful as part of the routing model, but the current split allocator selects candidates by simulated incremental output rather than using the score as its complete optimization objective.

This is one of the areas intended for further development.

## 10. Turn the Plan Into ABI-Encoded Execution Steps

After allocation, the Rust engine replays the chosen execution order against the simulated state and constructs Solidity execution objects.

The execution type is:

```solidity
struct Execution {
    address target;
    address tokenIn;
    uint256 amountIn;
    bytes data;
}
```

For each hop, Rust constructs the AMM swap call and ABI-encodes it with Alloy:

```rust
let call = AMMPool::swapCall {
    tokenIn: edge.token_in,
    amountIn: hop_amount_in,
    minAmountOut: min_amount_out,
};

let data = call.abi_encode();
```

The execution builder uses the same simulated state transitions as the allocator while generating the final call sequence.

That means the calldata is created for the exact order that the simulator selected.

## 11. Generic Solidity Execution Layer

The Solidity contract is intentionally separated from the routing algorithm.

`QuoteAggregator` accepts a sequence of generic execution steps rather than requiring the Rust router to know about a specific DEX implementation.

The flow is:

```text
Trader
  |
  | approve input token
  v
QuoteAggregator
  |
  | transfer input tokens
  v
Execution 1
  |
  v
Execution 2
  |
  v
Execution N
  |
  v
final output token
  |
  v
Trader
```

For every step, the contract:

1. checks that the target pool is approved by the registry
2. checks basic execution arguments
3. approves the target to spend the input token
4. performs the encoded low-level call
5. clears the approval
6. emits an execution event

The executor measures the final token balance change and then checks it against the transaction-level minimum output.

## 12. Pool Registry as an Execution Trust Boundary

The project keeps pool authorization separate from swap execution.

`PoolRegistry` maintains a mapping of approved pool addresses:

```text
PoolRegistry
    |
    +--> AMM1 approved
    +--> AMM2 approved
    +--> AMM3 approved
    +--> AMM4 approved
```

The execution contract refuses to call a target that is not approved by the registry.

This creates a small explicit trust boundary between:

```text
routing decision
       |
       v
encoded execution target
       |
       v
registry validation
       |
       v
actual external call
```

The current project uses a manually configured registry. A more complete system could evolve this toward a richer adapter or factory/discovery model.

## 13. On-Chain Quote Support

The Solidity execution contract also contains quote functions that evaluate a supplied path against the current pool reserves.

The quote API accepts:

```text
input token
output token
input amount
paths
pools
```

and can return the best final output across the supplied candidate paths.

A route quote also returns the intermediate amounts for every hop:

```text
amountIn
   |
   v
hop 1 output
   |
   v
hop 2 output
   |
   v
final amountOut
```

The main routing pipeline currently performs the more sophisticated route discovery and split simulation off-chain in Rust.

## 14. Transaction-Level Slippage

The current prototype applies a 1% minimum-output tolerance at the final transaction level.

The simulated final output is converted into:

```text
amountOutMin = simulatedOutput × 99 / 100
```

For the first correctness-focused execution path, individual AMM calls use the simulated hop output as their `minAmountOut`.

That is intentionally strict and useful for testing simulation correctness, but it is not yet a complete production slippage policy.

A production router would need a more deliberate treatment of per-hop tolerances, transaction-level protection, stale state and execution-time price movement.

## 15. Atomic Multi-Hop Execution

The complete plan is submitted as one call to `QuoteAggregator.execute`.

Conceptually:

```text
execution plan
      |
      v
one Solidity call
      |
      +--> swap 1
      +--> swap 2
      +--> swap 3
      +--> ...
      |
      v
final output check
```

Because the steps are performed inside the same EVM transaction, a failing step reverts the transaction rather than leaving a partially executed route.

The Rust side then checks the trader's token-out balance before and after the transaction to calculate the actual received amount.

## Correctness Validation

One of the main goals of the project is to make the local simulation agree with real on-chain reserve transitions.

The current end-to-end validation produced:

```text
Simulated output: 552782643753440975662
Actual output:    552782643753440975662
Perfect match: simulation == on-chain execution.
```

This is an important milestone because the routing engine is not useful if its local reserve model diverges from the execution semantics of the contracts.

For the tested pool topology and execution plan, the simulation reproduced the same final output as the actual transaction.

## Local Test Topology

The current local setup uses three ERC-20 test tokens and four AMM pools:

```text
Token A <----> Token B
   |              |
   |              |
   +---- AMM3     +---- AMM4
   |              |
   v              v
Token C <---------+
```

More precisely:

```text
AMM1: Token A / Token B
AMM2: Token A / Token B
AMM3: Token A / Token C
AMM4: Token B / Token C
```

This topology is intentionally useful for testing both:

```text
parallel liquidity
A -> B via AMM1
A -> B via AMM2
```

and:

```text
shared downstream liquidity
AMM1 -> AMM4
AMM2 -> AMM4
```

The setup script deploys the test tokens, AMMs, registry and aggregator, configures the approved pools, seeds liquidity and funds a local trader account.

## Solidity Components

The on-chain side currently contains:

```text
src/
├── aggregator/
│   └── QuoteAggregator.sol
├── amm/
│   └── AMMPool.sol
├── interfaces/
│   └── IAMMPool.sol
├── pool_registry/
│   └── PoolRegistry.sol
└── tokens/
    ├── TokenA.sol
    ├── TokenB.sol
    └── TokenC.sol
```

### `AMMPool`

The test AMM implements:

- constant-product style quoting
- 0.3% swap fee
- two-token liquidity pools
- reserve synchronization
- liquidity add/remove operations
- swaps in either token direction

The swap implementation measures the actual input token amount received by the pool before calculating output, which keeps the reserve update tied to what the pool actually received.

### `QuoteAggregator`

The aggregator contract provides:

- candidate route quote evaluation
- route quote calculation
- generic execution steps
- approved-target validation
- atomic execution
- final output/slippage verification
- execution events

### `PoolRegistry`

A simple owner-controlled allowlist of approved execution pools.

### Test Tokens

Three local ERC-20 tokens provide a deterministic environment for developing and validating the router.

## Development Workflow

The repository is designed around a local Foundry/Anvil environment and a Rust CLI.

Build the Solidity project with:

```bash
forge build
```

Run Solidity formatting and tests with:

```bash
forge fmt --check
forge test -vvv
```

Check the Rust project with:

```bash
cd aggregator
cargo check
```

Run Rust tests with:

```bash
cargo test
```

Start a local Anvil node:

```bash
anvil
```

Then deploy the local environment:

```bash
./script/setup_local.sh
```

The setup script deploys the contracts through `Setup.s.sol` and writes the local addresses and trader key to `.env.local`.

The router itself can then be invoked with:

```bash
cd aggregator

cargo run -- \
  --in-token <INPUT_TOKEN_ADDRESS> \
  --out-token <OUTPUT_TOKEN_ADDRESS> \
  --amount-in <AMOUNT_IN_BASE_UNITS>
```

The RPC URL can be supplied through the CLI or `RPC_URL` environment variable.

## Engineering Decisions

### Keep routing off-chain

The expensive search, quoting, cloning and split simulation happen in Rust rather than inside the EVM.

That makes it practical to explore more candidate paths without paying on-chain computation costs for every hypothetical route.

### Keep execution generic

The Solidity executor does not contain the routing algorithm.

Rust decides:

```text
which route
which pool
which amount
which order
which calldata
```

Solidity is responsible for:

```text
authorization
execution
atomicity
minimum-output enforcement
```

This separation allows routing logic to evolve without redesigning the complete execution layer.

### Model shared pools by physical identity

The simulator identifies shared liquidity through the pool address rather than treating every directional graph edge as a different pool.

That is important because:

```text
A -> B via AMM1
B -> A via AMM1
```

are two graph views of one liquidity source.

### Replay the chosen order when building calldata

The allocator's result is an ordered plan, not just a set of percentages.

The execution builder replays that exact order while updating the same simulated pool state, which keeps the generated hop inputs consistent with the state assumed by the allocator.

## Current Limitations

This is an engineering prototype and several components are intentionally simplified.

### Allocation

The current split algorithm is greedy and chunk-based.

It does not guarantee the globally optimal split across all available routes.

### Gas model

Gas estimates are coarse constants rather than measured execution costs for the complete generated plan.

### Route search

Candidate routes are discovered with bounded DFS. A production-scale router would need stronger pruning, caching, topology management and more scalable candidate generation.

### DEX coverage

The current contracts model a single test AMM interface. The project does not yet integrate multiple production DEX protocols with different pool and swap interfaces.

### Pool discovery

The current setup uses configured pool addresses. There is no production indexing/discovery system that continuously discovers new pools and updates the routing graph.

### Slippage

Slippage handling is intentionally simple and aimed at correctness testing rather than production execution policy.

### Execution optimization

The current execution representation can be improved to reduce unnecessary calldata and execution overhead, especially when the allocator produces many small chunks.

### Reliability under rapidly changing chain state

The current simulation starts from synchronized reserves but does not yet provide a sophisticated mechanism for protecting against all forms of state change between synchronization and transaction mining.

## Future Work

The project is still ongoing. The areas I want to develop next include:

- stronger global split optimization
- gas-aware allocation and execution ordering
- more efficient shared-pool state indexing
- route pruning and caching
- execution-plan compression
- realistic gas estimation
- generic adapters for multiple DEX designs
- broader pool discovery and indexing
- stronger target and calldata validation
- better slippage modeling
- fuzzing and invariant testing across routing and execution
- larger topology and performance benchmarks

## Project Goal

The goal is to build a routing engine that demonstrates the systems problem behind DEX aggregation:

```text
pool state
    |
    v
route discovery
    |
    v
AMM quoting
    |
    v
shared-liquidity simulation
    |
    v
split allocation
    |
    v
ordered execution plan
    |
    v
ABI encoding
    |
    v
atomic on-chain execution
    |
    v
simulation vs actual result
```

The current implementation is deliberately small enough to reason about end to end, while leaving the main optimization and productionization problems open for further work.
