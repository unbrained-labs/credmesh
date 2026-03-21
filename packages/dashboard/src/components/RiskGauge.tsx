import type { RiskReport } from '../api';
import { Card } from './Card';

const riskColor: Record<string, string> = {
  LOW: 'text-green', MODERATE: 'text-amber', HIGH: 'text-red', CRITICAL: 'text-red',
};

export function RiskGauge({ risk }: { risk: RiskReport }) {
  const pct = risk.healthScore;
  const barWidth = `${pct}%`;
  const barColor = pct >= 80 ? 'bg-green' : pct >= 60 ? 'bg-amber' : 'bg-red';

  return (
    <Card title="Portfolio Health">
      <div className="space-y-4">
        {/* Score display */}
        <div className="text-center">
          <span className="text-4xl font-bold text-white">{pct}</span>
          <span className="text-text-muted text-sm ml-1">/100</span>
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-border-bright">
          <div className={`h-full ${barColor} transition-all duration-1000`} style={{ width: barWidth }} />
        </div>

        {/* Risk label */}
        <div className="text-center">
          <span className={`text-xs font-bold uppercase tracking-[0.2em] ${riskColor[risk.overallRisk]}`}>
            {risk.overallRisk} RISK
          </span>
        </div>

        {/* Metrics grid */}
        <div className="space-y-1.5 text-[11px] border-t border-border pt-3">
          <Row label="utilization" value={`${(risk.metrics.utilizationRate * 100).toFixed(0)}%`} />
          <Row label="default_rate" value={`${(risk.metrics.weightedDefaultRate * 100).toFixed(1)}%`} />
          <Row label="overdue" value={String(risk.metrics.overdueCount)} />
          <Row label="concentration" value={`${(risk.concentrationRisk * 100).toFixed(0)}%`} />
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}
