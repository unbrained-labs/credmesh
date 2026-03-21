export function DemoControls({ onAction, loading }: {
  onAction: (a: 'happy' | 'failure' | 'both' | 'reset') => void; loading: boolean;
}) {
  const btn = "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50";
  return (
    <div className="bg-surface border border-border rounded-xl p-4 flex flex-wrap items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-text-muted mr-2">Demo</span>
      <button onClick={() => onAction('happy')} disabled={loading}
        className={`${btn} bg-credit-green/10 text-credit-green border-credit-green/20 hover:bg-credit-green/20`}>Happy Path</button>
      <button onClick={() => onAction('failure')} disabled={loading}
        className={`${btn} bg-credit-red/10 text-credit-red border-credit-red/20 hover:bg-credit-red/20`}>Failure Path</button>
      <button onClick={() => onAction('both')} disabled={loading}
        className={`${btn} bg-primary/10 text-primary border-primary/20 hover:bg-primary/20`}>Both Scenarios</button>
      <div className="flex-1" />
      <button onClick={() => onAction('reset')} disabled={loading}
        className={`${btn} bg-surface-2 text-text-muted border-border hover:text-credit-red hover:border-credit-red/30`}>Reset State</button>
    </div>
  );
}
