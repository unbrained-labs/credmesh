import { DurableObject } from "cloudflare:workers";
import { computeCreditProfile, quoteAdvance } from "./credit";
import { createEvent, computePortfolio, computeRisk, generateHappyPath, generateFailurePath } from "./demo";
import { rankBids, evaluateBid, awardJob } from "./marketplace";
import {
  DEFAULT_TREASURY,
  depositFunds,
  reserveFunds,
  returnFunds,
  recordDefaultLoss,
  settleWaterfall,
  buildSpendPolicy,
  validateSpend,
} from "./treasury";
import type {
  AgentRecord,
  AgentRegistrationInput,
  AgentState,
  Bid,
  CreditAdvance,
  CreditProfile,
  CreditQuote,
  Env,
  JobReceivable,
  PortfolioReport,
  RiskReport,
  SpendCategory,
  SpendRecord,
  TimelineEvent,
  TreasuryDeposit,
  TreasuryState,
  WaterfallResult,
} from "./types";
import { escrowIssueAdvance, escrowSettle, writeReputation, isChainEnabled, isEscrowEnabled, transferTokens, vaultRecordRepayment, vaultRecordDefault, vaultSupplyToEscrow } from "./chain";
import { splitFee } from "./pricing";
import { norm, rc } from "./utils";

const DEFAULT_STATE: AgentState = {
  agents: {},
  jobs: {},
  advances: {},
  bids: {},
  treasury: { ...DEFAULT_TREASURY },
  spendRecords: {},
  timeline: [],
};

export class CreditAgent extends DurableObject<Env> {
  private state!: AgentState;
  private initialized = false;

