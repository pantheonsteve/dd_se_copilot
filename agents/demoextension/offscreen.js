// Offscreen document for image stitching
// This runs in a DOM context where Image and Canvas APIs are available

/**
 * Stitch multiple viewport screenshots into a single full-page image
 * @param {Array<{dataUrl: string, yOffset: number}>} screenshots - Array of screenshot data
 * @param {number} totalWidth - Total width of the final image
 * @param {number} totalHeight - Total height of the final image
 * @returns {Promise<string>} Base64 data URL of the stitched image
 */
async function stitchImages(screenshots, totalWidth, totalHeight) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.getElementById('stitchCanvas');
      const ctx = canvas.getContext('2d');
      
      // Set canvas size to full page dimensions
      canvas.width = totalWidth;
      canvas.height = totalHeight;
      
      // Fill with white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, totalWidth, totalHeight);
      
      // Load and draw each screenshot
      let loadedCount = 0;
      const images = [];
      
      if (screenshots.length === 0) {
        reject(new Error('No screenshots to stitch'));
        return;
      }
      
      screenshots.forEach((screenshot, index) => {
        const img = new Image();
        
        img.onload = () => {
          images[index] = { img, yOffset: screenshot.yOffset };
          loadedCount++;
          
          // When all images are loaded, draw them
          if (loadedCount === screenshots.length) {
            // Sort by yOffset to ensure correct order
            images.sort((a, b) => a.yOffset - b.yOffset);
            
            // Draw each image at its Y offset
            images.forEach(({ img, yOffset }) => {
              ctx.drawImage(img, 0, yOffset);
            });
            
            // Export as base64 data URL
            // Use JPEG for smaller file size (important for API calls)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(dataUrl);
          }
        };
        
        img.onerror = (error) => {
          reject(new Error(`Failed to load screenshot ${index}: ${error}`));
        };
        
        img.src = screenshot.dataUrl;
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Resize an image to fit within max dimensions while maintaining aspect ratio
 * @param {string} dataUrl - Base64 data URL of the image
 * @param {number} maxWidth - Maximum width
 * @param {number} maxHeight - Maximum height
 * @returns {Promise<string>} Resized image as base64 data URL
 */
async function resizeImage(dataUrl, maxWidth, maxHeight) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      let { width, height } = img;
      
      // Calculate scale factor
      const scale = Math.min(maxWidth / width, maxHeight / height, 1);
      
      if (scale === 1) {
        // No resize needed
        resolve(dataUrl);
        return;
      }
      
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    
    img.onerror = () => reject(new Error('Failed to load image for resize'));
    img.src = dataUrl;
  });
}

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STITCH_SCREENSHOTS') {
    const { screenshots, totalWidth, totalHeight, maxWidth, maxHeight } = message;
    
    console.log(`Stitching ${screenshots.length} screenshots into ${totalWidth}x${totalHeight} image`);
    
    stitchImages(screenshots, totalWidth, totalHeight)
      .then(async (dataUrl) => {
        // Optionally resize if the image is too large
        if (maxWidth && maxHeight) {
          console.log(`Resizing to max ${maxWidth}x${maxHeight}`);
          dataUrl = await resizeImage(dataUrl, maxWidth, maxHeight);
        }
        
        console.log('Stitching complete, image size:', Math.round(dataUrl.length / 1024), 'KB');
        sendResponse({ success: true, dataUrl });
      })
      .catch((error) => {
        console.error('Stitching error:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.type === 'RESIZE_IMAGE') {
    const { dataUrl, maxWidth, maxHeight } = message;
    
    resizeImage(dataUrl, maxWidth, maxHeight)
      .then((resizedDataUrl) => {
        sendResponse({ success: true, dataUrl: resizedDataUrl });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
});

console.log('Offscreen document loaded and ready for image stitching');

