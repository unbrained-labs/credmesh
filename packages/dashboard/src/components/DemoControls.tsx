export function DemoControls({ onAction, loading }: {
  onAction: (a: 'happy' | 'failure' | 'both' | 'reset') => void; loading: boolean;
}) {
  const btn = "px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border transition-colors disabled:opacity-30";
  return (
    <div className="bg-surface border border-border-bright p-3 flex flex-wrap items-center gap-2">
      <span className="text-[10px] text-text-muted mr-2">&gt; demo_</span>
      <button onClick={() => onAction('happy')} disabled={loading}
        className={`${btn} border-green/40 text-green hover:bg-green/10`}>run:happy</button>
      <button onClick={() => onAction('failure')} disabled={loading}
        className={`${btn} border-red/40 text-red hover:bg-red/10`}>run:failure</button>
      <button onClick={() => onAction('both')} disabled={loading}
        className={`${btn} border-indigo/40 text-indigo hover:bg-indigo/10`}>run:both</button>
      <div className="flex-1" />
      <button onClick={() => onAction('reset')} disabled={loading}
        className={`${btn} border-border-bright text-text-muted hover:text-red hover:border-red/40`}>reset</button>
    </div>
  );
}
