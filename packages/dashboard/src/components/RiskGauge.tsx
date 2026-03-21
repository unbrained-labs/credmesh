import type { RiskReport } from '../api';
import { Card } from './Card';

const riskColors: Record<string, string> = {
  LOW: 'text-credit-green', MODERATE: 'text-credit-amber', HIGH: 'text-credit-red', CRITICAL: 'text-credit-red',
};
const riskGlow: Record<string, string> = {
  LOW: 'shadow-[0_0_30px_rgba(34,197,94,0.15)]', MODERATE: 'shadow-[0_0_30px_rgba(245,158,11,0.15)]',
  HIGH: 'shadow-[0_0_30px_rgba(239,68,68,0.15)]', CRITICAL: 'shadow-[0_0_30px_rgba(239,68,68,0.25)]',
};

export function RiskGauge({ risk }: { risk: RiskReport }) {
  const pct = risk.healthScore;
  const circ = 2 * Math.PI * 54;
  const offset = circ * (1 - pct / 100);
  const stroke = pct >= 80 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <Card title="Portfolio Health" className={riskGlow[risk.overallRisk]}>
      <div className="flex flex-col items-center">
        <div className="relative w-32 h-32">
          <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
            <circle cx="60" cy="60" r="54" fill="none" stroke="#252536" strokeWidth="8" />
            <circle cx="60" cy="60" r="54" fill="none" stroke={stroke} strokeWidth="8"
              strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
              className="transition-all duration-1000" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold font-mono">{pct}</span>
            <span className="text-[10px] text-text-muted uppercase tracking-wider">score</span>
          </div>
        </div>
        <span className={`text-sm font-bold uppercase tracking-wider mt-3 ${riskColors[risk.overallRisk]}`}>
          {risk.overallRisk} RISK
        </span>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-4 text-xs">
          <span className="text-text-muted">Utilization</span>
          <span className="text-right font-mono">{(risk.metrics.utilizationRate * 100).toFixed(0)}%</span>
          <span className="text-text-muted">Default Rate</span>
          <span className="text-right font-mono">{(risk.metrics.weightedDefaultRate * 100).toFixed(1)}%</span>
          <span className="text-text-muted">Overdue</span>
          <span className="text-right font-mono">{risk.metrics.overdueCount}</span>
          <span className="text-text-muted">Concentration</span>
          <span className="text-right font-mono">{(risk.concentrationRisk * 100).toFixed(0)}%</span>
        </div>
      </div>
    </Card>
  );
}
