import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { TreasuryState } from '../api';
import { AXIS_TICK, TOOLTIP_STYLE, CURSOR_STYLE, COLORS, dollarFmt } from '../lib/chart';
import { Card } from './Card';

const BAR_COLORS = [COLORS.indigo, COLORS.green, COLORS.cyan, COLORS.red, COLORS.amber];
const MARGIN = { top: 0, right: 0, left: -20, bottom: 0 };
const AXIS_LINE = { stroke: '#1a1a1a' };

export function WaterfallChart({ treasury: t, totalExposure }: {
  treasury: TreasuryState; totalExposure: number;
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
        <BarChart data={data} margin={MARGIN}>
          <XAxis dataKey="name" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={dollarFmt} cursor={CURSOR_STYLE} />
          <Bar dataKey="value" radius={0}>
            {data.map((d) => <Cell key={d.name} fill={BAR_COLORS[data.indexOf(d)]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[10px] text-text-muted mt-2 pt-2 border-t border-border">
        <span>fees: <span className="text-green">${(t.totalUnderwriterFees ?? 0).toFixed(2)}</span> underwriter + <span className="text-amber">${(t.totalProtocolFees ?? 0).toFixed(2)}</span> protocol</span>
        <span>exposure: <span className="text-amber">${totalExposure.toFixed(2)}</span></span>
      </div>
    </Card>
  );
}
