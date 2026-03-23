/**
 * Landing page HTML — served at the root / path.
 * Neobrutalist style: dark bg, sharp edges, monospace, green accent.
 * No frameworks, no build step — inline HTML string.
 */

export function landingHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TrustVault Credit — Programmable Working Capital for Autonomous Agents</title>
  <meta name="description" content="Non-custodial credit infrastructure for AI agents. Advance working capital against verified on-chain receivables. No operator approval needed.">
  <link rel="agent" href="https://credit.unbrained.club/.well-known/agent.json">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23050505'/><rect x='4' y='4' width='8' height='8' fill='%2300ff41'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #050505; color: #e0e0e0; font-family: 'JetBrains Mono', monospace; }
    ::selection { background: #00ff41; color: #000; }
    a { color: #00ff41; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

    /* Header */
    header { position: sticky; top: 0; z-index: 50; background: #050505; border-bottom: 1px solid #333; }
    header .inner { height: 48px; display: flex; align-items: center; justify-content: space-between; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-mark { color: #00ff41; font-weight: 800; font-size: 12px; }
    .logo-text { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #fff; }
    .nav { display: flex; gap: 16px; align-items: center; }
    .nav a { font-size: 10px; color: #666; }
    .nav a:hover { color: #00ff41; }
    .badge { border: 1px solid rgba(0,255,65,0.3); padding: 2px 8px; display: flex; align-items: center; gap: 6px; }
    .badge .dot { width: 6px; height: 6px; background: #00ff41; animation: blink 1.5s infinite; }
    .badge span { color: #00ff41; font-size: 10px; font-weight: 700; }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

    /* Hero */
    .hero { padding: 80px 0 60px; border-bottom: 1px solid #1a1a1a; }
    .hero h1 { font-size: clamp(32px, 5vw, 56px); font-weight: 800; color: #fff; line-height: 1.1; letter-spacing: -2px; }
    .hero h1 em { font-style: normal; color: #00ff41; }
    .hero p { margin-top: 20px; font-size: 14px; color: #666; line-height: 1.7; max-width: 600px; }
    .hero-cta { margin-top: 32px; display: flex; gap: 12px; flex-wrap: wrap; }
    .btn { display: inline-block; padding: 10px 24px; font-size: 11px; font-weight: 700; font-family: 'JetBrains Mono', monospace;
           text-transform: uppercase; letter-spacing: 2px; border: 2px solid; cursor: pointer; }
    .btn-primary { border-color: #00ff41; color: #00ff41; background: transparent; }
    .btn-primary:hover { background: rgba(0,255,65,0.1); text-decoration: none; }
    .btn-secondary { border-color: #333; color: #666; background: transparent; }
    .btn-secondary:hover { border-color: #666; color: #e0e0e0; text-decoration: none; }

    /* Sections */
    section { padding: 60px 0; border-bottom: 1px solid #1a1a1a; }
    .section-label { font-size: 9px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #666; margin-bottom: 24px; }
    h2 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 16px; }

    /* How it works */
    .flow { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 2px; margin-top: 24px; }
    .flow-step { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 20px; }
    .flow-step .num { font-size: 9px; color: #00ff41; font-weight: 700; margin-bottom: 8px; }
    .flow-step .title { font-size: 13px; color: #fff; font-weight: 700; margin-bottom: 6px; }
    .flow-step .desc { font-size: 10px; color: #666; line-height: 1.6; }

    /* Stats */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 2px; margin-top: 24px; }
    .stat { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 20px; }
    .stat .label { font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 2px; }
    .stat .value { font-size: 24px; font-weight: 800; color: #fff; margin-top: 4px; }
    .stat .sub { font-size: 10px; color: #666; margin-top: 4px; }
    .stat .value.green { color: #00ff41; }

    /* Cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2px; margin-top: 24px; }
    .card { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 24px; }
    .card h3 { font-size: 14px; color: #fff; font-weight: 700; margin-bottom: 8px; }
    .card p { font-size: 11px; color: #666; line-height: 1.7; }
    .card .tag { display: inline-block; font-size: 9px; color: #00ff41; border: 1px solid rgba(0,255,65,0.3); padding: 2px 8px; margin-top: 12px; }

    /* Integrations */
    .integrations { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 2px; margin-top: 24px; }
    .integration { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 16px; text-align: center; }
    .integration .name { font-size: 11px; color: #fff; font-weight: 700; }
    .integration .chain { font-size: 9px; color: #666; margin-top: 4px; }
    .integration .status { font-size: 9px; margin-top: 6px; }
    .integration .status.live { color: #00ff41; }
    .integration .status.next { color: #ff9100; }
    .integration .status.planned { color: #666; }

    /* Footer */
    footer { padding: 40px 0; }
    footer .inner { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
    footer .links { display: flex; gap: 24px; }
    footer a { font-size: 10px; color: #666; }
    footer .copy { font-size: 10px; color: #333; }

    /* Code block */
    .code { background: #0a0a0a; border: 1px solid #333; padding: 16px; font-size: 11px; color: #e0e0e0;
            overflow-x: auto; white-space: pre; line-height: 1.6; margin-top: 16px; }
    .code .comment { color: #666; }
    .code .keyword { color: #00ff41; }
    .code .string { color: #ff9100; }
  </style>
</head>
<body>

<header>
  <div class="container">
    <div class="inner">
      <div class="logo">
        <span class="logo-mark">[TV]</span>
        <span class="logo-text">TRUSTVAULT CREDIT</span>
      </div>
      <div class="nav">
        <a href="https://credit.unbrained.club/.well-known/agent.json">[agent.json]</a>
        <a href="https://credit.unbrained.club/fees">[fees]</a>
        <a href="https://github.com/unbrained-labs/trustvault-credit">[github]</a>
        <a href="https://trustvault-dashboard.pages.dev">[dashboard]</a>
        <div class="badge"><div class="dot"></div><span>LIVE</span></div>
      </div>
    </div>
  </div>
</header>

<main class="container">

  <!-- Hero -->
  <div class="hero">
    <h1>Programmable <em>working capital</em> for autonomous agents</h1>
    <p>Non-custodial credit infrastructure. Agents borrow against verified on-chain receivables. No operator approval — the contract verifies everything. Repayment via automatic waterfall.</p>
    <div class="hero-cta">
      <a href="https://credit.unbrained.club/bootstrap" class="btn btn-primary">Bootstrap an Agent</a>
      <a href="https://credit.unbrained.club/vault/opportunity" class="btn btn-secondary">LP Yield Opportunity</a>
      <a href="https://trustvault-dashboard.pages.dev" class="btn btn-secondary">Open Dashboard</a>
    </div>
  </div>

  <!-- How it works -->
  <section>
    <div class="section-label">How it works</div>
    <h2>The advance loop</h2>
    <div class="flow">
      <div class="flow-step">
        <div class="num">01</div>
        <div class="title">Agent registers</div>
        <div class="desc">Free HTTP call. No tokens, no gas needed. Agent gets an on-chain identity via ERC-8004.</div>
      </div>
      <div class="flow-step">
        <div class="num">02</div>
        <div class="title">Receivable verified</div>
        <div class="desc">The contract reads the IReceivableOracle — is there a real, funded, on-chain escrow backing this agent's work?</div>
      </div>
      <div class="flow-step">
        <div class="num">03</div>
        <div class="title">Credit checked</div>
        <div class="desc">ICreditOracle reads reputation score and exposure. Dynamic fee computed from utilization, duration, risk, pool state.</div>
      </div>
      <div class="flow-step">
        <div class="num">04</div>
        <div class="title">Advance issued</div>
        <div class="desc">USDC transferred from escrow to agent. No operator approval — the contract enforces all conditions.</div>
      </div>
      <div class="flow-step">
        <div class="num">05</div>
        <div class="title">Agent works</div>
        <div class="desc">Compute, APIs, gas, sub-agents — spend is tracked with programmable controls (categories, daily limits).</div>
      </div>
      <div class="flow-step">
        <div class="num">06</div>
        <div class="title">Waterfall settles</div>
        <div class="desc">Principal repaid first, then fees (85% to LPs, 15% protocol), then remainder to agent. Reputation updated on-chain.</div>
      </div>
    </div>
  </section>

  <!-- For Agents -->
  <section>
    <div class="section-label">For agents</div>
    <h2>Zero-capital bootstrap</h2>
    <p style="font-size:12px;color:#666;line-height:1.7;max-width:600px;margin-bottom:24px;">
      Agents interact via HTTP only. The protocol wallet signs all on-chain transactions.
      The advance is the agent's first tokens — bootstrapped from marketplace receivables.
    </p>
    <div class="cards">
      <div class="card">
        <h3>Trading Agent</h3>
        <p>Runs a multi-hour DeFi yield strategy. Needs capital for data feeds, compute, gas across transactions. Repays from strategy returns.</p>
        <div class="tag">4-12 hours | 2-3% fee</div>
      </div>
      <div class="card">
        <h3>Code Agent</h3>
        <p>Hired for a smart contract audit. Needs inference API, test deployment gas, compute. Repays from the job payout.</p>
        <div class="tag">24-48 hours | 4-5% fee</div>
      </div>
      <div class="card">
        <h3>Multi-Agent Coordinator</h3>
        <p>Lead agent hires 3 sub-agents. Needs to pay them upfront. Repays from the project payout after delivery.</p>
        <div class="tag">48-72 hours | 5-7% fee</div>
      </div>
    </div>
    <div class="code"><span class="comment">// Agent integration — 3 lines</span>
<span class="keyword">const</span> profile = <span class="keyword">await</span> fetch(<span class="string">"https://credit.unbrained.club/credit/profile"</span>, { method: <span class="string">"POST"</span>, body: JSON.stringify({ agentAddress }) });
<span class="keyword">const</span> advance = <span class="keyword">await</span> fetch(<span class="string">"https://credit.unbrained.club/credit/advance"</span>, { method: <span class="string">"POST"</span>, body: JSON.stringify({ agentAddress, jobId, requestedAmount: 20, purpose: <span class="string">"compute"</span> }) });
<span class="comment">// Agent receives USDC. Repayment is automatic via waterfall.</span></div>
  </section>

  <!-- For LPs -->
  <section>
    <div class="section-label">For liquidity providers</div>
    <h2>Earn yield from agent credit fees</h2>
    <div class="stats">
      <div class="stat">
        <div class="label">Fee range</div>
        <div class="value green">2-25%</div>
        <div class="sub">Dynamic, per advance</div>
      </div>
      <div class="stat">
        <div class="label">LP share</div>
        <div class="value green">85%</div>
        <div class="sub">Of all collected fees</div>
      </div>
      <div class="stat">
        <div class="label">Vault standard</div>
        <div class="value">ERC-4626</div>
        <div class="sub">Deposit USDC, get tvCREDIT</div>
      </div>
      <div class="stat">
        <div class="label">Settlement</div>
        <div class="value">Auto</div>
        <div class="sub">Waterfall sweeps on completion</div>
      </div>
    </div>
    <p style="font-size:11px;color:#666;margin-top:16px;">
      Idle capital is withdrawable instantly. Deployed capital (in active advances) unlocks as agents repay.
      <a href="https://credit.unbrained.club/vault/opportunity">Check live yield opportunity →</a>
    </p>
  </section>

  <!-- Trust model -->
  <section>
    <div class="section-label">Trust model</div>
    <h2>Non-custodial by design</h2>
    <div class="cards">
      <div class="card">
        <h3>No operator approval</h3>
        <p>The TrustlessEscrow contract verifies all conditions on-chain: receivable exists, credit score passes, exposure within limits. Nobody approves individual advances.</p>
      </div>
      <div class="card">
        <h3>Pluggable oracles</h3>
        <p>IReceivableOracle reads from any on-chain escrow (Virtuals ACP, Claw Earn, PayCrow, custom). ICreditOracle reads any reputation source. Chain-agnostic.</p>
      </div>
      <div class="card">
        <h3>Governance → DAO</h3>
        <p>Governance sets parameters and registers oracles (with 48h timelock). Transferable to multisig or DAO. Cannot withdraw capital or block advances.</p>
      </div>
    </div>
  </section>

  <!-- Integrations -->
  <section>
    <div class="section-label">Ecosystem</div>
    <h2>Where agents work and capital lives</h2>
    <div class="integrations">
      <div class="integration">
        <div class="name">Sepolia</div>
        <div class="chain">Ethereum L1</div>
        <div class="status live">LIVE</div>
      </div>
      <div class="integration">
        <div class="name">Base</div>
        <div class="chain">Coinbase L2</div>
        <div class="status next">NEXT</div>
      </div>
      <div class="integration">
        <div class="name">HyperEVM</div>
        <div class="chain">Hyperliquid</div>
        <div class="status planned">PLANNED</div>
      </div>
      <div class="integration">
        <div class="name">Virtuals ACP</div>
        <div class="chain">$28M/day volume</div>
        <div class="status next">NEXT</div>
      </div>
      <div class="integration">
        <div class="name">Olas Mech</div>
        <div class="chain">500 daily agents</div>
        <div class="status next">NEXT</div>
      </div>
      <div class="integration">
        <div class="name">Claw Earn</div>
        <div class="chain">Agent bounties</div>
        <div class="status next">NEXT</div>
      </div>
      <div class="integration">
        <div class="name">MPP</div>
        <div class="chain">Stripe + Tempo</div>
        <div class="status live">ACTIVE</div>
      </div>
      <div class="integration">
        <div class="name">x402</div>
        <div class="chain">Coinbase</div>
        <div class="status live">ACTIVE</div>
      </div>
    </div>
  </section>

  <!-- API -->
  <section>
    <div class="section-label">For developers</div>
    <h2>Machine-readable everything</h2>
    <div class="code"><span class="comment"># Agent discovery</span>
GET /.well-known/agent.json    <span class="comment"># A2A agent card with endpoint examples</span>
GET /bootstrap                 <span class="comment"># Zero-capital onboarding guide</span>
GET /use-cases                 <span class="comment"># Concrete examples for agents + LPs</span>
GET /payment/methods           <span class="comment"># Available payment rails</span>

<span class="comment"># Credit operations</span>
POST /credit/profile           <span class="comment"># Get credit score + limits</span>
POST /credit/quote             <span class="comment"># Dynamic fee quote (no commitment)</span>
POST /credit/advance           <span class="comment"># Issue advance (on-chain transfer)</span>

<span class="comment"># LP operations</span>
GET /vault/opportunity         <span class="comment"># Yield, risk, deposit instructions</span>
GET /vault/position/:address   <span class="comment"># Your shares, value, accrued yield</span>
GET /fees                      <span class="comment"># Current fee model + example rates</span></div>
    <p style="font-size:11px;color:#666;margin-top:16px;">
      Full API reference: <a href="https://github.com/unbrained-labs/trustvault-credit/blob/main/SKILL.md">SKILL.md</a>
    </p>
  </section>

</main>

<footer>
  <div class="container">
    <div class="inner">
      <div class="links">
        <a href="https://credit.unbrained.club/.well-known/agent.json">Agent Card</a>
        <a href="https://trustvault-dashboard.pages.dev">Dashboard</a>
        <a href="https://github.com/unbrained-labs/trustvault-credit">GitHub</a>
        <a href="https://github.com/unbrained-labs/trustvault-credit/blob/main/SKILL.md">SKILL.md</a>
        <a href="https://credit.unbrained.club/fees">Fee Model</a>
      </div>
      <div class="copy">unbrained.club — 2026</div>
    </div>
  </div>
</footer>

</body>
</html>`;
}
