import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { AXIS_TICK, TOOLTIP_STYLE, CURSOR_STYLE, COLORS, dollarFmt } from '../lib/chart';
import { Card } from './Card';

export function ExposureChart({ exposure }: { exposure: Record<string, number> }) {
  const data = Object.entries(exposure).map(([name, value]) => ({ name: name.toUpperCase(), value }));

  if (!data.length) {
    return <Card title="Exposure by Category"><div className="h-48 flex items-center justify-center text-text-muted text-xs">&gt; no active exposure_</div></Card>;
  }

  return (
    <Card title="Exposure by Category">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <YAxis type="category" dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} width={120} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={dollarFmt} cursor={CURSOR_STYLE} />
          <Bar dataKey="value" fill={COLORS.green} radius={0} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
