---
title: How a DEX Aggregator Works
summary: A practical look at building a DEX routing system, from pool state and graph-based route discovery to state-aware split allocation and atomic on-chain execution.
date: 2026-09-08
dateLabel: Technical Note
tags: [Ethereum, DEX, DeFi, Solidity, Rust, AMM, Routing, Blockchain, Backend]
draft: false
---

When I started building this DEX aggregator, I wanted to understand the part of a swap system that sits between "there are several liquidity pools" and "which transaction should actually be executed?"

A simple swap can use one pool directly. An aggregator has a harder problem: given an input token, an output token and an amount, there may be several possible paths through the available liquidity.

The interesting part is that the best route is not necessarily the route with the best quote at the beginning. Swapping through a pool changes its reserves, so routes that share liquidity can affect one another.

That led me to structure the project around three separate concerns: route discovery, state-aware simulation and execution.

## The basic flow

A useful mental model is:

```text
Blockchain / RPC
       |
       | pool addresses + reserves
       v
Pool State
       |
       v
Token Graph
       |
       +--------------------+
       |                    |
       v                    v
Route Discovery       Route Dependencies
       |                    |
       +---------+----------+
                 |
                 v
        State-aware Simulation
                 |
                 v
          Split Allocation
                 |
                 v
         Ordered Execution Plan
                 |
                 v
          ABI-encoded Calls
                 |
                 v
        Solidity Aggregator
                 |
                 v
       Atomic On-chain Swap
                 |
                 v
        Actual Output Token
```

The project is split between a Rust routing engine and a Solidity execution layer.

Rust handles the off-chain intelligence: loading state, constructing the graph, finding routes, quoting swaps, simulating reserve changes and deciding how the input should be allocated.

Solidity handles the on-chain part: accepting the input tokens, executing approved pool calls and returning the final output atomically.

## 1. Start with liquidity pools, not with routes

The first thing the router needs is a representation of the available pools.

The test environment contains four AMMs:

```text
AMM1: Token A / Token B
AMM2: Token A / Token B
AMM3: Token A / Token C
AMM4: Token B / Token C
```

This gives the system several ways to move from A to C:

```text
A → C
A → B → C
A → B → C
```

The two A → B → C routes are especially interesting because they use different A/B pools but share the same B/C pool.

That shared pool becomes important later when deciding how to split a large trade.

## 2. Pool state has to be synchronized with the chain

The Rust router does not assume that its local reserve values are current.

For every configured pool, it reads:

```text
tokenA
tokenB
reserveA
reserveB
```

The state synchronization step refreshes every edge in the candidate routes from the on-chain pool.

Conceptually:

```text
Pool address
    |
    +--> tokenA()
    +--> tokenB()
    +--> getReserves()
    |
    v
Local Edge State
```

This gives the router a snapshot of the liquidity it is about to reason about.

The important distinction is that this is an off-chain model of on-chain state. The final transaction is still the source of truth.

## 3. Represent the DEX as a token graph

Once pool state is available, the router turns the pools into a graph.

A pool between A and B becomes two directed edges:

```text
A ─────────► B
B ◄───────── A
```

Each edge stores:

```text
token_in
token_out
pool
reserve_in
reserve_out
```

This makes the routing problem a graph-search problem rather than a collection of hard-coded swap combinations.

For the current topology:

```text
        AMM1
   A ────────── B
   │            │
   │ AMM2       │ AMM4
   │            │
   └────────────┘
   │
   │ AMM3
   ▼
   C
```

The actual graph contains directed edges for both swap directions.

## 4. Candidate routes are discovered with bounded DFS

The router uses depth-first search to discover possible paths from the input token to the output token.

The search keeps:

```text
current token
current path
visited tokens
maximum hop count
current amount
```

The current implementation limits the search to three hops.

A simplified search looks like:

```text
A
|
+--> B
|    |
|    +--> C
|
+--> C
```

The visited-token set prevents cycles such as:

```text
A → B → A → C
```

from becoming candidate routes.

The result is a collection of `Route` values containing their ordered pool edges and the quoted output.

## 5. Quote each hop using the AMM invariant

The test AMM uses a constant-product style pricing formula with a 0.3% fee.

The calculation is:

```text
amountInWithFee = amountIn × 997

amountOut =
    (amountInWithFee × reserveOut)
    /
    (reserveIn × 1000 + amountInWithFee)
```

For a multi-hop route, the output of one pool becomes the input to the next:

```text
A → B
    |
    v
amount B
    |
    v
B → C
    |
    v
amount C
```

The router therefore does not simply add independent prices together. It propagates the actual amount through every hop.

## 6. Why the first quote is not enough

One of the main things I wanted this project to handle was the effect of a trade on shared liquidity.

Imagine:

