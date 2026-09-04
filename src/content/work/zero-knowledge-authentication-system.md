---
title: Chaum-Pedersen Zero-Knowledge Authentication System
summary: A Rust authentication service that uses a Chaum-Pedersen zero-knowledge proof flow over gRPC, with PostgreSQL-backed sessions, rate limiting and TLS.
role: Independent Project
date: 2026-01-01
dateLabel: Completed
tags: [Rust, Cryptography, Zero-Knowledge Proofs, Chaum-Pedersen, gRPC, Tonic, Tokio, PostgreSQL, SQLx, TLS]
featured: true
draft: false
---

I built this project to understand how a zero-knowledge authentication system could work as a real backend service rather than treating the cryptographic protocol as a separate exercise.

The system uses a Chaum-Pedersen style proof to authenticate a user without sending the password to the server. The client performs the proof computations, the server verifies the proof over an async gRPC connection, and PostgreSQL stores the public commitments, authentication logs and session state.

## What I Wanted to Build

The basic idea is to prove knowledge of a secret `x` without revealing `x` itself.

The client derives two public values from the same secret:

```text
Y1 = alpha^x mod p
Y2 = beta^x mod p
```

During authentication, the client creates fresh commitments using a random value `k`:

```text
R1 = alpha^k mod p
R2 = beta^k mod p
```

The server then chooses a random challenge `c`.

The client responds with:

```text
s = k + c * x mod q
```

The server verifies the two relationships:

```text
alpha^s = R1 * Y1^c mod p
beta^s  = R2 * Y2^c mod p
```

The server therefore checks that the client knows the same secret behind both public commitments without receiving the secret itself.

## Architecture

The project is split into a CLI client, an async gRPC authentication server and a PostgreSQL persistence layer.

```text
                 CLI Client
              (Prover / Client)
                     │
                     │ gRPC over TLS
                     ▼
              Auth gRPC Server
              (Verifier / Logic)
                │           │
                │           │
                ▼           ▼
           PostgreSQL    In-memory state
           users/logs/   auth challenges /
           sessions      rate limiting
```

The main pieces are:

- Rust client
- Rust/Tokio authentication server
- Tonic gRPC service
- Chaum-Pedersen proof implementation
- PostgreSQL with SQLx
- Temporary in-memory authentication state
- Session management
- In-memory rate limiting
- Structured logging with `tracing`
- TLS transport between client and server

## Registration

Registration does not send the password to the server.

The client converts the password into the secret value `x` and computes:

```text
Y1 = alpha^x mod p
Y2 = beta^x mod p
```

The gRPC registration request contains the username and the two public values:

```text
name
y1
y2
```

The server stores these commitments in the `users` table.

The password itself is never stored in the database and is not included in the registration request.

```text
Password
   │
   ▼
Client
   │
   ├── Y1 = alpha^x mod p
   └── Y2 = beta^x mod p
          │
          ▼
       gRPC
          │
          ▼
       Server
          │
          ▼
     PostgreSQL
```

## Authentication Flow

Authentication is split into a challenge and verification phase.

### 1. Create Commitments

The client generates a fresh random `k` below `q` and computes:

```text
R1 = alpha^k mod p
R2 = beta^k mod p
```

These values are sent to the server together with the username.

### 2. Server Challenge

The server checks that the user exists and that the user is not currently rate limited.

It then creates:

- a random authentication ID
- a random challenge `c`

The server temporarily stores the authentication session in an in-memory `DashMap`.

The stored challenge state contains the username, `R1`, `R2`, `c` and its creation time.

The server returns:

```text
auth_id
c
```

to the client.

### 3. Client Response

The client uses its password-derived secret `x` together with the challenge to calculate:

```text
s = k + c * x mod q
```

The client sends the authentication ID and `s` back to the server.

### 4. Verification

The server retrieves and removes the temporary authentication state using the authentication ID.

It then loads the user's stored commitments `Y1` and `Y2` from PostgreSQL and checks:

```text
alpha^s = R1 * Y1^c mod p
beta^s  = R2 * Y2^c mod p
```

Both conditions must hold.

A successful verification results in a new authenticated session.

## Replay Protection

Authentication challenges are stored under a unique `auth_id`.

When the server verifies a response, it removes the authentication state from the in-memory map before completing verification.

That means the same `auth_id` cannot simply be submitted again after a successful verification.

The project includes an explicit replay test to verify that reusing the same authentication request fails.

Authentication challenges also expire after 60 seconds.

## Session Management

After successful proof verification, the server creates a random 32-byte session ID and returns it to the client.

The database stores only a SHA-256 hash of the session ID rather than the raw value.

The session record contains:

```text
session_id_hash
user_name
auth_id
created_at
expires_at
```

Session validation hashes the presented session ID and looks up the corresponding database record.

Sessions expire after one hour.

The service also exposes logout functionality which removes the stored session.

There is a background cleanup task that periodically deletes expired sessions from the database.

## Database Design

PostgreSQL is used as the persistent state layer and is accessed through SQLx.

