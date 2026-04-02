// Initialize Datadog RUM (loaded via CDN in sidepanel.html)
window.DD_RUM && window.DD_RUM.init({
    applicationId: '936722d5-37e8-4cd4-a5ae-68f46c76a6f7',
    clientToken: 'pub6073faa971d344833e0b3bacd3e2dc2e',
    site: 'datadoghq.com',
    service: 'demobuddy',
    env: 'localhost',
    // Specify a version number to identify the deployed version of your application in Datadog
    // version: '1.0.0',
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    trackBfcacheViews: true,
    defaultPrivacyLevel: 'allow',
});

// Side panel logic
class TalkTrackApp {
  constructor() {
    this.currentUrl = '';
    this.talkTracks = [];
    this.aiMode = false;
    this.editMode = false;
    this.editingTrack = null; // Track being edited/created
    this.selectedPersona = null;
    this.generatedContent = null;
    this.categories = [];
    this.customers = []; // Customer profiles
    this.selectedCustomer = null; // Currently selected customer for demo
    this.baseUrl = 'https://app.datadoghq.com'; // Default base URL
    this.quillEditor = null; // Quill editor instance
    this.aiService = new AIService();
    this.screenshotService = new ScreenshotService();
    this.storageManager = null; // Will be initialized in initCloudSync
    this.syncStatus = { configured: false, lastSync: null, pendingChanges: false };
    this.docContextText = ''; // Documentation text for AI context
    this.docUrls = ''; // Documentation URLs for "Learn More" section
    this.selectedDemoTag = null; // Persisted tag filter for demo flows
    this.speechService = null; // Speech-to-text service
    this.formatAsBullets = false; // Toggle for formatting transcripts as bullets

    // Demo Plan mode state
    this.demoPlanView = null; // null | 'authoring' | 'demo'
    this.demoPlanService = new DemoPlanService();
    this.availablePlans = [];
    this.activePlan = null;
    this.activeLoops = [];
    this.selectedLoopIndex = -1;
    this.editingLoopPhase = null; // { loopIndex, phase } when inline-editing
    this.refiningLoop = false;
    this.activeKeyMomentIndex = -1;
    this._urlPollInterval = null;

    this.init();
  }

  async init() {
    this.render();
    await this.loadSettings();
    // Initialize storage manager FIRST so loadTalkTracks uses IndexedDB
    await this.initCloudSync();
    await this.loadTalkTracks();
    await this.loadCategories();
    await this.loadPersonas();
    await this.loadCustomers();
    await this.loadSelectedDemoTag();
    await this.getCurrentTabUrl();
    this.setupListeners();
    this.initSpeechService();
  }

  /**
   * Initialize speech-to-text service
   */
  async initSpeechService() {
    // Check if Web Speech API or audio recording is supported
    if (!SpeechService.isSupported() && !SpeechService.isAudioSupported()) {
      console.warn('[TalkTrackApp] Speech recognition not supported');
      return;
    }

    this.speechService = new SpeechService();
    
    // Check for OpenAI API key and enable Whisper mode if available
    try {
      const result = await chrome.storage.local.get(['openaiApiKey']);
      if (result.openaiApiKey) {
        this.speechService.setWhisperMode(result.openaiApiKey);
        console.log('[TalkTrackApp] Whisper mode enabled (better punctuation)');
      }
    } catch (error) {
      console.warn('[TalkTrackApp] Could not check for API key:', error);
    }
    
    this.speechService.onResult = (result) => {
      if (result.isFinal && result.final) {
        this.insertTranscription(result.final);
      }
    };

    this.speechService.onError = (error) => {
      console.error('[TalkTrackApp] Speech error:', error);
      let message = 'Speech recognition error';
      if (error === 'microphone-denied') {
        message = 'Microphone access denied';
      } else if (error === 'transcription-failed') {
        message = 'Transcription failed - check API key';
      }
      this.showNotification(message, 'error');
      this.updateMicButtonState('idle');
    };

    this.speechService.onEnd = () => {
      this.updateMicButtonState('idle');
    };

    this.speechService.onStart = () => {
      this.updateMicButtonState('recording');
    };

    this.speechService.onProcessing = (isProcessing) => {
      this.updateMicButtonState(isProcessing ? 'processing' : 'idle');
    };

    console.log('[TalkTrackApp] Speech service initialized');
  }

  /**
   * Update the mic button visual state
   * @param {string} state - 'idle', 'recording', or 'processing'
   */
  updateMicButtonState(state) {
    const micBtn = document.getElementById('micDictateBtn');
    if (!micBtn) return;

    // Remove all state classes
    micBtn.classList.remove('listening', 'processing');
    
    switch (state) {
      case 'recording':
        micBtn.classList.add('listening');
        micBtn.textContent = '🔴';
        micBtn.title = 'Stop recording';
        micBtn.disabled = false;
        break;
      case 'processing':
        micBtn.classList.add('processing');
        micBtn.textContent = '⏳';
        micBtn.title = 'Transcribing...';
        micBtn.disabled = true;
        break;
      default: // idle
        micBtn.textContent = '🎤';
        const mode = this.speechService?.getMode();
        micBtn.title = mode === 'whisper' 
          ? 'Start dictation (Whisper - better punctuation)' 
          : 'Start dictation';
        micBtn.disabled = false;
    }
  }

  /**
   * Toggle speech dictation on/off
   */
  async toggleDictation() {
    if (!this.speechService) {
      this.showNotification('Speech recognition not available', 'error');
      return;
    }

    // Don't allow toggling while processing
    if (this.speechService.isTranscribing()) {
      return;
    }

    if (this.speechService.isListening()) {
      this.speechService.stopListening();
      const mode = this.speechService.getMode();
      if (mode === 'whisper') {
        this.showNotification('Processing audio...');
      }
    } else {
      const success = await this.speechService.startListening();
      if (success) {
        const mode = this.speechService.getMode();
        const message = mode === 'whisper' 
          ? 'Recording... click again to transcribe' 
          : 'Listening... speak now';
        this.showNotification(message);
      }
    }
  }

  /**
   * Insert transcribed text into the Quill editor at cursor position
   */
  async insertTranscription(text) {
    if (!this.quillEditor || !text) return;

    let textToInsert = text;

    // Format as bullets if toggle is on
    if (this.formatAsBullets) {
      this.updateMicButtonState('processing');
      try {
        textToInsert = await this.formatTranscriptAsBullets(text);
      } catch (error) {
        console.error('[TalkTrackApp] Formatting failed, using raw text:', error);
        this.showNotification('Formatting failed, using raw text', 'error');
      }
      this.updateMicButtonState('idle');
    }

    // Get current selection or end of document
    const range = this.quillEditor.getSelection(true);
    const insertIndex = range ? range.index : this.quillEditor.getLength() - 1;

    // Check if we need a newline before bullets
    const currentText = this.quillEditor.getText();
    const charBefore = currentText[insertIndex - 1];
    const needsNewline = this.formatAsBullets && charBefore && charBefore !== '\n';
    const needsSpace = !this.formatAsBullets && charBefore && charBefore !== ' ' && charBefore !== '\n';
    
    const prefix = needsNewline ? '\n' : (needsSpace ? ' ' : '');
    const finalText = prefix + textToInsert;

    // Insert the transcribed text
    this.quillEditor.insertText(insertIndex, finalText, 'user');
    
    // Move cursor to end of inserted text
    this.quillEditor.setSelection(insertIndex + finalText.length, 0);
    
    console.log('[TalkTrackApp] Inserted transcription:', finalText);
  }