```text
Route 0:
A → B using AMM1
B → C using AMM4

Route 1:
A → B using AMM2
B → C using AMM4
```

At the beginning, both routes can quote against the same AMM4 reserves.

But after executing part of Route 0:

```text
AMM4 reserves
    |
    v
changed
```

Route 1 no longer has the same price.

A router that evaluates every route independently against the original reserves can therefore produce a split that looks good on paper but is inconsistent with the state created by its own earlier allocations.

This is why the project has a separate simulation layer.

## 7. Build a route-dependency graph

After candidate routes are discovered, the router builds another graph: this time between routes.

Two routes are connected when they use the same pool.

For example:

```text
Route 0 ───── Route 1
   \             /
    \           /
      shared AMM4
```

This dependency graph makes the relationship between candidate routes explicit.

It also gives the system a way to reason about liquidity contention instead of treating every route as independent.

## 8. Simulate swaps against mutable local state

The router keeps a mutable copy of the synchronized route state.

When a simulated swap happens:

```text
tokenIn → tokenOut
```

the corresponding reserves are updated:

```text
reserveIn  += amountIn
reserveOut -= amountOut
```

The reverse-direction view of the same physical pool is updated too.

That matters because the same pool can appear in multiple route edges.

The simulation therefore acts like a small local model of how the pool graph would evolve as the trade is executed.

## 9. Candidate simulations must start from the same current state

Suppose the current simulated state is `S`.

The router wants to compare several possible next chunks.

It does not want this:

```text
S
 |
 +--> simulate Route 0 --> modified S
                         |
                         +--> simulate Route 1
```

because Route 1 would accidentally be evaluated after Route 0's hypothetical changes.

Instead, each candidate is evaluated from the same state:

```text
                 S
          _______|_______
         /       |       \
        v        v        v
   Route 0    Route 1   Route 2
      |          |         |
     S0         S1        S2
         \       |       /
             compare
                |
                v
          choose winner
                |
                v
          commit state
```

The implementation achieves this by cloning the current simulated route state for each candidate.

Only the winning candidate state becomes the next state.

## 10. Large trades can be split across routes

The current allocator does not force the entire input amount through one route.

Instead, it processes the input in chunks.

For example:

```text
Input = 100

chunk size = 10

10 → best route
10 → best route
10 → best route
...
```

After every chunk, the simulated pool state changes.

That means the best route can change during the same transaction.

Conceptually:

```text
Initial state
    |
    +--> Route 0 is best
    |
    v
state changes
    |
    +--> Route 1 becomes best
    |
    v
state changes
    |
    +--> Route 0 becomes best again
```

The current allocator is intentionally greedy: for every chunk it chooses the candidate producing the highest simulated total output.

It is therefore a state-aware allocator, but not yet a globally optimal optimizer.

## 11. The execution order is part of the result

A split allocation alone is not enough.

These two plans can have the same allocations:

```text
Route 0: 50
Route 1: 50
```

but different execution orders:

```text
Plan A:
Route 0 / 50
Route 1 / 50

Plan B:
Route 1 / 50
Route 0 / 50
```

Because the routes can share pools, the order can change the reserves seen by later swaps.

The allocator therefore produces an explicit `RouteExecution` sequence:

```rust
pub struct RouteExecution {
    pub route_index: usize,
    pub amount_in: U256,
}
```

This sequence is later replayed when constructing the actual transaction.

## 12. Turn the plan into generic execution calls

Once the Rust side has decided what should happen, it needs to express that plan in a form the Solidity contract can execute.

The Solidity aggregator uses:

```solidity
struct Execution {
    address target;
    address tokenIn;
    uint256 amountIn;
    bytes data;
}
```

For every route hop, Rust creates the AMM swap calldata.

Conceptually:

```text
RouteExecution
      |
      v
Route edges
      |
      v
quote each hop
      |
      v
AMMPool::swap(...)
      |
      v
ABI encode
      |
      v
Execution[]
```

The execution layer therefore does not need to understand the router's graph algorithms.

It receives a sequence of generic calls.

## 13. The pool registry creates an execution boundary

The Solidity `QuoteAggregator` does not allow arbitrary addresses to be used as execution targets.

Before a call is made, the target must be approved by `PoolRegistry`.

The model is:

```text
Execution target
      |
      v
PoolRegistry
      |
   approved?
    /     \
  yes      no
   |        |
 execute   revert
```

This separates routing decisions from the question of which contracts are trusted execution targets.

The current registry is intentionally simple and owner-controlled.

## 14. Atomic execution happens in Solidity

The final swap is executed through one call to `QuoteAggregator.execute`.

The high-level flow is:

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
measure token-out balance
  |
  v
