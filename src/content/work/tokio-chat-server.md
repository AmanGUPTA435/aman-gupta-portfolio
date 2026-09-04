---
title: Tokio Chat Server
summary: A real-time multi-client chat server built in Rust with Tokio, TCP networking, PostgreSQL persistence and asynchronous task-based concurrency.
role: Independent Project
date: 2026-01-01
dateLabel: Completed
tags: [Rust, Tokio, TCP, Async Programming, Concurrency, PostgreSQL, SQLx]
featured: true
draft: false
---

I built this project to get more comfortable with asynchronous networking and concurrent backend systems in Rust.

The result is a stateful TCP-based chat server that can handle multiple clients concurrently. Clients can register, log in, join chat groups and exchange messages in real time. Messages and group membership are persisted in PostgreSQL, while the active group and session state is kept in memory.

The main thing I wanted to understand was how the different pieces of a real-time backend fit together: TCP connections, asynchronous tasks, shared state, message fan-out, database transactions and connection lifecycles.

## Architecture

The system has a CLI client, an asynchronous TCP server and a PostgreSQL database.

```text
                   CLI Client
                       |
                       | JSON over TCP
                       v
                Tokio TCP Server
                       |
          +------------+-------------+
          |            |             |
          v            v             v
      Sessions       Groups       Client Tasks
          |            |             |
          |            v             |
          |      broadcast::Sender   |
          |            |             |
          |            v             |
          |       Group Receivers    |
          |                          |
          +------------+-------------+
                       |
                       v
                  PostgreSQL
                     SQLx
```

Each TCP connection is handled in its own Tokio task. Shared sessions and group channels are stored in concurrent maps, while chat history, users and membership are persisted in PostgreSQL.

## TCP Server

The server listens on:

```text
127.0.0.1:8081
```

When a client connects, the server splits the TCP stream into a reader and writer and parses the initial command as JSON.

The command layer currently supports:

```text
Register
Login
Join
Logout
```

After a successful `Join`, the same TCP connection stays open and becomes the client's real-time chat connection.

This creates two different phases for the connection:

```text
Command request
    |
    v
Authentication / group join
    |
    v
Persistent chat stream
```

I liked this part of the project because it made the difference between a normal request/response interaction and a long-lived network connection very concrete.

## Async Connection Handling

Each accepted client connection is handled with `tokio::spawn`:

```rust
tokio::spawn(async move {
    if let Err(e) = handle_connection(socket, server_clone, addr).await {
        // ...
    }
});
```

This lets the server handle multiple clients concurrently without creating a dedicated OS thread for each connection.

Once a client joins a group, its task waits on two things using `tokio::select!`:

```text
+----------------------+
| Client TCP input     |
|          OR          |
| Group broadcast      |
+----------------------+
          |
          v
     handle event
```

One branch reads messages arriving from the client.

The other receives messages or membership events from the group's broadcast channel.

This means the same task can both accept new messages from its client and forward messages arriving from other clients.

## Group Broadcasts

Each chat group has its own `tokio::sync::broadcast` channel.

The server keeps these channels in a concurrent `DashMap`:

```text
group_id
   |
   v
broadcast::Sender
   |
   +---- client A receiver
   |
   +---- client B receiver
   |
   +---- client C receiver
```

When a client sends a message, the server first persists it to PostgreSQL and then broadcasts an `Event::Message` to the group's channel.

Clients other than the sender receive the event through their own receiver.

The same mechanism is used for:

```text
Join
Leave
Message
```

The sender also includes the client's socket address with the event so that a connection can ignore its own broadcast.

## Why `broadcast`?

I used `tokio::sync::broadcast` because the same message needs to reach multiple clients in a group.

Instead of the server explicitly iterating through every connected client, each client subscribes to the group's channel and receives the events independently.

The channel is bounded, with a capacity of 100 messages.

That also introduces an important backpressure tradeoff: a receiver that falls too far behind can receive a `Lagged` error and miss messages that have already fallen out of the channel buffer.

For this project, that behavior is acceptable because the database remains the persistent source for chat history.

## Session Management

The server supports registration and login rather than allowing clients to immediately enter a chat group.

During registration, passwords are hashed with bcrypt before being stored in PostgreSQL.

After successful login, the server generates a UUID session ID and stores the session in an in-memory `DashMap`.

The client then stores the session ID locally and uses it when joining a group.

The flow is:

```text
Register
   |
   v
bcrypt password hash
   |
   v
PostgreSQL

Login
   |
   v
verify password
   |
   v
generate UUID session
   |
   v
store session in memory
   |
   v
SESSION <id>

Join
   |
   v
validate session
   |
   v
join group
```

Sessions expire after 30 minutes.

The server also runs a background cleanup task every 10 minutes to remove expired sessions from memory.

## Database and Persistence

PostgreSQL is used for persistent state and is accessed through SQLx.

The schema contains tables for:

- users
- group members
- group requests
- group chats

The `group_requests` table records join and leave operations, while `group_members` tracks current membership.

Chat messages are stored in `group_chats` with the group ID, username, message and timestamp.

This gives the system a useful separation:

```text
In-memory
-----------
active sessions
active groups
broadcast channels

PostgreSQL
-----------
users
memberships
join/leave history
chat history
```

## Database Transactions

Database writes for important state changes are performed through SQLx transactions.

For example, when a client joins a group, the server:

