// OpenAI API integration service

class AIService {
  constructor() {
    this.apiEndpoint = 'https://api.openai.com/v1/chat/completions';
    this.model = 'gpt-5-mini';
    this.maxTokens = 8000;

    // ChromaDB RAG settings
    this.chromaEndpoint = 'http://localhost:8000';
    this.chromaCollection = 'librarian';
    this.embeddingModel = 'text-embedding-3-small';
    this.embeddingDimensions = 1536;
    this.ragTopK = 5;
    this.screenshotAnalysisModel = 'gpt-4o-mini';
  }

  /**
   * Lightweight vision pass: look at the screenshot and extract structured info
   * for doc retrieval. Uses gpt-4o-mini to keep cost/latency low.
   * Returns { page, features[], searchQuery } or null.
   */
  async analyzeScreenshot(imageData, currentUrl, apiKey) {
    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.screenshotAnalysisModel,
        max_tokens: 250,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Look at this screenshot of a Datadog product page (URL: ${currentUrl}).

Return ONLY a JSON object — no markdown, no backticks:
{
  "page": "short page/product area name",
  "features": ["3-5 specific features or capabilities visible on screen"],
  "searchQuery": "natural-language query to find documentation about the features and product area shown"
}`
            },
            {
              type: 'image_url',
              image_url: { url: imageData, detail: 'low' }
            }
          ]
        }]
      })
    });

    if (!response.ok) throw new Error(`Screenshot analysis failed: ${response.status}`);
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty screenshot analysis response');

    const cleaned = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  }

  /**
   * Fallback: derive search terms from URL path segments + persona when vision is unavailable.
   */
  extractSearchTermsFallback(currentUrl, persona) {
    const terms = [];
    try {
      const url = new URL(currentUrl);
      const segments = url.pathname.split('/').filter(s => s && s.length > 1);
      terms.push(...segments.map(s => s.replace(/[-_]/g, ' ')));
    } catch { /* non-parseable URL */ }
    if (persona?.name) terms.push(persona.name);
    return terms.join(' ').trim();
  }

  /**
   * Embed text via OpenAI embeddings API (same model the librarian uses).
   */
  async embedText(text, apiKey) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: text,
        dimensions: this.embeddingDimensions
      })
    });

    if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * Query the ChromaDB HTTP server for relevant doc chunks.
   */
  async queryChromaDB(embedding) {
    const collResp = await fetch(
      `${this.chromaEndpoint}/api/v1/collections/${this.chromaCollection}`
    );
    if (!collResp.ok) throw new Error(`ChromaDB collection lookup failed: ${collResp.status}`);
    const collection = await collResp.json();

    const queryResp = await fetch(
      `${this.chromaEndpoint}/api/v1/collections/${collection.id}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query_embeddings: [embedding],
          n_results: this.ragTopK,
          include: ['documents', 'metadatas', 'distances']
        })
      }
    );

    if (!queryResp.ok) throw new Error(`ChromaDB query failed: ${queryResp.status}`);
    return queryResp.json();
  }

  /**
   * Full RAG pipeline: analyze screenshot -> embed -> query ChromaDB -> format chunks.
   * Returns { referenceText, docUrls, analysis } or null.
   * Fails gracefully — returns null if ChromaDB is unreachable.
   * @param {Function} onProgress - Optional callback: (step, detail) => void
   */
  async fetchRAGContext(imageData, currentUrl, persona, apiKey, onProgress) {
    try {
      let analysis = null;
      let searchQuery = '';

      onProgress?.('analyze', 'Analyzing screenshot...');
      try {
        analysis = await this.analyzeScreenshot(imageData, currentUrl, apiKey);
        searchQuery = analysis.searchQuery || analysis.features?.join(' ') || '';
        console.log('[RAG] Screenshot analysis:', JSON.stringify(analysis));
        onProgress?.('analyze', `Identified: ${analysis.page || 'page'}`);
      } catch (err) {
        console.warn('[RAG] Vision analysis failed, falling back to URL extraction:', err.message);
        searchQuery = this.extractSearchTermsFallback(currentUrl, persona);
        onProgress?.('analyze', 'Using URL-based analysis (fallback)');
      }

      if (!searchQuery) return null;

      onProgress?.('docs', 'Searching documentation...');
      console.log('[RAG] Querying ChromaDB with:', searchQuery);

      const embedding = await this.embedText(searchQuery, apiKey);
      const results = await this.queryChromaDB(embedding);

      if (!results.documents?.[0]?.length) {
        onProgress?.('docs', 'No matching docs found');
        return null;
      }

      const chunks = results.documents[0].map((doc, i) => {
        const meta = results.metadatas[0][i] || {};
        const source = meta.source || 'unknown';
        const sourceName = source.includes('/') ? source.split('/').pop() : source;
        return `[${sourceName}]\n${doc}`;
      });

      const docUrls = results.metadatas[0]
        .map(m => m.source || '')
        .filter(s => s.startsWith('http'));

      console.log(`[RAG] Retrieved ${chunks.length} chunks from ChromaDB`);
      onProgress?.('docs', `Found ${chunks.length} relevant doc${chunks.length !== 1 ? 's' : ''}`);
      return {
        referenceText: chunks.join('\n\n---\n\n'),
        docUrls,
        analysis
      };
    } catch (error) {
      console.warn('[RAG] ChromaDB unavailable, continuing without RAG context:', error.message);
      onProgress?.('docs', 'Docs unavailable — skipping');
      return null;
    }
  }

  /**
   * Generate talk track from screenshot
   * @param {string} imageData - Base64 data URL of screenshot
   * @param {Object} persona - Persona object with name and description
   * @param {string} currentUrl - Current page URL
   * @param {string} apiKey - OpenAI API key
   * @param {Object} customerContext - Optional customer context object
   * @param {Object} docContext - Optional documentation context {referenceText, docUrls}
   * @returns {Promise<Object>} Generated talk track with title and content
   */
  /**
   * @param {Function} onProgress - Optional callback: (step, detail) => void
   *   Steps: 'capture' | 'analyze' | 'docs' | 'generate'
   */
  async generateTalkTrack(imageData, persona, currentUrl, apiKey, customerContext = null, docContext = null, onProgress = null) {
    try {
      // Pass 1: analyze the screenshot and pull relevant docs from ChromaDB
      const ragContext = await this.fetchRAGContext(imageData, currentUrl, persona, apiKey, onProgress);
      if (ragContext) {
        docContext = docContext || { referenceText: '', docUrls: [] };
        docContext.referenceText = [docContext.referenceText, ragContext.referenceText]
          .filter(Boolean).join('\n\n---\n\n');
        docContext.docUrls = [...(docContext.docUrls || []), ...ragContext.docUrls];
        docContext.screenshotAnalysis = ragContext.analysis;
      }

      // Pass 2: generate the talk track with doc-enriched prompt
      onProgress?.('generate', 'Generating talk track...');
      const prompt = this.buildPrompt(persona, currentUrl, customerContext, docContext);

      // Prepare the request
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageData,
                    detail: 'high'
                  }
                }
              ]
            }
          ],
          max_completion_tokens: this.maxTokens
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('API error response:', errorData);
        throw new Error(errorData.error?.message || `API request failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('OpenAI API response:', JSON.stringify(data, null, 2));
      
      const content = data.choices?.[0]?.message?.content;
      const refusal = data.choices?.[0]?.message?.refusal;
      const finishReason = data.choices?.[0]?.finish_reason;

      if (refusal) {
        throw new Error(`AI refused to generate: ${refusal}`);
      }

      if (!content) {
        console.error('No content found. Full response:', data);
        console.error('Finish reason:', finishReason);
        throw new Error(`No content in API response. Finish reason: ${finishReason || 'unknown'}`);
      }

      // Extract title and content
      const parsed = this.parseGeneratedContent(content, currentUrl);
      
      return {
        title: parsed.title,
        content: parsed.content,
        rawContent: content
      };
    } catch (error) {
      console.error('AI generation error:', error);
      throw error;
    }
  }

  /**
   * Build the prompt for OpenAI
   * @param {Object} persona - Persona with name and description
   * @param {string} currentUrl - Current page URL
   * @param {Object} customerContext - Optional customer context with name and discoveryNotes
   * @param {Object} docContext - Optional documentation context {referenceText, docUrls}
   * @returns {string} Formatted prompt
   */
  buildPrompt(persona, currentUrl, customerContext = null, docContext = null) {
    const hasContext = customerContext && customerContext.discoveryNotes;
    
    // Build prioritization rules based on whether we have customer context
    const prioritizationRules = hasContext
      ? `PRIORITIZATION (you have customer context - go deep):
1. Features that directly address their stated pain points
2. Features relevant to their industry (${customerContext.industry || 'unspecified'})
3. Workflows they mentioned in discovery notes

QUESTION STRATEGY: Probe deeper into stated pain. Reference what they told you.`
      : `PRIORITIZATION (no customer context - this is discovery):
1. Visual anomalies - red/yellow indicators, spikes, outliers
2. High-density data areas - graphs, tables, main content panels
3. Interactive elements - filters, drilldowns, action buttons

QUESTION STRATEGY: Probe wide to uncover pain. Ask about their current state.`;

    // Customer context section
    let customerSection = '';
    if (hasContext) {
      customerSection = `
## CUSTOMER: ${customerContext.name}${customerContext.industry ? ` (${customerContext.industry})` : ''}

Discovery notes:
${customerContext.discoveryNotes}

`;
    }

    // Screenshot pre-analysis (from vision pass)
    let analysisSection = '';
    if (docContext?.screenshotAnalysis) {
      const a = docContext.screenshotAnalysis;
      analysisSection = `
## PAGE ANALYSIS
Page: ${a.page || 'Unknown'}
Visible features: ${(a.features || []).join(', ')}

`;
    }

    // Documentation context section — drives feature suggestions
    let docSection = '';
    if (docContext && docContext.referenceText) {
      docSection = `
## PRODUCT DOCUMENTATION (use as your source of truth)
The following documentation describes capabilities available on this page.
Prioritize features mentioned in these docs that are visible in the screenshot.
Use the exact terminology, metric names, and feature names from the docs.

${docContext.referenceText}

`;
    }

    // Documentation URLs section
    let docUrlsSection = '';
    if (docContext && docContext.docUrls && docContext.docUrls.length > 0) {
      docUrlsSection = `
📚 **Learn More:** ${docContext.docUrls.join(' | ')}
`;
    }

    return `You are a senior Sales Engineer running a live demo. You need scannable notes - not a script.

Persona: ${persona.name}
${persona.description}
${customerSection}${analysisSection}${docSection}${prioritizationRules}

---

Analyze the screenshot and generate a talk track. If PRODUCT DOCUMENTATION is provided above, use it to identify which features on this page are most worth demonstrating and to get accurate descriptions of what each feature does. Prefer documented capabilities over guessing.

Use this EXACT structure:

# [Page Name]

**Anchor:** [One sentence - what is this page and why are we here${hasContext ? ' for this customer' : ''}]

---

[3-4 FEATURES using this EXACT format. Copy this structure precisely:]

**Service Map**

🎯 [[VALUE]]Real-time dependency visualization showing blast radius instantly[[/VALUE]]

💬 "This is every service talking to checkout, updated live — you can see the bottleneck immediately."

🔍 "Walk me through the last time an upstream service caused a checkout failure — how did you figure out which one?"

→ [[OUTCOME]]Click failing node to drill into traces and isolate root cause[[/OUTCOME]]

---

[Now generate 3-4 features from the screenshot following that EXACT format above. Each feature must have:]
- Feature name in **bold**
- Blank line
- 🎯 line with [[VALUE]]...[[/VALUE]] tags
- Blank line
- 💬 line with quoted phrase
- Blank line  
- 🔍 line with TEDW question
- Blank line
- → line with [[OUTCOME]]...[[/OUTCOME]] tags

---

**Next → [Page name]:** [One sentence - why go there${hasContext ? ' for this customer' : ''}]
${docUrlsSection}
---

RULES:
- MAX 4 features
- MUST include blank line between each line (🎯, 💬, 🔍, →)
- MUST wrap value text in [[VALUE]]...[[/VALUE]]
- MUST wrap outcome text in [[OUTCOME]]...[[/OUTCOME]]
- 🔍 questions: TEDW format, specific to feature shown

Current URL: ${currentUrl}

Generate now:`;
  }

  /**
   * Parse generated content to extract title and body
   * @param {string} content - Raw generated content
   * @param {string} fallbackUrl - URL to use if title extraction fails
   * @returns {Object} {title, content}
   */
  parseGeneratedContent(content, fallbackUrl) {
    // Try to extract title from first heading
    const lines = content.trim().split('\n');
    let title = '';
    let contentBody = content;

    // Look for first h1 heading
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
      // Remove the title from content
      contentBody = content.replace(h1Match[0], '').trim();
    } else {
      // Try to generate title from URL
      try {
        const url = new URL(fallbackUrl);
        const pathParts = url.pathname.split('/').filter(p => p);
        title = pathParts[pathParts.length - 1] || 'AI Generated Talk Track';
        title = title.replace(/-/g, ' ').replace(/_/g, ' ');
        title = title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      } catch {
        title = 'AI Generated Talk Track';
      }
    }

    return {
      title: title || 'AI Generated Talk Track',
      content: contentBody || content
    };
  }

  /**
   * Validate API key
   * @param {string} apiKey - OpenAI API key to validate
   * @returns {Promise<boolean>} True if valid
   */
  async validateApiKey(apiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      return response.ok;
    } catch (error) {
      console.error('API key validation error:', error);
      return false;
    }
  }

  /**
   * Get error message for user
   * @param {Error} error - The error object
   * @returns {string} User-friendly error message
   */
  /**
   * Refine a TST loop's talk track using screenshots of the actual Datadog pages.
   * Accepts an array of { label, key, dataUrl } objects for multi-page loops,
   * or a single data URL string for backward compatibility.
   */
  async refineTSTLoop(screenshots, loopContent, customerContext, apiKey) {
    // Normalize input: accept a single string (legacy) or array of objects
    const screenshotList = typeof screenshots === 'string'
      ? [{ label: 'Current Page', key: 'current', dataUrl: screenshots }]
      : screenshots;

    const isMultiPage = screenshotList.length > 1;

    const customerSection = customerContext?.name
      ? `\nCUSTOMER: ${customerContext.name}${customerContext.industry ? ` (${customerContext.industry})` : ''}\n`
      : '';

    const multiPageInstructions = isMultiPage
      ? `\nYou are receiving ${screenshotList.length} screenshots, one for each Key Moment in this demo loop. Each screenshot is labeled with its Key Moment name. Match each section of the SHOW narrative to the corresponding screenshot — update references, metric names, service names, and values to reflect what is actually visible on that specific page.\n`
      : '';

    const prompt = `You are a demo coaching assistant. You have a Tell-Show-Tell demo loop and ${isMultiPage ? 'screenshots of each page' : 'a screenshot of the actual Datadog page'} the presenter will show.

Your job: update the talk track so it references the REAL data, metric names, service names, dashboard titles, and values visible in the ${isMultiPage ? 'screenshots' : 'screenshot'} — while preserving the customer-specific story, pain points, and narrative arc.
${customerSection}${multiPageInstructions}
CURRENT LOOP:
Title: ${loopContent.title || ''}
Pain Point: ${loopContent.pain_point || ''}

TELL (Setup):
${loopContent.tell_setup || '(empty)'}

SHOW (Live Demo):
${loopContent.show_demo || '(empty)'}

TELL (Connection):
${loopContent.tell_connection || '(empty)'}

---

Analyze the ${isMultiPage ? 'screenshots' : 'screenshot'} and return a JSON object (no markdown fences) with these exact keys:
{
  "tell_setup": "Updated setup text referencing real dashboard/page names visible in the screenshots",
  "show_demo": "Updated demo walkthrough referencing actual metrics, services, values on screen for each Key Moment",
  "tell_connection": "Updated connection text tying the real data back to the customer story"
}

Rules:
- Replace generic placeholders with actual names/values from the ${isMultiPage ? 'screenshots' : 'screenshot'}
- Keep the same narrative structure and customer-specific framing
- If a metric or value is visible, cite it specifically
${isMultiPage ? '- For each Key Moment in the SHOW section, use data from the corresponding labeled screenshot\n- Preserve the Key Moment structure (Opening screen, Key moment 1, Key moment 2, etc.)' : ''}
- Preserve markdown formatting`;

    const contentParts = [{ type: 'text', text: prompt }];
    for (const shot of screenshotList) {
      if (isMultiPage) {
        contentParts.push({ type: 'text', text: `\n--- Screenshot for: ${shot.label} ---` });
      }
      contentParts.push({ type: 'image_url', image_url: { url: shot.dataUrl, detail: 'high' } });
    }

    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: isMultiPage ? 6000 : 4000,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: contentParts
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Refinement API call failed: ${response.status}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty refinement response');

    const cleaned = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  }

  getUserErrorMessage(error) {
    const message = error.message.toLowerCase();

    if (message.includes('api key')) {
      return 'Invalid API key. Please check your OpenAI API key in settings.';
    }

    if (message.includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    }

    if (message.includes('quota')) {
      return 'API quota exceeded. Please check your OpenAI account billing.';
    }

    if (message.includes('network') || message.includes('fetch')) {
      return 'Network error. Please check your internet connection.';
    }

    if (message.includes('timeout')) {
      return 'Request timed out. The page may be too large. Try again or use a smaller screenshot.';
    }

    return `Error generating talk track: ${error.message}`;
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIService;
}
