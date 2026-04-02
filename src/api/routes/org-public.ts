// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P348/P349 — Glasscheibe Public Org Chart Routes (unauthenticated)
 *
 *   GET  /api/v1/org/public        — privacy-filtered org chart tree (JSON)
 *   GET  /api/v1/org/public/live   — SSE stream of public agent-status events
 *   GET  /widget/glasscheibe.js    — embeddable vanilla JS widget (P349)
 *
 * All routes:
 *  - Require no Bearer token (added to PUBLIC_PATHS / PUBLIC_PREFIXES in auth.ts)
 *  - Apply IP-keyed rate limiter on API routes (60 req/min per IP, burst 10)
 *  - Return CORS headers for browser cross-origin consumption
 *
 * Widget pattern follows pwa.ts: content is inlined as a constant — no
 * runtime file reads, no build-step copies needed.
 */

import type { Hono }        from "hono";
import type Database        from "better-sqlite3";
import { streamSSE }        from "hono/streaming";
import { createLogger }     from "../../core/logger.js";
import { rateLimiter }      from "../middleware/rate-limiter.js";
import type { RateLimitConfig } from "../middleware/rate-limiter.js";
import { OrgChartStore }    from "../../org-chart/org-chart-store.js";
import { toPublicTree, filterPublicEvent } from "../org-public/privacy-filter.js";
import type { EventStreamManager, SSEWritable } from "../sse/event-stream.js";
import type { SSEEvent }    from "../sse/event-filter.js";

const logger = createLogger("org-public");

export interface OrgPublicRouteServices {
  db:                   InstanceType<typeof Database>;
  manager:              EventStreamManager;
  /** Milliseconds between keep-alive pings (default 30 000). */
  keepaliveIntervalMs?: number;
  /** Allowed CORS origin (default "*"). */
  corsOrigin?:          string;
}

/** 60 req / min per IP — conservative for a public, unauthenticated endpoint */
const PUBLIC_RATE_LIMIT: RateLimitConfig = {
  enabled:      true,
  window_ms:    60_000,
  max_requests: 60,
  burst_max:    10,
};

// ---------------------------------------------------------------------------
// FilteringSSEWritable
// ---------------------------------------------------------------------------

/**
 * Wraps an inner SSEWritable and intercepts writeSSE() calls, applying the
 * Glasscheibe privacy filter before forwarding to the real Hono stream.
 *
 * Non-public event types are silently dropped (returns without writing).
 * Internal data fields (tier, model, cost, …) are stripped; only
 * agentId, divisionId, and status pass through.
 */
class FilteringSSEWritable implements SSEWritable {
  constructor(private readonly inner: SSEWritable) {}

  async writeSSE(msg: { id?: string; event?: string; data: string }): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch (_e) {
      return; // malformed data — drop silently
    }

    const candidate: SSEEvent = {
      id:        parseInt(msg.id ?? "0", 10) || 0,
      type:      (msg.event ?? "") as SSEEvent["type"],
      data:      (typeof parsed === "object" && parsed !== null
        ? parsed
        : {}) as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };

    const filtered = filterPublicEvent(candidate);
    if (filtered === null) return; // event not allowed on public stream

    return this.inner.writeSSE({
      ...msg,
      data: JSON.stringify(filtered.data),
    });
  }

  write(data: string): Promise<unknown>   { return this.inner.write(data); }
  get closed(): boolean                   { return this.inner.closed; }
  close(): Promise<void>                  { return this.inner.close(); }
  sleep(ms: number): Promise<unknown>     { return this.inner.sleep(ms); }
  abort(): void                           { this.inner.abort(); }
}

// ---------------------------------------------------------------------------
// Glasscheibe widget JS (inlined — same pattern as pwa.ts for zero-dep serving)
// Source file: src/api/static/glasscheibe.js (kept for readability)
// ---------------------------------------------------------------------------

