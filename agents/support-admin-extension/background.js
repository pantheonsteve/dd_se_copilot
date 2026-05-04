// background.js — service worker
// Responsibilities:
//   1. Open side panel when extension icon clicked
//   2. Capture full-page screenshots (auto-picks strategy, see screenshot.js)
//   3. Route all AI calls through SE Copilot backend (single auditable chokepoint)

import { captureFullPage } from './screenshot.js';

const DEFAULT_API_ROOT = 'http://localhost:5070';

/** @returns {Promise<string>} e.g. http://localhost:5070/api/sac */
async function getSacBase() {
  const { sacApiRoot } = await chrome.storage.local.get({ sacApiRoot: DEFAULT_API_ROOT });
  const root = String(sacApiRoot || DEFAULT_API_ROOT).replace(/\/$/, '');
  return `${root}/api/sac`;
}

const ALLOWED_HOSTS_PATTERN =
  /^https:\/\/[^/]*\.(datadoghq\.com|datadoghq\.eu|datad0g\.com)\//;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'CAPTURE_FULL_PAGE') {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!ALLOWED_HOSTS_PATTERN.test(tab.url || '')) {
          throw new Error(`Screenshots restricted to Datadog domains. Current: ${tab.url}`);
        }
        const result = await captureFullPage(msg.tabId, { strategy: msg.strategy || 'auto' });
        sendResponse({ ok: true, ...result });
      } else if (msg.type === 'CAPTURE_VIEWPORT') {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        sendResponse({ ok: true, dataUrl, strategy: 'viewport' });
      } else if (msg.type === 'ANALYZE') {
        const result = await callBackend('/analyze', msg.payload);
        sendResponse({ ok: true, ...result });
      } else if (msg.type === 'GENERATE_REPORT') {
        const result = await callBackend('/report', msg.payload);
        sendResponse({ ok: true, ...result });
      } else if (msg.type === 'GET_CONTEXT') {
        const result = await callBackend('/context', msg.payload);
        sendResponse({ ok: true, ...result });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[bg]', msg.type, e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

async function callBackend(path, payload) {
  const base = await getSacBase();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Backend ${path} ${res.status}: ${text}`);
  }
  return res.json();
}