### `users`

Stores the public commitments associated with each user:

```text
user_name
y1
y2
created_at
```

The database never stores the original password.

### `auth_logs`

Records authentication attempts and whether verification succeeded.

It also stores an optional failure reason and the authentication ID.

This creates an audit trail that can also support operational debugging and rate-limiting decisions.

### `sessions`

Stores active session metadata and expiration information.

The actual session token is not stored directly; the server stores a hash of it.

The tables use foreign keys so user deletion also removes related authentication logs and sessions.

## Rate Limiting

The server keeps per-user rate limiting state in memory.

For authentication attempts, the server tracks:

- number of recent failures
- last attempt time
- temporary block status

After five failed attempts, the user is blocked for 60 seconds.

A successful authentication clears the rate-limit state for that user.

The project includes a test covering this behavior.

This is intentionally an in-memory implementation. A distributed deployment would need a shared store such as Redis so that rate limits are consistent across multiple server instances.

## gRPC API

The client and server communicate through a Tonic gRPC service defined in Protocol Buffers.

The service exposes:

```text
Register
CreateAuthenticationChallenge
VerifyAuthentication
Logout
ValidateSession
```

The protocol definitions are kept in `proto/zkp_auth.proto` and compiled during the Rust build.

The client is exposed as a CLI with commands for registration, authentication, logout and session validation.

## Async Rust

The server is built around Tokio and Tonic.

The network-facing API is asynchronous, database operations use async SQLx calls, and the server also runs a background session-cleanup task.

The project also uses `DashMap` for temporary challenge and rate-limit state so that these maps can be accessed concurrently without wrapping the whole server state in a single global mutex.

This let me work through how the cryptographic protocol interacts with a normal async backend rather than implementing the proof in isolation.

## TLS

The gRPC server is configured with TLS using a server certificate and private key.

The client loads the server certificate and configures a TLS connection to the local gRPC endpoint.

The transport therefore runs over:

```text
HTTPS / HTTP2
      +
   gRPC
      +
    TLS
```

This is important because the ZKP protocol is only one part of securing the authentication service. The transport itself still needs to be protected against interception and tampering.

## Observability

The service uses `tracing` for structured logs.

Important operations are instrumented with events such as:

```text
register
create_challenge
verify
logout
validate_session
```

Authentication and request handlers also measure operation duration.

The implementation takes care not to log the raw session token during session-related operations.

## Testing

The project contains both unit-style tests around the ZKP operations and integration-style tests that exercise the client/server flow.

The cryptographic tests cover:

- exponentiation
- challenge generation
- proof construction
- proof verification
- toy examples using small parameters
- randomized toy examples

The service tests cover:

- successful registration
- authentication flow
- duplicate registration
- invalid users
- invalid authentication IDs
- replay attempts
- session validation
- logout
- rate limiting
- invalid and incorrect authentication attempts

Several tests start the authentication server and communicate with it through the same gRPC interface used by the client.

## Design Decisions

### Keep proof generation on the client

The server receives only the public commitments, the challenge response and the values necessary to verify the proof.

The password-derived secret remains on the client side during the authentication flow.

### Separate protocol state from persistent state

The short-lived challenge state is kept in memory because it only needs to exist for the lifetime of an authentication attempt.

User commitments, authentication logs and sessions are persisted in PostgreSQL because they need to survive process restarts and support later queries.

### Hash session IDs at rest

The server returns the session ID to the client but stores only a SHA-256 hash of it in PostgreSQL.

This means the database does not contain the raw bearer token.

### Consume authentication challenges

The authentication state is removed when verification begins, preventing the same authentication ID from being reused.

### Keep the cryptographic operations explicit

The ZKP implementation uses `BigUint` and performs the modular exponentiation directly instead of hiding the protocol behind a higher-level authentication library.

That was intentional because one of the main goals of the project was to understand the underlying mathematics and the implementation details.

## What I Learned

The main thing I got from this project was seeing how cryptography fits into a backend system.

It is one thing to understand the Chaum-Pedersen equations on paper. It is another to make the protocol work across a client/server boundary while also dealing with:

- request and response types
- temporary challenge state
- replay protection
- database transactions
- session management
- rate limiting
- TLS
- async execution
- structured logging
- integration testing

The project also made the distinction between persistent authentication state and short-lived protocol state much clearer to me.

The cryptographic part can be mathematically correct while the surrounding service still has problems such as replayable challenges, leaked sessions or missing rate limits. Building the whole service made those concerns much more concrete.

## Current State

The project is a learning-focused authentication system rather than a production authentication product.

The current implementation demonstrates the complete registration, proof-based authentication and session lifecycle, but there are still areas I would improve before treating it as production-ready.

Some possible next steps include:

- moving rate limiting to Redis for multi-instance deployments
- improving session rotation and refresh-token handling
- adding more production-oriented metrics
- strengthening protocol parameter management
- adding broader security testing and threat modeling
- improving horizontal scaling support for temporary authentication state
