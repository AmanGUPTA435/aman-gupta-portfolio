---
title: Rift Runtime
summary: A custom asynchronous runtime built from scratch in Rust to understand futures, task scheduling, wakeups, timers, cancellation and runtime internals.
role: Independent Project
date: 2026-01-01
dateLabel: Completed
tags: [Rust, Async Rust, Futures, Concurrency, Systems Programming]
featured: true
draft: false
---

I built Rift Runtime from scratch in Rust to understand what actually happens underneath `async`/`await` instead of treating an async runtime as a black box.

The project implements the core pieces of an asynchronous runtime without using Tokio or async-std, including task scheduling, a custom `RawWaker`, an executor, timers, `JoinHandle`, cancellation and panic handling.

The goal was not to build a production replacement for Tokio. I wanted to understand how futures are polled, how sleeping tasks become runnable again, how wakers interact with scheduling, and how task lifecycle and synchronization work inside a runtime.

## Architecture

At a high level, spawned futures are wrapped in tasks and placed into a FIFO ready queue.

```text
spawn()
   │
   ▼
Ready Queue (mpsc)
   │
   ▼
Executor Loop
   │
   ▼
poll() Task
   │
   ├───────────────┐
   │               │
 Pending          Ready
   │               │
   ▼               ▼
 Waker          Complete
   │               │
   ▼               ▼
Task Queue     JoinHandle<T>
   │
   ▼
Executor polls again
```

The runtime is made up of several pieces that work together:

- `Executor`
- `Spawner`
- `Task`
- `RawWaker`
- `JoinHandle<T>`
- `TimerFuture`
- `TimerDriver`
- `CatchUnwind`

Each component handles a different part of the async execution model.

## Executor

The executor is intentionally small.

It owns a `std::sync::mpsc` receiver containing ready tasks and continuously waits for the next task to arrive.

When a task is received, the executor creates a `Context` using the task's custom waker and calls `poll()` on the future.

A task can return:

```text
Poll::Pending
Poll::Ready
```

A pending task stays suspended until something wakes it. A completed task is not scheduled again.

The executor itself does not know the concrete type or output of the future. It only deals with erased `Task` values.

## Tasks and Scheduling

Every spawned future is wrapped inside a `Task`.

A task stores its future behind:

```rust
Mutex<Option<Pin<Box<dyn Future<Output = ()> + Send>>>>
```

The future is temporarily taken out while it is being polled and placed back into the task when it returns `Poll::Pending`.

This avoids accidentally polling the same future twice while holding the task's mutex.

Tasks also contain an atomic scheduling flag:

```text
queued
```

Before polling, the task clears this flag.

When a waker fires, `schedule()` uses an atomic swap to determine whether the task is already queued.

```text
wake()
   │
   ▼
queued.swap(true)
   │
   ├── already true  → don't enqueue again
   │
   └── false         → push task into ready queue
```

This prevents multiple wakeups from creating duplicate entries for the same task before it is polled again.

That was one of the more interesting parts of the project because scheduling and waking are separate events, and it's easy to create unnecessary queue entries if they aren't coordinated.

## Custom `RawWaker`

One of the most low-level parts of the runtime is the custom `RawWaker`.

The runtime manually constructs a `RawWakerVTable` containing:

- `clone`
- `wake`
- `wake_by_ref`
- `drop`

The waker stores an erased `Arc<Task>` pointer.

When `wake()` or `wake_by_ref()` is called, the implementation reconstructs the `Arc<Task>` and schedules the task back onto the executor's queue.

The difficult part here was getting the ownership rules correct.

Each `RawWaker` operation has to maintain the correct `Arc` reference count, and `wake()` and `wake_by_ref()` have different ownership semantics.

The implementation uses `unsafe` only around the raw pointer and `Arc` conversions required to implement the `RawWaker` interface.

## Why Waking Matters

The executor does not continuously poll every pending future.

A future that returns `Poll::Pending` is waiting for something to happen.

That future registers a waker with whatever subsystem it is waiting on. Once the event occurs, the subsystem wakes the task, which puts the task back into the executor's ready queue.

The timer system is a concrete example of this flow.

```text
TimerFuture
     │
     │ Poll::Pending
     ▼
stores Waker
     │
     ▼
TimerDriver
     │
     │ deadline reached
     ▼
wake()
     │
     ▼
Task rescheduled
     │
     ▼
Executor polls task
```

This made the relationship between `Future`, `Context`, `Waker` and the executor much clearer to me than reading about the API in isolation.

## Timer Subsystem

I also implemented a timer subsystem separately from the executor.

It consists of:

- `TimerFuture`
- `TimerHandle`
- `TimerDriver`

When a `TimerFuture` is created, it sends a timer entry containing a deadline and shared state to the timer driver.

The driver keeps pending timers in a `BinaryHeap` ordered by deadline.

