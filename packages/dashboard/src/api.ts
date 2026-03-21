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
  totalFeesEarned: number; totalDefaultLoss: number; availableFunds: number;
}

export interface TimelineEvent {
  id: string; timestamp: number; type: string;
  actor: string; description: string; data: Record<string, unknown>;
}

export const api = {
  portfolio: () => get<PortfolioReport>('/dashboard/portfolio'),
  risk: () => get<RiskReport>('/dashboard/risk'),
  treasury: () => get<TreasuryState>('/treasury'),
  timeline: (limit = 30) => get<TimelineEvent[]>(`/timeline?limit=${limit}`),
  bootstrap: (scenario: 'happy' | 'failure' | 'both') =>
    post<{ summary: string }>('/demo/bootstrap', { scenario }),
  reset: () => post<{ message: string }>('/demo/reset'),
};
