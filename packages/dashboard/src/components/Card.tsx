import type { ReactNode } from 'react';

export function Card({ title, children, className = '' }: {
  title?: string; children: ReactNode; className?: string;
}) {
  return (
    <div className={`bg-surface border border-border rounded-xl p-5 ${className}`}>
      {title && <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-4">{title}</h3>}
      {children}
    </div>
  );
}
