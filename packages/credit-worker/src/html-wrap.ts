/**
 * Wraps JSON API responses in human-readable HTML when a browser visits.
 * Agents get raw JSON. Humans get a styled page with the same data.
 *
 * Usage in a route:
 *   return respond(c, data, { title: "Vault Opportunity", cta: { label: "Deposit", href: "..." } });
 */

import type { Context } from "hono";

interface RespondOptions {
  title: string;
  description?: string;
  cta?: { label: string; href: string };
  backLabel?: string;
}

export function respond(c: Context, data: unknown, opts: RespondOptions) {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json(data);
  }
  if (!accept.includes("text/html")) {
    return c.json(data);
  }

  // Render HTML
  const json = JSON.stringify(data, null, 2);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} — TrustVault Credit</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #050505; color: #e0e0e0; font-family: 'JetBrains Mono', monospace; }
    ::selection { background: #00ff41; color: #000; }
    a { color: #00ff41; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
    header { border-bottom: 1px solid #333; padding-bottom: 24px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
    h1 { font-size: 20px; font-weight: 800; color: #fff; }
    .desc { font-size: 11px; color: #666; margin-top: 8px; max-width: 500px; line-height: 1.6; }
    .btn { display: inline-block; padding: 10px 24px; font-size: 11px; font-weight: 700; font-family: 'JetBrains Mono', monospace;
           text-transform: uppercase; letter-spacing: 2px; border: 2px solid #00e5ff; color: #00e5ff; }
    .btn:hover { background: rgba(0,229,255,0.1); text-decoration: none; }
    .btn-back { border-color: #333; color: #666; font-size: 10px; padding: 6px 16px; }
    .btn-back:hover { border-color: #666; color: #e0e0e0; }
    .data-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 2px; margin-bottom: 32px; }
    .data-item { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 16px; }
    .data-item .label { font-size: 9px; text-transform: uppercase; letter-spacing: 2px; color: #666; }
    .data-item .value { font-size: 18px; font-weight: 800; color: #fff; margin-top: 4px; }
    .data-item .value.green { color: #00ff41; }
    .data-item .value.cyan { color: #00e5ff; }
    .raw { background: #0a0a0a; border: 1px solid #1a1a1a; padding: 16px; font-size: 10px; color: #666;
           overflow-x: auto; white-space: pre; line-height: 1.5; max-height: 400px; overflow-y: auto; }
    .raw-label { font-size: 9px; text-transform: uppercase; letter-spacing: 2px; color: #333; margin-bottom: 8px; }
    .nav { display: flex; gap: 16px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #1a1a1a; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${opts.title}</h1>
        ${opts.description ? `<p class="desc">${opts.description}</p>` : ""}
      </div>
      ${opts.cta ? `<a href="${opts.cta.href}" class="btn">${opts.cta.label}</a>` : ""}
    </header>
    ${renderDataGrid(data)}
    <div class="raw-label">Raw JSON (this is what agents see)</div>
    <pre class="raw">${escapeHtml(json)}</pre>
    <div class="nav">
      <a href="/" class="btn-back">&larr; Landing</a>
      <a href="https://trustvault-dashboard.pages.dev" class="btn-back">Dashboard</a>
      <a href="/.well-known/agent.json" class="btn-back">Agent Card</a>
    </div>
  </div>
</body>
</html>`;

  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(html);
}

function renderDataGrid(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  const items: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "object" && !Array.isArray(val)) {
      // Nested object — render its fields
      const nested = val as Record<string, unknown>;
      for (const [k, v] of Object.entries(nested)) {
        if (typeof v === "object") continue;
        const colorClass = typeof v === "number" && v > 0 ? "green" : typeof v === "string" && v.includes("%") ? "cyan" : "";
        items.push(`<div class="data-item"><div class="label">${escapeHtml(key + "." + k)}</div><div class="value ${colorClass}">${escapeHtml(String(v))}</div></div>`);
      }
    } else if (typeof val !== "object") {
      const colorClass = typeof val === "number" && val > 0 ? "green" : typeof val === "string" && val.includes("%") ? "cyan" : "";
      items.push(`<div class="data-item"><div class="label">${escapeHtml(key)}</div><div class="value ${colorClass}">${escapeHtml(String(val))}</div></div>`);
    }
  }

  if (items.length === 0) return "";
  return `<div class="data-grid">${items.join("\n")}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
