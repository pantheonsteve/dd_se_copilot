// Screenshot capture service for full-page and viewport captures
// Uses offscreen document for image stitching (DOM APIs not available in service workers)

class ScreenshotService {
  constructor() {
    this.captureQuality = 0.85;
    this.captureDelay = 400; // ms between captures (Chrome rate limit: 2/sec)
    this.offscreenDocumentPath = 'offscreen.html';
    this.hasOffscreenDocument = false;
    this.maxImageWidth = 2048; // Max width for API (keeps file size manageable)
    this.maxImageHeight = 4096; // Max height for full page
  }

  /**
   * Ensure offscreen document is created
   */
  async ensureOffscreenDocument() {
    if (this.hasOffscreenDocument) {
      return;
    }

    try {
      // Check if offscreen document already exists
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(this.offscreenDocumentPath)]
      });

      if (existingContexts.length > 0) {
        this.hasOffscreenDocument = true;
        return;
      }

      // Create offscreen document
      await chrome.offscreen.createDocument({
        url: this.offscreenDocumentPath,
        reasons: ['DOM_PARSER'], // Using DOM APIs for canvas/image manipulation
        justification: 'Stitching multiple viewport screenshots into a single full-page image'
      });

      this.hasOffscreenDocument = true;
      console.log('Offscreen document created for image stitching');
    } catch (error) {
      // Handle case where document already exists
      if (error.message.includes('Only a single offscreen')) {
        this.hasOffscreenDocument = true;
      } else {
        console.error('Failed to create offscreen document:', error);
        throw error;
      }
    }
  }

  /**
   * Close offscreen document to free resources
   */
  async closeOffscreenDocument() {
    if (!this.hasOffscreenDocument) return;

    try {
      await chrome.offscreen.closeDocument();
      this.hasOffscreenDocument = false;
      console.log('Offscreen document closed');
    } catch (error) {
      // Ignore errors if document doesn't exist
      console.log('Offscreen document close error (may not exist):', error.message);
    }
  }

  /**
   * Capture full scrolling page using offscreen document for stitching
   * @param {number} tabId - The tab ID to capture
   * @param {function} onProgress - Optional callback for progress updates
   * @returns {Promise<string>} Base64 data URL of the screenshot
   */
  async captureFullPage(tabId, onProgress = null) {
    try {
      console.log('[ScreenshotService] Starting full-page capture for tab:', tabId);

      // Get page dimensions from content script
      const dimensions = await this.getPageDimensions(tabId);
      console.log('[ScreenshotService] Page dimensions:', JSON.stringify(dimensions));
      console.log('[ScreenshotService] scrollHeight:', dimensions.scrollHeight, 'viewportHeight:', dimensions.viewportHeight);
      console.log('[ScreenshotService] Ratio:', (dimensions.scrollHeight / dimensions.viewportHeight).toFixed(2));

      // If page fits in viewport or is very short, just capture viewport
      // Using 1.1 threshold to be more aggressive about full-page captures
      if (dimensions.scrollHeight <= dimensions.viewportHeight * 1.1) {
        console.log('[ScreenshotService] Page fits in viewport (ratio <= 1.1), using single capture');
        return await this.captureViewport(tabId);
      }
      
      console.log('[ScreenshotService] Page requires scrolling capture');

      // Ensure offscreen document is ready
      await this.ensureOffscreenDocument();

      // Calculate number of captures needed
      const viewportHeight = dimensions.viewportHeight;
      const viewportWidth = dimensions.viewportWidth;
      const totalHeight = dimensions.scrollHeight;
      const numCaptures = Math.ceil(totalHeight / viewportHeight);

      console.log(`[ScreenshotService] Full-page capture: ${numCaptures} viewports needed`);
      console.log(`[ScreenshotService] Viewport: ${viewportWidth}x${viewportHeight}, Total height: ${totalHeight}`);

      // Prepare scroll options for container-based scrolling
      const scrollOptions = {
        useContainer: dimensions.useContainer,
        containerId: dimensions.containerId
      };
      
      console.log(`[ScreenshotService] Scroll mode: ${dimensions.useContainer ? 'container' : 'window'}${dimensions.containerId ? ` (${dimensions.containerId})` : ''}`);

      // Capture each viewport section
      const screenshots = [];
      for (let i = 0; i < numCaptures; i++) {
        const yOffset = i * viewportHeight;
        const isLastCapture = i === numCaptures - 1;
        
        console.log(`[ScreenshotService] Capturing section ${i + 1}/${numCaptures} at yOffset: ${yOffset}`);
        
        // Report progress
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: numCaptures,
            message: `Capturing section ${i + 1} of ${numCaptures}...`
          });
        }

        // Scroll to position (using container if detected)
        console.log(`[ScreenshotService] Scrolling to position: ${yOffset}`);
        await this.scrollToPosition(tabId, yOffset, scrollOptions);

        // Wait for page to settle after scroll (increased for modern SPAs)
        // Longer delay allows lazy-loaded content and animations to complete
        await this.delay(400);

        // Capture viewport
        const dataUrl = await this.captureViewport(tabId);

        // For the last capture, we might have overlap
        // Calculate actual yOffset for stitching
        let stitchYOffset = yOffset;
        if (isLastCapture && yOffset + viewportHeight > totalHeight) {
          // Adjust for partial last viewport
          stitchYOffset = totalHeight - viewportHeight;
        }

        screenshots.push({
          dataUrl,
          yOffset: stitchYOffset
        });

        // Wait between captures to avoid rate limiting
        if (i < numCaptures - 1) {
          await this.delay(this.captureDelay);
        }
      }

      // Restore original scroll position
      console.log(`[ScreenshotService] Restoring scroll to original position: ${dimensions.originalScrollY}`);
      await this.scrollToPosition(tabId, dimensions.originalScrollY, scrollOptions);

      // Clean up the container marker attribute
      if (dimensions.useContainer && dimensions.containerId) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (containerId) => {
            const container = document.querySelector(`[data-screenshot-container="${containerId}"]`);
            if (container) {
              container.removeAttribute('data-screenshot-container');
            }
          },
          args: [dimensions.containerId]
        });
      }

      // Report stitching progress
      if (onProgress) {
        onProgress({
          current: numCaptures,
          total: numCaptures,
          message: 'Stitching images...'
        });
      }

      console.log(`[ScreenshotService] Sending ${screenshots.length} screenshots to offscreen document for stitching`);
      
      // Send screenshots to offscreen document for stitching
      const stitchedResult = await chrome.runtime.sendMessage({
        type: 'STITCH_SCREENSHOTS',
        screenshots,
        totalWidth: viewportWidth,
        totalHeight: totalHeight,
        maxWidth: this.maxImageWidth,
        maxHeight: this.maxImageHeight
      });

      if (!stitchedResult.success) {
        console.error('[ScreenshotService] Stitching failed:', stitchedResult.error);
        throw new Error(stitchedResult.error || 'Failed to stitch screenshots');
      }

      console.log('[ScreenshotService] Full-page capture complete, stitched image ready');
      return stitchedResult.dataUrl;

    } catch (error) {
      console.error('[ScreenshotService] Full-page capture failed:', error);
      console.error('[ScreenshotService] Error details:', error.message, error.stack);
      // Fall back to viewport capture
      console.log('[ScreenshotService] Falling back to viewport capture due to error');
      return await this.captureViewport(tabId);
    }
  }

  /**
   * Get page dimensions from content script
   * Detects scrollable containers in modern SPAs (like Datadog)
   * @param {number} tabId - The tab ID
   * @returns {Promise<Object>} Page dimension info
   */
  async getPageDimensions(tabId) {
    console.log(`[ScreenshotService] Getting page dimensions for tab ${tabId}`);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Get comprehensive dimension info for debugging
        const bodyScrollHeight = document.body?.scrollHeight || 0;
        const docScrollHeight = document.documentElement?.scrollHeight || 0;
        const bodyOffsetHeight = document.body?.offsetHeight || 0;
        const docClientHeight = document.documentElement?.clientHeight || 0;
        
        // Find the actual scrollable container (many modern SPAs use a scrollable div)
        // Look for elements with overflow scroll/auto that have scrollable content
        function findScrollableContainer() {
          // Common selectors for main content areas in modern web apps
          const candidates = [
            // Datadog-specific selectors (most specific first)
            '[data-testid="main-content-scroll-container"]',
            '[data-testid="page-content"]',
            '.scrollable-content',
            '.application-main__content',
            '.view-content',
            '.application-wrapper',
            '.react-container',
            '[data-test-id="main-content"]',
            '.application-main',
            '.layout-content',
            '.content-wrapper',
            // Generic scrollable containers
            'main',
            '[role="main"]',
            '.main-content',
            '.content-area',
            '.page-content',
            // Other common patterns
            '#app > div',
            '#root > div',
            '.app-container',
            // SPA framework patterns
            '[class*="scroll"]',
            '[class*="content"]'
          ];
          
          // First, try specific selectors
          for (const selector of candidates) {
            const el = document.querySelector(selector);
            if (el && isScrollable(el)) {
              console.log('[ScreenshotService Content] Found scrollable via selector:', selector);
              return el;
            }
          }
          
          // Then, search for any element with significant scrollable content
          const allElements = document.querySelectorAll('*');
          let bestCandidate = null;
          let maxScrollable = 0;
          
          for (const el of allElements) {
            if (isScrollable(el)) {
              const scrollableHeight = el.scrollHeight - el.clientHeight;
              // Prefer elements that are visible and have significant scroll
              if (scrollableHeight > maxScrollable && scrollableHeight > 100) {
                const rect = el.getBoundingClientRect();
                // Must be reasonably large (at least 50% of viewport)
                if (rect.width > window.innerWidth * 0.4 && rect.height > window.innerHeight * 0.4) {
                  maxScrollable = scrollableHeight;
                  bestCandidate = el;
                }
              }
            }
          }
          
          if (bestCandidate) {
            console.log('[ScreenshotService Content] Found scrollable container via search:', 
              bestCandidate.tagName, bestCandidate.className?.substring(0, 50));
            return bestCandidate;
          }
          
          return null;
        }
        
        function isScrollable(el) {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll';
          const hasScrollableContent = el.scrollHeight > el.clientHeight + 10; // 10px threshold
          return isScrollableStyle && hasScrollableContent;
        }
        
        const scrollContainer = findScrollableContainer();
        
        console.log('[ScreenshotService Content] Dimension check:', {
          bodyScrollHeight,
          docScrollHeight,
          bodyOffsetHeight,
          docClientHeight,
          innerHeight: window.innerHeight,
          hasScrollContainer: !!scrollContainer,
          containerScrollHeight: scrollContainer?.scrollHeight,
          containerClientHeight: scrollContainer?.clientHeight
        });
        
        // If we found a scrollable container, use its dimensions
        if (scrollContainer) {
          // Generate a unique ID to identify this element later
          const containerId = 'screenshot-scroll-container-' + Date.now();
          scrollContainer.setAttribute('data-screenshot-container', containerId);
          
          return {
            scrollHeight: scrollContainer.scrollHeight,
            viewportHeight: scrollContainer.clientHeight,
            viewportWidth: window.innerWidth,
            originalScrollY: scrollContainer.scrollTop,
            useContainer: true,
            containerId: containerId,
            // Debug info
            _bodyScrollHeight: bodyScrollHeight,
            _docScrollHeight: docScrollHeight,
            _containerClass: scrollContainer.className?.substring(0, 100)
          };
        }
        
        // Fall back to document-level scrolling
        return {
          scrollHeight: Math.max(bodyScrollHeight, docScrollHeight),
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          originalScrollY: window.scrollY,
          useContainer: false,
          // Debug info
          _bodyScrollHeight: bodyScrollHeight,
          _docScrollHeight: docScrollHeight
        };
      }
    });

    if (!results || !results[0]) {
      console.error('[ScreenshotService] Failed to get page dimensions - no results');
      throw new Error('Failed to get page dimensions');
    }

    console.log('[ScreenshotService] Got dimensions:', results[0].result);
    return results[0].result;
  }

  /**
   * Scroll page to specific Y position
   * Handles both document-level scrolling and container-level scrolling
   * @param {number} tabId - The tab ID
   * @param {number} yPosition - Y position to scroll to
   * @param {Object} options - Scroll options
   * @param {boolean} options.useContainer - Whether to scroll a container element
   * @param {string} options.containerId - ID of the container element to scroll
   */
  async scrollToPosition(tabId, yPosition, options = {}) {
    const { useContainer = false, containerId = null } = options;
    console.log(`[ScreenshotService] Executing scroll to y=${yPosition} on tab ${tabId}, useContainer=${useContainer}`);
    
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (y, useContainer, containerId) => {
        console.log('[ScreenshotService Content] Scrolling to:', y, 'useContainer:', useContainer);
        
        if (useContainer && containerId) {
          // Find the container element by the ID we set earlier
          const container = document.querySelector(`[data-screenshot-container="${containerId}"]`);
          if (container) {
            // Use scrollTop assignment for container scrolling
            container.scrollTop = y;
            
            // Force a layout recalculation
            void container.offsetHeight;
            
            console.log('[ScreenshotService Content] Scrolled container to:', container.scrollTop, 
              'requested:', y, 'max:', container.scrollHeight - container.clientHeight);
            return { 
              requestedY: y, 
              actualY: container.scrollTop,
              scrollHeight: container.scrollHeight,
              viewportHeight: container.clientHeight,
              usedContainer: true,
              containerTag: container.tagName,
              containerClass: container.className?.substring(0, 50)
            };
          } else {
            console.warn('[ScreenshotService Content] Container not found with id:', containerId);
            // Try to find any scrollable container as fallback
            const anyScrollable = document.querySelector('[style*="overflow"]');
            if (anyScrollable) {
              console.log('[ScreenshotService Content] Found alternative scrollable:', anyScrollable.tagName);
            }
          }
        }
        
        // Fall back to window scrolling
        console.log('[ScreenshotService Content] Using window.scrollTo');
        window.scrollTo({ top: y, behavior: 'instant' });
        
        // Also try scrolling document.documentElement and document.body as fallback
        if (window.scrollY !== y) {
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
        }
        
        return { 
          requestedY: y, 
          actualY: window.scrollY,
          docScrollTop: document.documentElement.scrollTop,
          bodyScrollTop: document.body.scrollTop,
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          usedContainer: false
        };
      },
      args: [yPosition, useContainer, containerId]
    });
    
    if (result && result[0] && result[0].result) {
      const scrollResult = result[0].result;
      console.log(`[ScreenshotService] Scroll result:`, scrollResult);
      
      // Warn if scroll didn't work as expected
      if (Math.abs(scrollResult.actualY - scrollResult.requestedY) > 50) {
        console.warn(`[ScreenshotService] Scroll mismatch! Requested: ${scrollResult.requestedY}, Actual: ${scrollResult.actualY}`);
      }
    }
  }

  /**
   * Capture just the visible viewport
   * @param {number} tabId - The tab ID to capture
   * @returns {Promise<string>} Base64 data URL of the screenshot
   */
  async captureViewport(tabId) {
    try {
      // Get the tab to find its window ID
      const tab = await chrome.tabs.get(tabId);
      
      // Capture from the specific window that contains the tab
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: Math.round(this.captureQuality * 100)
      });
      return dataUrl;
    } catch (error) {
      console.error('Viewport capture failed:', error);
      throw error;
    }
  }

  /**
   * Helper to delay execution
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Compress image if it's too large for API
   * Uses offscreen document for image manipulation
   * @param {string} dataUrl - Original data URL
   * @param {number} maxSize - Max size in bytes (default 5MB for OpenAI)
   * @returns {Promise<string>} Compressed data URL
   */
  async compressImage(dataUrl, maxSize = 5 * 1024 * 1024) {
    const sizeInBytes = Math.ceil((dataUrl.length * 3) / 4);
    
    if (sizeInBytes <= maxSize) {
      return dataUrl;
    }

    console.log(`Image too large (${Math.round(sizeInBytes / 1024)}KB), compressing...`);

    // Ensure offscreen document is ready
    await this.ensureOffscreenDocument();

    // Send to offscreen document for resizing
    const result = await chrome.runtime.sendMessage({
      type: 'RESIZE_IMAGE',
      dataUrl,
      maxWidth: Math.round(this.maxImageWidth * 0.75),
      maxHeight: Math.round(this.maxImageHeight * 0.75)
    });

    if (!result.success) {
      console.warn('Compression failed, using original:', result.error);
      return dataUrl;
    }

    return result.dataUrl;
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScreenshotService;
}
