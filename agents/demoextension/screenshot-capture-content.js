// Content script injected for full-page screenshot capture
(function() {
  // Helper to get full page dimensions
  function getPageDimensions() {
    const body = document.body;
    const html = document.documentElement;
    
    const height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.clientHeight,
      html.scrollHeight,
      html.offsetHeight
    );
    
    const width = Math.max(
      body.scrollWidth,
      body.offsetWidth,
      html.clientWidth,
      html.scrollWidth,
      html.offsetWidth
    );
    
    return { width, height };
  }
  
  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_DIMENSIONS') {
      const dimensions = getPageDimensions();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      
      sendResponse({
        pageHeight: dimensions.height,
        pageWidth: dimensions.width,
        viewportHeight: viewportHeight,
        viewportWidth: viewportWidth
      });
      return true;
    }
    
    if (message.type === 'SCROLL_TO_POSITION') {
      window.scrollTo(0, message.position);
      
      // Wait for scroll to complete and any lazy-loaded content
      setTimeout(() => {
        sendResponse({ success: true });
      }, 200);
      
      return true;
    }
    
    if (message.type === 'RESET_SCROLL') {
      window.scrollTo(0, 0);
      sendResponse({ success: true });
      return true;
    }
  });
})();

