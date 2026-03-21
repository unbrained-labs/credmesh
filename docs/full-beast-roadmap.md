# Full Beast Roadmap

## Goal

Turn TrustVault Credit from a credit MVP into the default underwriting and working-capital layer for agent marketplaces.

## North Star

An agent should be able to:

1. win a paid job
2. borrow against that receivable
3. spend the advance within policy
4. complete the work
5. repay automatically
6. build portable financial reputation over time

## Build Order

## Phase 1: Make The Core Loop Undeniable

These are the highest-leverage additions.

### 1. Real marketplace loop

Add:

- job posting
- agent bidding
- bid award
- receivable creation from awarded job

Why:

- makes the product obviously about autonomous workers
- gives the demo a stronger narrative than manual job creation

### 2. Receivable-scoped underwriting

Strengthen quote inputs with:

- task type
- deadline
- expected payout
- payer reliability
- requested advance / payout ratio

Why:

- makes underwriting legible
- is more defensible than generic reputation-based scoring

### 3. Repayment waterfall

Add settlement logic:

- payout arrives
- lender principal repaid first
- fee paid second
- remainder sent to agent
- payout shortfall recorded explicitly

Why:

- this is the economic heart of the system

### 4. Default deterioration

Add:

- missed-deadline default
- payout-shortfall default
- repeat-default penalties
- higher fee for weaker borrowers

Why:

- without deterioration, the underwriting is not credible

## Phase 2: Make It Feel Novel

### 5. Programmable spend controls

Advance should specify allowed uses such as:

- compute
- browser credits
- paid APIs
- gas
- sub-agent payroll

Why:

- "money with guardrails" is much stronger than generic lending

### 6. Receipts and auditability

Emit receipts for:

- quote issued
- advance created
- spend authorized
- job completed
- repayment settled
- default recorded

Why:

- creates portable financial reputation
- makes the system inspectable for lenders and marketplaces

### 7. Capability-specific underwriting

Track reliability per task category:

- code
- research
- browser automation
- growth ops
- onchain execution

Why:

- "strong research borrower, weak coding borrower" is more realistic and more defensible than one global score

## Phase 3: Make It Two-Sided

### 8. Lender-facing risk report

Add a lender or underwriter view showing:

- advance amount
- fee
- expected payout
- coverage ratio
- confidence
- historical repayment rate
- default rate

Why:

- turns this into a real capital product instead of only a borrower product

### 9. Portfolio dashboard

Add a dashboard with:

- active advances
- exposure by category
- repayment rate
- default rate
- utilization
- top borrowers

Why:

- helps judges and sponsors see the system as infrastructure

## Phase 4: Make It Multi-Agent Native

### 10. Sub-agent payroll

Support a lead agent that:

- wins a job
- takes an advance
- allocates part of that advance to a specialist sub-agent
- repays from the final client payout

Why:

- this is the strongest multi-agent use case

### 11. Team or agent-org credit

Add credit at the level of:

- individual agent
- agent team
- lead agent with delegated sub-agents

Why:

- agent companies are likely to emerge, not just solo agents

## Phase 5: Make It Sponsor-Grade

### 12. Stablecoin or GHO capital source

Show a path where:

- capital comes from a warehouse pool
- advances are stablecoin-denominated
- repayment flows back to the capital source

Why:

- makes the Aave fit concrete without overbuilding DeFi mechanics too early

### 13. Credit delegation

Support a lender or backer that delegates a credit line to marketplace underwriting logic.

Why:

- this is a clean bridge to existing lending primitives

## Demo Additions

## Happy path

Show:

1. job posted
2. bid awarded
3. `$15` advance approved against `$100` payout
4. funds spent on compute
5. work completed
6. payout sweeps repayment
7. agent limit increases

## Failure path

Show:

1. job posted
2. advance approved
3. weak delivery or payout shortfall
4. partial repayment
5. default recorded
6. next quote becomes smaller and more expensive

## What Creates Moat

- repayment history tied to actual task outcomes
- programmable credit restrictions
- category-specific underwriting
- receipts for portable agent financial reputation
- embedded position inside agent marketplaces

## What Not To Build Next

- permissionless lender marketplace
- generalized consumer-style credit
- long-duration unsecured loans
- deep liquidation systems
- too much DeFi plumbing before the underwriting loop is strong

## Work Packages For Extra Agents

### Agent 1

Build the marketplace loop:

- posting
- bidding
- award
- receivable creation

### Agent 2

Build spend controls and repayment waterfall.

### Agent 3

Build judge-facing demo flows and a risk dashboard.
