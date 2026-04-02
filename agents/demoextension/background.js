// Background service worker
importScripts('screenshot-service.js');

let popupWindowId = null;
let screenshotService = null;
let initialTabUrl = null; // Store the URL of the tab that was active when popup was opened
let currentActiveBrowserWindowId = chrome.windows.WINDOW_ID_NONE; // Track the currently focused browser window
let currentActiveTabId = null; // Track the currently active tab ID for screenshot capture

// Helper function to check if URL is a valid browser URL (not extension internal)
function isValidBrowserUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('edge://')) return false;
  if (url.startsWith('moz-extension://')) return false;
  return true;
}

// Helper to send URL update to popup
function sendUrlUpdate(url) {
  if (!isValidBrowserUrl(url)) {
    console.log('[Background] Ignoring internal URL:', url);
    return;
  }
  console.log('[Background] Sending URL update:', url);
  chrome.runtime.sendMessage({
    type: 'UPDATE_URL',
    url: url
  }).catch(() => {
    // Popup might not be ready, that's okay
  });
}

// Initialize screenshot service
try {
  screenshotService = new ScreenshotService();
} catch (error) {
  console.error('Failed to initialize screenshot service:', error);
}

// Open popup window when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  // Store the URL and tab ID of the tab where the extension icon was clicked
  if (tab && tab.url && isValidBrowserUrl(tab.url)) {
    initialTabUrl = tab.url;
    currentActiveBrowserWindowId = tab.windowId; // Track this window as the active browser window
    currentActiveTabId = tab.id; // Track the tab ID for screenshot capture
    console.log('[Background] Extension clicked from tab:', tab.id, initialTabUrl);
  }
  
  // Check if popup window already exists
  if (popupWindowId !== null) {
    try {
      const window = await chrome.windows.get(popupWindowId);
      // Window exists, focus it and send the current tab URL
      chrome.windows.update(popupWindowId, { focused: true });
      if (initialTabUrl) {
        sendUrlUpdate(initialTabUrl);
      }
      return;
    } catch (error) {
      // Window was closed, create a new one
      popupWindowId = null;
    }
  }

  // Create new popup window
  const window = await chrome.windows.create({
    url: chrome.runtime.getURL('sidepanel.html'),
    type: 'popup',
    width: 400,
    height: 600,
    left: 100,
    top: 100
  });
  
  popupWindowId = window.id;
});