/* eslint-disable */
const GLASSCHEIBE_WIDGET_JS = `// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// SIDJUA Glasscheibe Widget — Embeddable public org chart viewer
(function() {
  'use strict';
  var scriptTag = document.currentScript;
  var apiBase = (scriptTag ? scriptTag.getAttribute('data-api') || '' : '').replace(/\\/$/, '');
  var targetSelector = scriptTag ? (scriptTag.getAttribute('data-target') || '#sidjua-org') : '#sidjua-org';
  var refreshInterval = parseInt(scriptTag ? (scriptTag.getAttribute('data-refresh') || '5000') : '5000', 10);
  if (!apiBase) { console.error('[Glasscheibe] Missing data-api attribute on script tag'); return; }
  var WIDGET_CSS = '.sjg-container{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0f;color:#e0e0e8;border-radius:12px;padding:24px;overflow-x:auto}.sjg-header{text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.08)}.sjg-header h2{margin:0 0 4px 0;font-size:18px;font-weight:600;color:#f0f0f8}.sjg-subtitle{font-size:12px;color:#888}.sjg-tree{display:flex;flex-direction:column;align-items:center;gap:16px}.sjg-level{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;width:100%}.sjg-division{background:#10101a;border:1px solid rgba(255,255,255,0.05);border-radius:10px;padding:12px 14px 10px;min-width:200px}.sjg-div-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#5a5a7a;margin-bottom:10px}.sjg-agents{display:flex;flex-direction:column;gap:8px}.sjg-card{background:#14141f;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;transition:border-color .2s}.sjg-card:hover{border-color:rgba(100,120,255,.3)}.sjg-card-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}.sjg-led{width:8px;height:8px;border-radius:50%;flex-shrink:0}.sjg-led-active{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.5);animation:sjg-pulse 2s infinite}.sjg-led-stopped{background:#555}.sjg-led-error{background:#ef4444}.sjg-led-offline{background:#3b3b50}@keyframes sjg-pulse{0%,100%{opacity:1}50%{opacity:.45}}.sjg-name{font-size:13px;font-weight:600;color:#f0f0f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sjg-role{font-size:11px;color:#6b6b8a;margin-top:1px}.sjg-connector{width:1px;height:14px;background:rgba(255,255,255,.08);margin:0 auto}.sjg-error{text-align:center;padding:32px;color:#888;font-size:13px}.sjg-loading{text-align:center;padding:32px;color:#555;font-size:13px}@media(max-width:640px){.sjg-level{flex-direction:column;align-items:stretch}.sjg-division{min-width:0}}';
  function injectCSS(){if(document.getElementById('sjg-styles'))return;var s=document.createElement('style');s.id='sjg-styles';s.textContent=WIDGET_CSS;document.head.appendChild(s);}
  function escapeHtml(str){if(typeof str!=='string')str=String(str==null?'':str);return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function agentLedClass(active){return active?'sjg-led-active':'sjg-led-offline';}
  function renderCard(agent){var h='';h+='<div class="sjg-card" data-agent-id="'+escapeHtml(agent.id)+'"><div class="sjg-card-header"><div class="sjg-led '+agentLedClass(agent.active)+'"></div><span class="sjg-name">'+escapeHtml(agent.name)+'</span></div>';if(agent.role_title)h+='<div class="sjg-role">'+escapeHtml(agent.role_title)+'</div>';h+='</div>';return h;}
  function renderDivision(node){var h='<div class="sjg-division"><div class="sjg-div-label">'+escapeHtml(node.name)+'</div>';if(node.agents&&node.agents.length>0){h+='<div class="sjg-agents">';for(var i=0;i<node.agents.length;i++)h+=renderCard(node.agents[i]);h+='</div>';}h+='</div>';return h;}
  function collectLevels(nodes,depth,levels){if(!nodes||!nodes.length)return;if(!levels[depth])levels[depth]=[];for(var i=0;i<nodes.length;i++){levels[depth].push(nodes[i]);if(nodes[i].children&&nodes[i].children.length)collectLevels(nodes[i].children,depth+1,levels);}}
  function renderTree(container,tree){if(!tree||!tree.roots||!tree.roots.length){container.innerHTML='<div class="sjg-container"><div class="sjg-error">No org chart data available</div></div>';return;}var levels=[];collectLevels(tree.roots,0,levels);var h='<div class="sjg-container"><div class="sjg-header"><h2>Company Overview</h2><span class="sjg-subtitle">Live agent status</span></div><div class="sjg-tree">';for(var i=0;i<levels.length;i++){if(i>0)h+='<div class="sjg-connector"></div>';h+='<div class="sjg-level">';for(var j=0;j<levels[i].length;j++)h+=renderDivision(levels[i][j]);h+='</div>';}h+='</div></div>';container.innerHTML=h;}
  function sseToLedClass(t){if(t==='agent:started'||t==='agent:restarted')return 'sjg-led-active';if(t==='agent:crashed')return 'sjg-led-error';if(t==='agent:stopped')return 'sjg-led-stopped';return 'sjg-led-offline';}
  function updateAgentCard(container,agentId,ledClass){if(!CSS||!CSS.escape)return;var card=container.querySelector('[data-agent-id="'+CSS.escape(agentId)+'"]');if(!card)return;var led=card.querySelector('.sjg-led');if(led)led.className='sjg-led '+ledClass;}
  function fetchOrgChart(cb){fetch(apiBase+'/api/v1/org/public',{mode:'cors'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(cb).catch(function(e){console.warn('[Glasscheibe] Fetch failed:',e.message);cb(null);});}
  function connectSSE(container){var sseUrl=apiBase+'/api/v1/org/public/live';var es=null;var fallbackTimer=null;function handleEvent(e){var data;try{data=JSON.parse(e.data);}catch(_pe){return;}if(data&&typeof data.agentId==='string')updateAgentCard(container,data.agentId,sseToLedClass(e.type));}function startSSE(){try{es=new EventSource(sseUrl);}catch(_ie){startPolling();return;}es.addEventListener('agent:started',handleEvent);es.addEventListener('agent:stopped',handleEvent);es.addEventListener('agent:crashed',handleEvent);es.addEventListener('agent:restarted',handleEvent);es.onerror=function(){if(es){es.close();es=null;}console.warn('[Glasscheibe] SSE disconnected, falling back to polling');startPolling();};}function startPolling(){if(fallbackTimer!==null)return;fallbackTimer=setInterval(function(){fetchOrgChart(function(t){if(t)renderTree(container,t);});},refreshInterval);setTimeout(function retrySSE(){if(es!==null)return;try{startSSE();}catch(_re){}if(fallbackTimer!==null)setTimeout(retrySSE,30000);},30000);}startSSE();}
  function init(){injectCSS();var container=document.querySelector(targetSelector);if(!container){console.error('[Glasscheibe] Target element not found: '+targetSelector);return;}container.innerHTML='<div class="sjg-container"><div class="sjg-loading">Loading\u2026</div></div>';fetchOrgChart(function(tree){if(tree){renderTree(container,tree);connectSSE(container);}else{container.innerHTML='<div class="sjg-container"><div class="sjg-error">Could not load org chart</div></div>';setTimeout(function(){init();},10000);}});}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();`;
