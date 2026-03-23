import type { ChainsResponse } from '../api';
import { Card } from './Card';

export function ChainStatus({ data }: { data: ChainsResponse | null }) {
  if (!data || data.chains.length === 0) {
    return (
      <Card title="Multi-Chain Status">
        <p className="text-text-muted text-xs">No active chains configured</p>
      </Card>
    );
  }

  return (
    <Card title="Multi-Chain Status">
      <div className="space-y-2">
        {data.chains.map((chain) => (
          <div
            key={chain.id}
            className="flex items-center justify-between bg-bg border border-border p-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  chain.hasEscrow ? 'bg-green' : 'bg-amber'
                }`}
              />
              <div>
                <p className="text-[11px] text-white font-bold">{chain.name}</p>
                <p className="text-[9px] text-text-muted">
                  Chain {chain.chainId}
                </p>
              </div>
            </div>
            <div className="flex gap-3 text-[9px]">
              <span className={chain.hasEscrow ? 'text-green' : 'text-text-muted'}>
                escrow {chain.hasEscrow ? 'ON' : 'OFF'}
              </span>
              <span className={chain.hasVault ? 'text-green' : 'text-text-muted'}>
                vault {chain.hasVault ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        ))}
        <div className="border-t border-border pt-2 text-[10px] text-text-muted">
          {data.count} chain{data.count !== 1 ? 's' : ''} active
        </div>
      </div>
    </Card>
  );
}
