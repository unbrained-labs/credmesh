import type { ReactNode } from 'react';

export function Card({ title, children, className = '' }: {
  title?: string; children: ReactNode; className?: string;
}) {
  return (
    <div className={`bg-surface border border-border-bright p-4 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
          <span className="text-green text-[10px]">&#9608;</span>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}
