#!/usr/bin/env node
/**
 * Generate placeholder icon PNG files for the extension.
 * This script creates simple colored PNG icons without external dependencies.
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a minimal PNG file with a solid color
 * This generates a valid PNG without requiring any external libraries
 */
function createSimplePNG(size, outputPath) {
  // Create a simple PNG with a gradient color scheme
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // Color gradient based on size (blue shades)
  const colors = {
    16: { r: 74, g: 144, b: 226 },   // Light blue
    48: { r: 52, g: 120, b: 200 },   // Medium blue  
    128: { r: 30, g: 96, b: 174 }    // Darker blue
  };
  
  const color = colors[size] || { r: 74, g: 144, b: 226 };
  
  // Create image data (RGBA format)
  const imageData = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      
      // Create a simple rounded square pattern
      const centerX = size / 2;
      const centerY = size / 2;
      const distFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
      const maxDist = size / 2;
      const isInCircle = distFromCenter < maxDist * 0.8;
      
      if (isInCircle) {
        imageData[idx] = color.r;
        imageData[idx + 1] = color.g;
        imageData[idx + 2] = color.b;
        imageData[idx + 3] = 255; // Alpha
      } else {
        imageData[idx] = 255;
        imageData[idx + 1] = 255;
        imageData[idx + 2] = 255;
        imageData[idx + 3] = 0; // Transparent
      }
    }
  }
  
  // Create PNG chunks
  const chunks = [];
  
  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);      // Width
  ihdr.writeUInt32BE(size, 4);      // Height
  ihdr.writeUInt8(8, 8);            // Bit depth
  ihdr.writeUInt8(6, 9);            // Color type (RGBA)
  ihdr.writeUInt8(0, 10);           // Compression
  ihdr.writeUInt8(0, 11);           // Filter
  ihdr.writeUInt8(0, 12);           // Interlace
  chunks.push(createChunk('IHDR', ihdr));
  
  // IDAT chunk (image data)
  const idatData = deflateData(imageData, size);
  chunks.push(createChunk('IDAT', idatData));
  
  // IEND chunk
  chunks.push(createChunk('IEND', Buffer.alloc(0)));
  
  // Combine everything
  const png = Buffer.concat([PNG_SIGNATURE, ...chunks]);
  fs.writeFileSync(outputPath, png);
  console.log(`Created ${outputPath}`);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = calculateCRC(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function calculateCRC(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function deflateData(imageData, size) {
  const zlib = require('zlib');
  
  // Add filter byte (0 = no filter) to each scanline
  const filtered = Buffer.alloc(size * size * 4 + size);
  for (let y = 0; y < size; y++) {
    filtered[y * (size * 4 + 1)] = 0; // Filter type
    imageData.copy(filtered, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  
  return zlib.deflateSync(filtered);
}

// Main execution
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir);
}

const sizes = [16, 48, 128];
sizes.forEach(size => {
  const outputPath = path.join(iconsDir, `icon${size}.png`);
  createSimplePNG(size, outputPath);
});

console.log('\nAll icons created successfully!');
