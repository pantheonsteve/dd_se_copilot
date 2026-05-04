// content.js — runs on Datadog pages
// Responsibilities:
//   1. Extract structured page context on request (URL, page type, visible entities, filters)
//   2. Draw overlay annotations (highlights, arrows, callouts) when sidepanel requests them
//   3. NEVER initiate clicks, form submissions, or navigation — read-only observer

(function () {
  // ---------- Page context extraction ----------

  function detectPageType() {
    const path = location.pathname;
    if (path.includes('/services')) return 'service_catalog';
    if (path.includes('/monitors/manage')) return 'monitors_list';
    if (path.includes('/monitors/')) return 'monitor_detail';
    if (path.includes('/dashboard/')) return 'dashboard';
    if (path.includes('/logs')) return 'logs_explorer';
    if (path.includes('/apm/traces')) return 'trace_explorer';
    if (path.includes('/apm/services')) return 'apm_service';
    if (path.includes('/slo')) return 'slo';
    if (path.includes('/rum')) return 'rum';
    if (path.includes('/infrastructure')) return 'infrastructure';
    if (path.includes('/metric/explorer')) return 'metrics_explorer';
    return 'unknown';
  }

  // Pull visible text from likely "entity" rows — generic DOM scraping
  // that doesn't depend on Datadog's specific class names (which change).
  function extractVisibleEntities() {
    const rows = [];
    const candidates = document.querySelectorAll('[role="row"], [data-testid*="row"], tr');
    for (const el of candidates) {
      const text = (el.innerText || '').trim();
      if (text && text.length < 500 && text.length > 3) {
        rows.push(text.replace(/\s+/g, ' '));
      }
      if (rows.length >= 100) break;
    }
    return rows;
  }

  function extractActiveFilters() {
    // Datadog uses chip/tag-style filter elements; capture their text
    const filters = [];
    const chips = document.querySelectorAll(
      '[data-testid*="filter"], [class*="chip"], [class*="Chip"], [class*="tag-facet"]'
    );
    for (const c of chips) {
      const t = (c.innerText || '').trim();
      if (t && t.length < 200) filters.push(t.replace(/\s+/g, ' '));
    }
    return Array.from(new Set(filters)).slice(0, 50);
  }

  function extractHeadings() {
    const hs = [];
    document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach((h) => {
      const t = (h.innerText || '').trim();
      if (t) hs.push({ level: h.tagName || 'H?', text: t });
    });
    return hs.slice(0, 30);
  }

  function getPageContext() {
    return {
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      pageType: detectPageType(),
      headings: extractHeadings(),
      filters: extractActiveFilters(),
      entityRows: extractVisibleEntities(),
      capturedAt: new Date().toISOString(),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      viewportHeight: window.innerHeight,
    };
  }

  // ---------- Overlay annotations ----------

  function clearOverlays() {
    document.querySelectorAll('.sac-overlay-annotation').forEach((n) => n.remove());
  }

  function drawAnnotation({ selector, label, color = '#ff6b35' }) {
    const target = document.querySelector(selector);
    if (!target) return false;
    const rect = target.getBoundingClientRect();

    const box = document.createElement('div');
    box.className = 'sac-overlay-annotation';
    box.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 2px solid ${color};
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483646;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.05);
    `;

    const tag = document.createElement('div');
    tag.className = 'sac-overlay-annotation';
    tag.textContent = label;
    tag.style.cssText = `
      position: fixed;
      top: ${Math.max(rect.top - 28, 4)}px;
      left: ${rect.left}px;
      background: ${color};
      color: white;
      font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
      padding: 6px 8px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483647;
      max-width: 400px;
    `;
    document.body.appendChild(box);
    document.body.appendChild(tag);
    return true;
  }

  // ---------- Scroll-stitch support ----------
  // For pages with virtualized scroll containers, we scroll the main scrollable
  // ancestor and let background.js capture the viewport at each step.

  let _stitchState = null;

  function findMainScroller() {
    // Try document scrolling element first
    const docScrollable = document.scrollingElement || document.documentElement;
    if (docScrollable.scrollHeight > docScrollable.clientHeight + 50) {
      return docScrollable;
    }
    // Otherwise find the tallest overflow:auto/scroll element
    const candidates = document.querySelectorAll('*');
    let best = null, bestH = 0;
    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (!/auto|scroll/.test(style.overflowY)) continue;
      if (el.scrollHeight > el.clientHeight + 50 && el.scrollHeight > bestH) {
        best = el;
        bestH = el.scrollHeight;
      }
    }
    return best || docScrollable;
  }

  // ---------- Message handlers (single listener; avoid duplicate on reinject) ----------

  if (window.__SAC_MSG_LISTENER__) return;
  window.__SAC_MSG_LISTENER__ = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'GET_PAGE_CONTEXT') {
      sendResponse({ ok: true, context: getPageContext() });
    } else if (msg.type === 'ANNOTATE') {
      clearOverlays();
      const drawn = (msg.annotations || []).map((a) => drawAnnotation(a));
      sendResponse({ ok: true, drawn: drawn.filter(Boolean).length });
    } else if (msg.type === 'CLEAR_ANNOTATIONS') {
      clearOverlays();
      sendResponse({ ok: true });
    } else if (msg.type === 'STITCH_PREP') {
      const scroller = findMainScroller();
      _stitchState = { scroller, originalScroll: scroller.scrollTop };
      sendResponse({
        ok: true,
        scrollHeight: scroller.scrollHeight,
        viewportHeight: scroller.clientHeight || window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      });
    } else if (msg.type === 'STITCH_SCROLL') {
      if (_stitchState?.scroller) {
        _stitchState.scroller.scrollTop = msg.y;
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'STITCH_RESTORE') {
      if (_stitchState?.scroller) {
        _stitchState.scroller.scrollTop = _stitchState.originalScroll;
      }
      _stitchState = null;
      sendResponse({ ok: true });
    }
    return true;
  });
})();
