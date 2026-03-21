import { useCallback, useEffect, useState } from 'react';
import { api, type PortfolioReport, type RiskReport, type TreasuryState, type TimelineEvent } from './api';
import { Header } from './components/Header';
import { StatsRow } from './components/StatsRow';
import { RiskGauge } from './components/RiskGauge';
import { ExposureChart } from './components/ExposureChart';
import { WaterfallChart } from './components/WaterfallChart';
import { TopBorrowers } from './components/TopBorrowers';
import { Timeline } from './components/Timeline';
import { DemoControls } from './components/DemoControls';
import { AlertsPanel } from './components/AlertsPanel';

export default function App() {
  const [portfolio, setPortfolio] = useState<PortfolioReport | null>(null);
  const [risk, setRisk] = useState<RiskReport | null>(null);
  const [treasury, setTreasury] = useState<TreasuryState | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [p, r, t, tl] = await Promise.all([
        api.portfolio(), api.risk(), api.treasury(), api.timeline(30),
      ]);
      setPortfolio(p); setRisk(r); setTreasury(t); setTimeline(tl);
    } catch (e) {
      console.error('Fetch failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, key]);

  const onDemo = useCallback(async (action: 'happy' | 'failure' | 'both' | 'reset') => {
    setLoading(true);
    try {
      if (action === 'reset') await api.reset();
      else await api.bootstrap(action);
      setKey(k => k + 1);
    } catch (e) {
      console.error('Demo action failed:', e);
      setLoading(false);
    }
  }, []);

  if (loading && !portfolio) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-text-muted font-mono text-sm">Connecting to TrustVault Credit...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-5">
        <DemoControls onAction={onDemo} loading={loading} />
        {portfolio && <StatsRow summary={portfolio.summary} />}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {risk && <RiskGauge risk={risk} />}
          {treasury && portfolio && <WaterfallChart treasury={treasury} summary={portfolio.summary} />}
          {risk && <AlertsPanel alerts={risk.alerts} recommendations={risk.recommendations} />}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {portfolio && <ExposureChart exposure={portfolio.exposureByCategory} />}
          {portfolio && <TopBorrowers borrowers={portfolio.topBorrowers} />}
        </div>
        <Timeline events={timeline} />
      </main>
    </div>
  );
}
