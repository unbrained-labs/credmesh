import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card } from './Card';

export function ExposureChart({ exposure }: { exposure: Record<string, number> }) {
  const data = Object.entries(exposure).map(([name, value]) => ({ name: name.toUpperCase(), value }));

  if (!data.length) {
    return (
      <Card title="Exposure by Category">
        <div className="h-48 flex items-center justify-center text-text-muted text-xs">
          &gt; no active exposure_
        </div>
      </Card>
    );
  }

  return (
    <Card title="Exposure by Category">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis type="number" tick={{ fill: '#666', fontSize: 9, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <YAxis type="category" dataKey="name" tick={{ fill: '#666', fontSize: 9, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} width={120} />
          <Tooltip
            contentStyle={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 0, fontSize: 11, fontFamily: 'JetBrains Mono', color: '#e0e0e0' }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, '']}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
          />
          <Bar dataKey="value" fill="#00ff41" radius={0} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