transfer output to trader
```

If one of the execution steps reverts, the transaction reverts.

That gives the off-chain routing engine a clean boundary:

```text
Rust
    |
    | decide + simulate + encode
    v
Solidity
    |
    | execute atomically
    v
EVM
```

## 15. Slippage protects the final result

The transaction includes a minimum acceptable final output.

The current prototype uses a 1% transaction-level slippage tolerance:

```text
amountOutMin =
    simulatedOutput × 99 / 100
```

The execution builder currently also uses the simulated output as the per-hop minimum output while validating the prototype.

That is intentionally strict for the current correctness test.

A more production-oriented implementation would use a more deliberate per-hop slippage policy and account for execution-time state changes.

## 16. Simulation is checked against real execution

One of the most useful parts of the project is that the Rust simulator is not treated as correct simply because the math looks right.

The program records the trader's output-token balance before execution:

```text
balanceBefore
```

then submits the atomic transaction and reads it again:

```text
balanceAfter
```

The actual output is:

```text
actualOutput =
    balanceAfter - balanceBefore
```

The program then compares:

```text
simulated output
        vs
actual output
```

For the tested setup, the result was:

```text
Simulated output: 552782643753440975662
Actual output:    552782643753440975662

Perfect match:
simulation == on-chain execution.
```

That was an important validation milestone because it tested the complete chain:

```text
pool state
   |
route discovery
   |
quoting
   |
allocation
   |
state simulation
   |
calldata construction
   |
Solidity execution
   |
actual reserves
   |
final output
```

## 17. Rust and Solidity have deliberately different responsibilities

The architecture is easier to reason about when the responsibilities stay separated.

### Rust

```text
CLI
 |
 v
Load pools
 |
 v
Build graph
 |
 v
Find routes
 |
 v
Synchronize state
 |
 v
Build dependencies
 |
 v
Score routes
 |
 v
Allocate input
 |
 v
Build execution calls
```

### Solidity

```text
Receive input
 |
 v
Validate execution target
 |
 v
Approve pool for exact amount
 |
 v
Call pool
 |
 v
Repeat
 |
 v
Measure output
 |
 v
Slippage check
 |
 v
Transfer output
```

Rust is therefore responsible for optimization and planning, while Solidity is responsible for enforcing the execution plan on-chain.

## 18. Route scoring also accounts for gas

The project contains a route scoring layer that converts the expected output and estimated gas cost into a simple score.

Conceptually:

```text
route score =
    output value in USD
    -
    estimated gas cost in USD
```

The current prototype uses simplified values for:

```text
token-out USD price
native-token USD price
gas price
```

and estimates gas from:

```text
base router gas
+
swap-hop gas × number of hops
```

This is useful as a starting point because a route with slightly more output is not necessarily better if its execution cost is significantly higher.

The current model is deliberately approximate rather than a production gas estimator.

## 19. The project is also an exercise in state modeling

The part I found most interesting is that the router is not simply a graph algorithm.

It is a graph algorithm operating over mutable financial state.

The system effectively works with:

```text
Graph
 +
Pool state
 +
Trade amount
 +
Execution order
 =
Expected outcome
```

Changing any of these can change the optimal route.

That is why the project separates:

```text
static topology
```

from:

```text
dynamic liquidity state
```

The graph tells the router what is possible.

The state tells it what is currently attractive.

## 20. What I think about when building a router now

The implementation details will change as the system grows, but the questions are fairly stable.

### What routes are actually possible?

The graph needs to represent all usable pools without allowing unnecessary cycles.

### What state are the quotes based on?

A quote is only meaningful relative to a particular reserve state.

### Which routes share liquidity?

Two routes that look independent at the token level may still compete for the same physical pool.

### Does allocation change future prices?

If yes, the optimizer cannot evaluate every route only once.

### Does execution order matter?

If routes share pools, it usually does.

### Can the execution layer enforce the plan?

The Solidity contract needs to validate targets and enforce minimum output conditions.

### Can the simulator be tested against reality?

Comparing predicted output with actual on-chain output is one of the strongest correctness checks available for this kind of system.

## What I learned

The main thing I took away from building this project is that DEX aggregation is not just "find the path with the best price."

The harder problem is:

```text
multiple routes
      |
      v
shared liquidity
      |
      v
state changes
      |
      v
changing prices
      |
      v
allocation + ordering
      |
      v
atomic execution
```

Building the project gave me hands-on experience with graph-based routing, AMM mathematics, Ethereum contract interaction, mutable state simulation, ABI encoding and multi-step atomic execution.

It also reinforced a broader backend engineering idea: when a system makes decisions against changing state, the model used for planning needs to account for the state transitions caused by its own decisions.

That is what makes the routing problem interesting to me. The graph tells you where a trade can go, but the state tells you where it should go.