  /**
   * Format transcript text as bullet points using GPT
   */
  async formatTranscriptAsBullets(text) {
    // Get API key
    const result = await chrome.storage.local.get(['openaiApiKey']);
    const apiKey = result.openaiApiKey;

    if (!apiKey) {
      throw new Error('No API key available');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a formatting assistant. Convert the user's spoken transcript into clean, concise bullet points.

Rules:
- Each bullet should be one clear talking point
- Remove filler words (um, uh, like, you know, basically, so)
- Fix grammar and add proper punctuation
- Keep the original meaning and key terms intact
- Use "- " for each bullet (markdown format)
- Keep bullets concise (aim for 1-2 lines each)
- Do NOT add any introduction or commentary, just output the bullets
- If the text is very short (one idea), output a single bullet`
          },
          {
            role: 'user',
            content: text
          }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const formatted = data.choices?.[0]?.message?.content?.trim();

    if (!formatted) {
      throw new Error('No formatted content returned');
    }

    console.log('[TalkTrackApp] Formatted transcript:', formatted);
    return formatted;
  }

  async loadSelectedDemoTag() {
    try {
      const result = await chrome.storage.local.get(['selectedDemoTag']);
      this.selectedDemoTag = result.selectedDemoTag || null;
    } catch (error) {
      console.error('Error loading selected demo tag:', error);
      this.selectedDemoTag = null;
    }
  }

  async setSelectedDemoTag(tag) {
    this.selectedDemoTag = tag || null;
    await chrome.storage.local.set({ selectedDemoTag: this.selectedDemoTag });
    this.render();
  }

  /**
   * Get all unique tags from all tracks
   */
  getAllUniqueTags() {
    const tagsSet = new Set();
    for (const track of this.talkTracks) {
      if (track.tags && Array.isArray(track.tags)) {
        for (const tag of track.tags) {
          if (tag && typeof tag === 'string') {
            tagsSet.add(tag.toLowerCase());
          }
        }
      }
    }
    return Array.from(tagsSet).sort();
  }

  async initCloudSync() {
    try {
      // Use the new StorageManagerV2 singleton (IndexedDB-based)
      if (typeof storageManager === 'undefined') {
        console.warn('StorageManagerV2 not available');
        this.storageManager = null;
        return;
      }
      
      this.storageManager = storageManager;
      await this.storageManager.init();
      await this.updateSyncStatus();
      
      // Listen for storage events
      this.storageManager.addListener((eventType, data) => {
        this.handleSyncEvent(eventType, data);
      });
      
      console.log('[TalkTrackApp] Storage initialized with IndexedDB');
    } catch (error) {
      console.error('Storage init error:', error);
      // Don't let storage errors break the app
      this.storageManager = null;
    }
  }

  handleSyncEvent(eventType, data) {
    switch (eventType) {
      case 'syncCompleted':
      case 'syncError':
      case 'pendingSync':
      case 'configured':
      case 'disconnected':
      case 'syncEnabled':
      case 'syncDisabled':
        this.updateSyncStatus();
        break;
      case 'migrationComplete':
        console.log('[TalkTrackApp] Migration complete:', data);
        this.showNotification(data.message || 'Data migrated successfully');
        this.loadTalkTracks();
        break;
      case 'saved':
      case 'trackSaved':
      case 'trackDeleted':
        // Refresh tracks display
        this.loadTalkTracks();
        break;
    }
  }

  async updateSyncStatus() {
    try {
      if (!this.storageManager) {
        this.syncStatus = { configured: false, lastSync: null, pendingChanges: false };
        this.renderSyncIndicator();
        return;
      }
      
      const status = await this.storageManager.getSyncStatus();
      this.syncStatus = {
        configured: status.isConfigured,
        lastSync: status.lastSync,
        pendingChanges: status.pendingChanges,
        syncInProgress: status.syncInProgress
      };
      this.renderSyncIndicator();
    } catch (error) {
      console.error('Error updating sync status:', error);
    }
  }

  renderSyncIndicator() {
    const indicator = document.getElementById('syncIndicator');
    if (!indicator) return;

    if (!this.syncStatus.configured) {
      indicator.innerHTML = '';
      indicator.title = 'Cloud sync not configured';
      return;
    }

    let icon = '☁️';
    let statusClass = 'synced';
    let title = 'Synced to cloud';

    if (this.syncStatus.syncInProgress) {
      icon = '🔄';
      statusClass = 'syncing';
      title = 'Syncing...';
    } else if (this.syncStatus.pendingChanges) {
      icon = '⏳';
      statusClass = 'pending';
      title = 'Changes pending sync';
    } else if (this.syncStatus.lastSync) {
      const lastSyncDate = new Date(this.syncStatus.lastSync);
      title = `Last synced: ${lastSyncDate.toLocaleString()}`;
    }

    indicator.innerHTML = `<span class="sync-icon ${statusClass}">${icon}</span>`;
    indicator.title = title;
  }

  /**
   * Save tracks using IndexedDB storage
   */
  async saveTracksWithSync(reason = 'Manual save') {
    try {
      console.log(`[SAVE] Starting save: ${reason}`);
      console.log(`[SAVE] Tracks to save:`, JSON.stringify(this.talkTracks.map(t => ({ id: t.id, title: t.title }))));
      
      if (this.storageManager) {
        // Use IndexedDB via StorageManagerV2
        await this.storageManager.saveTracks(this.talkTracks, { reason });
        console.log(`[SAVE] Saved ${this.talkTracks.length} tracks to IndexedDB`);
      } else {
        // Fallback to chrome.storage.local
        await chrome.storage.local.set({ talkTracks: this.talkTracks });
        console.log(`[SAVE] Saved ${this.talkTracks.length} tracks to chrome.storage.local (fallback)`);
      }
      
      // Verify the save worked
      const verification = this.storageManager 
        ? await this.storageManager.loadTracks()
        : (await chrome.storage.local.get(['talkTracks'])).talkTracks || [];
      
      console.log(`[SAVE] Verification - stored ${verification.length} tracks`);
      
      if (verification.length !== this.talkTracks.length) {
        console.error('[SAVE] MISMATCH: Save verification failed!');
      }
      
      this.updateSyncStatus();
    } catch (error) {
      console.error('[SAVE] Error saving tracks:', error);
      alert('Error saving track: ' + error.message);
      throw error;
    }
  }

  async loadSettings() {
    const result = await chrome.storage.local.get(['baseUrl']);
    this.baseUrl = result.baseUrl || 'https://app.datadoghq.com';
  }

  async loadCategories() {
    const defaultCategories = [
      'Dashboards', 'APM', 'Logs', 'Infrastructure',
      'RUM', 'Synthetics', 'Security', 'Monitors', 'Other'
    ];
    
    const result = await chrome.storage.local.get(['customCategories']);
    const customCategories = result.customCategories || [];
    
    this.categories = [...defaultCategories, ...customCategories];
  }

  async loadCustomers() {
    try {
      if (this.storageManager) {
        this.customers = await this.storageManager.getCustomers();
        const selectedId = await this.storageManager.getSetting('selectedCustomerId');
        if (selectedId) {
          this.selectedCustomer = this.customers.find(c => c.id === selectedId) || null;
        }
      } else {
        // Fallback
        const result = await chrome.storage.local.get(['customers', 'selectedCustomerId']);
        this.customers = result.customers || [];
        if (result.selectedCustomerId) {
          this.selectedCustomer = this.customers.find(c => c.id === result.selectedCustomerId) || null;
        }
      }
    } catch (error) {
      console.error('Error loading customers:', error);
      this.customers = [];
    }
  }

  async setSelectedCustomer(customerId) {
    this.selectedCustomer = customerId ? this.customers.find(c => c.id === customerId) : null;
    if (this.storageManager) {
      await this.storageManager.setSetting('selectedCustomerId', customerId || null);
    } else {
      await chrome.storage.local.set({ selectedCustomerId: customerId || null });
    }
    this.render();
  }

  getCustomerById(id) {
    return this.customers.find(c => c.id === id);
  }

  isMatchingBaseUrl(url) {
    if (!url || !this.baseUrl) return false;
    try {
      const urlObj = new URL(url);
      const baseObj = new URL(this.baseUrl);
      return urlObj.hostname.includes(baseObj.hostname.replace('www.', ''));
    } catch {
      return url.includes(this.baseUrl);
    }
  }

  async loadPersonas() {
    const defaultPersonas = [
      {
        id: 'sales-engineer',
        name: 'Sales Engineer',
        description: 'Focus on features, benefits, ROI, competitive advantages, and customer success stories'
      },
      {
        id: 'solutions-architect',
        name: 'Solutions Architect',
        description: 'Emphasize technical architecture, integrations, scalability, and implementation best practices'
      },
      {
        id: 'executive-briefing',
        name: 'Executive Briefing',
        description: 'High-level business value, strategic benefits, time-to-value, and key metrics'
      },
      {
        id: 'technical-deep-dive',
        name: 'Technical Deep Dive',
        description: 'In-depth technical details, APIs, data models, query languages, and advanced features'
      },
      {
        id: 'customer-success',
        name: 'Customer Success',
        description: 'Onboarding guidance, best practices, tips and tricks, common pitfalls, and support resources'
      }
    ];

    const result = await chrome.storage.local.get(['customPersonas']);
    const customPersonas = result.customPersonas || [];
    
    this.personas = [...defaultPersonas, ...customPersonas];
    this.selectedPersona = this.personas[0]; // Default to first persona
  }

  async loadTalkTracks() {
    console.log('[LOAD] Loading talk tracks... storageManager available:', !!this.storageManager);
    try {
      // Use IndexedDB storage via StorageManagerV2
      if (this.storageManager) {
        console.log('[LOAD] Using IndexedDB via storageManager');
        this.talkTracks = await this.storageManager.loadTracks();
      } else {
        // Fallback to chrome.storage.local if StorageManager not ready
        console.warn('[LOAD] WARNING: storageManager not available, using chrome.storage.local fallback');
        const result = await chrome.storage.local.get(['talkTracks']);
        this.talkTracks = result.talkTracks || [];
      }
      console.log(`[LOAD] Loaded ${this.talkTracks.length} tracks from ${this.storageManager ? 'IndexedDB' : 'chrome.storage'}`);
    } catch (error) {
      console.error('[LOAD] Error loading tracks:', error);
      // Fallback to chrome.storage.local
      const result = await chrome.storage.local.get(['talkTracks']);
      this.talkTracks = result.talkTracks || [];
    }
    this.render();
  }

  async getCurrentTabUrl() {
    try {
      // Request the initial URL from the background script
      // This is the URL of the tab where the extension icon was clicked
      const response = await chrome.runtime.sendMessage({ type: 'GET_INITIAL_URL' });
      
      if (response && response.url) {
        console.log('[getCurrentTabUrl] Got initial URL from background:', response.url);
        this.updateUrl(response.url);
        return;
      }
      
      console.warn('[getCurrentTabUrl] No initial URL available from background');
      
      // Fallback: try to find any valid browser tab URL
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      for (const window of windows) {
        const activeTab = window.tabs.find(tab => tab.active);
        if (activeTab && activeTab.url && 
            !activeTab.url.startsWith('chrome-extension://') && 
            !activeTab.url.startsWith('chrome://') &&
            !activeTab.url.startsWith('about:')) {
          console.log('[getCurrentTabUrl] Fallback - Found tab URL:', activeTab.url);
          this.updateUrl(activeTab.url);
          return;
        }
      }
      
      console.warn('[getCurrentTabUrl] No valid browser tab URL found');
    } catch (error) {
      console.error('[getCurrentTabUrl] Error:', error);
    }
  }

  /**
   * Manually refresh the current URL from the active browser tab
   * Useful if automatic URL detection failed
   */
  async refreshCurrentUrl() {
    this.showNotification('Refreshing URL...');
    try {
      // Try to get URL from background's tracked tab first
      const response = await chrome.runtime.sendMessage({ type: 'GET_TRACKED_TAB' });
      if (response && response.tab && response.tab.url) {
        console.log('[refreshCurrentUrl] Got URL from tracked tab:', response.tab.url);
        this.updateUrl(response.tab.url);
        this.showNotification('URL refreshed!');
        return;
      }

      // Fallback: scan browser windows
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      for (const window of windows) {
        if (window.focused) {
          const activeTab = window.tabs.find(tab => tab.active);
          if (activeTab && activeTab.url && 
              !activeTab.url.startsWith('chrome-extension://') && 
              !activeTab.url.startsWith('chrome://')) {
            console.log('[refreshCurrentUrl] Found URL from focused window:', activeTab.url);
            this.updateUrl(activeTab.url);
            this.showNotification('URL refreshed!');
            return;
          }
        }
      }

      // Last resort: any active tab
      for (const window of windows) {
        const activeTab = window.tabs.find(tab => tab.active);
        if (activeTab && activeTab.url && 
            !activeTab.url.startsWith('chrome-extension://') && 
            !activeTab.url.startsWith('chrome://')) {
          console.log('[refreshCurrentUrl] Found URL from any window:', activeTab.url);
          this.updateUrl(activeTab.url);
          this.showNotification('URL refreshed!');
          return;
        }
      }

      this.showNotification('Could not detect URL', 'error');
    } catch (error) {
      console.error('[refreshCurrentUrl] Error:', error);
      this.showNotification('Error refreshing URL', 'error');
    }
  }

  setupListeners() {
    // Listen for URL updates from background script
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'UPDATE_URL') {
        this.updateUrl(message.url);
      }
    });

    // Listen for storage changes - reload from IndexedDB when tracks are updated
    chrome.storage.onChanged.addListener((changes) => {
      // Listen for the update signal from options page
      if (changes.tracksLastUpdated) {
        console.log('[STORAGE CHANGE] Tracks update signal received from:', changes.tracksUpdateSource?.newValue || 'unknown');
        console.log('[STORAGE CHANGE] Reloading tracks from IndexedDB...');
        this.loadTalkTracks();
      }
      // Also catch direct talkTracks changes (legacy fallback)
      if (changes.talkTracks) {
        console.log('[STORAGE CHANGE] chrome.storage.talkTracks changed - reloading from IndexedDB for consistency');
        this.loadTalkTracks();
      }
      if (changes.customPersonas) {
        this.loadPersonas();
      }
      if (changes.customers) {
        this.customers = changes.customers.newValue || [];
        // Clear selection if customer was deleted
        if (this.selectedCustomer && !this.customers.find(c => c.id === this.selectedCustomer.id)) {
          this.selectedCustomer = null;
        }
        if (!this.aiMode && !this.editMode) {
          this.render();
        }
      }
    });

    // Reload data when sidepanel becomes visible (user switches back from options)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[SIDEPANEL] Became visible, reloading tracks from IndexedDB...');
        this.loadTalkTracks();
        this.loadCustomers();
      }
    });

    // Listen for screenshot progress updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SCREENSHOT_PROGRESS') {
        this.updateCaptureProgress(message);
      }
    });

    // Delegated click handler for navigation buttons
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('nav-button')) {
        e.preventDefault();
        const url = e.target.getAttribute('data-nav-url');
        if (url) {
          this.navigateActiveTab(url);
        }
      }
    });
  }

  /**
   * Navigate the active browser tab to a new URL
   */
  async navigateActiveTab(url) {
    try {
      // Send message to background script to navigate the active tab
      const response = await chrome.runtime.sendMessage({
        type: 'NAVIGATE_TAB',
        url: url
      });
      
      if (!response?.success) {
        console.error('Navigation failed:', response?.error);
        this.showNotification('Navigation failed', 'error');
      }
    } catch (error) {
      console.error('Error navigating tab:', error);
      this.showNotification('Navigation failed', 'error');
    }
  }

  /**
   * Show a brief notification
   */
  showNotification(message, type = 'success') {
    const existing = document.querySelector('.popup-notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = 'popup-notification';
    notification.textContent = message;
    if (type === 'error') {
      notification.style.backgroundColor = '#dc3545';
    }
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 2000);
  }

  toggleAiMode() {
    this.aiMode = !this.aiMode;
    this.editMode = false;
    this.render();
  }

  async enterEditMode(track = null) {
    this.editMode = true;
    this.aiMode = false;
    
    if (track) {
      // Editing existing track
      this.editingTrack = { ...track };
    } else {
      // Creating new track - get page title from active tab
      let pageTitle = '';
      try {
        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
        for (const window of windows) {
          const activeTab = window.tabs.find(tab => tab.active);
          if (activeTab && activeTab.title) {
            pageTitle = activeTab.title;
            // Clean up common suffixes
            pageTitle = pageTitle
              .replace(/\s*[-|–]\s*Datadog$/i, '')
              .replace(/\s*[-|–]\s*Google Docs$/i, '')
              .replace(/\s*[-|–]\s*Google Sheets$/i, '')
              .trim();
            break;
          }
        }
      } catch (error) {
        console.log('Could not get page title:', error);
      }
      
      this.editingTrack = {
        id: null,
        title: pageTitle,
        category: this.inferCategory(this.currentUrl),
        urlPattern: this.createUrlPattern(this.currentUrl),
        content: '',
        customerId: this.selectedCustomer?.id || null, // Tag with selected customer
        tags: [] // Demo flow tags
      };
    }
    
    this.render();
  }

  exitEditMode() {
    // Stop dictation if active
    if (this.speechService?.isListening()) {
      this.speechService.stopListening();
    }
    // Clean up Quill editor properly
    if (this.quillEditor) {
      this.quillEditor.off('text-change');
      this.quillEditor = null;
    }
    this.editMode = false;
    this.editingTrack = null;
    this.render();
  }

  /**
   * Create a customer-specific version of a generic track
   * Copies the generic track's content and opens edit mode for the customer-specific version
   * @param {Object} genericTrack - The generic track to customize
   */
  customizeForCustomer(genericTrack) {
    if (!genericTrack || !this.selectedCustomer) {
      console.error('[customizeForCustomer] Missing track or customer');
      return;
    }

    this.editMode = true;
    this.aiMode = false;

    // Create a new track based on the generic one, but for the selected customer
    this.editingTrack = {
      id: null, // New track
      title: genericTrack.title || '',
      category: genericTrack.category || this.inferCategory(this.currentUrl),
      urlPattern: genericTrack.urlPattern || this.createUrlPattern(this.currentUrl),
      content: genericTrack.content || '',
      customerId: this.selectedCustomer.id, // Tag with selected customer
      tags: genericTrack.tags ? [...genericTrack.tags] : [] // Copy tags
    };

    console.log(`[customizeForCustomer] Creating customized track for ${this.selectedCustomer.name} from generic track: ${genericTrack.title}`);
    
    this.render();
  }

  initQuillEditor() {
    const container = document.getElementById('quillEditorPopup');
    if (!container) return;

    // Initialize Quill with a compact toolbar for popup
    this.quillEditor = new Quill(container, {
      theme: 'snow',
      placeholder: 'Write your talk track here...',
      modules: {
        toolbar: {
          container: [
            [{ 'header': [2, 3, false] }],
            ['bold', 'italic', 'underline'],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            ['blockquote'],
            ['link', 'insertNavLink'],
            ['clean']
          ],
          handlers: {
            'insertNavLink': () => this.insertNavigationLink()
          }
        }
      }
    });

    // Add tooltip to the custom button
    const navLinkBtn = document.querySelector('.ql-insertNavLink');
    if (navLinkBtn) {
      navLinkBtn.title = 'Insert Navigation Link';
    }

    // Load initial content using Quill's clipboard for proper Delta conversion
    if (this.editingTrack?.content) {
      const html = ContentConverter.markdownToHtml(this.editingTrack.content);
      console.log('Loading HTML into Quill:', html);
      
      try {
        // Use Quill's clipboard module for proper conversion to Delta format
        // Quill 2.x uses clipboard.convert({ html }), older versions use clipboard.convert(html)
        let delta;
        if (typeof this.quillEditor.clipboard.convert === 'function') {
          try {
            delta = this.quillEditor.clipboard.convert({ html });
          } catch (e) {
            // Fallback for older Quill versions
            delta = this.quillEditor.clipboard.convert(html);
          }
        }
        
        if (delta) {
          this.quillEditor.setContents(delta, 'silent');
        } else {
          // Ultimate fallback - use pasteHTML
          this.quillEditor.root.innerHTML = html;
        }
      } catch (error) {
        console.warn('Error loading content into Quill, using fallback:', error);
        this.quillEditor.root.innerHTML = html;
      }
    }

    // Track changes
    this.quillEditor.on('text-change', () => {
      if (this.editingTrack) {
        // Store HTML temporarily
        this.editingTrack._quillHtml = this.quillEditor.root.innerHTML;
      }
    });
  }

  validateUrlPattern(pattern) {
    if (!pattern || !this.currentUrl) {
      return { valid: false, matches: false, message: 'Enter a URL pattern' };
    }
    
    try {
      // Check if pattern matches current URL
      const matches = this.urlMatches(this.currentUrl, pattern);
      
      return {
        valid: true,
        matches: matches,
        message: matches 
          ? '✅ Pattern matches current page!' 
          : '❌ Pattern does NOT match current page'
      };
    } catch (error) {
      return {
        valid: false,
        matches: false,
        message: '⚠️ Invalid pattern syntax'
      };
    }
  }

  updateEditingTrack(field, value) {
    if (this.editingTrack) {
      this.editingTrack[field] = value;
      
      // Re-render validation if URL pattern changed
      if (field === 'urlPattern') {
        this.updateUrlValidation();
      }
    }
  }

  updateUrlValidation() {
    const validationEl = document.getElementById('urlPatternValidation');
    if (validationEl && this.editingTrack) {
      const validation = this.validateUrlPattern(this.editingTrack.urlPattern);
      validationEl.innerHTML = `
        <span class="${validation.matches ? 'validation-success' : 'validation-error'}">
          ${validation.message}
        </span>
      `;
    }
  }

  async saveEditingTrack() {
    if (!this.editingTrack) return;
    
    // Validate
    if (!this.editingTrack.urlPattern.trim()) {
      alert('Please enter a URL pattern');
      return;
    }
    
    // Get content from Quill editor
    if (this.quillEditor) {
      const html = this.quillEditor.root.innerHTML;
      
      // DETAILED DEBUG OUTPUT
      console.log('=== SAVE DEBUG START ===');
      console.log('Raw Quill HTML:');
      console.log(html);
      console.log('---');
      
      // Check for ql-indent classes
      const hasIndent = html.includes('ql-indent');
      console.log('Has ql-indent classes:', hasIndent);
      
      // Check for data-list attributes
      const hasDataList = html.includes('data-list');
      console.log('Has data-list attributes:', hasDataList);
      
      // Debug the HTML structure
      ContentConverter.debugHtml(html);
      
      // Convert HTML to markdown for storage
      const markdown = ContentConverter.htmlToMarkdown(html);
      console.log('---');
      console.log('Converted Markdown:');
      console.log(markdown);
      console.log('=== SAVE DEBUG END ===');
      
      // Store both for backup
      this.editingTrack.content = markdown;
      this.editingTrack.htmlBackup = html; // Keep HTML backup in case conversion has issues
    }
    
    // Get title, category, customer, and tags from form
    const titleInput = document.getElementById('editTitle');
    const categorySelect = document.getElementById('editCategory');
    const customerSelect = document.getElementById('editCustomer');
    const tagsInput = document.getElementById('editTags');
    if (titleInput) this.editingTrack.title = titleInput.value.trim();
    if (categorySelect) this.editingTrack.category = categorySelect.value;
    if (customerSelect) this.editingTrack.customerId = customerSelect.value || null;
    if (tagsInput) {
      this.editingTrack.tags = tagsInput.value
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);
    }
    
    const isNew = !this.editingTrack.id;
    
    if (this.editingTrack.id) {
      // Update existing track
      const index = this.talkTracks.findIndex(t => t.id === this.editingTrack.id);
      if (index !== -1) {
        this.talkTracks[index] = { ...this.editingTrack };
      }
    } else {
      // Create new track
      this.editingTrack.id = Date.now();
      this.editingTrack.order = this.talkTracks.length;
      this.talkTracks.push(this.editingTrack);
    }
    
    await this.saveTracksWithSync(isNew ? 'Created new track' : 'Updated track');
    
    console.log('Saved track:', this.editingTrack);
    this.showNotification(isNew ? 'New talk track created!' : 'Talk track saved!');
    this.exitEditMode();
  }

  async captureAndGenerate() {
    try {
      console.log('[Sidepanel] Starting AI generation...');
      
      // Check for API key
      const result = await chrome.storage.local.get(['openaiApiKey']);
      const apiKey = result.openaiApiKey;

      if (!apiKey) {
        this.showError('No API key configured. Please add your OpenAI API key in the extension options.');
        return;
      }

      console.log('[Sidepanel] API key found, showing loading...');
      
      // Show loading with step progress
      this.showLoading(true, 'Preparing...');

      // Get the tab that was tracked when the extension was opened or when focus changed
      // First, ask background script for the currently tracked tab
      let targetTab = null;
      
      try {
        const trackedResponse = await chrome.runtime.sendMessage({ type: 'GET_TRACKED_TAB' });
        if (trackedResponse && trackedResponse.tab) {
          targetTab = trackedResponse.tab;
          console.log('[Sidepanel] Got tracked tab from background:', targetTab.id, targetTab.url);
        }
      } catch (e) {
        console.log('[Sidepanel] Could not get tracked tab, falling back to window search');
      }

      // Fallback: Get active tab from normal browser windows (not popup)
      if (!targetTab) {
        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
        console.log('[Sidepanel] Found', windows.length, 'normal windows');
        
        for (const window of windows) {
          console.log('[Sidepanel] Checking window', window.id, 'focused:', window.focused);
          const activeTab = window.tabs.find(tab => tab.active);
          if (activeTab) {
            console.log('[Sidepanel] Window', window.id, 'active tab:', activeTab.id, activeTab.url?.substring(0, 60));
          }
          if (activeTab && activeTab.url && this.isMatchingBaseUrl(activeTab.url)) {
            targetTab = activeTab;
            console.log('[Sidepanel] Selected tab (matching base URL):', targetTab.id);
            break;
          }
        }

        if (!targetTab) {
          // Fall back to any active tab if no matching base URL found
          for (const window of windows) {
            const activeTab = window.tabs.find(tab => tab.active);
            if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome://')) {
              targetTab = activeTab;
              console.log('[Sidepanel] Selected tab (fallback):', targetTab.id, targetTab.url?.substring(0, 60));
              break;
            }
          }
        }
      }

      if (!targetTab) {
        throw new Error('No active tab found. Please open a web page in a browser tab.');
      }

      console.log('[Sidepanel] Final target tab:', targetTab.id, targetTab.url);
      console.log('[Sidepanel] Tab window ID:', targetTab.windowId);

      // Show which tab we're capturing
      const tabTitle = targetTab.title || targetTab.url?.substring(0, 40) || 'Unknown';
      this.showNotification(`Capturing: ${tabTitle.substring(0, 30)}...`);

      // Request screenshot capture from background script
      console.log('[Sidepanel] Requesting FULL PAGE screenshot capture from background...');
      this.updateGenerationStep('capture', 'active', `Capturing "${tabTitle.substring(0, 25)}..."`);
      
      const response = await chrome.runtime.sendMessage({
        type: 'CAPTURE_SCREENSHOT',
        tabId: targetTab.id,
        fullPage: true  // Explicitly request full page capture
      });

      console.log('[Sidepanel] Screenshot response received:', response ? 'success' : 'null', 'dataUrl length:', response?.dataUrl?.length);

      if (!response || !response.dataUrl) {
        throw new Error('Screenshot capture failed: ' + (response?.error || 'Unknown error'));
      }

      console.log('Screenshot captured successfully, generating talk track...');
      this.updateGenerationStep('capture', 'done', 'Screenshot captured');

      // Prepare customer context if a customer is selected
      const customerContext = this.selectedCustomer ? {
        name: this.selectedCustomer.name,
        industry: this.selectedCustomer.industry,
        discoveryNotes: this.selectedCustomer.discoveryNotes
      } : null;

      // Prepare documentation context
      const docContext = {
        referenceText: this.docContextText?.trim() || '',
        docUrls: this.docUrls?.trim() ? this.docUrls.trim().split('\n').filter(url => url.trim()) : []
      };

      // Progress callback wired to the step UI
      const onProgress = (step, detail) => this.updateGenerationStep(step, 'active', detail);

      // Generate talk track (pass customer context if available)
      const generated = await this.aiService.generateTalkTrack(
        response.dataUrl,
        this.selectedPersona,
        this.currentUrl || targetTab.url,
        apiKey,
        customerContext,
        docContext,
        onProgress
      );

      this.updateGenerationStep('generate', 'done', 'Done');
      console.log('Talk track generated successfully', customerContext ? `(for ${customerContext.name})` : '(generic)');

      this.generatedContent = generated;
      this.showLoading(false);
      this.render();

    } catch (error) {
      console.error('AI generation error:', error);
      this.showLoading(false);
      this.showError(this.aiService.getUserErrorMessage(error));
    }
  }

  async saveGeneratedTrack(action = 'new') {
    if (!this.generatedContent) return;

    if (action === 'new') {
      // Create new track
      const category = this.inferCategory(this.currentUrl);
      const urlPattern = this.createUrlPattern(this.currentUrl);

      const newTrack = {
        id: Date.now(),
        title: this.generatedContent.title,
        category: category,
        urlPattern: urlPattern,
        content: this.generatedContent.content,
        customerId: this.selectedCustomer?.id || null, // Tag with selected customer
        order: this.talkTracks.length
      };

      this.talkTracks.push(newTrack);
      await this.saveTracksWithSync('AI generated track');
      const customerNote = this.selectedCustomer ? ` (for ${this.selectedCustomer.name})` : '';
      alert(`New talk track saved successfully${customerNote}!`);
      
    } else if (action === 'append') {
      // Append to existing track
      const existingTrack = this.findMatchingTalkTrack();
      
      if (!existingTrack) {
        alert('No existing track found to append to. Saving as new track instead.');
        await this.saveGeneratedTrack('new');
        return;
      }

      // Append with a separator
      existingTrack.content = existingTrack.content + '\n\n---\n\n' + this.generatedContent.content;
      await this.saveTracksWithSync('AI content appended');
      alert('Content appended to existing talk track!');
      
    } else if (action === 'replace') {
      // Replace existing track content
      const existingTrack = this.findMatchingTalkTrack();
      
      if (!existingTrack) {
        alert('No existing track found to replace. Saving as new track instead.');
        await this.saveGeneratedTrack('new');
        return;
      }

      if (!confirm(`Replace the content of "${existingTrack.title || 'Untitled Track'}"?`)) {
        return;
      }

      existingTrack.content = this.generatedContent.content;
      existingTrack.title = this.generatedContent.title || existingTrack.title;
      await this.saveTracksWithSync('AI replaced track');
      alert('Existing talk track replaced!');
    }

    // Reset AI mode
    this.generatedContent = null;
    this.aiMode = false;
    await this.loadTalkTracks();
    this.render();
  }

  inferCategory(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/dashboard')) return 'Dashboards';
    if (urlLower.includes('/apm')) return 'APM';
    if (urlLower.includes('/logs')) return 'Logs';
    if (urlLower.includes('/infrastructure')) return 'Infrastructure';
    if (urlLower.includes('/rum')) return 'RUM';
    if (urlLower.includes('/synthetics')) return 'Synthetics';
    if (urlLower.includes('/security')) return 'Security';
    if (urlLower.includes('/monitors')) return 'Monitors';
    return 'Other';
  }

  createUrlPattern(url) {
    try {
      const urlObj = new URL(url);
      let pattern = urlObj.pathname;
      
      // Replace specific IDs with wildcards
      pattern = pattern.replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/*');
      pattern = pattern.replace(/\/[a-z0-9]{20,}/gi, '/*');
      
      return '*' + pattern + '*';
    } catch {
      return '*' + url + '*';
    }
  }

  showLoading(show, message = null) {
    const loadingEl = document.getElementById('aiLoadingIndicator');
    const generateBtn = document.getElementById('captureGenerateBtn');
    const captureProgress = document.getElementById('captureProgress');
    
    if (loadingEl) {
      loadingEl.style.display = show ? 'block' : 'none';
    }
    if (generateBtn) {
      generateBtn.disabled = show;
      const customerText = this.selectedCustomer ? ` for ${this.escapeHtml(this.selectedCustomer.name)}` : '';
      generateBtn.textContent = show ? 'Generating...' : `📸 Capture & Generate${customerText}`;
    }
    if (!show && captureProgress) {
      captureProgress.style.display = 'none';
    }

    if (show) {
      this.resetGenerationSteps();
      if (message) this.updateGenerationStep('capture', 'active', message);
    }
  }

  /** Steps: capture | analyze | docs | generate. States: pending | active | done | skipped */
  updateGenerationStep(step, state, detail = '') {
    const STEPS = ['capture', 'analyze', 'docs', 'generate'];
    const icons = { pending: '○', active: '◉', done: '✓', skipped: '–' };

    // Mark all prior steps as done when a new step becomes active
    if (state === 'active') {
      const idx = STEPS.indexOf(step);
      for (let i = 0; i < idx; i++) {
        const prevIcon = document.getElementById(`stepIcon-${STEPS[i]}`);
        const prevStep = prevIcon?.closest('.gen-step');
        if (prevIcon && !prevStep?.classList.contains('skipped')) {
          prevIcon.textContent = icons.done;
          prevStep?.classList.remove('active');
          prevStep?.classList.add('done');
        }
      }
    }

    const iconEl = document.getElementById(`stepIcon-${step}`);
    const detailEl = document.getElementById(`stepDetail-${step}`);
    const stepEl = iconEl?.closest('.gen-step');

    if (iconEl) iconEl.textContent = icons[state] || icons.pending;
    if (detailEl) detailEl.textContent = detail;
    if (stepEl) {
      stepEl.classList.remove('pending', 'active', 'done', 'skipped');
      stepEl.classList.add(state);
    }
  }

  resetGenerationSteps() {
    const STEPS = ['capture', 'analyze', 'docs', 'generate'];
    for (const step of STEPS) {
      this.updateGenerationStep(step, 'pending', '');
    }
  }

  updateCaptureProgress(progress) {
    const captureProgress = document.getElementById('captureProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    if (captureProgress) {
      captureProgress.style.display = 'block';
    }
    if (progressFill && progress.total > 0) {
      const percent = (progress.current / progress.total) * 100;
      progressFill.style.width = `${percent}%`;
    }
    if (progressText && progress.message) {
      progressText.textContent = progress.message;
    }

    const detail = progress.total > 0
      ? `Section ${progress.current} of ${progress.total}`
      : (progress.message || 'Capturing...');
    this.updateGenerationStep('capture', 'active', detail);
  }

  showError(message) {
    const root = document.getElementById('root');
    const errorHtml = `
      <div class="ai-error">
        <p style="color: #dc3545; font-weight: 600;">⚠️ Error</p>
        <p>${message}</p>
      </div>
    `;
    
    // Show error temporarily
    const preview = document.getElementById('aiPreview');
    if (preview) {
      preview.innerHTML = errorHtml;
      preview.style.display = 'block';
      setTimeout(() => {
        preview.style.display = 'none';
      }, 5000);
    }
  }

  onPersonaChange(e) {
    const personaId = e.target.value;
    this.selectedPersona = this.personas.find(p => p.id === personaId);
  }

  updateUrl(url) {
    // Ignore extension URLs and chrome internal URLs
    if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) {
      console.log('[updateUrl] Ignoring internal URL:', url);
      return;
    }
    
    const urlChanged = this.currentUrl !== url;
    console.log('[updateUrl] Setting URL to:', url, urlChanged ? '(changed)' : '(unchanged)');
    this.currentUrl = url;
    if (urlChanged && this.demoPlanView) {
      this.autoMatchLoopToUrl();
    }
    this.render();
    
    // Add visual feedback for URL changes
    if (urlChanged) {
      this.highlightUrlChange();
    }
  }

  /**
   * Briefly highlight the URL display to show it updated
   */
  highlightUrlChange() {
    const urlDisplay = document.getElementById('currentUrlDisplay');
    if (urlDisplay) {
      urlDisplay.classList.add('url-updated');
      setTimeout(() => {
        urlDisplay.classList.remove('url-updated');
      }, 1000);
    }
  }

  findMatchingTalkTrack() {
    // Smart track matching with tag filter, customer priority, and pattern specificity:
    // 1. Find all matching tracks by URL
    // 2. If selectedDemoTag is set, filter to tracks with matching tag
    // 3. Sort by pattern specificity (more specific patterns first)
    // 4. If customer selected: find customer-specific track first
    // 5. Fall back to generic track if no customer-specific match
    // 6. Track if there are alternatives (for indicator)
    
    let matchingTracks = this.talkTracks.filter(track => 
      this.urlMatches(this.currentUrl, track.urlPattern)
    );
    
    console.log(`[URL Match] Current URL: ${this.currentUrl}`);
    console.log(`[URL Match] Found ${matchingTracks.length} matching tracks:`, 
      matchingTracks.map(t => ({ title: t.title, pattern: t.urlPattern, tags: t.tags, specificity: this.getPatternSpecificity(t.urlPattern) }))
    );
    
    if (matchingTracks.length === 0) return null;
    
    // Store count of all URL-matching tracks for alternative indicator
    const totalUrlMatches = matchingTracks.length;
    
    // Filter by selected demo tag if set
    if (this.selectedDemoTag) {
      const tagFilteredTracks = matchingTracks.filter(track => 
        track.tags && Array.isArray(track.tags) && 
        track.tags.map(t => t.toLowerCase()).includes(this.selectedDemoTag.toLowerCase())
      );
      
      console.log(`[URL Match] After tag filter (${this.selectedDemoTag}): ${tagFilteredTracks.length} tracks`);
      
      if (tagFilteredTracks.length > 0) {
        matchingTracks = tagFilteredTracks;
      } else {
        // No tracks with selected tag - fall back to tracks with no tags (generic)
        const genericTagTracks = matchingTracks.filter(track => 
          !track.tags || track.tags.length === 0
        );
        if (genericTagTracks.length > 0) {
          matchingTracks = genericTagTracks;
          console.log(`[URL Match] No tag match, using ${genericTagTracks.length} generic (untagged) tracks`);
        }
        // If still no match, keep all tracks as fallback
      }
    }
    
    // Sort by pattern specificity (higher = more specific)
    matchingTracks.sort((a, b) => {
      const specA = this.getPatternSpecificity(a.urlPattern);
      const specB = this.getPatternSpecificity(b.urlPattern);
      return specB - specA; // Descending - most specific first
    });
    
    console.log(`[URL Match] After sorting by specificity:`, 
      matchingTracks.map(t => ({ title: t.title, pattern: t.urlPattern, specificity: this.getPatternSpecificity(t.urlPattern) }))
    );
    
    let selectedTrack = null;
    
    if (this.selectedCustomer) {
      // Look for customer-specific track first
      const customerTrack = matchingTracks.find(track => 
        track.customerId === this.selectedCustomer.id
      );
      if (customerTrack) {
        console.log(`[URL Match] Selected customer-specific track: ${customerTrack.title}`);
        selectedTrack = customerTrack;
      } else {
        // Fall back to generic track
        const genericTrack = matchingTracks.find(track => !track.customerId);
        console.log(`[URL Match] Selected generic track: ${genericTrack?.title || 'none'}`);
        selectedTrack = genericTrack || null;
      }
    } else {
      // No customer selected - use generic tracks only
      const genericTrack = matchingTracks.find(track => !track.customerId);
      console.log(`[URL Match] Selected generic track: ${genericTrack?.title || 'none'}`);
      selectedTrack = genericTrack || null;
    }
    
    // Attach metadata about alternatives and fallback status
    if (selectedTrack) {
      selectedTrack._hasAlternatives = !this.selectedDemoTag && totalUrlMatches > 1;
      selectedTrack._alternativeCount = totalUrlMatches;
      // Flag if showing a generic track as fallback when customer is selected
      selectedTrack._isGenericFallback = this.selectedCustomer && !selectedTrack.customerId;
    }
    
    return selectedTrack;
  }

  /**
   * Calculate pattern specificity score
   * Higher score = more specific pattern
   * Factors: fewer wildcards, longer literal segments, exact path matches
   */
  getPatternSpecificity(pattern) {
    if (!pattern) return 0;
    
    let score = 0;
    
    // Longer patterns are generally more specific
    score += pattern.length;
    
    // Count wildcards (fewer = more specific)
    const wildcardCount = (pattern.match(/\*/g) || []).length;
    score -= wildcardCount * 20; // Heavy penalty for wildcards
    
    // Count path segments (more segments = more specific)
    const pathSegments = pattern.split('/').filter(s => s && s !== '*').length;
    score += pathSegments * 10;
    
    // Bonus for ending with specific path (not wildcard)
    if (!pattern.endsWith('*') && !pattern.endsWith('/')) {
      score += 15;
    }
    
    // Bonus for having literal text (not just wildcards)
    const literalLength = pattern.replace(/\*/g, '').length;
    score += literalLength * 2;
    
    return score;
  }

  urlMatches(url, pattern) {
    // Simple pattern matching - can be enhanced
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }
    return url.includes(pattern);
  }

  /**
   * Find tracks related to the current track by shared tags
   * If selectedDemoTag is set, only show tracks with that specific tag
   * Returns tracks ordered by their 'order' property (as in options page)
   */
  findRelatedTracksByTags(currentTrack) {
    // If a demo tag is selected, use that for filtering instead of current track's tags
    if (this.selectedDemoTag) {
      return this.findRelatedTracksBySelectedTag(currentTrack);
    }
    
    if (!currentTrack || !currentTrack.tags || currentTrack.tags.length === 0) {
      return { relatedTracks: [], flowTracks: [], currentIndex: 0 };
    }

    const currentTags = new Set(currentTrack.tags.map(t => t.toLowerCase()));
    const seenTrackIds = new Set();
    const relatedTracks = [];

    // Find all tracks that share at least one tag with the current track (excluding current)
    for (const track of this.talkTracks) {
      if (track.id === currentTrack.id) continue;
      if (!track.tags || track.tags.length === 0) continue;

      // Find matching tags
      const trackTags = track.tags.map(t => t.toLowerCase());
      const matchingTags = trackTags.filter(t => currentTags.has(t));

      if (matchingTags.length > 0 && !seenTrackIds.has(track.id)) {
        seenTrackIds.add(track.id);
        relatedTracks.push({
          ...track,
          matchingTags // Store which tags matched
        });
      }
    }

    // Create flow that includes current track + related tracks, sorted by order
    const flowTracks = [
      { ...currentTrack, matchingTags: currentTrack.tags, isCurrent: true },
      ...relatedTracks
    ].sort((a, b) => {
      // Sort by order property (as in options page)
      const orderA = typeof a.order === 'number' ? a.order : Infinity;
      const orderB = typeof b.order === 'number' ? b.order : Infinity;
      return orderA - orderB;
    });

    // Find the current track's index in the sorted flow
    const currentIndex = flowTracks.findIndex(t => t.isCurrent);

    return { relatedTracks, flowTracks, currentIndex };
  }

  /**
   * Find tracks related by the globally selected demo tag
   * Shows all tracks with the selected tag as the demo flow
   */
  findRelatedTracksBySelectedTag(currentTrack) {
    const selectedTag = this.selectedDemoTag.toLowerCase();
    
    // Find all tracks with the selected tag
    const taggedTracks = this.talkTracks.filter(track => 
      track.tags && Array.isArray(track.tags) && 
      track.tags.map(t => t.toLowerCase()).includes(selectedTag)
    );
    
    if (taggedTracks.length === 0) {
      return { relatedTracks: [], flowTracks: [], currentIndex: 0 };
    }
    
    // Sort by order property
    const sortedTracks = [...taggedTracks].sort((a, b) => {
      const orderA = typeof a.order === 'number' ? a.order : Infinity;
      const orderB = typeof b.order === 'number' ? b.order : Infinity;
      return orderA - orderB;
    });
    
    // Mark current track and build flow
    const flowTracks = sortedTracks.map(track => ({
      ...track,
      matchingTags: [selectedTag],
      isCurrent: currentTrack && track.id === currentTrack.id
    }));
    
    // Find current track's index (-1 if no track matches current page)
    const currentIndex = flowTracks.findIndex(t => t.isCurrent);
    
    // Related tracks excludes the current one
    const relatedTracks = flowTracks.filter(t => !t.isCurrent);
    
    // Return -1 for currentIndex if no track is current (user is on non-matching page)
    return { relatedTracks, flowTracks, currentIndex };
  }

  /**
   * Navigate to a related track by updating the URL in the browser
   */
  async navigateToTrack(track) {
    if (!track || !track.urlPattern) return;

    // Convert pattern to a navigable URL
    let targetUrl = track.urlPattern;
    
    // If pattern has wildcards, try to construct a reasonable URL
    if (targetUrl.includes('*')) {
      // Remove leading * and replace internal * with empty string
      targetUrl = targetUrl.replace(/^\*/, '').replace(/\*/g, '');
    }

    // Prepend base URL if it's a relative path
    if (!targetUrl.startsWith('http')) {
      targetUrl = this.baseUrl + targetUrl;
    }

    // Send message to background to navigate
    try {
      await chrome.runtime.sendMessage({
        type: 'NAVIGATE_TAB',
        url: targetUrl
      });
    } catch (error) {
      console.error('[TalkTrackApp] Navigation error:', error);
    }
  }

  getDisplayUrl() {
    try {
      const urlObj = new URL(this.currentUrl);
      return urlObj.pathname + urlObj.search;
    } catch {
      return this.currentUrl;
    }
  }

  openOptions() {
    chrome.runtime.openOptionsPage();
  }

  render() {
    const root = document.getElementById('root');
    
    if (this.editMode) {
      this.renderEditMode(root);
    } else if (this.aiMode) {
      this.renderAiMode(root);
    } else if (this.demoPlanView) {
      this.renderDemoPlanMode(root);
    } else {
      this.renderNormalMode(root);
    }
  }

  renderNormalMode(root) {
    const matchingTrack = this.findMatchingTalkTrack();
    
    // Get flow tracks - either from matching track's tags OR from the selected demo tag
    let flowTracks = [];
    let currentIndex = -1;
    let relatedTracks = [];
    
    if (this.selectedDemoTag) {
      // When a demo tag is selected, always show that flow
      const flowResult = this.findRelatedTracksBySelectedTag(matchingTrack);
      flowTracks = flowResult.flowTracks;
      currentIndex = flowResult.currentIndex;
      relatedTracks = flowResult.relatedTracks;
    } else if (matchingTrack) {
      // Otherwise, show flow based on matching track's tags
      const flowResult = this.findRelatedTracksByTags(matchingTrack);
      flowTracks = flowResult.flowTracks;
      currentIndex = flowResult.currentIndex;
      relatedTracks = flowResult.relatedTracks;
    }
    
    // Show flow bar if we have a selected demo tag with tracks, OR if we have related tracks
    const showFlowBar = (this.selectedDemoTag && flowTracks.length > 0) || relatedTracks.length > 0;
    const hasRelatedTracks = relatedTracks.length > 0;
    
    root.innerHTML = `
      <div class="container">
        <div class="header">
          <div class="header-top">
            <h1>Demo Buddy</h1>
            <div class="header-buttons">
              <div id="syncIndicator" class="sync-indicator" title="Cloud sync status"></div>
              <button id="demoPlanToggle" class="demo-plan-toggle-btn" title="Demo Plan Mode">
                📋
              </button>
              <button id="aiModeToggle" class="ai-toggle-btn" title="AI Generation Mode">
                🤖
              </button>
              <button id="createTrackBtn" class="create-track-btn" title="Create talk track for this page">
                ✏️
              </button>
            </div>
          </div>
          ${this.customers.length > 0 ? `
            <div class="customer-selector">
              <select id="customerSelect" class="customer-dropdown" title="Select customer for tailored talk tracks">
                <option value="">Generic Demo</option>
                ${this.customers.map(c => `
                  <option value="${c.id}" ${this.selectedCustomer?.id === c.id ? 'selected' : ''}>
                    👤 ${this.escapeHtml(c.name)}
                  </option>
                `).join('')}
              </select>
              ${this.selectedCustomer ? `
                <span class="customer-indicator" style="background-color: ${this.selectedCustomer.color}" title="${this.escapeHtml(this.selectedCustomer.name)}"></span>
              ` : ''}
            </div>
          ` : ''}
          ${this.getAllUniqueTags().length > 0 ? `
            <div class="demo-tag-selector">
              <select id="demoTagSelect" class="demo-tag-dropdown" title="Filter by demo flow tag">
                <option value="">All Demos</option>
                ${this.getAllUniqueTags().map(tag => `
                  <option value="${this.escapeHtml(tag)}" ${this.selectedDemoTag === tag ? 'selected' : ''}>
                    🏷️ ${this.escapeHtml(tag)}
                  </option>
                `).join('')}
              </select>
              ${this.selectedDemoTag ? `
                <button id="clearDemoTag" class="clear-tag-btn" title="Clear tag filter">✕</button>
              ` : ''}
            </div>
          ` : ''}
          <div class="url-row">
            <div class="current-url" id="currentUrlDisplay" title="${this.escapeHtml(this.currentUrl || '')}">${this.getDisplayUrl() || 'No page loaded'}</div>
            <button id="headerRefreshBtn" class="url-refresh-btn" title="Refresh URL from browser tab">🔄</button>
          </div>
        </div>
        ${showFlowBar ? `
          ${this.renderDemoFlowBar(flowTracks, currentIndex)}
        ` : ''}
        ${matchingTrack && showFlowBar ? `
          <div class="content-with-flow">
            <div class="track-header-bar">
              <span class="track-title">${this.escapeHtml(matchingTrack.title || 'Untitled')}</span>
              <button id="editTrackBtn" class="edit-track-btn" title="Edit this talk track">
                ✏️ Edit
              </button>
            </div>
            ${matchingTrack._hasAlternatives ? `
              <div class="alternatives-indicator">
                <span class="alternatives-badge">${matchingTrack._alternativeCount} tracks</span>
                <span class="alternatives-hint">Select a tag to filter demo flow</span>
              </div>
            ` : ''}
            ${matchingTrack._isGenericFallback ? `
              <div class="generic-fallback-banner">
                <span class="fallback-label">📋 Generic track</span>
                <button id="customizeForCustomerBtn" class="customize-btn" title="Create a customized version for ${this.escapeHtml(this.selectedCustomer.name)}">
                  ✨ Customize for ${this.escapeHtml(this.selectedCustomer.name)}
                </button>
              </div>
            ` : ''}
            <div class="talk-track">${this.renderMarkdown(matchingTrack.content)}</div>
          </div>
        ` : showFlowBar && !matchingTrack ? `
          <div class="content-with-flow">
            <div class="no-match-with-flow">
              <p>📍 Navigate to a page in this demo flow</p>
              <p class="flow-hint">Click a tab above to go to that step</p>
            </div>
          </div>
        ` : `
          <div class="content">
            ${matchingTrack ? `
              <div class="track-header-bar">
                <span class="track-title">${this.escapeHtml(matchingTrack.title || 'Untitled')}</span>
                ${matchingTrack._hasAlternatives ? `
                  <span class="alternatives-badge compact" title="${matchingTrack._alternativeCount} tracks match this page - select a tag to filter">
                    +${matchingTrack._alternativeCount - 1}
                  </span>
                ` : ''}
                <button id="editTrackBtn" class="edit-track-btn" title="Edit this talk track">
                  ✏️ Edit
                </button>
              </div>
              ${matchingTrack._hasAlternatives && !hasRelatedTracks ? `
                <div class="alternatives-indicator">
                  <span class="alternatives-hint">Multiple tracks match this page. Select a tag above to filter.</span>
                </div>
              ` : ''}
              ${matchingTrack._isGenericFallback ? `
                <div class="generic-fallback-banner">
                  <span class="fallback-label">📋 Generic track</span>
                  <button id="customizeForCustomerBtn" class="customize-btn" title="Create a customized version for ${this.escapeHtml(this.selectedCustomer.name)}">
                    ✨ Customize for ${this.escapeHtml(this.selectedCustomer.name)}
                  </button>
                </div>
              ` : ''}
              <div class="talk-track">${this.renderMarkdown(matchingTrack.content)}</div>
            ` : `
              <div class="no-match">
                <div class="no-match-icon">📝</div>
                <h3 class="no-match-title">New Page Detected</h3>
                <p class="no-match-subtitle">No talk track matches this URL. Create one now!</p>
                <div class="no-match-actions">
                  <button class="create-btn primary" id="createNewBtn">
                    ✏️ Create Talk Track
                  </button>
                  <button class="ai-create-btn" id="aiCreateBtn">
                    🤖 Generate with AI
                  </button>
                </div>
                <div class="no-match-footer">
                  <button class="quick-edit-button" id="openOptions">Open Full Editor</button>
                  <button class="refresh-url-btn" id="refreshUrlBtn" title="Refresh current URL">🔄</button>
                </div>
              </div>
            `}
          </div>
        `}
      </div>
    `;

    // Add event listeners
    const optionsBtn = document.getElementById('openOptions');
    if (optionsBtn) {
      optionsBtn.addEventListener('click', () => this.openOptions());
    }

    const aiToggleBtn = document.getElementById('aiModeToggle');
    if (aiToggleBtn) {
      aiToggleBtn.addEventListener('click', () => this.toggleAiMode());
    }

    const demoPlanToggle = document.getElementById('demoPlanToggle');
    if (demoPlanToggle) {
      demoPlanToggle.addEventListener('click', () => this.toggleDemoPlanMode());
    }

    const customerSelect = document.getElementById('customerSelect');
    if (customerSelect) {
      customerSelect.addEventListener('change', (e) => this.setSelectedCustomer(e.target.value));
    }

    const demoTagSelect = document.getElementById('demoTagSelect');
    if (demoTagSelect) {
      demoTagSelect.addEventListener('change', (e) => this.setSelectedDemoTag(e.target.value));
    }

    const clearDemoTagBtn = document.getElementById('clearDemoTag');
    if (clearDemoTagBtn) {
      clearDemoTagBtn.addEventListener('click', () => this.setSelectedDemoTag(null));
    }

    const createTrackBtn = document.getElementById('createTrackBtn');
    if (createTrackBtn) {
      createTrackBtn.addEventListener('click', () => this.enterEditMode());
    }

    const createNewBtn = document.getElementById('createNewBtn');
    if (createNewBtn) {
      createNewBtn.addEventListener('click', () => this.enterEditMode());
    }

    const aiCreateBtn = document.getElementById('aiCreateBtn');
    if (aiCreateBtn) {
      aiCreateBtn.addEventListener('click', () => this.toggleAiMode());
    }

    const refreshUrlBtn = document.getElementById('refreshUrlBtn');
    if (refreshUrlBtn) {
      refreshUrlBtn.addEventListener('click', () => this.refreshCurrentUrl());
    }

    const headerRefreshBtn = document.getElementById('headerRefreshBtn');
    if (headerRefreshBtn) {
      headerRefreshBtn.addEventListener('click', () => this.refreshCurrentUrl());
    }

    const editTrackBtn = document.getElementById('editTrackBtn');
    if (editTrackBtn && matchingTrack) {
      editTrackBtn.addEventListener('click', () => this.enterEditMode(matchingTrack));
    }

    const customizeBtn = document.getElementById('customizeForCustomerBtn');
    if (customizeBtn && matchingTrack) {
      customizeBtn.addEventListener('click', () => this.customizeForCustomer(matchingTrack));
    }

    // Add event listeners for flow tab links
    const flowTabs = document.querySelectorAll('.flow-tab:not(.current)');
    flowTabs.forEach(tab => {
      tab.addEventListener('click', async (e) => {
        e.preventDefault();
        const trackId = tab.dataset.trackId;
        const track = this.talkTracks.find(t => String(t.id) === trackId);
        if (track) {
          await this.navigateToTrack(track);
        }
      });
    });

    // Render sync indicator
    this.renderSyncIndicator();
  }

  /**
   * Render the demo flow tab bar
   * Shows current and next track with full titles, others as compact tabs
   * If currentIndex is -1, no track is current (user is on non-matching page)
   */
  renderDemoFlowBar(flowTracks, currentIndex) {
    if (flowTracks.length === 0) return '';

    // When no current track (currentIndex is -1), show first track as "next"
    const effectiveCurrentIndex = currentIndex >= 0 ? currentIndex : -1;

    const tabs = flowTracks.map((track, index) => {
      const isCurrent = index === effectiveCurrentIndex;
      // Show first two as "next" style when no current track, otherwise just the next one
      const isNext = effectiveCurrentIndex === -1 
        ? index < 2 
        : index === effectiveCurrentIndex + 1;
      const isCompact = !isCurrent && !isNext;
      
      // Determine tab class
      let tabClass = 'flow-tab';
      if (isCurrent) tabClass += ' current';
      else if (isNext) tabClass += ' next';
      else tabClass += ' compact';

      // For compact tabs, show abbreviated title or just index
      const displayTitle = isCompact 
        ? this.abbreviateTitle(track.title, 12)
        : this.escapeHtml(track.title || 'Untitled');

      const stepNumber = index + 1;

      return `
        <a href="#" 
           class="${tabClass}" 
           data-track-id="${track.id}"
           title="${this.escapeHtml(track.title || 'Untitled')}${track.urlPattern ? '\n' + track.urlPattern : ''}">
          <span class="flow-tab-index">${stepNumber}</span>
          ${!isCompact ? `<span class="flow-tab-title">${displayTitle}</span>` : ''}
        </a>
      `;
    }).join('');

    const flowLabel = this.selectedDemoTag ? `🏷️ ${this.escapeHtml(this.selectedDemoTag)}` : 'Flow';

    return `
      <div class="demo-flow-bar">
        <span class="demo-flow-label">${flowLabel}</span>
        <div class="demo-flow-tabs">
          ${tabs}
        </div>
      </div>
    `;
  }

  /**
   * Abbreviate a title for compact display
   */
  abbreviateTitle(title, maxLength) {
    if (!title) return '?';
    const escaped = this.escapeHtml(title);
    if (escaped.length <= maxLength) return escaped;
    return escaped.substring(0, maxLength - 1) + '…';
  }

  renderEditMode(root) {
    const isNew = !this.editingTrack?.id;
    const validation = this.validateUrlPattern(this.editingTrack?.urlPattern);
    
    root.innerHTML = `
      <div class="container">
        <div class="header">
          <div class="header-top">
            <h1>${isNew ? '✏️ Create Talk Track' : '✏️ Edit Talk Track'}</h1>
            <button id="cancelEditBtn" class="back-btn" title="Cancel and go back">
              ✕
            </button>
          </div>
          <div class="current-url" title="${this.escapeHtml(this.getDisplayUrl() || '')}">${this.getDisplayUrl() || 'No page loaded'}</div>
        </div>
        
        <div class="edit-form">
          <div class="form-group">
            <label for="editTitle">Title</label>
            <input 
              type="text" 
              id="editTitle" 
              value="${this.escapeHtml(this.editingTrack?.title || '')}"
              placeholder="e.g., Dashboard Overview Demo"
            />
          </div>
          
          <div class="form-group">
            <label for="editCategory">Category</label>
            <select id="editCategory">
              ${this.categories.map(cat => `
                <option value="${cat}" ${this.editingTrack?.category === cat ? 'selected' : ''}>
                  ${cat}
                </option>
              `).join('')}
            </select>
          </div>
          
          ${this.customers.length > 0 ? `
            <div class="form-group">
              <label for="editCustomer">Customer <span class="label-hint">(optional)</span></label>
              <select id="editCustomer" class="customer-edit-select">
                <option value="">Generic (all customers)</option>
                ${this.customers.map(c => `
                  <option value="${c.id}" ${this.editingTrack?.customerId === c.id ? 'selected' : ''}>
                    👤 ${this.escapeHtml(c.name)}${c.industry ? ` (${this.escapeHtml(c.industry)})` : ''}
                  </option>
                `).join('')}
              </select>
            </div>
          ` : ''}
          
          <div class="form-group">
            <label for="editUrlPattern">URL Pattern</label>
            <input 
              type="text" 
              id="editUrlPattern" 
              value="${this.escapeHtml(this.editingTrack?.urlPattern || '')}"
              placeholder="e.g., */dashboards/* or */apm/services"
            />
            <div id="urlPatternValidation" class="url-validation">
              <span class="${validation.matches ? 'validation-success' : 'validation-error'}">
                ${validation.message}
              </span>
            </div>
            <div class="url-pattern-suggestions">
              <button type="button" class="suggestion-btn" data-pattern="${this.createUrlPattern(this.currentUrl)}">
                📍 Auto-detect from current page
              </button>
              <button type="button" class="suggestion-btn" data-pattern="*${this.getDisplayUrl()}*">
                🔗 Exact path match
              </button>
            </div>
          </div>
          
          <div class="form-group">
            <label for="editTags">Tags <span class="label-hint">(comma-separated)</span></label>
            <input 
              type="text" 
              id="editTags" 
              value="${this.escapeHtml((this.editingTrack?.tags || []).join(', '))}"
              placeholder="e.g., acme-demo, q1-roadmap"
            />
            <div class="tags-hint">Use tags to group tracks into demo flows</div>
          </div>
          
          <div class="form-group content-form-group">
            <div class="content-label-row">
              <label for="editContent">Talk Track Content</label>
              ${(SpeechService.isSupported() || SpeechService.isAudioSupported()) ? `
                <div class="dictation-controls">
                  <label class="format-toggle" title="Use AI to format transcription as bullet points">
                    <input type="checkbox" id="formatBulletsToggle" ${this.formatAsBullets ? 'checked' : ''}>
                    <span class="format-toggle-label">Bullets</span>
                  </label>
                  <button type="button" id="micDictateBtn" class="mic-button" title="Start dictation">
                    🎤
                  </button>
                </div>
              ` : ''}
            </div>
            <div id="quillEditorPopup" class="quill-editor-popup"></div>
          </div>
          
          <div class="edit-actions">
            <button id="saveTrackBtn" class="save-btn">
              💾 ${isNew ? 'Create Track' : 'Save Changes'}
            </button>
            <button id="cancelBtn" class="cancel-btn">
              Cancel
            </button>
            <button id="debugHtmlBtn" class="debug-btn" title="Show raw HTML for debugging">
              🔍 Debug
            </button>
            ${!isNew ? `
              <button id="deleteTrackBtn" class="delete-btn" title="Delete this talk track">
                🗑️
              </button>
            ` : ''}
          </div>
          
        </div>
      </div>
    `;

    // Add event listeners
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', () => this.exitEditMode());
    }

    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.exitEditMode());
    }

    const saveTrackBtn = document.getElementById('saveTrackBtn');
    if (saveTrackBtn) {
      saveTrackBtn.addEventListener('click', () => this.saveEditingTrack());
    }

    const deleteTrackBtn = document.getElementById('deleteTrackBtn');
    if (deleteTrackBtn) {
      deleteTrackBtn.addEventListener('click', () => this.deleteEditingTrack());
    }

    // Debug button
    const debugHtmlBtn = document.getElementById('debugHtmlBtn');
    if (debugHtmlBtn) {
      debugHtmlBtn.addEventListener('click', () => this.showDebugHtml());
    }

    // Form input handlers
    const titleInput = document.getElementById('editTitle');
    if (titleInput) {
      titleInput.addEventListener('input', (e) => this.updateEditingTrack('title', e.target.value));
    }

    const categorySelect = document.getElementById('editCategory');
    if (categorySelect) {
      categorySelect.addEventListener('change', (e) => this.updateEditingTrack('category', e.target.value));
    }

    const customerSelect = document.getElementById('editCustomer');
    if (customerSelect) {
      customerSelect.addEventListener('change', (e) => this.updateEditingTrack('customerId', e.target.value || null));
    }

    const urlPatternInput = document.getElementById('editUrlPattern');
    if (urlPatternInput) {
      urlPatternInput.addEventListener('input', (e) => this.updateEditingTrack('urlPattern', e.target.value));
    }

    // Initialize Quill editor
    this.initQuillEditor();

    // Format as bullets toggle
    const formatBulletsToggle = document.getElementById('formatBulletsToggle');
    if (formatBulletsToggle) {
      formatBulletsToggle.addEventListener('change', (e) => {
        this.formatAsBullets = e.target.checked;
      });
    }

    // Mic button for dictation
    const micDictateBtn = document.getElementById('micDictateBtn');
    if (micDictateBtn) {
      micDictateBtn.addEventListener('click', () => this.toggleDictation());
      // Update button state based on current speech service state
      if (this.speechService?.isTranscribing()) {
        this.updateMicButtonState('processing');
      } else if (this.speechService?.isListening()) {
        this.updateMicButtonState('recording');
      } else {
        this.updateMicButtonState('idle');
      }
    }

    // URL pattern suggestion buttons
    const suggestionBtns = document.querySelectorAll('.suggestion-btn');
    suggestionBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const pattern = e.target.dataset.pattern;
        urlPatternInput.value = pattern;
        this.updateEditingTrack('urlPattern', pattern);
      });
    });
  }

  async deleteEditingTrack() {
    if (!this.editingTrack?.id) return;
    
    if (!confirm('Are you sure you want to delete this talk track?')) {
      return;
    }
    
    this.talkTracks = this.talkTracks.filter(t => t.id !== this.editingTrack.id);
    await this.saveTracksWithSync('Deleted track');
    
    this.showNotification('Talk track deleted');
    this.exitEditMode();
  }

  showDebugHtml() {
    if (!this.quillEditor) {
      alert('No Quill editor found');
      return;
    }
    
    const html = this.quillEditor.root.innerHTML;
    const markdown = ContentConverter.htmlToMarkdown(html);
    
    // Create a modal to show the debug info
    const debugInfo = `
=== RAW QUILL HTML ===
${html}

=== CONVERTED MARKDOWN ===
${markdown}

=== CHECK FOR QUILL CLASSES ===
Has ql-indent: ${html.includes('ql-indent')}
Has data-list: ${html.includes('data-list')}
    `.trim();
    
    // Copy to clipboard and show alert
    navigator.clipboard.writeText(debugInfo).then(() => {
      alert('Debug info copied to clipboard!\n\nPlease paste it in the chat so we can diagnose the issue.');
    }).catch(() => {
      // Fallback: show in console and prompt
      console.log(debugInfo);
      prompt('Copy this debug info:', html);
    });
  }

  /**
   * Insert a navigation link at the current cursor position in the Quill editor
   */
  insertNavigationLink() {
    if (!this.quillEditor) {
      alert('Editor not initialized');
      return;
    }

    // Prompt for link text
    const linkText = prompt('Enter the link text (e.g., "Go to Dashboard"):');
    if (!linkText) return;

    // Prompt for URL path
    const urlPath = prompt('Enter the URL path (e.g., "/dashboard/abc-123" or "https://..."):');
    if (!urlPath) return;

    // Build the full URL
    const fullUrl = this.buildFullUrl(urlPath);

    // Get current selection or cursor position
    const range = this.quillEditor.getSelection(true);
    
    if (range) {
      // Insert the link at cursor position
      this.quillEditor.insertText(range.index, linkText, 'link', fullUrl);
      // Move cursor after the inserted text
      this.quillEditor.setSelection(range.index + linkText.length);
    } else {
      // If no selection, append to end
      const length = this.quillEditor.getLength();
      this.quillEditor.insertText(length - 1, linkText, 'link', fullUrl);
    }
  }

  applyFormatting(textarea, format) {
    if (!textarea) return;
    
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    const beforeText = textarea.value.substring(0, start);
    const afterText = textarea.value.substring(end);
    
    let formattedText = '';
    let cursorOffset = 0;
    
    switch(format) {
      case 'bold':
        formattedText = selectedText ? `**${selectedText}**` : '**bold text**';
        cursorOffset = selectedText ? selectedText.length + 4 : 2;
        break;
      case 'italic':
        formattedText = selectedText ? `*${selectedText}*` : '*italic text*';
        cursorOffset = selectedText ? selectedText.length + 2 : 1;
        break;
      case 'list':
        if (selectedText) {
          formattedText = selectedText.split('\n').map(line => line.trim() ? `- ${line}` : '').join('\n');
          cursorOffset = formattedText.length;
        } else {
          formattedText = '- ';
          cursorOffset = 2;
        }
        break;
      case 'heading':
        formattedText = selectedText ? `## ${selectedText}` : '## ';
        cursorOffset = selectedText ? selectedText.length + 3 : 3;
        break;
    }
    
    textarea.value = beforeText + formattedText + afterText;
    const newPos = start + cursorOffset;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    
    // Update preview
    const preview = document.getElementById('contentPreview');
    if (preview) {
      preview.innerHTML = this.renderMarkdown(textarea.value);
    }
    
    // Update editing track
    this.updateEditingTrack('content', textarea.value);
  }

