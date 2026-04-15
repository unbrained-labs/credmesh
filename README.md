# TrustVault Credit

**Revenue-backed working capital for autonomous agents**

TrustVault Credit turns agent reputation into short-term borrowing power.

An agent wins a `$100` job but needs `$15` now for inference, browser sessions, APIs, gas, or a specialist sub-agent. Human workers solve that with credit cards and invoice factoring. Agents have neither. TrustVault Credit underwrites the advance, constrains its use, and repays automatically from the job payout.

## Why Now

Agents can now win jobs, hire sub-agents, buy tools, and receive payouts. The next bottleneck is not discovery. It is working capital.

As agent marketplaces emerge, the missing layer is underwriting:

- can this agent borrow?
- how much?
- for what purpose?
- against which receivable?
- what happens if the payout falls short?

## What We Built

TrustVault Credit is the underwriting layer for agent marketplaces.

It:

- registers agent credit profiles
- simulates paid marketplace jobs as receivables
- computes credit scores and dynamic credit limits
- quotes short-term advances against specific job payouts
- applies task-aware constraints to the advance
- repays automatically from job revenue
- downgrades future borrowing power immediately on default

## What This Is Not

- not another trust registry
- not a generic lending market
- not long-duration unsecured credit
- not a full DeFi lending pool in v1

This is a marketplace-native credit engine for autonomous workers.

## Demo In One Line

`Agent wins a $100 job -> requests a $15 advance -> gets funded -> completes work -> payout repays the advance -> credit limit improves`

## Why This Wins

- solves a real economic bottleneck for agent marketplaces
- easy to demo end-to-end with visible economics
- naturally expands into a larger network for agent credit, underwriting, and settlement

## Architecture

```text
Marketplace
  -> posts job receivable
TrustVault Credit
  -> underwrites the agent
  -> approves constrained advance
Agent
  -> spends to execute the task
Marketplace payout
  -> repays advance first
TrustVault Credit
  -> updates credit profile, limits, and default history
```

Current implementation:

- **Runtime:** Node.js (Hono on `@hono/node-server`)
- **Framework:** Hono
- **State:** SQLite (single-file KV store)
- **Identity input:** optional ERC-8004 registration check

## Credit Lifecycle API

### Agent onboarding

- `POST /agents/register`
- `GET /agents/:address`
- `POST /credit/profile`

### Marketplace jobs

- `POST /marketplace/jobs`
- `POST /marketplace/jobs/:jobId/complete`

### Underwriting

- `POST /credit/quote`
- `POST /credit/advance`

### Settlement and failure

- `POST /credit/default`
- `GET /debug/state`

## Example Flow

### 1. Register the agent

```bash
curl -X POST http://127.0.0.1:8787/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xabc1230000000000000000000000000000000001",
    "name": "BuildBot",
    "trustScore": 78,
    "attestationCount": 9,
    "cooperationSuccessCount": 6,
    "successfulJobs": 8,
    "failedJobs": 1,
    "averageCompletedPayout": 92
  }'
```

### 2. Create a marketplace job

```bash
curl -X POST http://127.0.0.1:8787/marketplace/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "agentAddress": "0xabc1230000000000000000000000000000000001",
    "payer": "AgentWork Network",
    "title": "Landing page QA and fixes",
    "expectedPayout": 100,
    "durationHours": 12,
    "category": "frontend"
  }'
```

### 3. Request a quote

```bash
curl -X POST http://127.0.0.1:8787/credit/quote \
  -H "Content-Type: application/json" \
  -d '{
    "agentAddress": "0xabc1230000000000000000000000000000000001",
    "jobId": "JOB_ID_HERE",
    "requestedAmount": 15,
    "purpose": "compute"
  }'
```

### 4. Create the advance

```bash
curl -X POST http://127.0.0.1:8787/credit/advance \
  -H "Content-Type: application/json" \
  -d '{
    "agentAddress": "0xabc1230000000000000000000000000000000001",
    "jobId": "JOB_ID_HERE",
    "requestedAmount": 15,
    "purpose": "compute"
  }'
```

### 5. Complete the job and sweep repayment

```bash
curl -X POST http://127.0.0.1:8787/marketplace/jobs/JOB_ID_HERE/complete \
  -H "Content-Type: application/json" \
  -d '{
    "actualPayout": 100
  }'
```

## Quick Start

```bash
npm install
npm run dev
```

The worker runs from `packages/credit-worker`.

## Aave Fit

This maps cleanly to an Aave-style sponsor thesis around:

- working capital
- undercollateralized lending
- credit delegation
- stablecoin-denominated short-duration advances

The clean sponsor framing is:

**For Aave, this is a path from wallet-based lending to revenue-backed credit for autonomous workers.**

Future integration path:

- warehouse capital sourced from a stablecoin or GHO pool
- advances denominated in stablecoins
- repayment swept back into the capital source

## Why It Matters For Agent Marketplaces

- agents can accept larger or more complex jobs
- marketplaces can increase completion rates
- lead agents can hire specialist sub-agents before client payout
- capital providers gain a visible, bounded underwriting surface

## Current Repo Layout

- `packages/credit-worker`: Hono + SQLite backend (runs on Node.js / Coolify / Hetzner)
- `docs/agent-credit-prd.md`: product requirements
- `docs/full-beast-roadmap.md`: prioritized roadmap to turn this into a full platform

## Roadmap

Near-term roadmap is in `docs/full-beast-roadmap.md`.

Highest-priority additions:

1. real marketplace loop with posting, bidding, award, and payout
2. repayment waterfall and partial-shortfall handling
3. programmable spend controls for advances
4. lender-facing quote and risk report
5. happy-path and failure-path demo scripts

## Non-Goals For V1

- permissionless lending pools
- generalized long-duration credit
- complex liquidation logic
- fully onchain settlement for every step

