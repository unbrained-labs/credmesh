import type { HealthResponse } from '../api';
import { Card } from './Card';

export function VaultPanel({ vault, chain }: { vault: HealthResponse['vault']; chain: HealthResponse['chain'] }) {
  if (!vault) {
    return (
      <Card title="ERC-4626 Vault">
        <p className="text-text-muted text-xs">Vault not configured</p>
      </Card>
    );
  }

  const sharePrice = parseFloat(vault.sharePrice);
  const priceColor = sharePrice > 1.0 ? 'text-green' : sharePrice < 1.0 ? 'text-red' : 'text-white';

  return (
    <Card title="ERC-4626 Vault">
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase tracking-widest text-text-muted">Share Price</span>
          <span className={`text-2xl font-bold ${priceColor}`}>${vault.sharePrice}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
          <Row label="Total Assets" value={`$${fmt(vault.totalAssets)}`} color="text-white" />
          <Row label="Total Shares" value={`${fmt(vault.totalShares)} tvCREDIT`} color="text-indigo" />
          <Row label="Idle Balance" value={`$${fmt(vault.idleBalance)}`} color="text-cyan" />
          <Row label="In Escrow" value={`$${fmt(vault.inEscrow)}`} color="text-amber" />
          <Row label="Fees Earned" value={`$${fmt(vault.feesEarned)}`} color="text-green" />
          <Row label="Default Loss" value={`$${fmt(vault.defaultLoss)}`} color="text-red" />
        </div>
        <div className="border-t border-border pt-2 flex items-center gap-2 text-[10px]">
          <span className={`w-1.5 h-1.5 rounded-full ${chain.enabled ? 'bg-green' : 'bg-red'}`} />
          <span className="text-text-muted">
            {chain.network ?? 'offline'} | escrow: {chain.escrowBalance ?? 'n/a'}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className={`text-right font-mono ${color}`}>{value}</span>
    </>
  );
}

function fmt(v: string): string {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
