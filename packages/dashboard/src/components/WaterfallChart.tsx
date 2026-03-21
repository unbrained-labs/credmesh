import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { TreasuryState, PortfolioReport } from '../api';
import { Card } from './Card';

const COLORS = ['#536dfe', '#00ff41', '#00e5ff', '#ff1744', '#ff9100'];

export function WaterfallChart({ treasury: t, summary: s }: {
  treasury: TreasuryState; summary: PortfolioReport['summary'];
}) {
  const data = [
    { name: 'DEPOSIT', value: t.totalDeposited },
    { name: 'ADVANCE', value: t.totalAdvanced },
    { name: 'REPAID', value: t.totalRepaid },
    { name: 'LOSS', value: t.totalDefaultLoss },
    { name: 'AVAIL', value: t.availableFunds },
  ];

  return (
    <Card title="Treasury Flow">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fill: '#666', fontSize: 9, fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#1a1a1a' }} tickLine={false} />
          <YAxis tick={{ fill: '#666', fontSize: 9, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <Tooltip
            contentStyle={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 0, fontSize: 11, fontFamily: 'JetBrains Mono', color: '#e0e0e0' }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, '']}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
          />
          <Bar dataKey="value" radius={0}>
            {data.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[10px] text-text-muted mt-2 pt-2 border-t border-border">
        <span>fees_earned: <span className="text-cyan">${t.totalFeesEarned.toFixed(2)}</span></span>
        <span>exposure: <span className="text-amber">${s.totalExposure.toFixed(2)}</span></span>
      </div>
    </Card>
  );
}
