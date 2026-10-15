# NexusBroker

A production-grade stock trading platform built from scratch — inspired by Zerodha and Groww.

## Live Demo
- **Frontend:** https://nexusbrokerdemo.vercel.app
- **Backend API:** https://nexusbroker-production.up.railway.app/health
- **Demo login:** arjun@demo.com / Demo@1234

## Features
- Custom order matching engine with price-time priority and partial fills
- Market-timing rules for regular Indian market hours (Monday–Friday, 9:15 AM–3:30 PM IST)
- Controlled market-demo overrides for switching OPEN/CLOSED without changing the computer clock
- Real-time price feed via WebSocket (50 NSE instruments + synthetic indices)
- Geometric Brownian Motion price simulator (same model as Black-Scholes)
- ACID transactions for all money movement — no float bugs (integer paise)
- Wash trade prevention, deadlock-safe wallet locking
- JWT authentication with httpOnly cookies + refresh token rotation
- Live P&L dashboard, order management, wallet management

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express.js, MySQL 8.0 |
| Frontend | React, Vite, React Router v7 |
| Real-time | WebSocket (native ws library) |
| Auth | JWT + opaque refresh tokens + bcrypt |
| Database | MySQL with mysql2 connection pool |

## Local Setup

### Prerequisites
- Node.js and npm
- MySQL 8.0 running locally

Create the database before running migrations. The migration script creates tables in the configured database; it does not create the database itself:

```sql
CREATE DATABASE nexusbroker;
```

### Backend
```bash
cd backend
npm install
cp .env.example .env
```

Set the local database connection and an application-generated `ACCESS_TOKEN_SECRET` in `backend/.env`. Do not commit `.env` or share its contents. For a normal run, keep `MARKET_DEMO_MODE=false` (or leave it unset) so the market uses the real IST clock.

Run migrations and seed instruments before seeding demo users and holdings:

```bash
npm run migrate
npm run seed:instruments
npm run seed:demo
npm run dev
```

`seed:demo` adds demo funding, positions, orders, trades, and ledger entries. It is intended for a fresh local/demo database; do not repeatedly run it against an existing database because seeding is additive.

### Frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

The frontend defaults to the local backend API at `http://localhost:3000/api`. Set `VITE_API_URL` and `VITE_WS_URL` in `frontend/.env` only if your local backend uses different URLs.

### Demo Credentials
| User | Email | Password | Role |
|------|-------|----------|------|
| Arjun Mehta | arjun@demo.com | Demo@1234 | Buyer (₹5L balance) |
| Priya Shah | priya@demo.com | Demo@1234 | Seller (holds shares) |

These credentials are for the public/demo application. For local testing, use a disposable database and avoid placing orders on a shared book.

## Market Timing

The simulated cash market uses `Asia/Kolkata` time and is considered open Monday through Friday from **9:15 AM inclusive to 3:30 PM exclusive**. This means 9:15:00 AM is open and 3:30:00 PM is closed.

Simulated stock and index prices update only while the market is open and freeze while it is closed.

| Session | MARKET order | LIMIT order |
|---------|--------------|-------------|
| Open | Accepted and submitted to the matching engine | Accepted and submitted to the matching engine |
| Closed | Rejected; it is not queued | Accepted and persisted as `PENDING`, but held off the order book |

When the market opens, the scheduler selects persisted pending LIMIT orders and submits them through the existing matching engine. An order that does not cross an opposing order rests on the book and may continue to show `PENDING`; activation does not guarantee a fill. The displayed simulated last-traded price is not a counterparty order.

### Controlled market demo mode

Demo mode manually overrides market OPEN/CLOSED state so the flow can be demonstrated outside real market hours. These controls are intended for a controlled demonstration. The backend route is unavailable unless `MARKET_DEMO_MODE=true`; it also requires an authenticated user whose database ID matches `MARKET_DEMO_OPERATOR_ID`. The frontend controls are included only when `VITE_MARKET_DEMO_MODE=true` is set at build time. This explicit configuration also permits a controlled production demonstration; there is no local-IP restriction.

