// Content script to detect URL changes
let lastUrl = location.href;

// Helper to send URL update with debouncing
let urlUpdateTimeout = null;
function sendUrlUpdate(url) {
  // Debounce rapid URL changes (e.g., during SPA routing)
  if (urlUpdateTimeout) {
    clearTimeout(urlUpdateTimeout);
  }
  urlUpdateTimeout = setTimeout(() => {
    if (url !== lastUrl) {
      console.log('[DemoBuddy Content] URL changed:', lastUrl, '->', url);
      lastUrl = url;
      chrome.runtime.sendMessage({
        type: 'URL_CHANGED',
        url: url
      }).catch(() => {
        // Extension might not be ready, ignore
      });
    }
  }, 50);
}

// Send initial URL
chrome.runtime.sendMessage({
  type: 'URL_CHANGED',
  url: location.href
}).catch(() => {
  // Extension might not be ready, ignore
});

// Intercept history.pushState for SPA navigation detection
const originalPushState = history.pushState;
history.pushState = function(...args) {
  originalPushState.apply(this, args);
  sendUrlUpdate(location.href);
};

// Intercept history.replaceState for SPA navigation detection
const originalReplaceState = history.replaceState;
history.replaceState = function(...args) {
  originalReplaceState.apply(this, args);
  sendUrlUpdate(location.href);
};

// Detect URL changes via MutationObserver (fallback for SPAs like Datadog)
const observer = new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    sendUrlUpdate(currentUrl);
  }
});

// Observe the document for changes
observer.observe(document, {
  subtree: true,
  childList: true
});

// Listen for popstate events (back/forward navigation)
window.addEventListener('popstate', () => {
  sendUrlUpdate(location.href);
});

// Listen for hashchange events (hash-based routing)
window.addEventListener('hashchange', () => {
  sendUrlUpdate(location.href);
});

// Periodic check as ultimate fallback (every 2 seconds)
setInterval(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    console.log('[DemoBuddy Content] Periodic check caught URL change');
    sendUrlUpdate(currentUrl);
  }
}, 2000);
