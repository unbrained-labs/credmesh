export function Footer() {
  return (
    <footer className="border-t border-border-bright mt-8">
      <div className="max-w-7xl mx-auto px-4 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Brain icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff1744" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A5.5 5.5 0 0 0 5 5.75a4 4 0 0 0-1 7.5 5 5 0 0 0 4.75 4.75h.75" />
            <path d="M14.5 2A5.5 5.5 0 0 1 19 5.75a4 4 0 0 1 1 7.5 5 5 0 0 1-4.75 4.75H14.5" />
            <path d="M12 2v20" />
            <path d="M8 8h.01" />
            <path d="M16 8h.01" />
            <path d="M8 12h.01" />
            <path d="M16 12h.01" />
          </svg>
          <a href="https://unbrained.club" target="_blank" rel="noopener"
            className="text-[11px] text-text-muted hover:text-white transition-colors font-bold tracking-wider">
            unbrained.club
          </a>
        </div>
        <div className="text-[10px] text-text-muted flex items-center gap-3">
          <span>Synthesis Hackathon 2026</span>
          <span className="text-border-bright">|</span>
          <span>March 13-22</span>
        </div>
      </div>
    </footer>
  );
}
