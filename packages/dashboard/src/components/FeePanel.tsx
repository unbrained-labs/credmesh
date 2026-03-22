import type { FeeInfo } from '../api';
import { Card } from './Card';

export function FeePanel({ fees }: { fees: FeeInfo | null }) {
  if (!fees) return null;

  return (
    <Card title="Dynamic Fee Model">
      <div className="space-y-3">
        <p className="text-[10px] text-text-muted leading-relaxed">{fees.description}</p>

        <div className="grid grid-cols-2 gap-2">
          <RateCard
            label="Best Agent"
            sub={fees.exampleRates.bestCase.description}
            rate={fees.exampleRates.bestCase.effectiveRate}
            underwriter={fees.exampleRates.bestCase.underwriterFee}
            protocol={fees.exampleRates.bestCase.protocolFee}
          />
          <RateCard
            label="Risky Agent"
            sub={fees.exampleRates.riskyCase.description}
            rate={fees.exampleRates.riskyCase.effectiveRate}
            underwriter={fees.exampleRates.riskyCase.underwriterFee}
            protocol={fees.exampleRates.riskyCase.protocolFee}
          />
        </div>

        <div className="border-t border-border pt-2 flex justify-between text-[10px]">
          <span className="text-text-muted">Protocol share: <span className="text-amber font-bold">{fees.protocolFeePercent}</span></span>
          <span className="text-text-muted">
            Earned: <span className="text-green">${fees.currentPool.underwriterFeesEarned.toFixed(2)}</span> underwriter
            {' / '}
            <span className="text-amber">${fees.currentPool.protocolFeesEarned.toFixed(2)}</span> protocol
          </span>
        </div>
      </div>
    </Card>
  );
}

function RateCard({ label, sub, rate, underwriter, protocol }: {
  label: string; sub: string; rate: number; underwriter: number; protocol: number;
}) {
  const pct = (rate * 100).toFixed(2);
  return (
    <div className="bg-bg border border-border p-2">
      <p className="text-[9px] uppercase tracking-widest text-text-muted mb-1">{label}</p>
      <p className="text-lg font-bold text-white">{pct}%</p>
      <p className="text-[9px] text-text-muted mt-1">{sub}</p>
      <p className="text-[9px] text-text-muted mt-0.5">
        ${underwriter.toFixed(2)} <span className="text-green">underwriter</span>
        {' + '}
        ${protocol.toFixed(2)} <span className="text-amber">protocol</span>
      </p>
    </div>
  );
}
