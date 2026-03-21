# TrustVault Credit

**Programmable working capital for autonomous agents**

TrustVault Credit underwrites short-term advances for agents that have won paid work but need funds before the payout arrives. It is built for agent marketplaces, not generic DeFi lending.

## Thesis

Agents need to spend money before they make money.

They pay for:

- inference
- browser automation
- paid APIs
- gas
- specialist sub-agents

Human freelancers use credit cards and invoice factoring. Agents have neither. TrustVault Credit fills that gap with revenue-backed microcredit.

## What It Does

- registers an agent credit profile
- simulates paid marketplace jobs
- computes a credit score and credit limit
- quotes a revenue-backed advance for a specific job
- issues an advance with explicit constraints
- sweeps repayment automatically when the job is completed
- penalizes defaults immediately

## Why It Matters

This is not "trust score for bots."

It is the underwriting layer for agent marketplaces:

- agents can buy compute before they get paid
- marketplaces can increase completion volume
- lenders can fund agent work using bounded risk
- sponsors like Aave can see a credible path to agent-native credit rails

## MVP API

### `POST /agents/register`

Seed or update an agent profile.

### `POST /marketplace/jobs`

Create a receivable-backed job for an agent.

### `POST /credit/profile`

Compute the agent's current credit profile.

### `POST /credit/quote`

Quote a short-term advance against a specific job payout.

### `POST /credit/advance`

Create the advance.

### `POST /marketplace/jobs/:jobId/complete`

Complete the job and sweep repayment.

### `POST /credit/default`

Record a default event.

## Quick Start

```bash
npm install
npm run dev
```

The worker runs from `packages/credit-worker`.

## Demo Flow

1. Register an agent with prior trust and delivery history.
2. Create a marketplace job with expected payout.
3. Request a credit quote for execution costs.
4. Approve an advance.
5. Complete the job.
6. Repay automatically from the payout.
7. Observe the improved credit profile.

## Aave Fit

This project is designed to map cleanly to a sponsor thesis around:

- undercollateralized lending
- working capital
- credit delegation
- stablecoin-denominated short-duration advances

The strongest sponsor-facing framing is:

**Revenue-backed credit rails for autonomous workers.**

## Repo Layout

- `packages/credit-worker`: Cloudflare Worker + Durable Object
- `docs/agent-credit-prd.md`: product requirements document

