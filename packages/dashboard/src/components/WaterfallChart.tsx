import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { TreasuryState, PortfolioReport } from '../api';
import { Card } from './Card';

const COLORS = ['#6366f1', '#22c55e', '#06b6d4', '#ef4444', '#f59e0b'];

export function WaterfallChart({ treasury: t, summary: s }: {
  treasury: TreasuryState; summary: PortfolioReport['summary'];
}) {
  const data = [
    { name: 'Deposited', value: t.totalDeposited },
    { name: 'Advanced', value: t.totalAdvanced },
    { name: 'Repaid', value: t.totalRepaid },
    { name: 'Fees', value: t.totalFeesEarned },
    { name: 'Available', value: t.availableFunds },
  ];

  return (
    <Card title="Treasury Flow">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fill: '#8888a0', fontSize: 11 }} axisLine={{ stroke: '#252536' }} tickLine={false} />
          <YAxis tick={{ fill: '#8888a0', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <Tooltip contentStyle={{ background: '#10101a', border: '1px solid #252536', borderRadius: '8px', fontSize: 12, color: '#e4e4ef' }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, '']} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-xs text-text-muted mt-2 pt-2 border-t border-border">
        <span>Default Loss: <span className="text-credit-red font-mono">${t.totalDefaultLoss.toFixed(2)}</span></span>
        <span>Exposure: <span className="text-credit-amber font-mono">${s.totalExposure.toFixed(2)}</span></span>
      </div>
    </Card>
  );
}
