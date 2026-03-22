export function Header() {
  return (
    <header className="border-b border-border-bright bg-bg sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-12 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-green font-bold text-xs">[TV]</span>
          <div className="border-l border-border-bright pl-3">
            <span className="text-xs text-white font-bold tracking-wider">TRUSTVAULT CREDIT</span>
            <span className="text-[10px] text-text-muted ml-2">// underwriting terminal</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px]">
          <a href="https://credit.unbrained.club/.well-known/agent.json" target="_blank" rel="noopener"
            className="text-text-muted hover:text-green transition-colors">[agent.json]</a>
          <a href="https://github.com/unbrained-labs/trustvault-credit" target="_blank" rel="noopener"
            className="text-text-muted hover:text-green transition-colors">[github]</a>
          <div className="flex items-center gap-1.5 border border-green/30 px-2 py-0.5">
            <span className="w-1.5 h-1.5 bg-green animate-blink" />
            <span className="text-green font-bold">LIVE</span>
          </div>
        </div>
      </div>
    </header>
  );
}
