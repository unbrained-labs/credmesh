import type { PortfolioReport } from '../api';
import { Card } from './Card';

function scoreColor(s: number) { return s >= 70 ? 'text-credit-green' : s >= 40 ? 'text-credit-amber' : 'text-credit-red'; }
function scoreBg(s: number) { return s >= 70 ? 'bg-credit-green/10' : s >= 40 ? 'bg-credit-amber/10' : 'bg-credit-red/10'; }

export function TopBorrowers({ borrowers }: { borrowers: PortfolioReport['topBorrowers'] }) {
  if (!borrowers.length) {
    return <Card title="Top Borrowers"><div className="h-48 flex items-center justify-center text-text-muted text-sm">No borrowing history</div></Card>;
  }

  return (
    <Card title="Top Borrowers">
      <div className="space-y-3">
        {borrowers.map(b => (
          <div key={b.address} className="flex items-center justify-between p-3 rounded-lg bg-surface-2 border border-border">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${scoreBg(b.creditScore)}`}>
                <span className={`text-sm font-bold font-mono ${scoreColor(b.creditScore)}`}>{b.creditScore}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-text">{b.name}</p>
                <p className="text-[10px] font-mono text-text-muted">{b.address.slice(0, 24)}...</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-mono text-text">${b.totalBorrowed.toFixed(2)}</p>
              <p className="text-[10px] text-text-muted">{(b.repaymentRate * 100).toFixed(0)}% repaid</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
