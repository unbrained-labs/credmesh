import { useState, useEffect } from 'react';
import { Card } from './Card';
import { DepositFlow } from './DepositFlow';
import type { HealthResponse, PaymentMethods } from '../api';
import { api } from '../api';
import { API_BASE } from '../lib/config';

interface UseCase {
  name: string;
  scenario: string;
  howItWorks: string;
  duration: string;
  feeRange: string;
  whyCredit: string;
}

interface UseCasesData {
  forAgents: { headline: string; description: string; examples: UseCase[] };
  forLPs: {
    headline: string;
    description: string;
    yield: { source: string; estimatedAPY: string; comparison: string; risk: string };
    howToDeposit: Record<string, string>;
  };
}

export function Landing({ vault }: { vault: HealthResponse['vault'] | null }) {
  const [data, setData] = useState<UseCasesData | null>(null);
  const [payments, setPayments] = useState<PaymentMethods | null>(null);
  // Auto-open LP tab if URL has #deposit hash
  const [tab, setTab] = useState<'agents' | 'lps'>(
    typeof window !== 'undefined' && window.location.hash === '#deposit' ? 'lps' : 'agents'
  );

  useEffect(() => {
    fetch(`${API_BASE}/use-cases`).then(r => r.json()).then(setData).catch(() => {});
    api.paymentMethods().then(setPayments).catch(() => {});
  }, []);

  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Tab selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('agents')}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-widest border transition-colors ${
            tab === 'agents' ? 'border-green text-green bg-green/10' : 'border-border text-text-muted hover:border-green/50'
          }`}
        >
          For Agents
        </button>
        <button
          onClick={() => setTab('lps')}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-widest border transition-colors ${
            tab === 'lps' ? 'border-cyan text-cyan bg-cyan/10' : 'border-border text-text-muted hover:border-cyan/50'
          }`}
        >
          For Liquidity Providers
        </button>
      </div>

      {tab === 'agents' && (
        <div className="space-y-4">
          <Card title={data.forAgents.headline}>
            <p className="text-[11px] text-text-muted leading-relaxed mb-4">{data.forAgents.description}</p>
            <div className="space-y-3">
              {data.forAgents.examples.map((ex) => (
                <UseCaseCard key={ex.name} useCase={ex} />
              ))}
            </div>
          </Card>

          {payments && (
            <Card title="Payment Rails">
              <p className="text-[10px] text-text-muted mb-3">Job posters and agents can pay via multiple rails. Agents use <span className="text-green font-bold">{payments.agentIntegration.recommended}</span> ({payments.agentIntegration.install}).</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {payments.methods.map((m) => (
                  <div key={m.id} className="bg-bg border border-border p-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${m.status === 'active' ? 'bg-green' : m.status === 'configurable' ? 'bg-amber' : 'bg-text-muted'}`} />
                      <span className="text-[9px] uppercase tracking-widest text-text-muted">{m.status}</span>
                    </div>
                    <p className="text-[10px] font-bold text-white">{m.name}</p>
                    <p className="text-[9px] text-text-muted mt-0.5">{m.description.slice(0, 80)}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'lps' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title={data.forLPs.headline}>
              <p className="text-[11px] text-text-muted leading-relaxed mb-4">{data.forLPs.description}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg border border-border p-3">
                  <p className="text-[9px] uppercase tracking-widest text-text-muted mb-1">Estimated APY</p>
                  <p className="text-xl font-bold text-cyan">{data.forLPs.yield.estimatedAPY}</p>
                  <p className="text-[10px] text-text-muted mt-1">{data.forLPs.yield.source}</p>
                </div>
                <div className="bg-bg border border-border p-3">
                  <p className="text-[9px] uppercase tracking-widest text-text-muted mb-1">vs Aave</p>
                  <p className="text-[11px] text-text-muted leading-relaxed">{data.forLPs.yield.comparison}</p>
                </div>
              </div>
              <div className="border-t border-border pt-3 mt-3">
                <p className="text-[10px] text-text-muted">
                  Risk: <span className="text-amber">{data.forLPs.yield.risk}</span>
                </p>
              </div>
            </Card>
            <DepositFlow vault={vault} />
          </div>
        </div>
      )}
    </div>
  );
}

function UseCaseCard({ useCase: uc }: { useCase: UseCase }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border bg-bg p-3">
      <div className="flex justify-between items-start cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <p className="text-xs font-bold text-white">{uc.name}</p>
          <p className="text-[10px] text-text-muted mt-0.5">{uc.scenario}</p>
        </div>
        <div className="text-right shrink-0 ml-3">
          <p className="text-[9px] text-text-muted">Fee</p>
          <p className="text-xs text-green font-bold">{uc.feeRange}</p>
          <p className="text-[9px] text-text-muted">{uc.duration}</p>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border space-y-1.5 text-[10px]">
          <p className="text-text-muted"><span className="text-indigo font-bold">Flow:</span> {uc.howItWorks}</p>
          <p className="text-text-muted"><span className="text-amber font-bold">Why credit:</span> {uc.whyCredit}</p>
        </div>
      )}
    </div>
  );
}
