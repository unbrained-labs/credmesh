export function Header() {
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-white font-bold text-sm">TV</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-text leading-tight">TrustVault Credit</h1>
            <p className="text-[11px] text-text-muted leading-tight">Agent Underwriting Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://trustvault-credit.leaidedev.workers.dev/.well-known/agent.json" target="_blank" rel="noopener"
            className="text-xs font-mono text-text-muted hover:text-primary transition-colors">agent.json</a>
          <a href="https://github.com/unbrained-labs/trustvault-credit" target="_blank" rel="noopener"
            className="text-xs font-mono text-text-muted hover:text-primary transition-colors">GitHub</a>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-credit-green animate-pulse" />
            <span className="text-xs font-mono text-credit-green">LIVE</span>
          </div>
        </div>
      </div>
    </header>
  );
}
