#!/bin/bash
# Verification script for Datadog Demo Buddy extension

echo "========================================="
echo "Datadog Demo Buddy - File Verification"
echo "========================================="
echo ""

cd ~/Projects/demoextension

echo "Checking directory: $(pwd)"
echo ""

# Count total files
total_files=$(find . -type f | wc -l)
echo "Total files found: $total_files"
echo ""

echo "📋 CORE EXTENSION FILES:"
for file in manifest.json background.js content.js sidepanel.html sidepanel.js sidepanel.css options.html options.js options.css; do
    if [ -f "$file" ]; then
        size=$(ls -lh "$file" | awk '{print $5}')
        echo "  ✓ $file ($size)"
    else
        echo "  ✗ MISSING: $file"
    fi
done

echo ""
echo "🎨 ICONS:"
if [ -d "icons" ]; then
    echo "  ✓ icons/ directory exists"
    for icon in icons/icon16.png icons/icon48.png icons/icon128.png; do
        if [ -f "$icon" ]; then
            size=$(ls -lh "$icon" | awk '{print $5}')
            echo "  ✓ $icon ($size)"
        else
            echo "  ✗ MISSING: $icon"
        fi
    done
else
    echo "  ✗ MISSING: icons/ directory"
fi

echo ""
echo "📚 DOCUMENTATION:"
for doc in README.md QUICKSTART.md INSTALL.txt; do
    if [ -f "$doc" ]; then
        echo "  ✓ $doc"
    fi
done

echo ""
echo "========================================="
echo "READY TO INSTALL IN CHROME"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Open Chrome and go to: chrome://extensions/"
echo "2. Enable 'Developer mode' (toggle top right)"
echo "3. Click 'Load unpacked'"
echo "4. Select this folder: $(pwd)"
echo "5. Click the extension icon on any Datadog page!"
echo ""