// Listen for window removal to clear the stored window ID
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'URL_CHANGED') {
    // Forward URL changes to the popup window
    if (popupWindowId !== null) {
      sendUrlUpdate(message.url);
    }
  }

  // Handle navigation request from popup (for demo flow)
  if (message.type === 'NAVIGATE_TAB') {
    (async () => {
      try {
        // Navigate the active tab in the current browser window
        if (currentActiveBrowserWindowId !== chrome.windows.WINDOW_ID_NONE) {
          const [activeTab] = await chrome.tabs.query({ 
            active: true, 
            windowId: currentActiveBrowserWindowId 
          });
          if (activeTab) {
            await chrome.tabs.update(activeTab.id, { url: message.url });
            sendResponse({ success: true });
            return;
          }
        }
        // Fallback: try any focused normal window
        const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
        for (const win of windows) {
          if (win.focused) {
            const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
            if (activeTab) {
              await chrome.tabs.update(activeTab.id, { url: message.url });
              sendResponse({ success: true });
              return;
            }
          }
        }
        sendResponse({ success: false, error: 'No active tab found' });
      } catch (error) {
        console.error('[Background] Navigation error:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async
  }
  
  // Handle request for the initial URL (from popup when it first loads)
  if (message.type === 'GET_INITIAL_URL') {
    console.log('[Background] Popup requesting initial URL:', initialTabUrl);
    if (initialTabUrl && isValidBrowserUrl(initialTabUrl)) {
      sendResponse({ url: initialTabUrl });
    } else {
      // Fallback: try to get the active tab from the last focused normal window
      (async () => {
        try {
          const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
          for (const win of windows) {
            if (win.focused || windows.length === 1) {
              const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
              if (activeTab && activeTab.url && isValidBrowserUrl(activeTab.url)) {
                sendResponse({ url: activeTab.url });
                return;
              }
            }
          }
          sendResponse({ url: null });
        } catch (error) {
          console.error('[Background] Error getting initial URL:', error);
          sendResponse({ url: null });
        }
      })();
      return true; // Keep message channel open for async response
    }
  }

  // Handle request for the tracked tab (for screenshot capture)
  if (message.type === 'GET_TRACKED_TAB') {
    console.log('[Background] Popup requesting tracked tab, tabId:', currentActiveTabId, 'windowId:', currentActiveBrowserWindowId);
    (async () => {
      try {
        // Try to get the tracked tab first
        if (currentActiveTabId) {
          try {
            const tab = await chrome.tabs.get(currentActiveTabId);
            if (tab && tab.url && isValidBrowserUrl(tab.url)) {
              console.log('[Background] Returning tracked tab:', tab.id, tab.url);
              sendResponse({ tab: tab });
              return;
            }
          } catch (e) {
            console.log('[Background] Tracked tab no longer exists');
          }
        }
        
        // Fallback: get the active tab from the tracked window or any normal window
        if (currentActiveBrowserWindowId !== chrome.windows.WINDOW_ID_NONE) {
          const [activeTab] = await chrome.tabs.query({ active: true, windowId: currentActiveBrowserWindowId });
          if (activeTab && activeTab.url && isValidBrowserUrl(activeTab.url)) {
            console.log('[Background] Returning active tab from tracked window:', activeTab.id, activeTab.url);
            sendResponse({ tab: activeTab });
            return;
          }
        }
        
        // Ultimate fallback: find any active tab in a normal window
        const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
        for (const win of windows) {
          if (win.id !== popupWindowId) {
            const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
            if (activeTab && activeTab.url && isValidBrowserUrl(activeTab.url)) {
              console.log('[Background] Returning active tab from any window:', activeTab.id, activeTab.url);
              sendResponse({ tab: activeTab });
              return;
            }
          }
        }
        
        sendResponse({ tab: null });
      } catch (error) {
        console.error('[Background] Error getting tracked tab:', error);
        sendResponse({ tab: null });
      }
    })();
    return true; // Keep message channel open for async response
  }

  // Forward offscreen document messages (these come from screenshot-service via popup)
  if (message.type === 'STITCH_SCREENSHOTS' || message.type === 'RESIZE_IMAGE') {
    // Let the offscreen document handle these - don't process here
    // Return false to allow message to propagate to other listeners (offscreen doc)
    return false;
  }

  if (message.type === 'CAPTURE_SCREENSHOT') {
    // Handle screenshot capture request
    const fullPage = message.fullPage !== false; // Default to full page
    
    handleScreenshotCapture(message.tabId, fullPage, (progress) => {
      // Send progress updates to the popup
      chrome.runtime.sendMessage({
        type: 'SCREENSHOT_PROGRESS',
        ...progress
      }).catch(() => {
        // Popup might not be listening
      });
    })
      .then(dataUrl => {
        sendResponse({ success: true, dataUrl: dataUrl });
      })
      .catch(error => {
        console.error('Screenshot capture error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.type === 'NAVIGATE_TAB') {
    // Handle navigation request - navigate the active tab to a new URL
    handleNavigateTab(message.url)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Navigation error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }
});

// Navigation handler - navigate the active tab to a new URL
async function handleNavigateTab(url) {
  try {
    // Get the active tab in the last focused window (excluding the popup)
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    
    // Find the most recently focused normal window
    let targetWindow = null;
    for (const win of windows) {
      if (win.id !== popupWindowId && win.focused) {
        targetWindow = win;
        break;
      }
    }
    
    // If no focused window, just get the first normal window
    if (!targetWindow) {
      targetWindow = windows.find(w => w.id !== popupWindowId);
    }
    
    if (!targetWindow) {
      throw new Error('No browser window found');
    }
    
    // Get the active tab in that window
    const [activeTab] = await chrome.tabs.query({ 
      active: true, 
      windowId: targetWindow.id 
    });
    
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    
    // Navigate the tab
    await chrome.tabs.update(activeTab.id, { url: url });
    
    return { success: true };
  } catch (error) {
    console.error('Error in handleNavigateTab:', error);
    throw error;
  }
}

// Screenshot capture handler
async function handleScreenshotCapture(tabId, fullPage = true, onProgress = null) {
  try {
    console.log(`[Background] handleScreenshotCapture called - tabId: ${tabId}, fullPage: ${fullPage}`);
    
    if (!screenshotService) {
      console.log('[Background] Creating new ScreenshotService instance');
      screenshotService = new ScreenshotService();
    }
    
    // Get the tab to find its window
    const tab = await chrome.tabs.get(tabId);
    console.log('[Background] Tab info:', tab.id, 'windowId:', tab.windowId, 'url:', tab.url?.substring(0, 60));
    
    // IMPORTANT: Focus the browser window containing the tab
    // This ensures the content is rendered and visible for capture
    console.log('[Background] Focusing window:', tab.windowId);
    await chrome.windows.update(tab.windowId, { focused: true });
    
    // Make sure the tab is active in its window
    // (captureVisibleTab captures the active tab in the specified window)
    console.log('[Background] Activating tab:', tabId);
    await chrome.tabs.update(tabId, { active: true });
    
    // Longer delay to ensure window is focused and tab content is rendered
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Use the screenshot service to capture
    let dataUrl;
    if (fullPage) {
      console.log('[Background] Starting FULL PAGE capture...');
      dataUrl = await screenshotService.captureFullPage(tabId, onProgress);
      console.log('[Background] Full page capture returned, dataUrl length:', dataUrl?.length);
    } else {
      console.log('[Background] Starting viewport-only capture...');
      dataUrl = await screenshotService.captureViewport(tabId);
    }
    
    return dataUrl;
  } catch (error) {
    console.error('[Background] Error in handleScreenshotCapture:', error);
    throw error;
  }
}

// Listen for active tab changes to update the popup
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    // Only update if the tab activation is in a normal browser window, not the popup
    const tabWindow = await chrome.windows.get(activeInfo.windowId);
    if (tabWindow.type !== 'normal') {
      return; // Ignore tab changes in popup windows
    }
    
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && isValidBrowserUrl(tab.url)) {
      // Always track the current tab URL and ID
      initialTabUrl = tab.url;
      currentActiveTabId = tab.id;
      currentActiveBrowserWindowId = activeInfo.windowId;
      console.log('[Background] Tab activated, tracking:', tab.id, initialTabUrl);
      
      // Send update to popup if it exists
      if (popupWindowId !== null) {
        sendUrlUpdate(tab.url);
      }
    }
  } catch (error) {
    // Tab or window might not be accessible, that's okay
  }
});

// Listen for window focus changes to update the popup when switching windows
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE && windowId !== popupWindowId) {
    try {
      const focusedWindow = await chrome.windows.get(windowId);
      if (focusedWindow.type === 'normal') {
        // Track this as the current active browser window
        currentActiveBrowserWindowId = windowId;
        
        // Get the active tab in the newly focused window
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: windowId });
        if (activeTab && activeTab.url && isValidBrowserUrl(activeTab.url)) {
          // Update the tracked URL and tab ID to this window's active tab
          initialTabUrl = activeTab.url;
          currentActiveTabId = activeTab.id;
          console.log('[Background] Window focus changed, tracking:', activeTab.id, initialTabUrl);
          
          // Send update to popup if it exists
          if (popupWindowId !== null) {
            sendUrlUpdate(activeTab.url);
          }
        }
      }
    } catch (error) {
      // Window not accessible, ignore
    }
  }
});

// Listen for tab updates (URL changes) to update the popup
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && isValidBrowserUrl(changeInfo.url)) {
    // Check if this tab is in a normal browser window (not the popup)
    // and is the active tab in its window
    try {
      const tabWindow = await chrome.windows.get(tab.windowId);
      if (tabWindow.type === 'normal' && tab.active) {
        // Track the new URL
        initialTabUrl = changeInfo.url;
        console.log('[Background] Tab URL changed, tracking:', initialTabUrl);
        
        // Send update to popup if it exists
        if (popupWindowId !== null) {
          sendUrlUpdate(changeInfo.url);
        }
      }
    } catch (error) {
      // Window not accessible, ignore
    }
  }
});
