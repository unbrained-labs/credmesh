import type { TimelineEvent } from '../api';
import { Card } from './Card';

const icons: Record<string, { icon: string; color: string }> = {
  agent_registered: { icon: '++', color: 'text-primary' },
  job_created: { icon: '>>', color: 'text-cyan' },
  job_posted: { icon: '>>', color: 'text-cyan' },
  job_completed: { icon: 'OK', color: 'text-credit-green' },
  job_defaulted: { icon: '!!', color: 'text-credit-red' },
  bid_submitted: { icon: '$$', color: 'text-credit-amber' },
  bid_awarded: { icon: '<>', color: 'text-credit-green' },
  advance_created: { icon: '<<', color: 'text-primary' },
  advance_repaid: { icon: 'OK', color: 'text-credit-green' },
  advance_defaulted: { icon: 'XX', color: 'text-credit-red' },
  quote_issued: { icon: '##', color: 'text-credit-amber' },
  spend_recorded: { icon: '--', color: 'text-cyan' },
  deposit_received: { icon: '$$', color: 'text-credit-green' },
  state_reset: { icon: '~~', color: 'text-text-muted' },
};

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <Card title="Event Timeline">
      <div className="max-h-80 overflow-y-auto space-y-0.5 font-mono text-xs">
        {!events.length ? (
          <div className="text-center text-text-muted py-8">No events yet. Run a demo scenario to see activity.</div>
        ) : events.map((e, i) => {
          const m = icons[e.type] ?? { icon: '--', color: 'text-text-muted' };
          return (
            <div key={e.id} className="flex gap-3 py-1.5 px-2 rounded hover:bg-surface-2 transition-colors animate-slide-in" style={{ animationDelay: `${i * 30}ms` }}>
              <span className="text-text-muted shrink-0 w-16">{fmt(e.timestamp)}</span>
              <span className={`shrink-0 w-5 font-bold ${m.color}`}>{m.icon}</span>
              <span className="text-text-muted truncate flex-1">{e.description}</span>
              <span className="text-text-muted/50 shrink-0">{e.actor.slice(0, 16)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
