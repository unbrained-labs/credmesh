import { Card } from './Card';

export function AlertsPanel({ alerts, recommendations }: { alerts: string[]; recommendations: string[] }) {
  return (
    <Card title="Alerts">
      <div className="space-y-3">
        {alerts.length > 0 ? (
          <div className="space-y-1">
            {alerts.map((a, i) => (
              <div key={i} className="text-[11px] flex items-start gap-2 py-1">
                <span className="text-red font-bold shrink-0">ERR</span>
                <span className="text-red/80">{a}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-green py-1">
            <span className="font-bold">OK </span>
            <span className="text-green/70">all systems nominal</span>
          </div>
        )}

        <div className="border-t border-border pt-2 space-y-1">
          {recommendations.map((r, i) => (
            <div key={i} className="text-[11px] flex items-start gap-2 py-0.5">
              <span className="text-amber shrink-0">&gt;</span>
              <span className="text-text-muted">{r}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
