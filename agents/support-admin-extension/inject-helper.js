/**
 * Ensure the SAC content script is listening so chrome.tabs.sendMessage works.
 * Declarative injection sometimes misses (tab opened before install, restricted frame, etc.).
 */

export async function ensureSacContentScript(tabId) {
  const ping = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, err: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, res });
      });
    });

  let p = await ping();
  if (p.ok && p.res?.ok) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    throw new Error(
      `Cannot inject script on this tab: ${e?.message || e}. Use a Datadog app tab (not chrome:// or the Web Store).`
    );
  }

  p = await ping();
  if (p.ok && p.res?.ok) return;

  throw new Error(
    'Still no response from the page script. Reload the Datadog tab (refresh), then try again.'
  );
}
