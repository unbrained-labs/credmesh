const BASE = import.meta.env.PROD
  ? 'https://trustvault-credit.leaidedev.workers.dev'
  : '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Returns both the parsed result and the raw JSON for display
async function postRaw<T>(path: string, body?: unknown): Promise<{ result: T; request: { method: string; url: string; body: unknown }; response: string }> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return {
    result: JSON.parse(text) as T,
    request: { method: 'POST', url: path, body },
    response: text,
  };
}

export interface PortfolioReport {
  summary: {
    totalAgents: number; totalJobs: number; totalAdvances: number;
    activeAdvances: number; totalExposure: number; totalRepaid: number;
    totalDefaulted: number; totalFeesEarned: number; repaymentRate: number;
    defaultRate: number; averageAdvanceSize: number; averageCreditScore: number;
  };
  exposureByCategory: Record<string, number>;
  topBorrowers: Array<{
    address: string; name: string; totalBorrowed: number;
    outstandingBalance: number; creditScore: number; repaymentRate: number;
  }>;
  recentActivity: TimelineEvent[];
}

export interface RiskReport {
  overallRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  healthScore: number; concentrationRisk: number;
  metrics: {
    utilizationRate: number; weightedDefaultRate: number;
    averageCoverageRatio: number; largestSingleExposure: number; overdueCount: number;
  };
  alerts: string[]; recommendations: string[];
}

export interface TreasuryState {
  totalDeposited: number; totalAdvanced: number; totalRepaid: number;
  totalFeesEarned: number; totalProtocolFees: number; totalUnderwriterFees: number;
  totalDefaultLoss: number; availableFunds: number;
}

export interface HealthResponse {
  status: string;
  version: string;
  chain: {
    enabled: boolean;
    network: string | null;
    escrowEnabled: boolean;
    vaultEnabled: boolean;
    escrowBalance: string | null;
  };
  vault: {
    totalAssets: string;
    totalShares: string;
    sharePrice: string;
    idleBalance: string;
    inAave: string;
    inEscrow: string;
    feesEarned: string;
    defaultLoss: string;
  } | null;
}

export interface FeeInfo {
  model: string;
  protocolFeeBps: number;
  protocolFeePercent: string;
  description: string;
  currentPool: {
    totalDeposited: number;
    totalAdvanced: number;
    totalFeesEarned: number;
    underwriterFeesEarned: number;
    protocolFeesEarned: number;
    totalDefaultLoss: number;
  };
  exampleRates: {
    bestCase: { description: string; effectiveRate: number; totalFee: number; underwriterFee: number; protocolFee: number };
    riskyCase: { description: string; effectiveRate: number; totalFee: number; underwriterFee: number; protocolFee: number };
  };
}

export interface TimelineEvent {
  id: string; timestamp: number; type: string;
  actor: string; description: string; data: Record<string, unknown>;
}

export const api = {
  portfolio: () => get<PortfolioReport>('/dashboard/portfolio'),
  risk: () => get<RiskReport>('/dashboard/risk'),
  treasury: () => get<TreasuryState>('/treasury'),
  health: () => get<HealthResponse>('/health'),
  fees: () => get<FeeInfo>('/fees'),
  timeline: (limit = 30) => get<TimelineEvent[]>(`/timeline?limit=${limit}`),
  bootstrap: (scenario: 'happy' | 'failure' | 'both') =>
    post<{ summary: string }>('/demo/bootstrap', { scenario }),
  reset: () => post<{ message: string }>('/demo/reset'),

  // Interactive actions — return raw request/response for display
  registerAgent: (body: { address: string; name: string; trustScore: number; successfulJobs: number; failedJobs: number }) =>
    postRaw('/agents/register', body),
  postJob: (body: { postedBy: string; title: string; expectedPayout: number; durationHours: number; category: string }) =>
    postRaw('/marketplace/post', body),
  createJob: (body: { agentAddress: string; payer: string; title: string; expectedPayout: number; durationHours: number; category: string }) =>
    postRaw('/marketplace/jobs', body),
  requestAdvance: (body: { agentAddress: string; jobId: string; requestedAmount: number; purpose: string }) =>
    postRaw('/credit/advance', body),
  completeJob: (jobId: string, actualPayout?: number) =>
    postRaw(`/marketplace/jobs/${jobId}/complete`, { actualPayout }),
  depositFunds: (body: { lenderAddress: string; amount: number; memo: string }) =>
    postRaw('/treasury/deposit', body),
  openJobs: () => get<Array<{ id: string; title: string; expectedPayout: number; category: string }>>('/marketplace/open'),
};
