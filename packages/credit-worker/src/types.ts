export interface Env {
  CREDIT_AGENT: DurableObjectNamespace;
  AGENT_NAME: string;
  CHAIN_RPC_URL?: string;
  IDENTITY_REGISTRY?: string;
  REPUTATION_REGISTRY?: string;
  CHAIN_ID?: string;
  AGENT_PRIVATE_KEY?: string;
  TEST_USDC?: string;
  CREDIT_ESCROW?: string;
  CREDIT_VAULT?: string;
  // Base Sepolia chain
  BASE_SEPOLIA_RPC_URL?: string;
  BASE_SEPOLIA_PRIVATE_KEY?: string;
  BASE_SEPOLIA_USDC?: string;
  BASE_SEPOLIA_ESCROW?: string;
  BASE_SEPOLIA_VAULT?: string;
  BASE_SEPOLIA_REPUTATION?: string;
  BASE_SEPOLIA_IDENTITY?: string;
  BASE_SEPOLIA_ORACLE?: string;        // RegistryReceivableOracle address
  BASE_SEPOLIA_CREDIT_ORACLE?: string; // ReputationCreditOracle address
  // Base mainnet chain
  BASE_RPC_URL?: string;
  BASE_PRIVATE_KEY?: string;
  BASE_USDC?: string;
  BASE_ESCROW?: string;
  BASE_VAULT?: string;
  BASE_REPUTATION?: string;
  BASE_IDENTITY?: string;
  // Payment rails
  TEMPO_ACCOUNT?: string;      // MPP — Tempo crypto payments (account address)
  STRIPE_SECRET_KEY?: string;  // MPP — Stripe fiat payments (secret key)
  X402_FACILITATOR_URL?: string;
  X402_PAY_TO?: string;
  X402_NETWORK?: string;
  // Admin
  ADMIN_SECRET?: string;  // Shared secret for demo/reset and testnet-setup endpoints
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
  requiredCapabilities?: string[];
  postedBy?: string;
  awardedBidId?: string;
  status: "open" | "completed" | "defaulted";
  createdAt: number;
  completedAt?: number;
  actualPayout?: number;
  reputationTxHash?: string;
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
  spendPolicy?: SpendPolicy;
  totalSpent?: number;
  spendCount?: number;
  transferTxHash?: string;
  repaymentTxHash?: string;
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
  feeBreakdown: FeeBreakdown;
  maxDurationHours: number;
  confidence: number;
  reasons: string[];
  constraints: string[];
}

export interface FeeBreakdown {
  totalFee: number;
  effectiveRate: number;
  underwriterFee: number;
  protocolFee: number;
  components: {
    utilizationRate: number;
    utilizationPremium: number;
    durationPremium: number;
    riskPremium: number;
    poolLossSurcharge: number;
    totalRate: number;
  };
}

export interface AgentState {
  agents: Record<string, AgentRecord>;
  jobs: Record<string, JobReceivable>;
  advances: Record<string, CreditAdvance>;
  bids: Record<string, Bid>;
  mandates: Record<string, Mandate>;
  treasury: TreasuryState;
  spendRecords: Record<string, SpendRecord>;
  timeline: TimelineEvent[];
  consumedPayments: Record<string, string>; // txHash → jobId (prevents replay)
}

// ── Mandates ──

/** A funded intent — capital allocated with policy constraints, not tied to a specific job. */
export interface Mandate {
  id: string;
  /** Address of the capital source (vault operator, treasury, direct funder) */
  funder: string;
  /** How the capital arrived */
  capitalOrigin: "direct" | "vault" | "treasury";
  /** Total USDC budget for this mandate */
  budgetUsdc: number;
  /** Job categories workers can use this mandate for */
  allowedCategories: string[];
  /** Max advance per individual task */
  maxPerTask: number;
  /** Max advance duration in hours */
  maxDurationHours: number;
  /** Minimum borrower credit score */
  minCreditScore: number;
  /** Required receivable type (or "any") */
  requiredReceivableType: "escrow" | "trading-balance" | "vault-equity" | "any";
  /** USDC currently deployed in active advances */
  allocated: number;
  /** USDC repaid from completed advances */
  returned: number;
  /** Fees earned from advances funded by this mandate */
  feesEarned: number;
  /** Number of advances issued */
  advanceCount: number;
  status: "active" | "paused" | "depleted" | "closed";
  createdAt: number;
  updatedAt: number;
}

