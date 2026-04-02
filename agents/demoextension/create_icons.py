#!/usr/bin/env python3
"""Generate placeholder icon PNG files for the extension."""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    """Create a simple placeholder icon with the size displayed."""
    # Create a new image with a gradient background
    img = Image.new('RGB', (size, size), color='#4A90E2')
    draw = ImageDraw.Draw(img)
    
    # Draw a simple shape (rounded rectangle)
    margin = size // 8
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 6,
        fill='#FFFFFF',
        outline='#2C5AA0',
        width=max(1, size // 32)
    )
    
    # Add text with size
    text = f"{size}x{size}"
    try:
        # Try to use a nice font
        font_size = size // 4
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
    except:
        # Fall back to default font
        font = ImageFont.load_default()
    
    # Get text bounding box for centering
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    
    position = ((size - text_width) // 2, (size - text_height) // 2)
    draw.text(position, text, fill='#4A90E2', font=font)
    
    # Save the image
    img.save(output_path, 'PNG')
    print(f"Created {output_path}")

if __name__ == '__main__':
    icons_dir = 'icons'
    os.makedirs(icons_dir, exist_ok=True)
    
    sizes = [16, 48, 128]
    for size in sizes:
        output_path = os.path.join(icons_dir, f'icon{size}.png')
        create_icon(size, output_path)
    
    print("\nAll icons created successfully!")
