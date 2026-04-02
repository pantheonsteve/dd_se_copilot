// Content converter for HTML <-> Markdown conversions
// Robust implementation with Quill editor support

class ContentConverter {
  /**
   * Convert Markdown to HTML for WYSIWYG editing
   * @param {string} markdown - Markdown text
   * @returns {string} HTML string
   */
  static markdownToHtml(markdown) {
    if (!markdown) return '';
    
    // Configure marked for proper parsing
    marked.setOptions({
      breaks: true,
      gfm: true
    });
    
    // Use marked.js to convert markdown to HTML
    const rawHtml = marked.parse(markdown);
    
    // Sanitize for security
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'strike', 'del', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a', 'hr', 'span', 'div'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'class']
    });
    
    return cleanHtml;
  }

  /**
   * Convert HTML to Markdown for storage - ROBUST VERSION
   * Handles Quill editor HTML output and various browser structures
   * @param {string} html - HTML string
   * @returns {string} Markdown text
   */
  static htmlToMarkdown(html) {
    if (!html) return '';
    
    // Handle empty Quill editor
    if (html === '<p><br></p>' || html === '<br>') {
      return '';
    }
    
    // Log input for debugging
    console.log('Converting HTML to Markdown:', html.substring(0, 500) + '...');
    
    // Create a temporary div to parse HTML
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    // Process the DOM tree
    const result = this.convertNode(temp);
    
    // Clean up the result
    const cleaned = this.cleanupMarkdown(result);
    
    console.log('Conversion result:', cleaned.substring(0, 500) + '...');
    
    return cleaned;
  }

  /**
   * Main conversion function - handles all node types
   * @param {Node} node - DOM node
   * @returns {string} Markdown text
   */
  static convertNode(node) {
    let result = '';
    
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        // Preserve text but normalize whitespace for non-pre contexts
        if (text.trim()) {
          result += text;
        } else if (text.includes('\n')) {
          result += '\n';
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        result += this.convertElement(child);
      }
    }
    
    return result;
  }

  /**
   * Convert a single element to markdown
   * @param {Element} element - DOM element
   * @returns {string} Markdown text
   */
  static convertElement(element) {
    const tag = element.tagName.toLowerCase();
    
    switch (tag) {
      case 'strong':
      case 'b': {
        const content = this.convertNode(element);
        return content.trim() ? `**${content.trim()}**` : '';
      }
      
      case 'em':
      case 'i': {
        const content = this.convertNode(element);
        return content.trim() ? `*${content.trim()}*` : '';
      }
      
      case 'u': {
        const content = this.convertNode(element);
        return content.trim() ? `<u>${content.trim()}</u>` : '';
      }
      
      case 'del':
      case 'strike':
      case 's': {
        const content = this.convertNode(element);
        return content.trim() ? `~~${content.trim()}~~` : '';
      }
      
      case 'h1':
        return `# ${this.getTextContent(element).trim()}\n\n`;
      
      case 'h2':
        return `## ${this.getTextContent(element).trim()}\n\n`;
      
      case 'h3':
        return `### ${this.getTextContent(element).trim()}\n\n`;
      
      case 'h4':
        return `#### ${this.getTextContent(element).trim()}\n\n`;
      
      case 'h5':
        return `##### ${this.getTextContent(element).trim()}\n\n`;
      
      case 'h6':
        return `###### ${this.getTextContent(element).trim()}\n\n`;
      
      case 'p': {
        // Check if this is an empty paragraph (Quill uses <p><br></p>)
        if (element.childNodes.length === 1 && element.firstChild?.nodeName === 'BR') {
          return '\n';
        }
        const content = this.convertNode(element);
        return content.trim() ? `${content.trim()}\n\n` : '\n';
      }
      
      case 'br':
        return '\n';
      
      case 'hr':
        return '\n---\n\n';
      
      case 'ul':
        return this.convertQuillList(element, 'ul') + '\n';
      
      case 'ol':
        return this.convertQuillList(element, 'ol') + '\n';
      
      case 'li':
        // LI outside a list context - treat as paragraph
        return this.convertNode(element) + '\n';
      
      case 'blockquote': {
        const content = this.convertNode(element);
        const lines = content.trim().split('\n');
        return lines.map(line => `> ${line}`).join('\n') + '\n\n';
      }
      
      case 'code': {
        const content = element.textContent || '';
        return `\`${content}\``;
      }
      
      case 'pre': {
        const codeEl = element.querySelector('code');
        const content = codeEl ? codeEl.textContent : element.textContent;
        return `\n\`\`\`\n${content}\n\`\`\`\n\n`;
      }
      
      case 'a': {
        const href = element.getAttribute('href') || '';
        const content = this.convertNode(element);
        return `[${content}](${href})`;
      }
      
      case 'div':
      case 'span':
      default:
        // For divs/spans, check if they have block-level content
        const innerContent = this.convertNode(element);
        // If it's a div that acts as a paragraph, add newlines
        if (tag === 'div' && innerContent.trim()) {
          return `${innerContent.trim()}\n\n`;
        }
        return innerContent;
    }
  }

  /**
   * Convert a Quill list (UL or OL) to markdown
   * Quill uses FLAT lists with ql-indent-* classes for nesting
   * Example Quill HTML:
   *   <ul>
   *     <li>Item 1</li>
   *     <li class="ql-indent-1">Nested 1.1</li>
   *     <li class="ql-indent-1">Nested 1.2</li>
   *     <li>Item 2</li>
   *   </ul>
   * 
   * @param {Element} listElement - UL or OL element
   * @param {string} listType - 'ul' or 'ol'
   * @returns {string} Markdown list
   */
  static convertQuillList(listElement, listType) {
    let result = '';
    let olCounters = {}; // Track ordered list counters per indent level
    
    // Get all list items
    const items = Array.from(listElement.children).filter(el => el.tagName === 'LI');
    
    for (const li of items) {
      // Get indent level from Quill's ql-indent-* class
      const indentLevel = this.getQuillIndentLevel(li);
      
      // Determine bullet type - check if this item or its context is ordered
      // Quill uses data-list attribute to indicate list type per item
      const dataList = li.getAttribute('data-list');
      const isOrdered = dataList === 'ordered' || (listType === 'ol' && dataList !== 'bullet');
      const isBullet = dataList === 'bullet' || (listType === 'ul' && dataList !== 'ordered');
      
      // Create indent string (2 spaces per level)
      const indent = '  '.repeat(indentLevel);
      
      // Get bullet character
      let bullet;
      if (isOrdered) {
        // Track counter per indent level for ordered lists
        if (!olCounters[indentLevel]) {
          olCounters[indentLevel] = 0;
        }
        olCounters[indentLevel]++;
        bullet = `${olCounters[indentLevel]}.`;
        
        // Reset deeper level counters when we move up
        Object.keys(olCounters).forEach(level => {
          if (parseInt(level) > indentLevel) {
            delete olCounters[level];
          }
        });
      } else {
        bullet = '-';
        // Reset ordered counters when switching to bullet
        if (olCounters[indentLevel]) {
          delete olCounters[indentLevel];
        }
      }
      
      // Get the text content (handle formatting inside)
      const content = this.convertListItemContent(li);
      
      // Build the line
      result += `${indent}${bullet} ${content.trim()}\n`;
    }
    
    return result;
  }

  /**
   * Get Quill indent level from element's class
   * @param {Element} element - Element to check
   * @returns {number} Indent level (0 if none)
   */
  static getQuillIndentLevel(element) {
    const classes = element.className || '';
    const match = classes.match(/ql-indent-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Convert the content of a list item (handles inline formatting)
   * @param {Element} li - LI element
   * @returns {string} Formatted content
   */
  static convertListItemContent(li) {
    let result = '';
    
    for (const child of li.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        
        // Skip nested lists (shouldn't happen in Quill's flat structure, but just in case)
        if (tag === 'ul' || tag === 'ol') {
          continue;
        }
        
        // Handle inline formatting
        if (tag === 'strong' || tag === 'b') {
          const text = child.textContent.trim();
          if (text) result += `**${text}**`;
        } else if (tag === 'em' || tag === 'i') {
          const text = child.textContent.trim();
          if (text) result += `*${text}*`;
        } else if (tag === 'u') {
          const text = child.textContent.trim();
          if (text) result += `<u>${text}</u>`;
        } else if (tag === 'del' || tag === 's' || tag === 'strike') {
          const text = child.textContent.trim();
          if (text) result += `~~${text}~~`;
        } else if (tag === 'a') {
          const href = child.getAttribute('href') || '';
          const text = child.textContent;
          result += `[${text}](${href})`;
        } else if (tag === 'code') {
          result += `\`${child.textContent}\``;
        } else if (tag === 'br') {
          // Ignore line breaks within list items
        } else if (tag === 'span') {
          // Span might contain formatted text, recurse
          result += this.convertListItemContent(child);
        } else {
          // Default: just get text content
          result += child.textContent;
        }
      }
    }
    
    return result;
  }

  /**
   * Get all text content from an element (including children)
   * but preserving inline formatting
   * @param {Element} element - DOM element
   * @returns {string} Formatted text
   */
  static getTextContent(element) {
    return this.convertNode(element);
  }

  /**
   * Clean up markdown output
   * @param {string} markdown - Raw markdown
   * @returns {string} Cleaned markdown
   */
  static cleanupMarkdown(markdown) {
    return markdown
      // Normalize line endings
      .replace(/\r\n/g, '\n')
      // Remove excessive blank lines (more than 2)
      .replace(/\n{3,}/g, '\n\n')
      // Remove trailing whitespace from lines (but keep leading indentation!)
      .replace(/[ \t]+$/gm, '')
      // Remove empty bold/italic markers
      .replace(/\*\*\s*\*\*/g, '')
      .replace(/\*\s*\*/g, '')
      // Fix multiple spaces ONLY in the middle of text (not at line start - that's indentation!)
      .replace(/([^\n]) {2,}([^\n])/g, '$1 $2')
      // Remove leading/trailing whitespace from document
      .trim();
  }

  /**
   * Clean pasted HTML from Google Docs or other sources
   * @param {string} html - Pasted HTML
   * @returns {string} Cleaned HTML
   */
  static cleanPastedHtml(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    // Remove unwanted elements
    const unwanted = temp.querySelectorAll('script, style, meta, link, title, head');
    unwanted.forEach(el => el.remove());
    
    // Convert Google Docs spans with bold styling to strong tags
    const spans = temp.querySelectorAll('span');
    spans.forEach(span => {
      const style = span.getAttribute('style') || '';
      const isBold = style.includes('font-weight') && (style.includes('bold') || style.includes('700'));
      const isItalic = style.includes('font-style') && style.includes('italic');
      
      if (isBold || isItalic) {
        let wrapper = span;
        
        if (isBold) {
          const strong = document.createElement('strong');
          strong.innerHTML = span.innerHTML;
          wrapper = strong;
        }
        
        if (isItalic) {
          const em = document.createElement('em');
          if (wrapper !== span) {
            em.appendChild(wrapper);
          } else {
            em.innerHTML = span.innerHTML;
          }
          wrapper = em;
        }
        
        span.replaceWith(wrapper);
      }
    });
    
    // Remove all remaining attributes except href
    const allElements = temp.querySelectorAll('*');
    allElements.forEach(el => {
      const attrs = Array.from(el.attributes);
      attrs.forEach(attr => {
        if (attr.name !== 'href' && attr.name !== 'title') {
          el.removeAttribute(attr.name);
        }
      });
    });
    
    return DOMPurify.sanitize(temp.innerHTML, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'strike', 'del', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a', 'hr'],
      ALLOWED_ATTR: ['href', 'title']
    });
  }

  /**
   * Debug helper - log the HTML structure
   * @param {string} html - HTML to debug
   */
  static debugHtml(html) {
    console.log('=== HTML Structure Debug ===');
    console.log('Raw HTML:', html);
    
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    const logElement = (el, indent = 0) => {
      const prefix = '  '.repeat(indent);
      if (el.nodeType === Node.TEXT_NODE) {
        const text = el.textContent.trim();
        if (text) {
          console.log(`${prefix}TEXT: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        }
      } else if (el.nodeType === Node.ELEMENT_NODE) {
        const attrs = el.attributes.length > 0 ? 
          ` [${Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).join(' ')}]` : '';
        console.log(`${prefix}<${el.tagName.toLowerCase()}${attrs}>`);
        for (const child of el.childNodes) {
          logElement(child, indent + 1);
        }
      }
    };
    
    logElement(temp);
    console.log('=== End Debug ===');
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContentConverter;
}
