/**
 * Support Admin Copilot — chat-first side panel.
 */

import { ensureSacContentScript } from './inject-helper.js';

const DEFAULT_API_ROOT = 'http://localhost:5070';

/** @type {Record<string, HTMLElement | null>} */
const el = {};

/** Last capture + context */
let lastImageDataUrl = null;
let lastPageContext = null;
/** For report */
let sessionObservations = [];
/** Backend history */
let sessionHistory = [];
/** Last generated report markdown (for PDF + re-render) */
let lastReportMarkdown = '';

/**
 * Render markdown to sanitized HTML (marked + DOMPurify loaded before this module).
 * @param {string} md
 * @returns {string}
 */
function renderMarkdownToSafeHtml(md) {
  const markedLib = globalThis.marked;
  const purify = globalThis.DOMPurify;
  const text = md ?? '';
  if (!markedLib?.parse || !purify?.sanitize) {
    const esc = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre class="md-fallback">${esc}</pre>`;
  }
  const raw = markedLib.parse(text, { breaks: true, gfm: true });
  return purify.sanitize(raw, { USE_PROFILES: { html: true } });
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ` ${kind}` : '');
}

function isDatadogUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h.endsWith('.datadoghq.com') ||
      h.endsWith('.datadoghq.eu') ||
      h.endsWith('.datad0g.com')
    );
  } catch {
    return false;
  }
}

async function getApiRoot() {
  const { sacApiRoot } = await chrome.storage.local.get({ sacApiRoot: DEFAULT_API_ROOT });
  return sacApiRoot || DEFAULT_API_ROOT;
}

async function getTargetTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let t = tabs[0];
  if (!t) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    t = tabs[0];
  }
  return t;
}

async function refreshTabLine() {
  try {
    const tab = await getTargetTab();
    if (!tab?.url) {
      el.tabInfo.textContent = 'No active tab.';
      return null;
    }
    const ok = isDatadogUrl(tab.url);
    el.tabInfo.textContent = ok
      ? `Active: ${tab.title || '(untitled)'}`
      : `Active tab is not Datadog (${new URL(tab.url).hostname}). Open app.datadoghq.com or app.datad0g.com.`;
    return ok ? tab : null;
  } catch (e) {
    el.tabInfo.textContent = String(e.message || e);
    return null;
  }
}

async function sendBg(message, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res) {
            reject(new Error('No response from background'));
            return;
          }
          if (!res.ok) {
            reject(new Error(res.error || 'Request failed'));
            return;
          }
          resolve(res);
        });
      });
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const transient =
        /Receiving end|Could not establish connection/i.test(msg);
      if (transient && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sendTab(tabId, message) {
  await ensureSacContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res?.ok) {
        reject(new Error('Content script did not respond. Reload the Datadog tab.'));
        return;
      }
      resolve(res);
    });
  });
}

async function checkBackendHealth() {
  const root = await getApiRoot();
  try {
    const r = await fetch(`${root}/api/health`, { method: 'GET' });
    if (!r.ok) {
      setStatus(`SE Copilot not ready (${r.status} at ${root}). Start ./start_all.sh or se-copilot.`, 'err');
      return false;
    }
    setStatus(`Connected to SE Copilot at ${root}`, 'ok');
    return true;
  } catch {
    setStatus(`Cannot reach ${root}. Start SE Copilot (default port 5070).`, 'err');
    return false;
  }
}

function scrollChatToBottom() {
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function appendUserMessage(text, { usedImage = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = usedImage ? 'You (with screenshot)' : 'You';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.appendChild(role);
  wrap.appendChild(body);
  el.chatLog.appendChild(wrap);
  scrollChatToBottom();
}

function appendAssistantMessage(text, { observations = [], next_steps = [] } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Copilot';
  const body = document.createElement('div');
  body.className = 'msg-body md-chat';
  body.innerHTML = renderMarkdownToSafeHtml(text || '(empty response)');
  wrap.appendChild(role);
  wrap.appendChild(body);

  if (next_steps.length) {
    const sub = document.createElement('div');
    sub.className = 'msg-sub';
    const h = document.createElement('h3');
    h.textContent = 'Suggested next steps';
    sub.appendChild(h);
    const ul = document.createElement('ul');
    next_steps.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    });
    sub.appendChild(ul);
    wrap.appendChild(sub);
  }

  if (observations.length) {
    const sub = document.createElement('div');
    sub.className = 'msg-sub';
    const h = document.createElement('h3');
    h.textContent = 'Observations (for report)';
    sub.appendChild(h);
    const ul = document.createElement('ul');
    observations.forEach((o) => {
      const li = document.createElement('li');
      li.textContent = o;
      ul.appendChild(li);
    });
    sub.appendChild(ul);
    wrap.appendChild(sub);
  }

  el.chatLog.appendChild(wrap);
  scrollChatToBottom();
}

function appendSystemMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-system';
  wrap.textContent = text;
  el.chatLog.appendChild(wrap);
  scrollChatToBottom();
}

function updateCaptureBadge() {
  if (lastImageDataUrl) {
    el.captureBadge.classList.remove('hidden');
  } else {
    el.captureBadge.classList.add('hidden');
  }
}

function showPreview(dataUrl) {
  lastImageDataUrl = dataUrl;
  el.preview.classList.remove('hidden');
  el.preview.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Last capture';
  el.preview.appendChild(img);
  updateCaptureBadge();
}

function setBusy(busy) {
  [
    el.btnViewport,
    el.btnFullPage,
    el.btnContext,
    el.btnSend,
    el.btnReport,
    el.btnDownloadPdf,
    el.btnNewChat,
    el.chatInput,
  ].forEach((b) => {
    if (b) b.disabled = busy;
  });
}

async function onCaptureViewport() {
  const tab = await getTargetTab();
  if (!tab?.id || !isDatadogUrl(tab.url)) {
    setStatus('Open a Datadog app tab first.', 'err');
    return;
  }
  setBusy(true);
  setStatus('Capturing viewport…');
  try {
    const res = await sendBg({ type: 'CAPTURE_VIEWPORT' });
    showPreview(res.dataUrl);
    const ctxRes = await sendTab(tab.id, { type: 'GET_PAGE_CONTEXT' });
    lastPageContext = ctxRes.context;
    setStatus(
      'Viewport captured. Enable “Include last screenshot in reply” to send it with your next message.',
      'ok'
    );
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function onCaptureFullPage() {
  const tab = await getTargetTab();
  if (!tab?.id || !isDatadogUrl(tab.url)) {
    setStatus('Open a Datadog app tab first.', 'err');
    return;
  }
  setBusy(true);
  setStatus('Full-page capture (may take 10–30s on tall pages)…');
  try {
    const res = await sendBg({ type: 'CAPTURE_FULL_PAGE', tabId: tab.id, strategy: 'auto' });
    showPreview(res.dataUrl);
    const ctxRes = await sendTab(tab.id, { type: 'GET_PAGE_CONTEXT' });
    lastPageContext = ctxRes.context;
    setStatus(
      `Captured (${res.strategy || 'ok'}). Enable “Include last screenshot in reply” to attach it.`,
      'ok'
    );
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function sendChatMessage() {
  const tab = await getTargetTab();
  if (!tab?.id || !isDatadogUrl(tab.url)) {
    setStatus('Open a Datadog app tab first.', 'err');
    return;
  }

  const prompt = el.chatInput.value.trim();
  if (!prompt) {
    setStatus('Type a message first.', 'err');
    return;
  }

  const wantImage = el.includeScreenshot.checked && !!lastImageDataUrl;
  if (el.includeScreenshot.checked && !lastImageDataUrl) {
    setStatus('No screenshot to attach — sending text and page context only.', '');
  }

  setBusy(true);
  setStatus('Thinking…');

  let ctxRes;
  try {
    ctxRes = await sendTab(tab.id, { type: 'GET_PAGE_CONTEXT' });
    lastPageContext = ctxRes.context;
  } catch (e) {
    setStatus(String(e.message || e), 'err');
    setBusy(false);
    return;
  }

  const payload = {
    prompt,
    image: wantImage ? lastImageDataUrl : undefined,
    pageContext: lastPageContext,
    history: sessionHistory.map((h) => ({
      role: h.role,
      content: h.content,
      hasImage: !!h.hasImage,
    })),
  };

  appendUserMessage(prompt, { usedImage: wantImage });

  try {
    const res = await sendBg({ type: 'ANALYZE', payload });
    const text = res.text || '';
    const obs = res.observations || [];
    const nextSteps = res.next_steps || [];

    appendAssistantMessage(text, { observations: obs, next_steps: nextSteps });
    if (obs.length) sessionObservations.push(...obs);

    sessionHistory.push({ role: 'user', content: prompt, hasImage: wantImage });
    sessionHistory.push({ role: 'assistant', content: text, hasImage: false });

    el.chatInput.value = '';
    setStatus('Ready.', 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
    appendSystemMessage(`Error: ${e.message || e}`);
  } finally {
    setBusy(false);
  }
}

async function onGetContext() {
  const account = el.accountName.value.trim();
  const pageType = lastPageContext?.pageType || null;
  setBusy(true);
  setStatus('Fetching grounded context…');
  try {
    const res = await sendBg({
      type: 'GET_CONTEXT',
      payload: { accountName: account || undefined, pageType },
    });
    const parts = [];
    if (res.accountContext) parts.push('Account:\n' + res.accountContext);
    if (res.productContext) parts.push('Product:\n' + res.productContext);
    const block = parts.length ? parts.join('\n\n---\n\n') : 'No extra context returned (agents may be down).';
    appendSystemMessage(`Context loaded:\n${block}`);
    setStatus('Context loaded.', 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function onReport() {
  const tab = await getTargetTab();
  if (!lastPageContext && tab?.id && isDatadogUrl(tab.url)) {
    try {
      const ctxRes = await sendTab(tab.id, { type: 'GET_PAGE_CONTEXT' });
      lastPageContext = ctxRes.context;
    } catch {
      /* ignore */
    }
  }
  const account = el.accountName.value.trim();
  setBusy(true);
  setStatus('Generating report…');
  el.reportSection.classList.remove('hidden');
  lastReportMarkdown = '';
  el.reportRendered.innerHTML = '';
  el.btnDownloadPdf.disabled = true;

  const payload = {
    observations: sessionObservations,
    history: sessionHistory.map((h) => ({
      role: h.role,
      content: h.content,
      hasImage: !!h.hasImage,
    })),
    pageContext: lastPageContext,
    accountName: account || undefined,
  };

  try {
    const res = await sendBg({ type: 'GENERATE_REPORT', payload });
    lastReportMarkdown = res.report || '';
    el.reportRendered.innerHTML = renderMarkdownToSafeHtml(
      lastReportMarkdown || '(empty)'
    );
    el.btnDownloadPdf.disabled = !lastReportMarkdown.trim();
    setStatus('Report generated.', 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function onDownloadPdf() {
  if (!lastReportMarkdown?.trim()) {
    setStatus('Generate a report first.', 'err');
    return;
  }
  const root = await getApiRoot();
  setBusy(true);
  setStatus('Building PDF…');
  try {
    const r = await fetch(`${root}/api/sac/report/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: lastReportMarkdown }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(errText || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'support-admin-report.pdf';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('PDF downloaded.', 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

function onNewChat() {
  el.chatLog.innerHTML = '';
  sessionHistory = [];
  sessionObservations = [];
  lastImageDataUrl = null;
  lastPageContext = null;
  el.preview.innerHTML = '';
  el.preview.classList.add('hidden');
  el.captureBadge.classList.add('hidden');
  el.reportSection.classList.add('hidden');
  lastReportMarkdown = '';
  el.reportRendered.innerHTML = '';
  el.btnDownloadPdf.disabled = true;
  el.chatInput.value = '';
  setStatus('New chat — capture optional; messages use live page context.', 'ok');
}

function onChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

async function loadApiRootField() {
  const root = await getApiRoot();
  if (el.apiRoot) el.apiRoot.value = root;
}

async function saveApiRootFromField() {
  if (!el.apiRoot) return;
  let v = el.apiRoot.value.trim().replace(/\/$/, '');
  if (!v.startsWith('http')) {
    v = DEFAULT_API_ROOT;
    el.apiRoot.value = v;
  }
  await chrome.storage.local.set({ sacApiRoot: v });
  await checkBackendHealth();
}

function bindElements() {
  el.status = document.getElementById('status');
  el.tabInfo = document.getElementById('tabInfo');
  el.apiRoot = document.getElementById('apiRoot');
  el.accountName = document.getElementById('accountName');
  el.btnNewChat = document.getElementById('btnNewChat');
  el.btnViewport = document.getElementById('btnViewport');
  el.btnFullPage = document.getElementById('btnFullPage');
  el.includeScreenshot = document.getElementById('includeScreenshot');
  el.btnContext = document.getElementById('btnContext');
  el.btnSend = document.getElementById('btnSend');
  el.btnReport = document.getElementById('btnReport');
  el.chatLog = document.getElementById('chatLog');
  el.chatInput = document.getElementById('chatInput');
  el.captureBadge = document.getElementById('captureBadge');
  el.preview = document.getElementById('preview');
  el.reportSection = document.getElementById('reportSection');
  el.reportRendered = document.getElementById('reportRendered');
  el.btnDownloadPdf = document.getElementById('btnDownloadPdf');
}

async function init() {
  bindElements();
  await loadApiRootField();

  el.btnNewChat.addEventListener('click', onNewChat);
  el.btnViewport.addEventListener('click', onCaptureViewport);
  el.btnFullPage.addEventListener('click', onCaptureFullPage);
  el.btnSend.addEventListener('click', sendChatMessage);
  el.btnContext.addEventListener('click', onGetContext);
  el.btnReport.addEventListener('click', onReport);
  el.btnDownloadPdf.addEventListener('click', onDownloadPdf);
  el.chatInput.addEventListener('keydown', onChatKeydown);

  if (el.apiRoot) {
    el.apiRoot.addEventListener('change', saveApiRootFromField);
    el.apiRoot.addEventListener('blur', saveApiRootFromField);
  }

  chrome.tabs.onActivated.addListener(() => {
    refreshTabLine();
  });
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete') refreshTabLine();
  });

  refreshTabLine();
  checkBackendHealth();
}

document.addEventListener('DOMContentLoaded', init);