/* eslint-enable */

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

/** Read a workspace_config value — returns null on any error or missing row. */
function getWorkspaceConfig(db: InstanceType<typeof Database>, key: string): string | null {
  try {
    const row = db.prepare<[string], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = ?",
    ).get(key);
    return row?.value ?? null;
  } catch (_e) {
    return null;
  }
}

export function registerOrgPublicRoutes(
  app: Hono,
  {
    db,
    manager,
    keepaliveIntervalMs = 30_000,
    corsOrigin          = "*",
  }: OrgPublicRouteServices,
): void {
  const store = new OrgChartStore(db);
  const rl    = rateLimiter(PUBLIC_RATE_LIMIT);

  function corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin":  corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
  }

  // CORS pre-flight
  app.options("/api/v1/org/public", (c) => {
    return new Response(null, { status: 204, headers: corsHeaders() });
  });
  app.options("/api/v1/org/public/live", (c) => {
    return new Response(null, { status: 204, headers: corsHeaders() });
  });

  // ── GET /api/v1/org/public ──────────────────────────────────────────────
  app.get("/api/v1/org/public", rl, (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.json({ error: "public_org_chart_disabled", message: "The public org chart is disabled on this server." }, 404);
    }
    for (const [k, v] of Object.entries(corsHeaders())) c.header(k, v);
    const internal = store.getTree();
    const pub      = toPublicTree(internal);
    return c.json(pub);
  });

  // ── GET /api/v1/org/public/live ─────────────────────────────────────────
  app.get("/api/v1/org/public/live", rl, (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.json({ error: "public_org_chart_disabled", message: "The public org chart is disabled on this server." }, 404);
    }
    for (const [k, v] of Object.entries(corsHeaders())) c.header(k, v);

    const clientId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      const filteringStream = new FilteringSSEWritable(stream);

      const added = manager.addClient({
        id:               clientId,
        stream:           filteringStream,
        filters:          {},  // no topic filters — privacy filter handles event selection
        connectedAt:      new Date().toISOString(),
        lastEventId:      0,
        pendingBytes:     0,
        lastBytesAddedAt: 0,
      });

      if (!added) {
        await stream.writeSSE({
          event: "error",
          data:  JSON.stringify({ code: "SSE-503", message: "Too many connections — try again later" }),
        });
        await stream.close();
        return;
      }

      logger.info("public_sse_opened", `Public SSE client ${clientId} connected`);

      try {
        while (!stream.closed) {
          await stream.sleep(keepaliveIntervalMs);
          if (!stream.closed) {
            await stream.write(`:ping ${Math.floor(Date.now() / 1000)}\n\n`);
          }
        }
      } finally {
        manager.removeClient(clientId);
        logger.info("public_sse_closed", `Public SSE client ${clientId} disconnected`);
      }
    });
  });

  // ── GET /widget/glasscheibe.js ───────────────────────────────────────────
  // Embeddable vanilla JS widget — served as a static asset, no auth required.
  // Content is inlined (zero runtime file reads); see src/api/static/glasscheibe.js.
  app.get("/widget/glasscheibe.js", (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.text("/* Public org chart is disabled on this server. */\n", 404);
    }
    return c.body(GLASSCHEIBE_WIDGET_JS, 200, {
      "Content-Type":                 "application/javascript; charset=utf-8",
      "Cache-Control":                "public, max-age=3600",
      "Access-Control-Allow-Origin":  corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
  });
}
