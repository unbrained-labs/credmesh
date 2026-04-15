import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import { Card } from './Card';

interface LogEntry {
  id: string;
  type: 'cmd' | 'req' | 'res' | 'err' | 'info';
  text: string;
}

const COMMANDS = [
  { cmd: 'demo', desc: 'Bootstrap demo data (happy/failure/both)', args: '[scenario]' },
  { cmd: 'reset', desc: 'Reset all state', args: '' },
  { cmd: 'deposit', desc: 'Fund the treasury (requires wallet auth)', args: 'amount' },
  { cmd: 'register', desc: 'Register an agent (requires wallet auth)', args: 'address name trustScore' },
  { cmd: 'job', desc: 'Create a job (requires wallet auth)', args: 'agentAddress title payout category' },
  { cmd: 'advance', desc: 'Request credit advance (requires wallet auth)', args: 'agentAddress jobId amount purpose' },
  { cmd: 'complete', desc: 'Complete a job (requires wallet auth)', args: 'jobId [actualPayout]' },
  { cmd: 'help', desc: 'Show available commands', args: '' },
  { cmd: 'clear', desc: 'Clear terminal', args: '' },
];

// Default addresses for terminal convenience (valid Ethereum format)
const DEMO_LENDER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEMO_AGENT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEMO_CLIENT = '0xcccccccccccccccccccccccccccccccccccccccc';

export function Terminal({ onMutation }: { onMutation: () => void }) {
  const [input, setInput] = useState('');
  const [log, setLog] = useState<LogEntry[]>([
    { id: '0', type: 'info', text: 'CredMesh Terminal v0.6.0 — type "help" for commands' },
    { id: '1', type: 'info', text: 'All commands hit the live API. Try: demo → then check the dashboard panels.' },
    { id: '2', type: 'info', text: 'Agent endpoints require wallet signature auth (EIP-191). Use demo/reset for quick testing.' },
  ]);
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  const push = (type: LogEntry['type'], text: string) =>
    setLog(prev => [...prev, { id: crypto.randomUUID(), type, text }]);

  const exec = async (raw: string) => {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    if (!cmd) return;

    push('cmd', `> ${raw}`);
    setRunning(true);

    try {
      switch (cmd) {
        case 'help': {
          COMMANDS.forEach(c => push('info', `  ${c.cmd.padEnd(12)} ${c.desc}${c.args ? ` — args: ${c.args}` : ''}`));
          break;
        }
        case 'clear': {
          setLog([]);
          break;
        }
        case 'deposit': {
          const amount = Number(parts[1] || 500);
          push('req', `POST /treasury/deposit { amount: ${amount} }`);
          const r = await api.depositFunds({ lenderAddress: DEMO_LENDER, amount, memo: 'Terminal deposit' });
          push('res', formatJson(r.response));
          onMutation();
          break;
        }
        case 'register': {
          const addr = parts[1] || DEMO_AGENT;
          const name = parts[2] || 'terminal-agent';
          const trust = Number(parts[3] || 70);
          push('req', `POST /agents/register { address: "${addr}", name: "${name}", trustScore: ${trust} }`);
          const r = await api.registerAgent({ address: addr, name, trustScore: trust, successfulJobs: 5, failedJobs: 0 });
          push('res', formatJson(r.response));
          onMutation();
          break;
        }
        case 'job': {
          const agent = parts[1];
          const title = parts[2] || 'Terminal-task';
          const payout = Number(parts[3] || 100);
          const cat = parts[4] || 'code';
          if (!agent) { push('err', 'Usage: job <agentAddress> [title] [payout] [category]'); break; }
          push('req', `POST /marketplace/jobs { agentAddress: "${agent}", expectedPayout: ${payout} }`);
          const r = await api.createJob({ agentAddress: agent, payer: DEMO_CLIENT, title, expectedPayout: payout, durationHours: 48, category: cat });
          push('res', formatJson(r.response));
          onMutation();
          break;
        }
        case 'advance': {
          const agent = parts[1];
          const jobId = parts[2];
          const amount = Number(parts[3] || 15);
          const purpose = parts[4] || 'compute';
          if (!agent || !jobId) { push('err', 'Usage: advance <agentAddress> <jobId> [amount] [purpose]'); break; }
          push('req', `POST /credit/advance { agentAddress: "${agent}", jobId: "${jobId}", requestedAmount: ${amount}, purpose: "${purpose}" }`);
          const r = await api.requestAdvance({ agentAddress: agent, jobId, requestedAmount: amount, purpose });
          push('res', formatJson(r.response));
          onMutation();
          break;
        }
        case 'complete': {
          const jobId = parts[1];
          const payout = parts[2] ? Number(parts[2]) : undefined;
          if (!jobId) { push('err', 'Usage: complete <jobId> [actualPayout]'); break; }
          push('req', `POST /marketplace/jobs/${jobId}/complete ${payout ? `{ actualPayout: ${payout} }` : '{}'}`);
          const r = await api.completeJob(jobId, payout);
          push('res', formatJson(r.response));
          onMutation();
          break;
        }
        case 'demo': {
          const scenario = (parts[1] || 'both') as 'happy' | 'failure' | 'both';
          push('req', `POST /demo/bootstrap { scenario: "${scenario}" }`);
          const r = await api.bootstrap(scenario);
          push('res', `${r.summary}`);
          onMutation();
          break;
        }
        case 'reset': {
          push('req', 'POST /demo/reset');
          const r = await api.reset();
          push('res', r.message);
          onMutation();
          break;
        }
        default:
          push('err', `Unknown command: ${cmd}. Type "help" for available commands.`);
      }
    } catch (e) {
      push('err', `Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || running) return;
    const cmd = input;
    setInput('');
    exec(cmd);
  };

  const colors: Record<LogEntry['type'], string> = {
    cmd: 'text-white',
    req: 'text-indigo',
    res: 'text-green/80',
    err: 'text-red',
    info: 'text-text-muted',
  };

  return (
    <Card title="Interactive Terminal">
      <div className="h-80 overflow-y-auto mb-3 space-y-0.5" onClick={() => inputRef.current?.focus()}>
        {log.map(entry => (
          <div key={entry.id} className={`text-[11px] leading-relaxed whitespace-pre-wrap break-all ${colors[entry.type]}`}>
            {entry.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border pt-2">
        <span className="text-green text-xs shrink-0">&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={running}
          placeholder={running ? 'executing...' : 'type a command (try: help)'}
          className="flex-1 bg-transparent text-xs text-white outline-none placeholder:text-text-muted/50"
          autoFocus
        />
      </form>
    </Card>
  );
}

function formatJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const compact = JSON.stringify(parsed, null, 2);
    // Truncate long responses for readability
    const lines = compact.split('\n');
    if (lines.length > 20) {
      return lines.slice(0, 18).join('\n') + '\n  ... (' + (lines.length - 18) + ' more lines)';
    }
    return compact;
  } catch {
    return raw;
  }
}
