// background.js — service worker
// Responsibilities:
//   1. Open side panel when extension icon clicked
//   2. Capture full-page screenshots (auto-picks strategy, see screenshot.js)
//   3. Route all AI calls through SE Copilot backend (single auditable chokepoint)

import { captureFullPage } from './screenshot.js';

const SE_COPILOT_BASE = 'http://localhost:5060';
const ALLOWED_HOSTS_PATTERN = /^https:\/\/[^/]*\.(datadoghq\.com|datad0g\.com)\//;

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
  const res = await fetch(`${SE_COPILOT_BASE}${path}`, {
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
