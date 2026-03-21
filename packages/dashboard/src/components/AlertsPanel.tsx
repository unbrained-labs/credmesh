import { Card } from './Card';

export function AlertsPanel({ alerts, recommendations }: { alerts: string[]; recommendations: string[] }) {
  return (
    <Card title="Alerts & Recommendations">
      <div className="space-y-4">
        {alerts.length > 0 ? (
          <div className="space-y-2">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs p-2 rounded-lg bg-credit-red/5 border border-credit-red/10">
                <span className="text-credit-red font-bold shrink-0 mt-px">!</span>
                <span className="text-credit-red/90">{a}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-credit-green/80 p-2 rounded-lg bg-credit-green/5 border border-credit-green/10 flex items-center gap-2">
            <span className="font-bold">OK</span><span>No active alerts</span>
          </div>
        )}
        <div className="border-t border-border pt-3 space-y-1.5">
          {recommendations.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-text-muted">
              <span className="text-primary shrink-0 mt-px">&rarr;</span><span>{r}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