  renderAiMode(root) {
    root.innerHTML = `
      <div class="container">
        <div class="header">
          <div class="header-top">
            <h1>AI Talk Track Generation</h1>
            <button id="normalModeToggle" class="normal-mode-btn" title="Back to Normal Mode">
              ← Back
            </button>
          </div>
          ${this.customers.length > 0 ? `
            <div class="customer-selector">
              <select id="customerSelectAi" class="customer-dropdown" title="Generate for specific customer">
                <option value="">Generic Demo</option>
                ${this.customers.map(c => `
                  <option value="${c.id}" ${this.selectedCustomer?.id === c.id ? 'selected' : ''}>
                    👤 ${this.escapeHtml(c.name)}
                  </option>
                `).join('')}
              </select>
              ${this.selectedCustomer ? `
                <span class="customer-indicator" style="background-color: ${this.selectedCustomer.color}"></span>
              ` : ''}
            </div>
          ` : ''}
          <div class="current-url" title="${this.escapeHtml(this.getDisplayUrl() || '')}">${this.getDisplayUrl() || 'No page loaded'}</div>
        </div>
        <div class="content ai-generation-panel">
          ${this.selectedCustomer ? `
            <div class="customer-context-notice">
              <strong>🎯 Generating for: ${this.escapeHtml(this.selectedCustomer.name)}</strong>
              ${this.selectedCustomer.industry ? `<span class="industry-tag">${this.escapeHtml(this.selectedCustomer.industry)}</span>` : ''}
              ${this.selectedCustomer.discoveryNotes ? `
                <p class="discovery-preview">${this.escapeHtml(this.selectedCustomer.discoveryNotes.substring(0, 150))}${this.selectedCustomer.discoveryNotes.length > 150 ? '...' : ''}</p>
              ` : '<p class="no-notes">No discovery notes added yet</p>'}
            </div>
          ` : ''}
          
          <div class="form-group">
            <label for="personaSelect">Select Persona</label>
            <select id="personaSelect" class="persona-select">
              ${this.personas.map(p => `
                <option value="${p.id}" ${p.id === this.selectedPersona?.id ? 'selected' : ''}>
                  ${p.name}
                </option>
              `).join('')}
            </select>
            <p class="persona-description">${this.selectedPersona?.description || ''}</p>
          </div>

          <div class="doc-context-section">
            <div class="form-group">
              <label for="docContextText">
                📄 Reference Documentation
                <span class="label-hint">(optional)</span>
              </label>
              <p class="field-description">Paste relevant documentation text to inform terminology and language</p>
              <textarea 
                id="docContextText" 
                class="doc-context-textarea" 
                placeholder="Paste documentation content here to help AI use accurate terminology..."
                rows="4"
              >${this.escapeHtml(this.docContextText || '')}</textarea>
            </div>
            
            <div class="form-group">
              <label for="docUrls">
                🔗 Documentation Links
                <span class="label-hint">(optional)</span>
              </label>
              <p class="field-description">URLs to include as "Learn More" references (one per line)</p>
              <textarea 
                id="docUrls" 
                class="doc-urls-textarea" 
                placeholder="https://docs.datadoghq.com/dashboards/&#10;https://docs.datadoghq.com/metrics/"
                rows="3"
              >${this.escapeHtml(this.docUrls || '')}</textarea>
            </div>
          </div>

          <button id="captureGenerateBtn" class="ai-generate-btn">
            📸 Capture & Generate${this.selectedCustomer ? ` for ${this.escapeHtml(this.selectedCustomer.name)}` : ''}
          </button>

          <div id="aiLoadingIndicator" class="ai-loading" style="display:none">
            <div class="generation-steps" id="generationSteps">
              <div class="gen-step" data-step="capture">
                <span class="step-icon" id="stepIcon-capture">○</span>
                <div class="step-body">
                  <span class="step-label">Capture screenshot</span>
                  <span class="step-detail" id="stepDetail-capture"></span>
                </div>
              </div>
              <div class="gen-step" data-step="analyze">
                <span class="step-icon" id="stepIcon-analyze">○</span>
                <div class="step-body">
                  <span class="step-label">Analyze screenshot</span>
                  <span class="step-detail" id="stepDetail-analyze"></span>
                </div>
              </div>
              <div class="gen-step" data-step="docs">
                <span class="step-icon" id="stepIcon-docs">○</span>
                <div class="step-body">
                  <span class="step-label">Search documentation</span>
                  <span class="step-detail" id="stepDetail-docs"></span>
                </div>
              </div>
              <div class="gen-step" data-step="generate">
                <span class="step-icon" id="stepIcon-generate">○</span>
                <div class="step-body">
                  <span class="step-label">Generate talk track</span>
                  <span class="step-detail" id="stepDetail-generate"></span>
                </div>
              </div>
            </div>
            <div id="captureProgress" class="capture-progress" style="display:none">
              <div class="progress-bar">
                <div id="progressFill" class="progress-fill"></div>
              </div>
              <p id="progressText" class="progress-text"></p>
            </div>
          </div>

          ${this.generatedContent ? this.renderSaveOptions() : ''}
        </div>
      </div>
    `;

    // Add event listeners
    const normalToggleBtn = document.getElementById('normalModeToggle');
    if (normalToggleBtn) {
      normalToggleBtn.addEventListener('click', () => {
        this.generatedContent = null;
        this.toggleAiMode();
      });
    }

    const personaSelect = document.getElementById('personaSelect');
    if (personaSelect) {
      personaSelect.addEventListener('change', (e) => this.onPersonaChange(e));
    }

    const customerSelectAi = document.getElementById('customerSelectAi');
    if (customerSelectAi) {
      customerSelectAi.addEventListener('change', (e) => this.setSelectedCustomer(e.target.value));
    }

    // Documentation context fields
    const docContextText = document.getElementById('docContextText');
    if (docContextText) {
      docContextText.addEventListener('input', (e) => {
        this.docContextText = e.target.value;
      });
    }

    const docUrls = document.getElementById('docUrls');
    if (docUrls) {
      docUrls.addEventListener('input', (e) => {
        this.docUrls = e.target.value;
      });
    }

    const generateBtn = document.getElementById('captureGenerateBtn');
    if (generateBtn) {
      generateBtn.addEventListener('click', () => this.captureAndGenerate());
    }

    const saveNewBtn = document.getElementById('saveAiTrackNew');
    if (saveNewBtn) {
      saveNewBtn.addEventListener('click', () => this.saveGeneratedTrack('new'));
    }

    const appendBtn = document.getElementById('saveAiTrackAppend');
    if (appendBtn) {
      appendBtn.addEventListener('click', () => this.saveGeneratedTrack('append'));
    }

    const replaceBtn = document.getElementById('saveAiTrackReplace');
    if (replaceBtn) {
      replaceBtn.addEventListener('click', () => this.saveGeneratedTrack('replace'));
    }

    const regenerateBtn = document.getElementById('regenerateBtn');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', () => {
        this.generatedContent = null;
        this.render();
      });
    }
  }

  renderSaveOptions() {
    const existingTrack = this.findMatchingTalkTrack();
    
    return `
      <div id="aiPreview" class="ai-preview">
        <h3>Generated Talk Track</h3>
        
        ${existingTrack ? `
          <div class="existing-track-notice">
            <strong>📌 Existing track found:</strong> "${this.escapeHtml(existingTrack.title || 'Untitled Track')}"
            <br>
            <small>You can save as new, append to existing, or replace existing content.</small>
          </div>
        ` : ''}
        
        <div class="preview-content">
          ${this.renderMarkdown(this.generatedContent.content)}
        </div>
        
        <div class="ai-actions">
          ${existingTrack ? `
            <button id="saveAiTrackAppend" class="save-btn append-btn" title="Add this content to the existing track">
              ➕ Append to Existing
            </button>
            <button id="saveAiTrackReplace" class="save-btn replace-btn" title="Replace the existing track's content">
              🔄 Replace Existing
            </button>
            <button id="saveAiTrackNew" class="secondary-btn" title="Create a new separate track">
              💾 Save as New
            </button>
          ` : `
            <button id="saveAiTrackNew" class="save-btn" title="Save as a new talk track">
              💾 Save as New Track
            </button>
          `}
          <button id="regenerateBtn" class="secondary-btn">🔄 Regenerate</button>
        </div>
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  renderMarkdown(text) {
    // Configure marked options for better formatting
    marked.setOptions({
      breaks: true,  // Enable line breaks
      gfm: true,     // GitHub Flavored Markdown
    });
    
    // Pre-process: Convert custom color markers to HTML spans before markdown parsing
    let processedText = text
      .replace(/\[\[VALUE\]\](.*?)\[\[\/VALUE\]\]/gs, '<span class="value-highlight">$1</span>')
      .replace(/\[\[OUTCOME\]\](.*?)\[\[\/OUTCOME\]\]/gs, '<span class="outcome-highlight">$1</span>');
    
    // Parse markdown to HTML
    const rawHtml = marked.parse(processedText);
    
    // Sanitize HTML to prevent XSS attacks
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'strike', 'del', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a', 'hr', 'button', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'class', 'data-nav-url']
    });
    
    // Convert links to navigation buttons
    return this.convertLinksToNavButtons(cleanHtml);
  }

  /**
   * Convert <a> tags to navigation buttons that control the active browser tab
   * Links starting with / or containing the base URL become nav buttons
   * External links remain as regular links
   */
  convertLinksToNavButtons(html) {
    // Create a temporary container to parse and modify the HTML
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    // Find all anchor tags
    const links = temp.querySelectorAll('a[href]');
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent;
      
      // Check if this is a navigation link (relative path or same-site URL)
      if (this.isNavigationLink(href)) {
        // Build the full URL
        const fullUrl = this.buildFullUrl(href);
        
        // Create a button element
        const button = document.createElement('button');
        button.className = 'nav-button';
        button.setAttribute('data-nav-url', fullUrl);
        button.textContent = text;
        button.title = `Navigate to: ${fullUrl}`;
        
        // Replace the link with the button
        link.parentNode.replaceChild(button, link);
      }
    });
    
    return temp.innerHTML;
  }

  /**
   * Check if a link should be converted to a navigation button
   */
  isNavigationLink(href) {
    if (!href) return false;
    
    // Relative paths starting with /
    if (href.startsWith('/')) return true;
    
    // URLs matching the base URL domain
    try {
      const linkUrl = new URL(href, this.baseUrl);
      const baseObj = new URL(this.baseUrl);
      return linkUrl.hostname === baseObj.hostname || 
             linkUrl.hostname.endsWith('datadoghq.com') ||
             linkUrl.hostname.endsWith('ddog-gov.com');
    } catch {
      return false;
    }
  }

  /**
   * Build a full URL from a relative or absolute path
   */
  buildFullUrl(href) {
    if (!href) return '';
    
    // If it's already a full URL, return it
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    
    // If it's a relative path, prepend the base URL
    try {
      const url = new URL(href, this.baseUrl);
      return url.href;
    } catch {
      // Fallback: simple concatenation
      const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
      const path = href.startsWith('/') ? href : '/' + href;
      return base + path;
    }
  }

  // =========================================================================
  // Demo Plan Mode
  // =========================================================================

  async toggleDemoPlanMode(targetView) {
    if (targetView) {
      this.demoPlanView = targetView;
    } else {
      this.demoPlanView = this.demoPlanView ? null : 'authoring';
    }
    this.aiMode = false;
    this.editMode = false;
    if (this.demoPlanView) {
      this.startUrlPolling();
      if (this.availablePlans.length === 0) {
        await this.loadAvailablePlans();
      }
    } else {
      this.stopUrlPolling();
    }
    this.render();
  }

  startUrlPolling() {
    this.stopUrlPolling();
    this._urlPollInterval = setInterval(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_TRACKED_TAB' });
        const url = resp?.tab?.url;
        if (url && url !== this.currentUrl && !url.startsWith('chrome')) {
          this.updateUrl(url);
        }
      } catch { /* background not reachable */ }
    }, 1000);
  }

  stopUrlPolling() {
    if (this._urlPollInterval) {
      clearInterval(this._urlPollInterval);
      this._urlPollInterval = null;
    }
  }

  async loadAvailablePlans() {
    try {
      this.availablePlans = await this.demoPlanService.listPlans();
    } catch (e) {
      console.error('[DemoPlan] Failed to load plans:', e);
      this.availablePlans = [];
    }
  }

  async selectPlan(planId) {
    if (!planId) {
      this.activePlan = null;
      this.activeLoops = [];
      this.selectedLoopIndex = -1;
      this.render();
      return;
    }
    try {
      const plan = await this.demoPlanService.getPlan(planId);
      console.log('[DemoPlan] Loaded plan:', plan?.id, 'loops:', plan?.loops?.length ?? 'N/A');
      if (plan?.error) {
        throw new Error(plan.error);
      }
      this.activePlan = plan;
      this.activeLoops = Array.isArray(plan?.loops) ? plan.loops : [];
      this.selectedLoopIndex = this.activeLoops.length > 0 ? 0 : -1;
      this.autoMatchLoopToUrl();
    } catch (e) {
      console.error('[DemoPlan] Failed to load plan:', e);
      this.showNotification('Failed to load plan: ' + e.message, 'error');
    }
    this.render();
  }

  selectLoop(index) {
    this.selectedLoopIndex = index;
    this.editingLoopPhase = null;
    this.render();
  }

  parseKeyMoments(showDemoText) {
    if (!showDemoText) return [];
    const moments = [];

    // Boundary lookahead that handles both `\n**Key moment` and `\n- **Key moment`
    const kmBoundary = '\\n\\s*(?:[-*]\\s*)?\\*\\*Key moment';
    const endBoundary = `(?=${kmBoundary}|\\n\\*\\*Closing|\\n---|$)`;

    const openingRe = new RegExp(
      '\\*\\*Opening screen:\\*\\*\\s*([\\s\\S]*?)' + endBoundary, 'i'
    );
    const openingMatch = showDemoText.match(openingRe);
    if (openingMatch) {
      moments.push({
        key: 'opening',
        label: openingMatch[1].split('\n')[0].replace(/[*_`]/g, '').trim(),
        content: openingMatch[0].trim(),
        page_url: '',
        url_pattern: ''
      });
    }

    const kmRegex = new RegExp(
      '\\*\\*Key moment\\s+(\\d+)\\s*[-–—]\\s*(.*?)\\*\\*:?\\s*([\\s\\S]*?)' + endBoundary, 'gi'
    );
    let match;
    while ((match = kmRegex.exec(showDemoText)) !== null) {
      moments.push({
        key: `moment_${match[1]}`,
        label: match[2].replace(/[*_`:]/g, '').trim(),
        content: match[0].trim(),
        page_url: '',
        url_pattern: ''
      });
    }

    return moments;
  }

  getKeyMomentsWithAssignments(loop) {
    const parsed = this.parseKeyMoments(loop.show_demo);
    let saved = [];
    try { saved = JSON.parse(loop.page_urls_json || '[]'); } catch {}

    return parsed.map(km => {
      const savedKm = saved.find(s => s.key === km.key);
      return {
        ...km,
        page_url: savedKm?.page_url || '',
        url_pattern: savedKm?.url_pattern || ''
      };
    });
  }

  autoMatchLoopToUrl() {
    if (!this.demoPlanView || !this.activeLoops.length || !this.currentUrl) return;

    for (let i = 0; i < this.activeLoops.length; i++) {
      const loop = this.activeLoops[i];
      let pageUrls = [];
      try { pageUrls = JSON.parse(loop.page_urls_json || '[]'); } catch {}

      for (let k = 0; k < pageUrls.length; k++) {
        if (pageUrls[k].url_pattern && this.urlMatches(this.currentUrl, pageUrls[k].url_pattern)) {
          this.selectedLoopIndex = i;
          this.activeKeyMomentIndex = k;
          return;
        }
      }

      if (loop.url_pattern && this.urlMatches(this.currentUrl, loop.url_pattern)) {
        this.selectedLoopIndex = i;
        this.activeKeyMomentIndex = -1;
        return;
      }
    }
  }

  async assignPageToLoop(loopIndex) {
    const loop = this.activeLoops[loopIndex];
    if (!loop || !this.currentUrl) return;

    const urlPattern = this.createUrlPattern(this.currentUrl);
    try {
      const updated = await this.demoPlanService.updateLoop(
        loop.plan_id, loop.id,
        { page_url: this.currentUrl, url_pattern: urlPattern }
      );
      this.activeLoops[loopIndex] = updated;
      this.showNotification('Page assigned to loop');
    } catch (e) {
      console.error('[DemoPlan] Failed to assign page:', e);
      this.showNotification('Failed to assign page', 'error');
    }
    this.render();
  }

  async clearPageAssignment(loopIndex) {
    const loop = this.activeLoops[loopIndex];
    if (!loop) return;
    try {
      const updated = await this.demoPlanService.updateLoop(
        loop.plan_id, loop.id,
        { page_url: '', url_pattern: '', page_urls_json: '[]' }
      );
      this.activeLoops[loopIndex] = updated;
      this.showNotification('Page assignment cleared');
    } catch (e) {
      console.error('[DemoPlan] Failed to clear assignment:', e);
      this.showNotification('Failed to clear assignment', 'error');
    }
    this.render();
  }

  async assignPageToKeyMoment(loopIndex, momentKey) {
    const loop = this.activeLoops[loopIndex];
    if (!loop || !this.currentUrl) return;

    const keyMoments = this.getKeyMomentsWithAssignments(loop);
    const urlPattern = this.createUrlPattern(this.currentUrl);

    const updatedMoments = keyMoments.map(km => ({
      key: km.key,
      label: km.label,
      page_url: km.key === momentKey ? this.currentUrl : km.page_url,
      url_pattern: km.key === momentKey ? urlPattern : km.url_pattern
    }));

    try {
      const updated = await this.demoPlanService.updateLoop(
        loop.plan_id, loop.id,
        { page_urls_json: JSON.stringify(updatedMoments) }
      );
      this.activeLoops[loopIndex] = updated;
      this.showNotification('Page assigned to key moment');
    } catch (e) {
      console.error('[DemoPlan] Failed to assign key moment page:', e);
      this.showNotification('Failed to assign page', 'error');
    }
    this.render();
  }

  async clearKeyMomentAssignment(loopIndex, momentKey) {
    const loop = this.activeLoops[loopIndex];
    if (!loop) return;

    const keyMoments = this.getKeyMomentsWithAssignments(loop);
    const updatedMoments = keyMoments.map(km => ({
      key: km.key,
      label: km.label,
      page_url: km.key === momentKey ? '' : km.page_url,
      url_pattern: km.key === momentKey ? '' : km.url_pattern
    }));

    try {
      const updated = await this.demoPlanService.updateLoop(
        loop.plan_id, loop.id,
        { page_urls_json: JSON.stringify(updatedMoments) }
      );
      this.activeLoops[loopIndex] = updated;
      this.showNotification('Key moment assignment cleared');
    } catch (e) {
      console.error('[DemoPlan] Failed to clear key moment:', e);
      this.showNotification('Failed to clear assignment', 'error');
    }
    this.render();
  }

  startEditingLoopPhase(loopIndex, phase) {
    this.editingLoopPhase = { loopIndex, phase };
    this.render();
    const textarea = document.getElementById('loopPhaseEditor');
    if (textarea) textarea.focus();
  }

  cancelEditingLoopPhase() {
    this.editingLoopPhase = null;
    this.render();
  }

  async saveLoopPhaseEdit() {
    if (!this.editingLoopPhase) return;
    const { loopIndex, phase } = this.editingLoopPhase;
    const loop = this.activeLoops[loopIndex];
    const textarea = document.getElementById('loopPhaseEditor');
    if (!loop || !textarea) return;

    const newValue = textarea.value;
    try {
      const updated = await this.demoPlanService.updateLoop(
        loop.plan_id, loop.id, { [phase]: newValue }
      );
      this.activeLoops[loopIndex] = updated;
      this.editingLoopPhase = null;
      this.showNotification('Saved');
    } catch (e) {
      console.error('[DemoPlan] Failed to save edit:', e);
      this.showNotification('Failed to save', 'error');
    }
    this.render();
  }

  async _navigateTabAndWait(tabId, url, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, timeoutMs);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          setTimeout(resolve, 1500);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url });
    });
  }

  async _captureTab(tabId) {
    const data = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'CAPTURE_SCREENSHOT', tabId, fullPage: true },
        (resp) => {
          if (resp?.error) reject(new Error(resp.error));
          else resolve(resp?.dataUrl);
        }
      );
    });
    if (!data) throw new Error('Screenshot capture failed');
    return data;
  }

  async refineLoopWithScreenshot(loopIndex) {
    const loop = this.activeLoops[loopIndex];
    if (!loop) return;

    this.refiningLoop = true;
    this.render();

    try {
      const result = await chrome.storage.local.get(['openaiApiKey']);
      const apiKey = result.openaiApiKey;
      if (!apiKey) {
        this.showNotification('OpenAI API key required for refinement', 'error');
        this.refiningLoop = false;
        this.render();
        return;
      }

      const response = await chrome.runtime.sendMessage({ type: 'GET_TRACKED_TAB' });
      const tabId = response?.tab?.id;
      const originalUrl = response?.tab?.url;
      if (!tabId) {
        throw new Error('No active tab to capture');
      }

      const keyMoments = this.getKeyMomentsWithAssignments(loop);
      const assignedMoments = keyMoments.filter(km => !!km.page_url);
      const screenshots = [];

      if (assignedMoments.length > 0) {
        const total = assignedMoments.length;
        for (let i = 0; i < total; i++) {
          const km = assignedMoments[i];
          this.showNotification(`Capturing ${km.label || km.key} (${i + 1}/${total})...`);

          await this._navigateTabAndWait(tabId, km.page_url);
          const dataUrl = await this._captureTab(tabId);
          screenshots.push({ label: km.label || km.key, key: km.key, dataUrl });
        }

        if (originalUrl) {
          await this._navigateTabAndWait(tabId, originalUrl);
        }
      } else {
        this.showNotification('Capturing full-page screenshot...');
        const dataUrl = await this._captureTab(tabId);
        screenshots.push({ label: 'Current Page', key: 'current', dataUrl });
      }

      this.showNotification('Refining talk track with AI...');
      const customerContext = this.activePlan ? {
        name: this.activePlan.company_name,
        industry: '',
        discoveryNotes: ''
      } : null;

      const refined = await this.aiService.refineTSTLoop(
        screenshots,
        {
          tell_setup: loop.tell_setup,
          show_demo: loop.show_demo,
          tell_connection: loop.tell_connection,
          title: loop.title,
          pain_point: loop.pain_point,
        },
        customerContext,
        apiKey
      );

      if (refined) {
        const updated = await this.demoPlanService.updateLoop(
          loop.plan_id, loop.id, {
            tell_setup: refined.tell_setup,
            show_demo: refined.show_demo,
            tell_connection: refined.tell_connection,
          }
        );
        this.activeLoops[loopIndex] = updated;
        this.showNotification('Talk track refined with screenshot data');
      }
    } catch (e) {
      console.error('[DemoPlan] Refinement failed:', e);
      this.showNotification('Refinement failed: ' + e.message, 'error');
    }

    this.refiningLoop = false;
    this.render();
  }

  renderDemoPlanMode(root) {
    const selectedLoop = this.selectedLoopIndex >= 0
      ? this.activeLoops[this.selectedLoopIndex]
      : null;
    const isDemo = this.demoPlanView === 'demo';
    const isAuthoring = this.demoPlanView === 'authoring';

    root.innerHTML = `
      <div class="container demo-plan-container ${isDemo ? 'demo-mode-active' : ''}">
        <div class="header">
          <div class="header-top">
            <h1>Demo Buddy</h1>
            <div class="header-buttons">
              <button id="demoPlanToggle" class="demo-plan-toggle-btn active" title="Exit Demo Plan Mode">
                📋
              </button>
              <button id="optionsBtn" class="options-btn" title="Settings">⚙️</button>
            </div>
          </div>
          <div class="plan-selector">
            <select id="planSelect" class="plan-dropdown">
              <option value="">-- Select a Demo Plan --</option>
              ${this.availablePlans.map(p => `
                <option value="${this.escapeHtml(p.id)}" ${this.activePlan?.id === p.id ? 'selected' : ''}>
                  ${this.escapeHtml(p.title)} (${new Date(p.created_at).toLocaleDateString()})
                </option>
              `).join('')}
            </select>
            <button id="refreshPlansBtn" class="refresh-plans-btn" title="Refresh plan list">🔄</button>
          </div>
          <div class="mode-toggle-row">
            <button id="modeAuthoring" class="mode-toggle-btn ${isAuthoring ? 'active' : ''}" data-mode="authoring">Authoring</button>
            <button id="modeDemo" class="mode-toggle-btn ${isDemo ? 'active' : ''}" data-mode="demo">Demo</button>
          </div>
          <div class="url-row">
            <div class="current-url" title="${this.escapeHtml(this.currentUrl || '')}">${this.getDisplayUrl() || 'No page loaded'}</div>
            ${isDemo ? '<span class="live-indicator">LIVE</span>' : `<button id="headerRefreshBtn" class="url-refresh-btn" title="Refresh URL">🔄</button>`}
          </div>
        </div>
        <div class="content demo-plan-content">
          ${this.activePlan ? this.renderLoopStepper(selectedLoop) : `
            <div class="no-plan-selected">
              <p>Select a demo plan above to get started.</p>
              <p class="hint">Plans are generated from the Demo Planner.</p>
            </div>
          `}
        </div>
        <div class="footer">
          <button id="optionsBtn2" class="options-link">⚙️ Settings</button>
        </div>
      </div>
    `;

    this.attachDemoPlanListeners(selectedLoop);
  }

  renderLoopStepper(selectedLoop) {
    if (this.activeLoops.length === 0) {
      const hasMd = this.activePlan?.markdown;
      return `
        <div class="no-loops-message">
          <p>This plan has no parsed TST loops.</p>
          <button id="reparseLoopsBtn" class="reparse-btn">Re-parse Loops from Plan</button>
          ${hasMd ? `
            <p class="hint">Full plan markdown shown below as fallback.</p>
            <div class="plan-markdown-fallback">${this.renderMarkdown(hasMd)}</div>
          ` : `
            <p class="hint">The plan may have been generated in an unexpected format.</p>
          `}
        </div>
      `;
    }

    const isDemo = this.demoPlanView === 'demo';
    const stepsHtml = this.activeLoops.map((loop, i) => {
      const isSelected = i === this.selectedLoopIndex;
      let pageUrls = [];
      try { pageUrls = JSON.parse(loop.page_urls_json || '[]'); } catch {}
      const assignedCount = pageUrls.filter(p => !!p.page_url).length;
      const totalKm = pageUrls.length;
      const isAssigned = !!loop.page_url || assignedCount > 0;
      const badgeText = totalKm > 0 ? `${assignedCount}/${totalKm}` : (loop.page_url ? 'Linked' : '');
      return `
        <div class="loop-step ${isSelected ? 'selected' : ''} ${isAssigned ? 'assigned' : ''}"
             data-loop-index="${i}">
          <div class="loop-step-header">
            <span class="loop-number">${loop.loop_number}</span>
            <span class="loop-title">${this.escapeHtml(loop.title || `Loop ${loop.loop_number}`)}</span>
            ${!isDemo ? `<span class="loop-product-badge">${this.escapeHtml(loop.primary_product || '')}</span>` : ''}
            ${isAssigned && badgeText ? `<span class="assigned-badge">${badgeText}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const detailHtml = selectedLoop ? this.renderLoopDetail(selectedLoop) : '';

    return `
      <div class="loop-stepper">
        <div class="loop-steps">${stepsHtml}</div>
      </div>
      ${detailHtml}
    `;
  }

  renderLoopDetail(loop) {
    if (this.demoPlanView === 'demo') {
      return this.renderLoopDetailDemo(loop);
    }
    return this.renderLoopDetailAuthoring(loop);
  }

  renderLoopDetailAuthoring(loop) {
    const loopIndex = this.selectedLoopIndex;
    const keyMoments = this.getKeyMomentsWithAssignments(loop);
    const hasKeyMoments = keyMoments.length > 0;

    const phases = [
      { key: 'tell_setup', label: 'TELL (Setup)', icon: '🎯' },
      { key: 'show_demo', label: 'SHOW (Live Demo)', icon: '🖥️' },
      { key: 'tell_connection', label: 'TELL (Connection)', icon: '🔗' },
    ];

    const phasesHtml = phases.map(p => {
      const isEditing = this.editingLoopPhase?.loopIndex === loopIndex
        && this.editingLoopPhase?.phase === p.key;
      const content = loop[p.key] || '';

      if (isEditing) {
        return `
          <div class="loop-phase editing">
            <div class="phase-header">
              <span class="phase-label">${p.icon} ${p.label}</span>
              <div class="phase-actions">
                <button class="phase-save-btn" data-action="savePhase">Save</button>
                <button class="phase-cancel-btn" data-action="cancelPhase">Cancel</button>
              </div>
            </div>
            <textarea id="loopPhaseEditor" class="phase-editor">${this.escapeHtml(content)}</textarea>
          </div>
        `;
      }

      let keyMomentCardsHtml = '';
      if (p.key === 'show_demo' && hasKeyMoments) {
        keyMomentCardsHtml = `
          <div class="key-moments-section">
            <div class="km-section-header">Page Assignments per Key Moment</div>
            ${keyMoments.map((km, ki) => {
              const assigned = !!km.page_url;
              return `
                <div class="km-card ${assigned ? 'assigned' : 'unassigned'}">
                  <div class="km-card-header">
                    <span class="km-dot ${assigned ? 'assigned' : ''}"></span>
                    <span class="km-label">${this.escapeHtml(km.label || km.key)}</span>
                  </div>
                  ${assigned ? `
                    <div class="km-assignment">
                      <span class="km-url" title="${this.escapeHtml(km.page_url)}">${this.escapeHtml(this.getDisplayUrlFromFull(km.page_url))}</span>
                      <button class="km-nav-btn" data-url="${this.escapeHtml(km.page_url)}" title="Navigate">Go</button>
                      <button class="km-unlink-btn" data-loop-index="${loopIndex}" data-km-key="${this.escapeHtml(km.key)}" title="Unlink">✕</button>
                    </div>
                  ` : `
                    <button class="km-assign-btn" data-loop-index="${loopIndex}" data-km-key="${this.escapeHtml(km.key)}">
                      Assign Current Page
                    </button>
                  `}
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      return `
        <div class="loop-phase">
          <div class="phase-header">
            <span class="phase-label">${p.icon} ${p.label}</span>
            <button class="phase-edit-btn" data-phase="${p.key}" data-loop-index="${loopIndex}">Edit</button>
          </div>
          <div class="phase-content">${this.renderMarkdown(content)}</div>
          ${keyMomentCardsHtml}
        </div>
      `;
    }).join('');

    const assignmentHtml = loop.page_url ? `
      <div class="page-assignment assigned">
        <span class="assignment-label">Linked to:</span>
        <span class="assignment-url" title="${this.escapeHtml(loop.page_url)}">${this.escapeHtml(this.getDisplayUrlFromFull(loop.page_url))}</span>
        <button class="nav-to-page-btn" data-url="${this.escapeHtml(loop.page_url)}">Go</button>
        <button class="clear-assignment-btn" data-loop-index="${loopIndex}">Unlink</button>
      </div>
    ` : `
      <div class="page-assignment unassigned">
        <button class="assign-page-btn" data-loop-index="${loopIndex}">
          Assign Current Page
        </button>
        <span class="assignment-hint">Navigate to the Datadog page for this step, then click assign.</span>
      </div>
    `;

    const refineDisabled = this.refiningLoop ? 'disabled' : '';
    const assignedPages = keyMoments.filter(km => !!km.page_url).length;
    let refineLabel;
    if (this.refiningLoop) {
      refineLabel = 'Refining...';
    } else if (assignedPages > 1) {
      refineLabel = `Refine All Pages (${assignedPages})`;
    } else {
      refineLabel = 'Refine with Screenshot';
    }

    return `
      <div class="loop-detail">
        <div class="loop-detail-header">
          <h3>${this.escapeHtml(loop.title || `Loop ${loop.loop_number}`)}</h3>
          ${loop.pain_point ? `<p class="loop-pain-point"><strong>Pain Point:</strong> ${this.escapeHtml(loop.pain_point)}</p>` : ''}
        </div>
        ${assignmentHtml}
        <div class="loop-phases">${phasesHtml}</div>
        <div class="loop-actions">
          <button class="refine-btn" data-loop-index="${loopIndex}" ${refineDisabled}>
            ${refineLabel}
          </button>
        </div>
      </div>
    `;
  }

  renderLoopDetailDemo(loop) {
    const loopIndex = this.selectedLoopIndex;
    const keyMoments = this.getKeyMomentsWithAssignments(loop);
    const activeKmIdx = this.activeKeyMomentIndex;

    const phases = [
      { key: 'tell_setup', label: 'TELL (Setup)', icon: '🎯' },
      { key: 'show_demo', label: 'SHOW (Live Demo)', icon: '🖥️' },
      { key: 'tell_connection', label: 'TELL (Connection)', icon: '🔗' },
    ];

    const phasesHtml = phases.map(p => {
      const content = loop[p.key] || '';

      let keyMomentStepsHtml = '';
      if (p.key === 'show_demo' && keyMoments.length > 0) {
        keyMomentStepsHtml = `
          <div class="km-step-list">
            ${keyMoments.map((km, ki) => {
              const isCurrent = ki === activeKmIdx;
              const isNext = ki === activeKmIdx + 1;
              const isPast = ki < activeKmIdx;
              let stepClass = 'km-step';
              if (isCurrent) stepClass += ' current';
              else if (isNext) stepClass += ' next';
              else if (isPast) stepClass += ' past';

              return `
                <div class="${stepClass}">
                  <div class="km-step-indicator">
                    ${isCurrent ? '<span class="km-here-badge">YOU ARE HERE</span>' : ''}
                    ${isNext ? '<span class="km-next-badge">NEXT →</span>' : ''}
                  </div>
                  <div class="km-step-label">${this.escapeHtml(km.label || km.key)}</div>
                  ${km.page_url && !isCurrent ? `<button class="km-go-btn" data-url="${this.escapeHtml(km.page_url)}">Navigate</button>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      return `
        <div class="loop-phase demo-phase">
          <div class="phase-header">
            <span class="phase-label">${p.icon} ${p.label}</span>
          </div>
          <div class="phase-content">${this.renderMarkdown(content)}</div>
          ${keyMomentStepsHtml}
        </div>
      `;
    }).join('');

    return `
      <div class="loop-detail demo-mode-detail">
        <div class="loop-detail-header">
          <h3>${this.escapeHtml(loop.title || `Loop ${loop.loop_number}`)}</h3>
        </div>
        <div class="loop-phases">${phasesHtml}</div>
      </div>
    `;
  }

  getDisplayUrlFromFull(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  attachDemoPlanListeners(selectedLoop) {
    const demoPlanToggle = document.getElementById('demoPlanToggle');
    if (demoPlanToggle) {
      demoPlanToggle.addEventListener('click', () => this.toggleDemoPlanMode());
    }

    document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleDemoPlanMode(btn.dataset.mode);
      });
    });

    document.querySelectorAll('#optionsBtn, #optionsBtn2').forEach(btn => {
      btn.addEventListener('click', () => this.openOptions());
    });

    const planSelect = document.getElementById('planSelect');
    if (planSelect) {
      planSelect.addEventListener('change', (e) => this.selectPlan(e.target.value));
    }

    const refreshPlansBtn = document.getElementById('refreshPlansBtn');
    if (refreshPlansBtn) {
      refreshPlansBtn.addEventListener('click', async () => {
        await this.loadAvailablePlans();
        this.render();
        this.showNotification('Plans refreshed');
      });
    }

    const headerRefreshBtn = document.getElementById('headerRefreshBtn');
    if (headerRefreshBtn) {
      headerRefreshBtn.addEventListener('click', () => this.refreshCurrentUrl());
    }

    document.querySelectorAll('.loop-step').forEach(el => {
      el.addEventListener('click', () => {
        this.selectLoop(parseInt(el.dataset.loopIndex, 10));
      });
    });

    document.querySelectorAll('.phase-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.startEditingLoopPhase(
          parseInt(btn.dataset.loopIndex, 10),
          btn.dataset.phase
        );
      });
    });

    const savePhaseBtn = document.querySelector('[data-action="savePhase"]');
    if (savePhaseBtn) {
      savePhaseBtn.addEventListener('click', () => this.saveLoopPhaseEdit());
    }

    const cancelPhaseBtn = document.querySelector('[data-action="cancelPhase"]');
    if (cancelPhaseBtn) {
      cancelPhaseBtn.addEventListener('click', () => this.cancelEditingLoopPhase());
    }

    document.querySelectorAll('.assign-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.assignPageToLoop(parseInt(btn.dataset.loopIndex, 10));
      });
    });

    document.querySelectorAll('.clear-assignment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.clearPageAssignment(parseInt(btn.dataset.loopIndex, 10));
      });
    });

    document.querySelectorAll('.nav-to-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.navigateActiveTab(btn.dataset.url);
      });
    });

    document.querySelectorAll('.refine-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.refineLoopWithScreenshot(parseInt(btn.dataset.loopIndex, 10));
      });
    });

    // Key moment buttons
    document.querySelectorAll('.km-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.assignPageToKeyMoment(
          parseInt(btn.dataset.loopIndex, 10),
          btn.dataset.kmKey
        );
      });
    });

    document.querySelectorAll('.km-unlink-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.clearKeyMomentAssignment(
          parseInt(btn.dataset.loopIndex, 10),
          btn.dataset.kmKey
        );
      });
    });

    document.querySelectorAll('.km-nav-btn, .km-go-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.navigateActiveTab(btn.dataset.url);
      });
    });

    const reparseBtn = document.getElementById('reparseLoopsBtn');
    if (reparseBtn) {
      reparseBtn.addEventListener('click', () => this.reparseActivePlanLoops());
    }
  }

  async reparseActivePlanLoops() {
    if (!this.activePlan?.id) return;
    this.showNotification('Re-parsing loops...');
    try {
      const result = await this.demoPlanService.reparseLoops(this.activePlan.id);
      console.log('[DemoPlan] Reparse result:', result);
      if (result.loops_parsed > 0) {
        this.showNotification(`Found ${result.loops_parsed} loops`);
        await this.selectPlan(this.activePlan.id);
      } else {
        this.showNotification('No loops found in plan markdown', 'error');
      }
    } catch (e) {
      console.error('[DemoPlan] Reparse failed:', e);
      this.showNotification('Re-parse failed: ' + e.message, 'error');
    }
  }
}

// Initialize app
new TalkTrackApp();

