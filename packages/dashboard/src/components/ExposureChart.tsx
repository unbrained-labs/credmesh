import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card } from './Card';

const COLORS = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function ExposureChart({ exposure }: { exposure: Record<string, number> }) {
  const data = Object.entries(exposure).map(([name, value]) => ({ name, value }));
  const total = data.reduce((s, d) => s + d.value, 0);

  if (!data.length) {
    return <Card title="Exposure by Category"><div className="h-48 flex items-center justify-center text-text-muted text-sm">No active exposure</div></Card>;
  }

  return (
    <Card title="Exposure by Category">
      <div className="flex items-center gap-6">
        <ResponsiveContainer width="50%" height={200}>
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" strokeWidth={0}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ background: '#10101a', border: '1px solid #252536', borderRadius: '8px', fontSize: 12, color: '#e4e4ef' }}
              formatter={(v: number) => [`$${v.toFixed(2)}`, '']} />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex-1 space-y-2">
          {data.map((d, i) => (
            <div key={d.name} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                <span className="text-text-muted capitalize">{d.name}</span>
              </div>
              <span className="font-mono text-text">${d.value.toFixed(2)} <span className="text-text-muted">({total > 0 ? ((d.value / total) * 100).toFixed(0) : 0}%)</span></span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
