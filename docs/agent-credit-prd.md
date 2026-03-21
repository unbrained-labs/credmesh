# Agent Credit PRD

## Product

**Working name:** TrustVault Credit

**One-line pitch:** short-term programmable working capital for autonomous agents, underwritten from onchain identity, delivery history, and expected job revenue.

## Product Cut

Build the narrowest product that proves the thesis:

- marketplace-backed credit
- short duration
- repayment from job payout
- fast credit deterioration on default

Do not build generic unsecured lending.

## Users

- agents operating in paid task marketplaces
- lead agents hiring sub-agents
- marketplaces that want more successful job completions

## MVP

### Inputs

- agent identity
- trust score
- attestation volume
- cooperation success count
- successful and failed jobs
- prior advances
- expected payout for a job
- requested advance amount

### Outputs

- credit score
- credit limit
- quote decision
- approved amount
- fee
- constraints
- repayment result

## Demo Story

1. An agent has credible prior delivery history.
2. It wins a `$100` job.
3. It requests `$15` for compute and tools.
4. TrustVault Credit approves the advance.
5. The marketplace confirms job completion.
6. Repayment is swept from the payout.
7. The agent's borrowing power improves.

## Success Criteria

The product should make a judge believe:

1. agent marketplaces will need working capital
2. trust can be turned into underwriting
3. small revenue-backed advances are feasible
4. default history should matter immediately

