import { DurableObject } from "cloudflare:workers";
import { computeCreditProfile, quoteAdvance } from "./credit";
import type {
  AgentRecord,
  AgentRegistrationInput,
  AgentState,
  CreditAdvance,
  CreditProfile,
  CreditQuote,
  Env,
  JobReceivable,
} from "./types";

const DEFAULT_STATE: AgentState = {
  agents: {},
  jobs: {},
  advances: {},
};

export class CreditAgent extends DurableObject<Env> {
  private state!: AgentState;
  private initialized = false;

  private async init(): Promise<void> {
    if (this.initialized) return;
    this.state = (await this.ctx.storage.get<AgentState>("state")) ?? structuredClone(DEFAULT_STATE);
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  async registerAgent(input: AgentRegistrationInput & { identityRegistered: boolean }): Promise<AgentRecord> {
    await this.init();

    const now = Date.now();
    const address = normalizeAddress(input.address);
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
    await this.persist();
    return agent;
  }

  async getAgent(address: string): Promise<AgentRecord | null> {
    await this.init();
    return this.state.agents[normalizeAddress(address)] ?? null;
  }

  async getProfile(address: string): Promise<CreditProfile> {
    await this.init();
    const agent = this.requireAgent(address);
    return computeCreditProfile(agent);
  }

  async createJob(input: {
    agentAddress: string;
    payer: string;
    title: string;
    expectedPayout: number;
    durationHours: number;
    category: string;
  }): Promise<JobReceivable> {
    await this.init();
    this.requireAgent(input.agentAddress);

    const job: JobReceivable = {
      id: crypto.randomUUID(),
      agentAddress: normalizeAddress(input.agentAddress),
      payer: input.payer,
      title: input.title,
      expectedPayout: roundCurrency(input.expectedPayout),
      durationHours: input.durationHours,
      category: input.category,
      status: "open",
      createdAt: Date.now(),
    };

    this.state.jobs[job.id] = job;
    await this.persist();
    return job;
  }

  async getJob(jobId: string): Promise<JobReceivable | null> {
    await this.init();
    return this.state.jobs[jobId] ?? null;
  }

  async quoteAdvance(input: {
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }): Promise<CreditQuote> {
    await this.init();
    const profile = await this.getProfile(input.agentAddress);
    const job = this.requireOpenJob(input.jobId, normalizeAddress(input.agentAddress));
    return quoteAdvance(profile, job, roundCurrency(input.requestedAmount), input.purpose);
  }

  async createAdvance(input: {
    agentAddress: string;
    jobId: string;
    requestedAmount: number;
    purpose: string;
  }): Promise<{ quote: CreditQuote; advance?: CreditAdvance }> {
    await this.init();
    const quote = await this.quoteAdvance(input);
    if (quote.decision !== "APPROVED") {
      return { quote };
    }

    const agent = this.requireAgent(input.agentAddress);
    const job = this.requireOpenJob(input.jobId, normalizeAddress(input.agentAddress));
    const now = Date.now();

    const advance: CreditAdvance = {
      id: crypto.randomUUID(),
      agentAddress: normalizeAddress(input.agentAddress),
      jobId: job.id,
      requestedAmount: roundCurrency(input.requestedAmount),
      approvedAmount: quote.approvedAmount,
      fee: quote.fee,
      purpose: input.purpose,
      constraints: quote.constraints,
      decision: quote.decision,
      status: "active",
      dueAt: now + job.durationHours * 60 * 60 * 1000,
      createdAt: now,
    };

    agent.outstandingBalance = roundCurrency(agent.outstandingBalance + advance.approvedAmount + advance.fee);
    agent.totalBorrowed = roundCurrency(agent.totalBorrowed + advance.approvedAmount);
    agent.updatedAt = now;

    this.state.advances[advance.id] = advance;
    await this.persist();

    return { quote, advance };
  }

  async completeJob(input: { jobId: string; actualPayout?: number }): Promise<{
    job: JobReceivable;
    settledAdvances: CreditAdvance[];
    repaidAmount: number;
    leftoverPayout: number;
  }> {
    await this.init();
    const job = this.requireJob(input.jobId);
    if (job.status !== "open") {
      throw new Error("Job is not open.");
    }

    const actualPayout = roundCurrency(input.actualPayout ?? job.expectedPayout);
    job.status = "completed";
    job.completedAt = Date.now();
    job.actualPayout = actualPayout;

    const agent = this.requireAgent(job.agentAddress);
    const activeAdvances = Object.values(this.state.advances).filter(
      (advance) => advance.jobId === job.id && advance.status === "active",
    );

    let repayable = actualPayout;
    const settledAdvances: CreditAdvance[] = [];
    let repaidAmount = 0;

    for (const advance of activeAdvances) {
      const amountDue = roundCurrency(advance.approvedAmount + advance.fee);
      const amountPaid = Math.min(repayable, amountDue);
      repayable = roundCurrency(repayable - amountPaid);
      repaidAmount = roundCurrency(repaidAmount + amountPaid);

      advance.status = amountPaid >= amountDue ? "repaid" : "defaulted";
      advance.repaidAt = Date.now();
      advance.repaidAmount = roundCurrency(amountPaid);
      if (advance.status === "defaulted") {
        advance.defaultReason = "Job payout did not cover the full amount due.";
        agent.defaultedAdvances += 1;
      } else {
        agent.repaidAdvances += 1;
      }

      agent.outstandingBalance = roundCurrency(agent.outstandingBalance - amountDue);
      agent.totalRepaid = roundCurrency(agent.totalRepaid + amountPaid);
      settledAdvances.push(advance);
    }

    agent.successfulJobs += 1;
    agent.averageCompletedPayout = updateAveragePayout(agent.averageCompletedPayout, agent.successfulJobs, actualPayout);
    agent.updatedAt = Date.now();

    await this.persist();

    return {
      job,
      settledAdvances,
      repaidAmount,
      leftoverPayout: roundCurrency(repayable),
    };
  }

  async defaultAdvance(input: { advanceId: string; reason: string }): Promise<CreditAdvance> {
    await this.init();
    const advance = this.requireAdvance(input.advanceId);
    if (advance.status !== "active") {
      throw new Error("Advance is not active.");
    }

    advance.status = "defaulted";
    advance.defaultReason = input.reason;
    advance.repaidAt = Date.now();
    advance.repaidAmount = 0;

    const agent = this.requireAgent(advance.agentAddress);
    agent.defaultedAdvances += 1;
    agent.outstandingBalance = roundCurrency(agent.outstandingBalance - advance.approvedAmount - advance.fee);
    agent.updatedAt = Date.now();

    const job = this.state.jobs[advance.jobId];
    if (job && job.status === "open") {
      job.status = "defaulted";
    }

    await this.persist();
    return advance;
  }

  async getSnapshot(): Promise<AgentState> {
    await this.init();
    return this.state;
  }

  private requireAgent(address: string): AgentRecord {
    const agent = this.state.agents[normalizeAddress(address)];
    if (!agent) {
      throw new Error(`Unknown agent: ${address}`);
    }
    return agent;
  }

  private requireJob(jobId: string): JobReceivable {
    const job = this.state.jobs[jobId];
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    return job;
  }

  private requireOpenJob(jobId: string, agentAddress: string): JobReceivable {
    const job = this.requireJob(jobId);
    if (job.agentAddress !== agentAddress) {
      throw new Error("Job is not assigned to this agent.");
    }
    if (job.status !== "open") {
      throw new Error("Job is not open.");
    }
    return job;
  }

  private requireAdvance(advanceId: string): CreditAdvance {
    const advance = this.state.advances[advanceId];
    if (!advance) {
      throw new Error(`Unknown advance: ${advanceId}`);
    }
    return advance;
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function updateAveragePayout(currentAverage: number, newCount: number, newValue: number): number {
  if (newCount <= 1) {
    return roundCurrency(newValue);
  }

  const previousCount = newCount - 1;
  const total = currentAverage * previousCount + newValue;
  return roundCurrency(total / newCount);
}