In `backend/.env`, set the backend opt-in and the database ID of the account authorized to operate the controls:

```dotenv
MARKET_DEMO_MODE=true
MARKET_DEMO_OPERATOR_ID=your_operator_user_id
```

`MARKET_DEMO_OPERATOR_ID` must match the authenticated account's `user_profiles.id`. Leave it unset to deny operator access.

Set the frontend flag when building the frontend (including production builds):

```dotenv
VITE_MARKET_DEMO_MODE=true
```

Log in as the configured operator and use the **OPEN** and **CLOSED** controls in the Markets or Portfolio navigation bar. CLOSED rejects new MARKET orders and queues new LIMIT orders as `PENDING`. OPEN waits for the current queued LIMIT activation attempt to complete; a failed activation is reported as an error and remains eligible for retry. Each CLOSED→OPEN transition activates a new demo cycle, even on the same date.

The control API is available only when `MARKET_DEMO_MODE=true` and only to authenticated requests whose user ID matches `MARKET_DEMO_OPERATOR_ID`:

- `GET /api/debug/market-demo` — read current state.
- `POST /api/debug/market-demo` with `{"state":"OPEN"}` or `{"state":"CLOSED"}` — change state.

This is a single-process, in-memory override. Restarting the backend resets the override to the real-clock default; it is not coordinated across multiple server instances. Keep it limited to a controlled demonstration and use a single backend instance while it is enabled.

### Testing market timing

Run the focused market-timing tests from `backend`:

```bash
node --test test/marketTiming.test.mjs
```

For a manual API/UI check, use a **fresh disposable local database** so test orders cannot match unrelated demo orders or affect demo holdings. Start the backend and frontend with demo mode enabled, log in as a dedicated test user, then:

1. Switch to CLOSED. Confirm a MARKET order is rejected. Submit a LIMIT order and confirm it is `PENDING`.
2. In local development, inspect the in-memory book with `GET /api/debug/orderbook/<symbol>`; the closed-market queued order should not be present yet.
3. Switch to OPEN. The control waits for activation. Inspect the book again: an unmatched LIMIT order should be resting there and may still have `PENDING` database status. A fill requires an opposing order at a matching price.
4. Switch back to CLOSED and repeat to demonstrate a second opening cycle on the same date.

The debug order-book endpoint is unavailable in production. Do not use the `seed:demo` accounts/database for isolated matching tests: seeded positions and orders may create counterparties. Cancel any remaining open test orders through the application before discarding or restoring the disposable database.

## Architecture Highlights

**Order Matching Engine:** Price-time priority, O(1) best bid/ask, partial fills, wash trade prevention via self-cross detection.

**Race Condition Prevention:** MySQL `SELECT ... FOR UPDATE` with consistent UUID sort order prevents deadlocks and double-spending.

**Event Sourcing:** The `trades` table is append-only. Portfolio state is always derived from trade history — never modified in-place.

**WebSocket Architecture:** One connection per user, pub-sub broker pattern inside React Context, auto-reconnect with exponential backoff.

## API Reference
See `/health` for service status. Application endpoints require JWT via httpOnly cookie except `/api/auth/register` and `/api/auth/login`. Debug endpoint availability is route-specific; the market-demo endpoints require explicit backend enablement and authenticated operator authorization.

## Running Tests
```bash
cd backend
npm test
```
`npm test` runs the automated `test/marketTiming.test.mjs` suite. It does not run `test/master_test.mjs`, which truncates tables in its configured database, or `test/test-race.mjs` and `test/thundering_herd.mjs`, which require a live server and create database writes or stress traffic. Run those scripts only as deliberate manual tests with a disposable database and server.

## Market Simulation Limitations
- There is no exchange holiday calendar or support for special/extended sessions; the schedule is weekday-only.
- Trading and prices are simulated. NexusBroker is not connected to NSE and does not route live orders.
