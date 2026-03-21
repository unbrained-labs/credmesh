import type { PortfolioReport } from '../api';

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface border border-border-bright p-3 animate-fade-in">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-text-muted mb-1">{label}</p>
      <p className={`text-xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export function StatsRow({ summary: s }: { summary: PortfolioReport['summary'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-border-bright">
      <Stat label="Agents" value={String(s.totalAgents)} />
      <Stat label="Credit Score" value={String(s.averageCreditScore)}
        color={s.averageCreditScore >= 70 ? 'text-green' : s.averageCreditScore >= 40 ? 'text-amber' : 'text-red'} />
      <Stat label="Active Advances" value={String(s.activeAdvances)} sub={`$${s.totalExposure.toFixed(2)} exposure`} />
      <Stat label="Repayment" value={`${(s.repaymentRate * 100).toFixed(0)}%`}
        color={s.repaymentRate >= 0.8 ? 'text-green' : 'text-amber'} />
      <Stat label="Repaid" value={`$${s.totalRepaid.toFixed(2)}`} color="text-green" />
      <Stat label="Fees" value={`$${s.totalFeesEarned.toFixed(2)}`} color="text-cyan" />
    </div>
  );
}
