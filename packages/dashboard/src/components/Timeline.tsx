import type { TimelineEvent } from '../api';
import { Card } from './Card';

const icons: Record<string, { sym: string; color: string }> = {
  agent_registered: { sym: '[+]', color: 'text-indigo' },
  job_created: { sym: '[>]', color: 'text-cyan' },
  job_posted: { sym: '[>]', color: 'text-cyan' },
  job_completed: { sym: '[OK]', color: 'text-green' },
  job_defaulted: { sym: '[!!]', color: 'text-red' },
  bid_submitted: { sym: '[$]', color: 'text-amber' },
  bid_awarded: { sym: '[*]', color: 'text-green' },
  advance_created: { sym: '[<<]', color: 'text-indigo' },
  advance_repaid: { sym: '[OK]', color: 'text-green' },
  advance_defaulted: { sym: '[XX]', color: 'text-red' },
  quote_issued: { sym: '[##]', color: 'text-amber' },
  spend_recorded: { sym: '[--]', color: 'text-cyan' },
  deposit_received: { sym: '[$$]', color: 'text-green' },
  state_reset: { sym: '[~~]', color: 'text-text-muted' },
};

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <Card title="Event Log">
      <div className="max-h-72 overflow-y-auto text-[11px] space-y-0">
        {!events.length ? (
          <div className="text-text-muted py-6 text-center">&gt; awaiting events... run demo to populate_<span className="animate-blink">|</span></div>
        ) : events.map((e, i) => {
          const m = icons[e.type] ?? { sym: '[--]', color: 'text-text-muted' };
          return (
            <div key={e.id} className="flex gap-2 py-1 px-1 hover:bg-white/[0.02] transition-colors animate-slide-in border-b border-border/50" style={{ animationDelay: `${i * 20}ms` }}>
              <span className="text-text-muted shrink-0 w-14">{fmt(e.timestamp)}</span>
              <span className={`shrink-0 w-8 font-bold ${m.color}`}>{m.sym}</span>
              <span className="text-text-muted truncate flex-1">{e.description}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
