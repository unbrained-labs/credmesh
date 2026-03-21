export interface Env {
  CREDIT_AGENT: DurableObjectNamespace;
  AGENT_NAME: string;
  CHAIN_RPC_URL?: string;
  IDENTITY_REGISTRY?: string;
}

export interface AgentRegistrationInput {
  address: string;
  name: string;
  url?: string;
  trustScore?: number;
  attestationCount?: number;
  cooperationSuccessCount?: number;
  successfulJobs?: number;
  failedJobs?: number;
  averageCompletedPayout?: number;
}

export interface AgentRecord {
  address: string;
  name: string;
  url?: string;
  trustScore: number;
  attestationCount: number;
  cooperationSuccessCount: number;
  successfulJobs: number;
  failedJobs: number;
  averageCompletedPayout: number;
  identityRegistered: boolean;
  repaidAdvances: number;
  defaultedAdvances: number;
  totalBorrowed: number;
  totalRepaid: number;
  outstandingBalance: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobReceivable {
  id: string;
  agentAddress: string;
  payer: string;
  title: string;
  expectedPayout: number;
  durationHours: number;
  category: string;
  status: "open" | "completed" | "defaulted";
  createdAt: number;
  completedAt?: number;
  actualPayout?: number;
}

export interface CreditAdvance {
  id: string;
  agentAddress: string;
  jobId: string;
  requestedAmount: number;
  approvedAmount: number;
  fee: number;
  purpose: string;
  constraints: string[];
  decision: CreditDecision;
  status: "active" | "repaid" | "defaulted";
  dueAt: number;
  createdAt: number;
  repaidAt?: number;
  repaidAmount?: number;
  defaultReason?: string;
}

export type CreditDecision = "APPROVED" | "MANUAL_REVIEW" | "DECLINED";

export interface CreditProfile {
  agent: AgentRecord;
  creditScore: number;
  creditLimit: number;
  availableCredit: number;
  repaymentRate: number;
  completionRate: number;
  outstandingBalance: number;
  reasons: string[];
}

export interface CreditQuote {
  decision: CreditDecision;
  approvedAmount: number;
  requestedAmount: number;
  fee: number;
  maxDurationHours: number;
  confidence: number;
  reasons: string[];
  constraints: string[];
}

export interface AgentState {
  agents: Record<string, AgentRecord>;
  jobs: Record<string, JobReceivable>;
  advances: Record<string, CreditAdvance>;
}