```text
TimerHandle
    │
    ▼
TimerDriver
    │
    ▼
BinaryHeap<deadline>
    │
    ▼
earliest timer
    │
    │ deadline reached
    ▼
mark completed
    │
    ▼
wake task
```

The timer driver waits for either a new timer to arrive or the next timer deadline to expire.

When the deadline is reached, it marks the timer as complete and wakes the waker registered by the future.

This gave me a practical example of how an external event source can drive future progress inside an async runtime.

## `JoinHandle`

The runtime provides a generic:

```rust
JoinHandle<T>
```

which represents the result of a spawned task.

Unlike the executor's erased `Task` representation, the join handle retains the concrete output type.

For example:

```rust
let handle = spawner.spawn(async {
    42
});

let value = handle.await.unwrap();
```

The shared completion state stores either:

```rust
Result<T, JoinError>
```

or the waker of a task waiting for the result.

When the spawned task completes, it stores the result and wakes the waiting task.

This lets tasks spawn other tasks and then await their results.

## Panic Handling

Spawned futures are wrapped in a custom `CatchUnwind` future.

The implementation calls `catch_unwind` around the future's `poll()` operation and converts a panic into:

```rust
JoinError::Panic(...)
```

rather than allowing the panic to terminate the executor.

From the caller's point of view, the task result is therefore:

```rust
Result<T, JoinError>
```

with the two runtime-level failure modes currently represented as:

- Panic
- Cancelled

This was useful for understanding where panic boundaries belong in an async task system.

## Cooperative Cancellation

Tasks can also be cancelled through their `JoinHandle`.

Cancellation is cooperative.

The handle sets an atomic cancellation flag, and when the task is next scheduled, the task checks that flag before polling its future.

If the task has been cancelled, the future is dropped and the shared completion state is completed with:

```rust
JoinError::Cancelled
```

Any task waiting on the join handle is then woken.

The important part for me was understanding that cancellation does not require forcibly interrupting a running future. The runtime instead coordinates cancellation with the normal task lifecycle.

## Synchronization and Lost Wakeups

One of the harder problems was making sure task completion and join-handle registration cannot race.

The shared state contains both:

- task result
- join waker

under the same mutex.

That means the runtime can atomically observe and update the state when a task completes or when another task starts waiting for its result.

Conceptually:

```text
                   SharedState
                ┌─────────────────┐
                │ result          │
                │ join_waker      │
                └────────┬────────┘
                         │
                    Mutex-protected
                         │
                ┌────────┴────────┐
                ▼                 ▼
           task completes     join polls
                │                 │
                └─────── race ────┘
```

The goal is to avoid the classic lost-wakeup problem where one side observes the state before the other side registers its waker.

## Type-Erased Scheduling

One of the architectural changes I made while building the runtime was separating task scheduling from task result types.

The initial design propagated generics through the executor:

```text
Executor<T>
Spawner<T>
Task<T>
```

That made the scheduler tightly coupled to the output type of each task.

The final design uses:

```text
Executor
Spawner
Task
```

and keeps the concrete result type only where it is actually needed:

```text
JoinHandle<T>
SharedState<T>
```

A private `Completion` trait is used to type-erase the completion operations required by the scheduler.

This allows the same executor to schedule futures producing different output types without turning the entire runtime into a generic data structure.

It also made the relationship between scheduling and task completion much cleaner.

## Testing

The project includes tests for the main runtime behaviors.

These cover:

- spawned task results
- nested task spawning
- panic propagation
- cancellation before polling
- timer wakeups
- repeated wakeup deduplication
- timer ordering
- waker invocation
- replacing a waiting timer waker

For example, the scheduler tests verify that repeatedly scheduling the same task before it is polled does not result in multiple queue entries.

The timer tests also verify that the earliest deadline is selected first and that the registered waker is triggered when the timer fires.

## What I Learned

The biggest value of this project was getting away from the abstraction of simply writing:

```rust
async fn ...
```

and actually seeing what happens underneath.

Building Rift Runtime forced me to work directly with:

- the `Future` trait
- `Poll`
- `Context`
- `Waker`
- `RawWaker`
- `Pin`
- `Arc` and `Mutex`
- atomics
- trait objects
- dynamic dispatch
- cooperative cancellation
- panic boundaries
- task scheduling

The custom waker was probably the most useful part for understanding Rust async internals, while the scheduling flag and shared join state forced me to think more carefully about races and synchronization.

It also showed me why a production runtime such as Tokio needs much more machinery than simply polling futures in a loop.

## Current State

Rift Runtime is a learning-focused implementation rather than a production async runtime.

The current executor is single-threaded and uses a standard library channel for the ready queue. The timer subsystem runs separately, and the runtime does not yet integrate with an operating-system I/O reactor.

The project is intentionally focused on understanding the core execution model rather than competing with production runtimes on performance.

Possible next steps include a multi-threaded executor, work stealing, async I/O integration, task priorities, metrics and benchmarking.
