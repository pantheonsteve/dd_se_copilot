#!/usr/bin/env python3
"""Generate promotional images for Chrome Web Store."""

from PIL import Image, ImageDraw, ImageFont
import os

# Datadog-inspired color palette
COLORS = {
    'purple_dark': '#632CA6',
    'purple_light': '#8B5CF6',
    'purple_gradient_start': '#7C3AED',
    'purple_gradient_end': '#4F46E5',
    'white': '#FFFFFF',
    'light_gray': '#F3F4F6',
    'accent': '#10B981',  # Green accent
}

def create_gradient(width, height, color1, color2, direction='horizontal'):
    """Create a gradient image."""
    img = Image.new('RGB', (width, height))
    pixels = img.load()
    
    # Convert hex to RGB
    def hex_to_rgb(hex_color):
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    
    c1 = hex_to_rgb(color1)
    c2 = hex_to_rgb(color2)
    
    for y in range(height):
        for x in range(width):
            if direction == 'horizontal':
                ratio = x / width
            else:
                ratio = y / height
            
            r = int(c1[0] * (1 - ratio) + c2[0] * ratio)
            g = int(c1[1] * (1 - ratio) + c2[1] * ratio)
            b = int(c1[2] * (1 - ratio) + c2[2] * ratio)
            pixels[x, y] = (r, g, b)
    
    return img


def get_font(size, bold=False):
    """Get a font, with fallbacks."""
    font_paths = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSDisplay.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    
    for path in font_paths:
        try:
            return ImageFont.truetype(path, size)
        except:
            continue
    
    return ImageFont.load_default()


def draw_rounded_rect(draw, coords, radius, fill):
    """Draw a rounded rectangle."""
    x1, y1, x2, y2 = coords
    draw.rounded_rectangle(coords, radius=radius, fill=fill)


def create_small_promo(output_path):
    """Create small promo tile (440x280)."""
    width, height = 440, 280
    
    # Create gradient background
    img = create_gradient(width, height, COLORS['purple_gradient_start'], COLORS['purple_gradient_end'])
    draw = ImageDraw.Draw(img)
    
    # Add decorative circles
    draw.ellipse([width - 150, -50, width + 50, 150], fill='#8B5CF640')
    draw.ellipse([-80, height - 120, 120, height + 80], fill='#6366F140')
    
    # Main title
    title_font = get_font(48, bold=True)
    title = "Demo Buddy"
    bbox = draw.textbbox((0, 0), title, font=title_font)
    title_width = bbox[2] - bbox[0]
    draw.text(((width - title_width) // 2, 70), title, fill=COLORS['white'], font=title_font)
    
    # Tagline
    tagline_font = get_font(20)
    tagline = "Presenter notes for any webpage"
    bbox = draw.textbbox((0, 0), tagline, font=tagline_font)
    tagline_width = bbox[2] - bbox[0]
    draw.text(((width - tagline_width) // 2, 135), tagline, fill=COLORS['light_gray'], font=tagline_font)
    
    # Feature highlights
    feature_font = get_font(16)
    features = ["AI-Powered", "Cloud Sync", "Rich Editor"]
    
    pill_width = 100
    pill_height = 30
    total_width = len(features) * pill_width + (len(features) - 1) * 15
    start_x = (width - total_width) // 2
    
    for i, feature in enumerate(features):
        x = start_x + i * (pill_width + 15)
        y = 190
        
        # Draw pill background
        draw.rounded_rectangle(
            [x, y, x + pill_width, y + pill_height],
            radius=15,
            fill='#FFFFFF30'
        )
        
        # Draw text
        bbox = draw.textbbox((0, 0), feature, font=feature_font)
        text_width = bbox[2] - bbox[0]
        text_x = x + (pill_width - text_width) // 2
        draw.text((text_x, y + 6), feature, fill=COLORS['purple_dark'], font=feature_font)
    
    img.save(output_path, 'PNG')
    print(f"Created {output_path} (440x280)")


def create_marquee_promo(output_path):
    """Create marquee promo tile (1400x560)."""
    width, height = 1400, 560
    
    # Create gradient background
    img = create_gradient(width, height, COLORS['purple_gradient_start'], COLORS['purple_gradient_end'])
    draw = ImageDraw.Draw(img)
    
    # Add decorative elements
    draw.ellipse([width - 400, -150, width + 100, 350], fill='#8B5CF630')
    draw.ellipse([-200, height - 250, 300, height + 150], fill='#6366F130')
    draw.ellipse([width // 2 - 100, -200, width // 2 + 400, 200], fill='#A78BFA20')
    
    # Main title - larger for marquee
    title_font = get_font(96, bold=True)
    title = "Demo Buddy"
    bbox = draw.textbbox((0, 0), title, font=title_font)
    title_width = bbox[2] - bbox[0]
    draw.text(((width - title_width) // 2, 120), title, fill=COLORS['white'], font=title_font)
    
    # Subtitle
    subtitle_font = get_font(36)
    subtitle = "Your Demo Companion"
    bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font)
    subtitle_width = bbox[2] - bbox[0]
    draw.text(((width - subtitle_width) // 2, 235), subtitle, fill=COLORS['light_gray'], font=subtitle_font)
    
    # Tagline
    tagline_font = get_font(28)
    tagline = "Create and display presenter notes for any webpage"
    bbox = draw.textbbox((0, 0), tagline, font=tagline_font)
    tagline_width = bbox[2] - bbox[0]
    draw.text(((width - tagline_width) // 2, 300), tagline, fill='#E0E7FF', font=tagline_font)
    
    # Feature boxes
    feature_font = get_font(22, bold=True)
    desc_font = get_font(16)
    
    features = [
        ("AI-Powered", "Generate talk tracks"),
        ("Cloud Sync", "Access anywhere"),
        ("Rich Editor", "WYSIWYG & Markdown"),
        ("Smart Match", "Auto URL detection"),
    ]
    
    box_width = 260
    box_height = 90
    total_boxes_width = len(features) * box_width + (len(features) - 1) * 30
    start_x = (width - total_boxes_width) // 2
    y = 400
    
    for i, (title, desc) in enumerate(features):
        x = start_x + i * (box_width + 30)
        
        # Draw box background
        draw.rounded_rectangle(
            [x, y, x + box_width, y + box_height],
            radius=12,
            fill='#FFFFFF20'
        )
        
        # Draw feature title
        bbox = draw.textbbox((0, 0), title, font=feature_font)
        text_width = bbox[2] - bbox[0]
        text_x = x + (box_width - text_width) // 2
        draw.text((text_x, y + 18), title, fill=COLORS['purple_dark'], font=feature_font)
        
        # Draw description
        bbox = draw.textbbox((0, 0), desc, font=desc_font)
        desc_width = bbox[2] - bbox[0]
        desc_x = x + (box_width - desc_width) // 2
        draw.text((desc_x, y + 52), desc, fill=COLORS['purple_light'], font=desc_font)
    
    img.save(output_path, 'PNG')
    print(f"Created {output_path} (1400x560)")


if __name__ == '__main__':
    # Create promo images in icons directory
    icons_dir = 'icons'
    os.makedirs(icons_dir, exist_ok=True)
    
    # Small promo tile (440x280)
    create_small_promo(os.path.join(icons_dir, 'promo_small.png'))
    
    # Marquee promo tile (1400x560)
    create_marquee_promo(os.path.join(icons_dir, 'promo_marquee.png'))
    
    print("\nPromo images created successfully!")
    print("Files saved to icons/ directory")

