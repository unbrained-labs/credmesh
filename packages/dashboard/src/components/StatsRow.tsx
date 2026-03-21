import type { PortfolioReport } from '../api';

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 animate-fade-in">
      <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${color ?? 'text-text'}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export function StatsRow({ summary: s }: { summary: PortfolioReport['summary'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Stat label="Agents" value={String(s.totalAgents)} />
      <Stat label="Avg Credit Score" value={String(s.averageCreditScore)}
        color={s.averageCreditScore >= 70 ? 'text-credit-green' : s.averageCreditScore >= 40 ? 'text-credit-amber' : 'text-credit-red'} />
      <Stat label="Active Advances" value={String(s.activeAdvances)} sub={`$${s.totalExposure.toFixed(2)} exposure`} />
      <Stat label="Repayment Rate" value={`${(s.repaymentRate * 100).toFixed(0)}%`}
        color={s.repaymentRate >= 0.8 ? 'text-credit-green' : 'text-credit-amber'} />
      <Stat label="Total Repaid" value={`$${s.totalRepaid.toFixed(2)}`} color="text-credit-green" />
      <Stat label="Fees Earned" value={`$${s.totalFeesEarned.toFixed(2)}`} color="text-cyan" />
    </div>
  );
}
