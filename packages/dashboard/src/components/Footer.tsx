export function Footer() {
  return (
    <footer className="border-t border-border-bright mt-8">
      <div className="max-w-7xl mx-auto px-4 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff1744" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 18V5" />
            <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
            <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
            <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
            <path d="M18 18a4 4 0 0 0 2-7.464" />
            <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
            <path d="M6 18a4 4 0 0 1-2-7.464" />
            <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
          </svg>
          <a href="https://unbrained.club" target="_blank" rel="noopener noreferrer"
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
