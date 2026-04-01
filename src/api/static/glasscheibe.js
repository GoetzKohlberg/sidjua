// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// SIDJUA Glasscheibe Widget — Embeddable public org chart viewer
//
// Source file for development. The production build serves this content
// inlined as a constant in src/api/routes/org-public.ts (same pattern
// as PWA assets in src/api/routes/pwa.ts).
//
// Usage:
//   <div id="sidjua-org"></div>
//   <script src="https://your-sidjua.example.com/widget/glasscheibe.js"
//           data-api="https://your-sidjua.example.com"
//           data-target="#sidjua-org"
//           data-refresh="5000"></script>

(function() {
  'use strict';

  // ---- Configuration from script tag attributes -------------------------
  var scriptTag = document.currentScript;
  var apiBase = (scriptTag ? scriptTag.getAttribute('data-api') || '' : '').replace(/\/$/, '');
  var targetSelector = scriptTag ? (scriptTag.getAttribute('data-target') || '#sidjua-org') : '#sidjua-org';
  var refreshInterval = parseInt(scriptTag ? (scriptTag.getAttribute('data-refresh') || '5000') : '5000', 10);

  if (!apiBase) {
    console.error('[Glasscheibe] Missing data-api attribute on script tag');
    return;
  }

  // ---- Scoped CSS injection ---------------------------------------------
  var WIDGET_CSS = [
    '.sjg-container {',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  background: #0a0a0f;',
    '  color: #e0e0e8;',
    '  border-radius: 12px;',
    '  padding: 24px;',
    '  overflow-x: auto;',
    '}',
    '.sjg-header {',
    '  text-align: center;',
    '  margin-bottom: 24px;',
    '  padding-bottom: 16px;',
    '  border-bottom: 1px solid rgba(255,255,255,0.08);',
    '}',
    '.sjg-header h2 {',
    '  margin: 0 0 4px 0;',
    '  font-size: 18px;',
    '  font-weight: 600;',
    '  color: #f0f0f8;',
    '}',
    '.sjg-subtitle { font-size: 12px; color: #888; }',
    '.sjg-tree { display: flex; flex-direction: column; align-items: center; gap: 16px; }',
    '.sjg-level { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; width: 100%; }',
    '.sjg-division {',
    '  background: #10101a;',
    '  border: 1px solid rgba(255,255,255,0.05);',
    '  border-radius: 10px;',
    '  padding: 12px 14px 10px;',
    '  min-width: 200px;',
    '}',
    '.sjg-div-label {',
    '  font-size: 10px;',
    '  font-weight: 600;',
    '  text-transform: uppercase;',
    '  letter-spacing: 0.08em;',
    '  color: #5a5a7a;',
    '  margin-bottom: 10px;',
    '}',
    '.sjg-agents { display: flex; flex-direction: column; gap: 8px; }',
    '.sjg-card {',
    '  background: #14141f;',
    '  border: 1px solid rgba(255,255,255,0.06);',
    '  border-radius: 8px;',
    '  padding: 12px 14px;',
    '  transition: border-color 0.2s;',
    '}',
    '.sjg-card:hover { border-color: rgba(100,120,255,0.3); }',
    '.sjg-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }',
    '.sjg-led { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }',
    '.sjg-led-active  { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); animation: sjg-pulse 2s infinite; }',
    '.sjg-led-stopped { background: #555; }',
    '.sjg-led-error   { background: #ef4444; }',
    '.sjg-led-offline { background: #3b3b50; }',
    '@keyframes sjg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }',
    '.sjg-name { font-size: 13px; font-weight: 600; color: #f0f0f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.sjg-role { font-size: 11px; color: #6b6b8a; margin-top: 1px; }',
    '.sjg-connector { width: 1px; height: 14px; background: rgba(255,255,255,0.08); margin: 0 auto; }',
    '.sjg-error { text-align: center; padding: 32px; color: #888; font-size: 13px; }',
    '.sjg-loading { text-align: center; padding: 32px; color: #555; font-size: 13px; }',
    '@media (max-width: 640px) {',
    '  .sjg-level { flex-direction: column; align-items: stretch; }',
    '  .sjg-division { min-width: 0; }',
    '}',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('sjg-styles')) return;
    var style = document.createElement('style');
    style.id = 'sjg-styles';
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
  }

  // ---- HTML escaping (XSS prevention) -----------------------------------
  function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str == null ? '' : str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Rendering --------------------------------------------------------

  function agentStatusClass(active) {
    return active ? 'sjg-led-active' : 'sjg-led-offline';
  }

  function renderCard(agent) {
    var statusClass = agentStatusClass(agent.active);
    var html = '';
    html += '<div class="sjg-card" data-agent-id="' + escapeHtml(agent.id) + '">';
    html += '<div class="sjg-card-header">';
    html += '<div class="sjg-led ' + statusClass + '"></div>';
    html += '<span class="sjg-name">' + escapeHtml(agent.name) + '</span>';
    html += '</div>';
    if (agent.role_title) {
      html += '<div class="sjg-role">' + escapeHtml(agent.role_title) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderDivision(node) {
    var html = '';
    html += '<div class="sjg-division">';
    html += '<div class="sjg-div-label">' + escapeHtml(node.name) + '</div>';
    if (node.agents && node.agents.length > 0) {
      html += '<div class="sjg-agents">';
      for (var i = 0; i < node.agents.length; i++) {
        html += renderCard(node.agents[i]);
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function collectLevels(nodes, depth, levels) {
    if (!nodes || nodes.length === 0) return;
    if (!levels[depth]) levels[depth] = [];
    for (var i = 0; i < nodes.length; i++) {
      levels[depth].push(nodes[i]);
      if (nodes[i].children && nodes[i].children.length > 0) {
        collectLevels(nodes[i].children, depth + 1, levels);
      }
    }
  }

  function renderTree(container, tree) {
    if (!tree || !tree.roots || tree.roots.length === 0) {
      container.innerHTML = '<div class="sjg-container"><div class="sjg-error">No org chart data available</div></div>';
      return;
    }

    var levels = [];
    collectLevels(tree.roots, 0, levels);

    var html = '<div class="sjg-container">';
    html += '<div class="sjg-header">';
    html += '<h2>Company Overview</h2>';
    html += '<span class="sjg-subtitle">Live agent status</span>';
    html += '</div>';
    html += '<div class="sjg-tree">';

    for (var i = 0; i < levels.length; i++) {
      if (i > 0) html += '<div class="sjg-connector"></div>';
      html += '<div class="sjg-level">';
      for (var j = 0; j < levels[i].length; j++) {
        html += renderDivision(levels[i][j]);
      }
      html += '</div>';
    }

    html += '</div></div>';
    container.innerHTML = html;
  }

  // ---- In-place status update (no full re-render) -----------------------

  function sseStatusToLedClass(eventType) {
    if (eventType === 'agent:started' || eventType === 'agent:restarted') return 'sjg-led-active';
    if (eventType === 'agent:crashed')  return 'sjg-led-error';
    if (eventType === 'agent:stopped')  return 'sjg-led-stopped';
    return 'sjg-led-offline';
  }

  function updateAgentCard(container, agentId, ledClass) {
    if (!CSS || !CSS.escape) return; // very old browsers — skip in-place update
    var card = container.querySelector('[data-agent-id="' + CSS.escape(agentId) + '"]');
    if (!card) return;
    var led = card.querySelector('.sjg-led');
    if (!led) return;
    led.className = 'sjg-led ' + ledClass;
  }

  // ---- Data fetching ----------------------------------------------------

  function fetchOrgChart(callback) {
    fetch(apiBase + '/api/v1/org/public', { mode: 'cors' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(callback)
      .catch(function(err) {
        console.warn('[Glasscheibe] Fetch failed:', err.message);
        callback(null);
      });
  }

  // ---- SSE connection with polling fallback ----------------------------

  function connectSSE(container) {
    var sseUrl = apiBase + '/api/v1/org/public/live';
    var es = null;
    var fallbackTimer = null;

    function handleEvent(e) {
      var eventType = e.type; // e.g. 'agent:started'
      var data;
      try {
        data = JSON.parse(e.data);
      } catch (_parseErr) {
        return; // malformed event — skip
      }
      if (data && typeof data.agentId === 'string') {
        updateAgentCard(container, data.agentId, sseStatusToLedClass(eventType));
      }
    }

    function startSSE() {
      try {
        es = new EventSource(sseUrl);
      } catch (_initErr) {
        startPolling();
        return;
      }

      es.addEventListener('agent:started',   handleEvent);
      es.addEventListener('agent:stopped',   handleEvent);
      es.addEventListener('agent:crashed',   handleEvent);
      es.addEventListener('agent:restarted', handleEvent);

      es.onerror = function() {
        if (es) { es.close(); es = null; }
        console.warn('[Glasscheibe] SSE disconnected, falling back to polling');
        startPolling();
      };
    }

    function startPolling() {
      if (fallbackTimer !== null) return;
      fallbackTimer = setInterval(function() {
        fetchOrgChart(function(tree) {
          if (tree) renderTree(container, tree);
        });
      }, refreshInterval);

      // Attempt SSE reconnect after 30s
      setTimeout(function retrySSE() {
        if (es !== null) return;
        try {
          startSSE();
        } catch (_retryErr) {
          // Will retry again
        }
        if (fallbackTimer !== null) setTimeout(retrySSE, 30000);
      }, 30000);
    }

    startSSE();
  }

  // ---- Initialization --------------------------------------------------

  function init() {
    injectCSS();

    var container = document.querySelector(targetSelector);
    if (!container) {
      console.error('[Glasscheibe] Target element not found: ' + targetSelector);
      return;
    }

    container.innerHTML = '<div class="sjg-container"><div class="sjg-loading">Loading\u2026</div></div>';

    fetchOrgChart(function(tree) {
      if (tree) {
        renderTree(container, tree);
        connectSSE(container);
      } else {
        container.innerHTML = '<div class="sjg-container"><div class="sjg-error">Could not load org chart</div></div>';
        setTimeout(function() { init(); }, 10000);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
