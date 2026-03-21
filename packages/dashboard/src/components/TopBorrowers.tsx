import type { PortfolioReport } from '../api';
import { Card } from './Card';

function scoreColor(s: number) { return s >= 70 ? 'text-green' : s >= 40 ? 'text-amber' : 'text-red'; }

export function TopBorrowers({ borrowers }: { borrowers: PortfolioReport['topBorrowers'] }) {
  if (!borrowers.length) {
    return <Card title="Top Borrowers"><div className="h-48 flex items-center justify-center text-text-muted text-xs">&gt; no borrowing history_</div></Card>;
  }

  return (
    <Card title="Top Borrowers">
      <div className="space-y-0">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_80px_80px_60px] gap-2 text-[9px] text-text-muted uppercase tracking-wider pb-2 border-b border-border">
          <span>agent</span>
          <span className="text-right">borrowed</span>
          <span className="text-right">score</span>
          <span className="text-right">repay</span>
        </div>
        {borrowers.map(b => (
          <div key={b.address} className="grid grid-cols-[1fr_80px_80px_60px] gap-2 py-2 border-b border-border text-xs hover:bg-surface-2 transition-colors">
            <div className="truncate">
              <span className="text-white">{b.name}</span>
              <span className="text-text-muted ml-1 text-[9px]">{b.address.slice(0, 12)}..</span>
            </div>
            <span className="text-right text-white">${b.totalBorrowed.toFixed(2)}</span>
            <span className={`text-right font-bold ${scoreColor(b.creditScore)}`}>{b.creditScore}</span>
            <span className="text-right text-text-muted">{(b.repaymentRate * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