  private async init(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.ctx.storage.get<AgentState>("state");
    this.state = stored ?? structuredClone(DEFAULT_STATE);
    if (!this.state.bids) this.state.bids = {};
    if (!this.state.treasury) this.state.treasury = { ...DEFAULT_TREASURY };
    // Migrate treasury to include protocol fee tracking
    if (this.state.treasury.totalProtocolFees === undefined) this.state.treasury.totalProtocolFees = 0;
    if (this.state.treasury.totalUnderwriterFees === undefined) this.state.treasury.totalUnderwriterFees = 0;
    if (!this.state.spendRecords) this.state.spendRecords = {};
    if (!this.state.timeline) this.state.timeline = [];
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private pushEvent(
    type: TimelineEvent["type"],
    actor: string,
    description: string,
    data: Record<string, unknown> = {},
  ): void {
    this.state.timeline.push(createEvent(type, actor, description, data));
    if (this.state.timeline.length > 500) {
      this.state.timeline = this.state.timeline.slice(-500);
    }
  }

  // ─── Agent Registration ───

  async registerAgent(
    input: AgentRegistrationInput & { identityRegistered: boolean },
  ): Promise<AgentRecord> {
    await this.init();

    const now = Date.now();
    const address = norm(input.address);
    const existing = this.state.agents[address];
    const agent: AgentRecord = {
      address,
      name: input.name,
      url: input.url ?? existing?.url,
      trustScore: input.trustScore ?? existing?.trustScore ?? 0,
      attestationCount: input.attestationCount ?? existing?.attestationCount ?? 0,
      cooperationSuccessCount: input.cooperationSuccessCount ?? existing?.cooperationSuccessCount ?? 0,
      successfulJobs: input.successfulJobs ?? existing?.successfulJobs ?? 0,
      failedJobs: input.failedJobs ?? existing?.failedJobs ?? 0,
      averageCompletedPayout: input.averageCompletedPayout ?? existing?.averageCompletedPayout ?? 0,
      identityRegistered: input.identityRegistered,
      repaidAdvances: existing?.repaidAdvances ?? 0,
      defaultedAdvances: existing?.defaultedAdvances ?? 0,
      totalBorrowed: existing?.totalBorrowed ?? 0,
      totalRepaid: existing?.totalRepaid ?? 0,
      outstandingBalance: existing?.outstandingBalance ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.state.agents[address] = agent;
    this.pushEvent("agent_registered", address, `Agent "${agent.name}" registered.`, { name: agent.name });
    await this.persist();
    return agent;
  }

  async getAgent(address: string): Promise<AgentRecord | null> {
    await this.init();
    return this.state.agents[norm(address)] ?? null;
  }

  // ─── Credit ───

  async getProfile(address: string): Promise<CreditProfile> {
    await this.init();
    const agent = this.requireAgent(address);
    return computeCreditProfile(agent);
  }

  async quoteAdvance(input: {
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }): Promise<CreditQuote> {
    await this.init();
    const profile = this.getProfileInternal(input.agentAddress);
    const job = this.requireOpenJob(input.jobId, norm(input.agentAddress));
    const quote = quoteAdvance(profile, job, rc(input.requestedAmount), input.purpose, this.state.treasury);
    this.pushEvent("quote_issued", norm(input.agentAddress), `Quote: ${quote.decision} for $${quote.approvedAmount.toFixed(2)}.`, {
      decision: quote.decision,
      approvedAmount: quote.approvedAmount,
      requestedAmount: quote.requestedAmount,
      feeRate: quote.feeBreakdown.effectiveRate,
    });
    await this.persist();
    return quote;
  }

  async createAdvance(input: {
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }): Promise<{ quote: CreditQuote; advance?: CreditAdvance }> {
    await this.init();
    const quote = this.quoteAdvanceInternal(input);
    if (quote.decision !== "APPROVED") {
      return { quote };
    }

    if (this.state.treasury.availableFunds < quote.approvedAmount) {
      quote.decision = "DECLINED";
      quote.reasons.push("Insufficient treasury funds.");
      return { quote };
    }

    const agent = this.requireAgent(input.agentAddress);
    const job = this.requireOpenJob(input.jobId, norm(input.agentAddress));
    const now = Date.now();

    const spendPolicy = buildSpendPolicy(quote.approvedAmount, input.purpose);

    const advance: CreditAdvance = {
      id: crypto.randomUUID(),
      agentAddress: norm(input.agentAddress),
      jobId: job.id,
      requestedAmount: rc(input.requestedAmount),
      approvedAmount: quote.approvedAmount,
      fee: quote.fee,
      purpose: input.purpose,
      constraints: quote.constraints,
      decision: quote.decision,
      status: "active",
      dueAt: now + job.durationHours * 60 * 60 * 1000,
      createdAt: now,
      spendPolicy,
      totalSpent: 0,
      spendCount: 0,
    };

    agent.outstandingBalance = rc(agent.outstandingBalance + advance.approvedAmount + advance.fee);
    agent.totalBorrowed = rc(agent.totalBorrowed + advance.approvedAmount);
    agent.updatedAt = now;

    this.state.advances[advance.id] = advance;
    this.state.treasury = reserveFunds(this.state.treasury, advance.approvedAmount);

    // On-chain capital flow: vault → escrow → agent
    // 1. Supply capital from vault to escrow (if vault enabled)
    // 2. Escrow issues advance to agent
    try {
      if (this.env.CREDIT_VAULT && isChainEnabled(this.env)) {
        await vaultSupplyToEscrow(this.env, advance.approvedAmount + advance.fee);
      }
      if (isEscrowEnabled(this.env)) {
        const txResult = await escrowIssueAdvance(
          this.env, advance.id, input.agentAddress, advance.approvedAmount, advance.fee,
        );
        if (txResult) advance.transferTxHash = txResult.txHash;
      } else if (isChainEnabled(this.env)) {
        const txResult = await transferTokens(this.env, input.agentAddress, advance.approvedAmount);
        if (txResult) advance.transferTxHash = txResult.txHash;
      }
    } catch (e) {
      console.error("Chain advance failed (non-fatal):", e);
    }

    this.pushEvent("advance_created", norm(input.agentAddress), `Advance $${advance.approvedAmount.toFixed(2)} issued for "${input.purpose}".`, {
      advanceId: advance.id,
      amount: advance.approvedAmount,
      fee: advance.fee,
      jobId: job.id,
      transferTxHash: advance.transferTxHash ?? null,
    });

    await this.persist();
    return { quote, advance };
  }

  // ─── Marketplace ───

  async createJob(body: {
    agentAddress: string;
    payer: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
  }): Promise<JobReceivable> {
    await this.init();
    this.requireAgent(body.agentAddress);
    return this.insertJob(norm(body.agentAddress), body.payer, body.title, body.expectedPayout, body.durationHours, body.category, undefined, "job_created");
  }

  async postJob(input: {
    postedBy: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
    requiredCapabilities?: string[];
  }): Promise<JobReceivable> {
    await this.init();
    return this.insertJob("", input.postedBy, input.title, input.expectedPayout, input.durationHours, input.category, input.requiredCapabilities, "job_posted");
  }

  private async insertJob(
    agentAddress: string,
    payer: string,
    title: string,
    expectedPayout: number,
    durationHours: number,
    category: string,
    requiredCapabilities: string[] | undefined,
    eventType: "job_created" | "job_posted",
  ): Promise<JobReceivable> {
    const job: JobReceivable = {
      id: crypto.randomUUID(),
      agentAddress,
      payer,
      postedBy: agentAddress ? undefined : payer,
      title,
      expectedPayout: rc(expectedPayout),
      durationHours,
      category,
      requiredCapabilities,
      status: "open",
      createdAt: Date.now(),
    };

    this.state.jobs[job.id] = job;
    this.pushEvent(eventType, payer, `Job "${title}" ($${job.expectedPayout.toFixed(2)}).`, {
      jobId: job.id,
      expectedPayout: job.expectedPayout,
      category,
    });
    await this.persist();
    return job;
  }

  async submitBid(input: {
    jobId: string;
    agentAddress: string;
    proposedCost: number;
    estimatedHours: number;
    capabilities: string[];
    pitch: string;
  }): Promise<{ bid: Bid; evaluation: { eligible: boolean; reasons: string[] } }> {
    await this.init();
    const agent = this.requireAgent(input.agentAddress);
    const job = this.requireJob(input.jobId);
    if (job.status !== "open") throw new Error("Job is not open for bidding.");
    if (job.agentAddress) throw new Error("Job is already assigned.");

    const profile = computeCreditProfile(agent);

    const bid: Bid = {
      id: crypto.randomUUID(),
      jobId: job.id,
      agentAddress: norm(input.agentAddress),
      proposedCost: rc(input.proposedCost),
      estimatedHours: input.estimatedHours,
      capabilities: input.capabilities,
      pitch: input.pitch,
      creditScore: profile.creditScore,
      status: "pending",
      createdAt: Date.now(),
    };

    const evaluation = evaluateBid(bid, job);
    this.state.bids[bid.id] = bid;

    this.pushEvent("bid_submitted", norm(input.agentAddress), `Bid on "${job.title}": $${bid.proposedCost.toFixed(2)}, score ${bid.creditScore}.`, {
      bidId: bid.id,
      jobId: job.id,
      proposedCost: bid.proposedCost,
      creditScore: bid.creditScore,
      eligible: evaluation.eligible,
    });

    await this.persist();
    return { bid, evaluation };
  }

  async getBids(jobId: string): Promise<{ bids: Bid[]; ranked: Bid[] }> {
    await this.init();
    const job = this.requireJob(jobId);
    const bids = Object.values(this.state.bids).filter((b) => b.jobId === jobId);
    const eligible = bids.filter((b) => evaluateBid(b, job).eligible);
    const ranked = rankBids(eligible);
    return { bids, ranked };
  }

  async awardBid(input: {
    jobId: string;
    bidId: string;
  }): Promise<{ job: JobReceivable; acceptedBid: Bid; rejectedBids: Bid[] }> {
    await this.init();
    const job = this.requireJob(input.jobId);
    if (job.agentAddress) throw new Error("Job is already assigned.");
    const bid = this.state.bids[input.bidId];
    if (!bid) throw new Error(`Unknown bid: ${input.bidId}`);
    if (bid.jobId !== job.id) throw new Error("Bid does not belong to this job.");

    const updatedJob = awardJob(job, bid);
    this.state.jobs[job.id] = updatedJob;

    bid.status = "accepted";

    const rejectedBids: Bid[] = [];
    for (const b of Object.values(this.state.bids)) {
      if (b.jobId === job.id && b.id !== bid.id) {
        b.status = "rejected";
        rejectedBids.push(b);
      }
    }

    this.pushEvent("bid_awarded", bid.agentAddress, `Bid awarded for "${job.title}" to ${bid.agentAddress}.`, {
      jobId: job.id,
      bidId: bid.id,
      proposedCost: bid.proposedCost,
    });

    await this.persist();
    return { job: updatedJob, acceptedBid: bid, rejectedBids };
  }

  async listOpenJobs(): Promise<JobReceivable[]> {
    await this.init();
    return Object.values(this.state.jobs).filter(
      (j) => j.status === "open" && !j.agentAddress,
    );
  }

  // ─── Job Completion & Waterfall ───

  async completeJob(input: { jobId: string; actualPayout?: number; callerAddress?: string }): Promise<{
    job: JobReceivable;
    waterfall: WaterfallResult;
    settledAdvances: CreditAdvance[];
  }> {
    await this.init();
    const job = this.requireJob(input.jobId);
    if (job.status !== "open") throw new Error("Job is not open.");

    // Authorization: only the job's payer or assigned agent can complete
    if (input.callerAddress) {
      const caller = input.callerAddress.toLowerCase();
      const isPayer = job.payer.toLowerCase() === caller;
      const isAgent = job.agentAddress.toLowerCase() === caller;
      if (!isPayer && !isAgent) {
        throw new Error("Job can only be completed by its payer or assigned agent.");
      }
    }

    // Clamp payout to 2x expected to prevent inflated repayment history
    const maxPayout = rc(job.expectedPayout * 2);
    const rawPayout = rc(Math.max(0, input.actualPayout ?? job.expectedPayout));
    const actualPayout = rc(Math.min(rawPayout, maxPayout));
    job.status = "completed";
    job.completedAt = Date.now();
    job.actualPayout = actualPayout;

    const agent = this.requireAgent(job.agentAddress);
    const activeAdvances = Object.values(this.state.advances).filter(
      (a) => a.jobId === job.id && a.status === "active",
    );

    const waterfall = settleWaterfall(actualPayout, activeAdvances);

    const totalDue = activeAdvances.reduce((s, a) => s + a.approvedAmount + a.fee, 0);
    let repaidTotal = 0;

    for (const advance of activeAdvances) {
      const advanceDue = rc(advance.approvedAmount + advance.fee);
      const share = totalDue > 0 ? advanceDue / totalDue : 0;
      const amountPaid = rc((waterfall.principalRepaid + waterfall.feePaid) * share);
      repaidTotal = rc(repaidTotal + amountPaid);

      advance.repaidAt = Date.now();
      advance.repaidAmount = amountPaid;

      if (amountPaid >= advanceDue) {
        advance.status = "repaid";
        agent.repaidAdvances += 1;
        this.pushEvent("advance_repaid", agent.address, `Advance $${advance.approvedAmount.toFixed(2)} repaid in full.`, {
          advanceId: advance.id, amountPaid,
        });
      } else {
        advance.status = "defaulted";
        advance.defaultReason = `Payout shortfall. Paid $${amountPaid.toFixed(2)} of $${advanceDue.toFixed(2)}.`;
        agent.defaultedAdvances += 1;
        const loss = rc(advanceDue - amountPaid);
        this.state.treasury = recordDefaultLoss(this.state.treasury, loss);
        this.pushEvent("advance_defaulted", agent.address, `Advance partially defaulted. Shortfall: $${loss.toFixed(2)}.`, {
          advanceId: advance.id, amountPaid, shortfall: loss,
        });
      }

      agent.outstandingBalance = rc(Math.max(0, agent.outstandingBalance - advanceDue));
    }

    // Penalties are pool revenue — split same as fees
    const { underwriterFee: penaltyUnderwriter, protocolFee: penaltyProtocol } = splitFee(waterfall.penaltyApplied);
    this.state.treasury = returnFunds(
      this.state.treasury,
      waterfall.principalRepaid,
      rc(waterfall.underwriterFeePaid + penaltyUnderwriter),
      rc(waterfall.protocolFeePaid + penaltyProtocol),
    );

    // Only count as successful if no advances defaulted
    const hasDefault = activeAdvances.some((a) => a.status === "defaulted");
    if (!hasDefault) {
      agent.successfulJobs += 1;
    } else {
      agent.failedJobs += 1;
    }
    agent.totalRepaid = rc(agent.totalRepaid + repaidTotal);
    agent.averageCompletedPayout = updateAveragePayout(
      agent.averageCompletedPayout,
      agent.successfulJobs,
      actualPayout,
    );
    agent.updatedAt = Date.now();

    // On-chain operations: settle escrow, record in vault, write reputation
    // Wrapped in try/catch so demo/test data works even if chain ops fail
    try {
      if (isEscrowEnabled(this.env)) {
        for (const advance of activeAdvances) {
          const repayAmount = advance.repaidAmount ?? 0;
          if (repayAmount > 0) {
            const settleTx = await escrowSettle(this.env, advance.id, repayAmount);
            if (settleTx) advance.repaymentTxHash = settleTx.txHash;
          }
        }
      }

      if (this.env.CREDIT_VAULT && isChainEnabled(this.env)) {
        if (waterfall.principalRepaid > 0 || waterfall.underwriterFeePaid > 0) {
          await vaultRecordRepayment(this.env, waterfall.principalRepaid, waterfall.underwriterFeePaid);
        }
        if (waterfall.shortfall > 0) {
          await vaultRecordDefault(this.env, waterfall.shortfall);
        }
      }

      if (isChainEnabled(this.env)) {
        const score = hasDefault ? 1 : 10;
        const evidence = JSON.stringify({
          type: hasDefault ? "partial_repayment" : "full_repayment",
          jobId: job.id,
          payout: actualPayout,
          waterfall: waterfall.status,
          advances: activeAdvances.length,
          source: "trustvault-credit",
        });
        const txHash = await writeReputation(this.env, agent.address, score, evidence);
        if (txHash) {
          job.reputationTxHash = txHash;
        }
      }
    } catch (e) {
      console.error("Chain settlement failed (non-fatal):", e);
    }

    this.pushEvent("job_completed", agent.address, `Job "${job.title}" completed. Payout: $${actualPayout.toFixed(2)}.`, {
      jobId: job.id, actualPayout, waterfallStatus: waterfall.status,
      reputationTxHash: job.reputationTxHash ?? null,
    });

    await this.persist();
    return { job, waterfall, settledAdvances: activeAdvances };
  }

  // ─── Default ───

  async defaultAdvance(input: { advanceId: string; reason: string }): Promise<CreditAdvance> {
    await this.init();
    const advance = this.requireAdvance(input.advanceId);
    if (advance.status !== "active") throw new Error("Advance is not active.");

    advance.status = "defaulted";
    advance.defaultReason = input.reason;
    advance.repaidAt = Date.now();
    advance.repaidAmount = 0;

    const agent = this.requireAgent(advance.agentAddress);
    agent.defaultedAdvances += 1;
    // Only principal was disbursed — fee is contingent on repayment
    const lostPrincipal = advance.approvedAmount;
    const totalOwed = rc(advance.approvedAmount + advance.fee);
    agent.outstandingBalance = rc(Math.max(0, agent.outstandingBalance - totalOwed));
    agent.updatedAt = Date.now();

    if (agent.defaultedAdvances >= 2) {
      agent.trustScore = Math.max(0, agent.trustScore - 10);
    }

    // Only record principal as loss (fee was never disbursed)
    this.state.treasury = recordDefaultLoss(this.state.treasury, lostPrincipal);

    const job = this.state.jobs[advance.jobId];
    if (job && job.status === "open") {
      job.status = "defaulted";
    }

    // On-chain: record loss in vault + write negative reputation
    try {
      if (this.env.CREDIT_VAULT && isChainEnabled(this.env)) {
        await vaultRecordDefault(this.env, lostPrincipal);
      }
      if (isChainEnabled(this.env)) {
        const evidence = JSON.stringify({
          type: "default",
          advanceId: advance.id,
          amount: advance.approvedAmount,
          reason: input.reason,
          source: "trustvault-credit",
        });
        await writeReputation(this.env, agent.address, 0, evidence);
      }
    } catch (e) {
      console.error("Chain default recording failed (non-fatal):", e);
    }

    this.pushEvent("advance_defaulted", agent.address, `Advance $${advance.approvedAmount.toFixed(2)} defaulted: ${input.reason}`, {
      advanceId: advance.id, amount: advance.approvedAmount, reason: input.reason,
    });

    await this.persist();
    return advance;
  }

  // ─── Treasury ───

  async deposit(input: {
    lenderAddress: string;
    amount: number;
    memo?: string;
  }): Promise<{ deposit: TreasuryDeposit; treasury: TreasuryState }> {
    await this.init();
    const result = depositFunds(this.state.treasury, input.lenderAddress, input.amount, input.memo ?? "");
    this.state.treasury = result.treasury;

    this.pushEvent("deposit_received", input.lenderAddress, `Treasury deposit: $${result.deposit.amount.toFixed(2)}.`, {
      depositId: result.deposit.id, amount: result.deposit.amount,
    });

    await this.persist();
    return result;
  }

  async getTreasury(): Promise<TreasuryState> {
    await this.init();
    return this.state.treasury;
  }

  // ─── Spend Controls ───

  async recordSpend(input: {
    advanceId: string;
    category: SpendCategory;
    amount: number;
    vendor: string;
    description: string;
  }): Promise<SpendRecord> {
    await this.init();
    const advance = this.requireAdvance(input.advanceId);
    if (advance.status !== "active") throw new Error("Advance is not active.");

    const policy = advance.spendPolicy;
    if (!policy) throw new Error("Advance has no spend policy.");

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();

    // Only scan spend records for this advance
    const todaySpend = Object.values(this.state.spendRecords)
      .filter((r) => r.advanceId === advance.id && r.approved && r.createdAt >= todayStart)
      .reduce((s, r) => s + r.amount, 0);

    const validation = validateSpend(
      policy,
      input.category,
      rc(input.amount),
      todaySpend,
      advance.totalSpent ?? 0,
      advance.approvedAmount,
    );

    const record: SpendRecord = {
      id: crypto.randomUUID(),
      advanceId: advance.id,
      category: input.category,
      amount: rc(input.amount),
      vendor: input.vendor,
      description: input.description,
      approved: validation.approved,
      rejectionReason: validation.reason,
      createdAt: Date.now(),
    };

    this.state.spendRecords[record.id] = record;

    if (validation.approved) {
      advance.totalSpent = rc((advance.totalSpent ?? 0) + record.amount);
      advance.spendCount = (advance.spendCount ?? 0) + 1;
    }

    this.pushEvent("spend_recorded", advance.agentAddress, `Spend ${validation.approved ? "approved" : "rejected"}: $${record.amount.toFixed(2)} on ${input.category}.`, {
      spendId: record.id, advanceId: advance.id, category: input.category, amount: record.amount, approved: validation.approved,
    });

    await this.persist();
    return record;
  }

  async getSpendHistory(advanceId: string): Promise<{
    records: SpendRecord[];
    totalSpent: number;
    remainingBudget: number;
    policy: SpendCategory[] | null;
  }> {
    await this.init();
    const advance = this.requireAdvance(advanceId);
    const records = Object.values(this.state.spendRecords)
      .filter((r) => r.advanceId === advanceId)
      .sort((a, b) => b.createdAt - a.createdAt);

    const totalSpent = advance.totalSpent ?? 0;
    return {
      records,
      totalSpent,
      remainingBudget: rc(advance.approvedAmount - totalSpent),
      policy: advance.spendPolicy?.allowedCategories ?? null,
    };
  }

  // ─── Dashboard ───

  async getPortfolio(): Promise<PortfolioReport> {
    await this.init();
    return computePortfolio(this.state);
  }

  async getRisk(): Promise<RiskReport> {
    await this.init();
    return computeRisk(this.state);
  }

  // ─── Timeline ───

  async getTimeline(limit = 50): Promise<TimelineEvent[]> {
    await this.init();
    return this.state.timeline.slice(-limit).reverse();
  }

  // ─── Demo ───

  async bootstrapDemo(scenario: "happy" | "failure" | "both"): Promise<{
    summary: string;
    agentsCreated: number;
    jobsCreated: number;
    advancesCreated: number;
    events: number;
  }> {
    await this.init();

    if (this.state.treasury.availableFunds <= 0) {
      const { treasury } = depositFunds(this.state.treasury, "0xfff0000000000000000000000000000000000001", 1000, "Demo seed capital");
      this.state.treasury = treasury;
      this.pushEvent("deposit_received", "0xfff0000000000000000000000000000000000001", "Demo treasury seeded with $1000.", { amount: 1000 });
    }

    let agentsCreated = 0;
    let jobsCreated = 0;
    let advancesCreated = 0;
    const startEvents = this.state.timeline.length;

    const runScenario = async (
      data: ReturnType<typeof generateHappyPath> | ReturnType<typeof generateFailurePath>,
      identityRegistered: boolean,
    ) => {
      const jobIds: string[] = [];

      for (const a of data.agents) {
        await this.registerAgent({ ...a, identityRegistered });
        agentsCreated++;
      }
      for (const j of data.jobs) {
        const job = await this.createJob(j);
        jobIds.push(job.id);
        jobsCreated++;
      }
      for (const adv of data.advances) {
        const result = await this.createAdvance({
          agentAddress: adv.agentAddress,
          jobId: jobIds[adv.jobIndex],
          requestedAmount: adv.requestedAmount,
          purpose: adv.purpose,
        });
        if (result.advance) advancesCreated++;
      }

      return jobIds;
    };

    if (scenario === "happy" || scenario === "both") {
      const data = generateHappyPath();
      const jobIds = await runScenario(data, true);
      for (const comp of data.completions) {
        await this.completeJob({ jobId: jobIds[comp.jobIndex], actualPayout: comp.actualPayout });
      }
    }

    if (scenario === "failure" || scenario === "both") {
      const data = generateFailurePath();
      const jobIds = await runScenario(data, false);

      for (const pc of data.partialCompletions) {
        await this.completeJob({ jobId: jobIds[pc.jobIndex], actualPayout: pc.actualPayout });
      }
      for (const def of data.defaults) {
        const targetJobId = jobIds[data.advances[def.advanceIndex].jobIndex];
        const advance = Object.values(this.state.advances).find(
          (a) => a.jobId === targetJobId && a.status === "active",
        );
        if (advance) {
          await this.defaultAdvance({ advanceId: advance.id, reason: def.reason });
        }
      }
    }

    const totalEvents = this.state.timeline.length - startEvents;
    const names = scenario === "both" ? "happy-path and failure-path" : `${scenario}-path`;

    return {
      summary: `Bootstrapped ${names} demo: ${agentsCreated} agents, ${jobsCreated} jobs, ${advancesCreated} advances.`,
      agentsCreated,
      jobsCreated,
      advancesCreated,
      events: totalEvents,
    };
  }

  async resetState(): Promise<{
    message: string;
    previousAgents: number;
    previousJobs: number;
    previousAdvances: number;
  }> {
    await this.init();
    const counts = {
      previousAgents: Object.keys(this.state.agents).length,
      previousJobs: Object.keys(this.state.jobs).length,
      previousAdvances: Object.keys(this.state.advances).length,
    };

    this.state = structuredClone(DEFAULT_STATE);
    this.pushEvent("state_reset", "system", "Full state reset.", counts);
    await this.persist();

    return { message: "State reset. All agents, jobs, and advances cleared.", ...counts };
  }

  async getSnapshot(): Promise<AgentState> {
    await this.init();
    return structuredClone(this.state);
  }

  // ─── Internal helpers ───

  private getProfileInternal(address: string): CreditProfile {
    return computeCreditProfile(this.requireAgent(address));
  }

  private quoteAdvanceInternal(input: {
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }): CreditQuote {
    const profile = this.getProfileInternal(input.agentAddress);
    const job = this.requireOpenJob(input.jobId, norm(input.agentAddress));
    return quoteAdvance(profile, job, rc(input.requestedAmount), input.purpose, this.state.treasury);
  }

  private requireAgent(address: string): AgentRecord {
    const agent = this.state.agents[norm(address)];
    if (!agent) throw new Error(`Unknown agent: ${address}`);
    return agent;
  }

  private requireJob(jobId: string): JobReceivable {
    const job = this.state.jobs[jobId];
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  private requireOpenJob(jobId: string, agentAddress: string): JobReceivable {
    const job = this.requireJob(jobId);
    if (job.agentAddress !== agentAddress) throw new Error("Job is not assigned to this agent.");
    if (job.status !== "open") throw new Error("Job is not open.");
    return job;
  }

  private requireAdvance(advanceId: string): CreditAdvance {
    const advance = this.state.advances[advanceId];
    if (!advance) throw new Error(`Unknown advance: ${advanceId}`);
    return advance;
  }
}

function updateAveragePayout(currentAverage: number, newCount: number, newValue: number): number {
  if (newCount <= 1) return rc(newValue);
  return rc((currentAverage * (newCount - 1) + newValue) / newCount);
}
