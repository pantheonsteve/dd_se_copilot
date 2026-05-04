// screenshot.js — capture strategies for Datadog pages
// Exported as a module loaded by background.js

import { ensureSacContentScript } from './inject-helper.js';

// Strategy 1: debugger API with captureBeyondViewport.
// Fast, clean, single call. Works when page uses normal document scroll.
export async function captureViaDebugger(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        dpr: window.devicePixelRatio || 1,
      })`,
      returnByValue: true,
    });
    const dims = JSON.parse(result.value);

    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: dims.width, height: dims.height, scale: 1 },
    });

    return {
      dataUrl: `data:image/png;base64,${shot.data}`,
      width: dims.width,
      height: dims.height,
      strategy: 'debugger',
    };
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}

// Strategy 2: scroll-stitch fallback.
// For pages with virtualized scroll containers (Logs Explorer, trace lists,
// long Service Catalog views) where captureBeyondViewport only catches the
// outer shell. We scroll the target container, capture the viewport, and
// ask the content script to hand us the stitching offsets.
//
// This is slower and uses chrome.tabs.captureVisibleTab, which is throttled
// to ~2 calls/sec. A tall page may take 10-20 seconds.
export async function captureViaScrollStitch(tabId, { maxHeight = 20000 } = {}) {
  // Ask content script for scroll metrics and to prep the page
  const prep = await chrome.tabs.sendMessage(tabId, { type: 'STITCH_PREP' });
  if (!prep?.ok) throw new Error('Content script did not respond to STITCH_PREP');

  const { scrollHeight, viewportHeight, dpr } = prep;
  const totalHeight = Math.min(scrollHeight, maxHeight);
  const step = Math.floor(viewportHeight * 0.9); // 10% overlap for safety

  const shots = [];
  let y = 0;
  while (y < totalHeight) {
    await chrome.tabs.sendMessage(tabId, { type: 'STITCH_SCROLL', y });
    await sleep(350); // let the virtualized list render new rows
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    shots.push({ y, dataUrl });
    y += step;
  }

  // Restore original scroll
  await chrome.tabs.sendMessage(tabId, { type: 'STITCH_RESTORE' });

  // Stitch in an OffscreenCanvas inside the service worker
  const stitched = await stitchImages(shots, totalHeight, dpr);
  return { ...stitched, strategy: 'scroll-stitch' };
}

async function stitchImages(shots, totalHeight, dpr) {
  // Load each data URL as an ImageBitmap
  const bitmaps = await Promise.all(shots.map(async (s) => {
    const blob = await (await fetch(s.dataUrl)).blob();
    return { y: s.y, bmp: await createImageBitmap(blob) };
  }));

  const width = bitmaps[0].bmp.width;
  const heightPx = Math.ceil(totalHeight * dpr);

  const canvas = new OffscreenCanvas(width, heightPx);
  const ctx = canvas.getContext('2d');

  for (const { y, bmp } of bitmaps) {
    // Draw each capture at its corresponding y offset in device pixels.
    ctx.drawImage(bmp, 0, y * dpr);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: Math.round(width / dpr), height: totalHeight };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Orchestrator: try debugger first, fall back to scroll-stitch if it looks bad.
// "Looks bad" heuristic: the debugger returned an image much shorter than the
// reported scrollHeight, suggesting a virtualized container.
export async function captureFullPage(tabId, { strategy = 'auto' } = {}) {
  await ensureSacContentScript(tabId);
  if (strategy === 'scroll-stitch') return captureViaScrollStitch(tabId);
  if (strategy === 'debugger') return captureViaDebugger(tabId);

  // auto
  try {
    const result = await captureViaDebugger(tabId);
    // Sanity check — if result height < half of reported scrollHeight, fall back
    const prep = await chrome.tabs.sendMessage(tabId, { type: 'STITCH_PREP' });
    if (prep?.ok && result.height < prep.scrollHeight * 0.5) {
      console.warn('[sac] debugger capture looks truncated, falling back to stitch');
      return captureViaScrollStitch(tabId);
    }
    return result;
  } catch (e) {
    console.warn('[sac] debugger capture failed, trying scroll-stitch:', e);
    return captureViaScrollStitch(tabId);
  }
}