// ── Marketplace ──

export interface Bid {
  id: string;
  jobId: string;
  agentAddress: string;
  proposedCost: number;
  estimatedHours: number;
  capabilities: string[];
  pitch: string;
  creditScore: number;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
}

// ── Treasury ──

export type SpendCategory =
  | "compute"
  | "api"
  | "gas"
  | "sub-agent"
  | "browser"
  | "storage"
  | "other";

export interface SpendPolicy {
  allowedCategories: SpendCategory[];
  maxSingleSpend: number;
  dailyLimit: number;
}

export interface SpendRecord {
  id: string;
  advanceId: string;
  category: SpendCategory;
  amount: number;
  vendor: string;
  description: string;
  approved: boolean;
  rejectionReason?: string;
  createdAt: number;
}

export interface TreasuryState {
  totalDeposited: number;
  totalAdvanced: number;
  totalRepaid: number;
  totalFeesEarned: number;
  totalProtocolFees: number;
  totalUnderwriterFees: number;
  totalDefaultLoss: number;
  availableFunds: number;
  deposits: TreasuryDeposit[];
}

export interface TreasuryDeposit {
  id: string;
  lenderAddress: string;
  amount: number;
  memo: string;
  createdAt: number;
}

export interface WaterfallResult {
  grossPayout: number;
  principalRepaid: number;
  feePaid: number;
  underwriterFeePaid: number;
  protocolFeePaid: number;
  penaltyApplied: number;
  agentNet: number;
  shortfall: number;
  status: "full_repayment" | "partial_repayment" | "total_default";
  breakdown: string[];
}

// ── Timeline & Dashboard ──

export interface TimelineEvent {
  id: string;
  timestamp: number;
  type:
    | "agent_registered"
    | "job_created"
    | "job_posted"
    | "bid_submitted"
    | "bid_awarded"
    | "job_completed"
    | "job_defaulted"
    | "advance_created"
    | "advance_repaid"
    | "advance_defaulted"
    | "credit_check"
    | "quote_issued"
    | "spend_recorded"
    | "deposit_received"
    | "mandate_created"
    | "mandate_updated"
    | "mandate_advance"
    | "state_reset";
  actor: string;
  description: string;
  data: Record<string, unknown>;
}

export interface PortfolioReport {
  summary: {
    totalAgents: number;
    totalJobs: number;
    totalAdvances: number;
    activeAdvances: number;
    totalExposure: number;
    totalRepaid: number;
    totalDefaulted: number;
    totalFeesEarned: number;
    repaymentRate: number;
    defaultRate: number;
    averageAdvanceSize: number;
    averageCreditScore: number;
  };
  exposureByCategory: Record<string, number>;
  topBorrowers: Array<{
    address: string;
    name: string;
    totalBorrowed: number;
    outstandingBalance: number;
    creditScore: number;
    repaymentRate: number;
  }>;
  recentActivity: TimelineEvent[];
}

export interface RiskReport {
  overallRisk: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  healthScore: number;
  concentrationRisk: number;
  metrics: {
    utilizationRate: number;
    weightedDefaultRate: number;
    averageCoverageRatio: number;
    largestSingleExposure: number;
    overdueCount: number;
  };
  alerts: string[];
  recommendations: string[];
}

export interface DemoScenario {
  name: string;
  description: string;
  agents: number;
  jobs: number;
  advances: number;
  includesDefault: boolean;
}