1. validates the session
2. checks that the user exists
3. records the join event
4. inserts the group membership
5. commits the transaction
6. continues into the chat loop

Messages follow a similar pattern. The message is inserted into PostgreSQL and the transaction is committed before the server broadcasts the message to the other clients.

That ordering means a successfully broadcast chat message has already been persisted.

## Chat History

When a client joins a group, the server retrieves the most recent 20 messages from PostgreSQL.

The query orders them newest-first, then reverses the result before sending it to the client so that the history appears in chronological order:

```text
Database
newest -> oldest

       reverse

Client
oldest -> newest
```

After the history is sent, the same TCP connection remains open for real-time messages.

## Client

The project also contains a CLI client built with `clap`.

The main commands are:

```bash
cargo run --bin client -- register <username> <password>
cargo run --bin client -- login <username> <password>
cargo run --bin client -- join <group_id>
cargo run --bin client -- logout
```

The client stores the session returned by the server in a local session file and uses it for subsequent group joins.

While connected to a chat group, the client uses `tokio::select!` to wait for either:

- input from the terminal
- messages arriving from the server

This makes the CLI capable of sending messages and receiving other users' messages at the same time.

## Protocol

The application uses a lightweight JSON-over-TCP protocol for its command messages.

For example, a login command is represented as a serialized enum containing:

```text
{
  "type": "Login",
  "username": "...",
  "password": "..."
}
```

The initial command is newline-delimited so that the server can read and deserialize one command at a time.

Once the client joins a group, the connection switches to newline-delimited chat messages rather than repeatedly opening new connections.

I intentionally kept the protocol small because the main goal of the project was understanding the networking and concurrency model rather than designing a full application protocol.

## Shared State

The server uses `DashMap` for concurrent access to:

```text
sessions
groups
```

Sessions map session IDs to usernames and creation times.

Groups map group IDs to their `broadcast::Sender`.

This lets independently running connection tasks access shared state without putting one large mutex around the entire server.

The group channel itself handles the synchronization needed for message fan-out.

## Connection Lifecycle

A connected client roughly follows this lifecycle:

```text
TCP connect
    |
    v
parse command
    |
    +---- Register ----> PostgreSQL
    |
    +---- Login -------> create session
    |
    +---- Join --------> validate session
                            |
                            v
                        subscribe
                            |
                            v
                      load history
                            |
                            v
                      chat loop
                       /       \
                receive       broadcast
                  input         events
                       \       /
                         |
                         v
                   TCP disconnect
                         |
                         v
                  leave event
```

When a client disconnects, the server records the leave event, removes the membership from the database and broadcasts a leave notification to the remaining clients.

## Error Handling and Observability

The server defines application-level errors for:

- database failures
- I/O failures
- password hashing errors
- authentication failures
- invalid input
- internal errors

Errors are logged using the `tracing` crate and surfaced to the client where appropriate.

For example, invalid sessions and invalid group IDs are returned as explicit `ERROR:` responses rather than being treated as generic internal failures.

The server also logs conditions such as failed network writes and lagging broadcast receivers.

## Testing

The project includes unit and asynchronous integration-style tests.

The tests cover:

- successful registration
- duplicate registration
- successful login
- incorrect passwords
- logout
- invalid sessions
- invalid JSON commands
- database operations
- join and leave behavior
- message insertion and history
- invalid group IDs

The server tests create an ephemeral TCP listener and interact with the actual connection handling code, which makes the tests more representative than only testing individual helper functions.

## Design Tradeoffs

This project intentionally keeps the architecture simple, which also makes some limitations visible.

### In-memory broadcast

Group message delivery uses Tokio's in-memory `broadcast` channel.

That works well for a single server process, but it does not provide cross-process or cross-machine message delivery.

A distributed version would need something such as Redis or NATS for shared pub/sub.

### Single-node state

Active sessions and group channels live in process memory.

That means a second server instance would not automatically know about the state held by the first.

A production horizontally scaled version would need a shared session/state layer.

### JSON over TCP

JSON keeps the protocol easy to inspect while developing, but it is not as compact or strongly typed as a binary protocol such as Protobuf.

### Database writes on every message

Messages are persisted before being broadcast. This gives the database a durable record, but it also means database throughput can eventually become a bottleneck for very high message rates.

## What I Learned

This project was mainly about understanding asynchronous backend systems by actually building one.

I got much more comfortable with:

- Tokio async tasks
- TCP streams
- `tokio::select!`
- channels and broadcast subscriptions
- concurrent shared state
- PostgreSQL transactions
- connection lifecycles
- authentication and sessions
- event-driven message handling

One thing that became much clearer was the relationship between the TCP connection and the broadcast channel.

The TCP stream is the actual connection between a client and the server. The broadcast channel is an internal server-side mechanism that lets multiple connection tasks receive the same group event without the server having to manage a separate direct send operation for every client.

That distinction is useful when thinking about how the same architecture could eventually be adapted to WebSockets.

## Current State

The current implementation is a single-node real-time chat server using TCP, Tokio and PostgreSQL.

It is intentionally not presented as a production-ready distributed chat system. The project was built to understand asynchronous networking, concurrency and stateful backend design, while making the important scalability tradeoffs visible in the implementation itself.

The next areas I would explore are a browser-facing WebSocket interface, a structured protocol such as Protobuf, distributed pub/sub and a shared state layer for horizontal scaling.
