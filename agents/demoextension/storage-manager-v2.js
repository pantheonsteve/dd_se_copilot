// Storage Manager v2
// Unified storage layer using IndexedDB with optional cloud sync for Pro users

class StorageManagerV2 {
  constructor() {
    this.storage = indexedDBStorage;
    this.initialized = false;
    this.listeners = new Set();
    
    // Cloud sync state (Pro feature)
    this.syncEnabled = false;
    this.syncInProgress = false;
    this.pendingChanges = false;
    this.cloudService = null; // Will be SupabaseCloudService for Pro users
    
    // Debounce settings
    this.SYNC_DEBOUNCE_MS = 2000;
    this.syncTimeout = null;
  }

  /**
   * Initialize storage and run migration if needed
   * @returns {Promise<StorageManagerV2>}
   */
  async init() {
    if (this.initialized) return this;
    
    try {
      // Initialize IndexedDB
      await this.storage.init();
      
      // Check if we need to migrate from chrome.storage.local
      const migrationComplete = await this.storage.isMigrationComplete();
      
      if (!migrationComplete) {
        console.log('[StorageManager] Running migration from chrome.storage.local...');
        const results = await this.storage.migrateFromChromeStorage();
        console.log('[StorageManager] Migration results:', results);
        
        // Show notification to user if tracks were migrated
        if (results.tracks > 0) {
          this.notifyListeners('migrationComplete', {
            trackCount: results.tracks,
            message: `Migrated ${results.tracks} talk tracks to improved storage`
          });
        }
      }
      
      // Try to initialize Supabase cloud service if configured
      await this.initCloudService();
      
      this.initialized = true;
      console.log('[StorageManager] Initialized successfully');
      
      return this;
    } catch (error) {
      console.error('[StorageManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize Supabase cloud service if configured
   */
  async initCloudService() {
    // Check if Supabase is configured
    if (typeof DEMOBUDDY_CONFIG !== 'undefined' && 
        typeof isCloudEnabled === 'function' && 
        isCloudEnabled() &&
        typeof supabaseCloud !== 'undefined') {
      
      try {
        await supabaseCloud.init(
          DEMOBUDDY_CONFIG.SUPABASE_URL,
          DEMOBUDDY_CONFIG.SUPABASE_ANON_KEY
        );
        
        // Check if user is logged in and has Pro
        if (supabaseCloud.user && supabaseCloud.isPro()) {
          this.cloudService = supabaseCloud;
          this.syncEnabled = true;
          console.log('[StorageManager] Cloud sync enabled for Pro user');
        }
        
        // Listen for auth changes
        supabaseCloud.addAuthListener((event, data) => {
          this.handleAuthChange(event, data);
        });
      } catch (error) {
        console.warn('[StorageManager] Cloud service init failed:', error);
      }
    }
  }

  /**
   * Handle auth state changes from Supabase
   */
  handleAuthChange(event, data) {
    if (event === 'signedIn' && supabaseCloud.isPro()) {
      this.cloudService = supabaseCloud;
      this.syncEnabled = true;
      this.notifyListeners('syncEnabled', { user: data });
    } else if (event === 'signedOut') {
      this.cloudService = null;
      this.syncEnabled = false;
      this.notifyListeners('syncDisabled', {});
    }
  }

  /**
   * Ensure storage is initialized
   */
  async ensureReady() {
    if (!this.initialized) {
      await this.init();
    }
  }

  // ==================== LISTENER MANAGEMENT ====================

  /**
   * Add a listener for storage events
   * @param {Function} callback - Called with (eventType, data)
   */
  addListener(callback) {
    this.listeners.add(callback);
  }

  /**
   * Remove a listener
   * @param {Function} callback
   */
  removeListener(callback) {
    this.listeners.delete(callback);
  }

  /**
   * Notify all listeners of an event
   */
  notifyListeners(eventType, data) {
    this.listeners.forEach(callback => {
      try {
        callback(eventType, data);
      } catch (e) {
        console.error('[StorageManager] Listener error:', e);
      }
    });
  }

  // ==================== TRACK OPERATIONS ====================

  /**
   * Load all tracks
   * @returns {Promise<Array>}
   */
  async loadTracks() {
    await this.ensureReady();
    return await this.storage.getAllTracks();
  }

  /**
   * Get a single track by ID
   * @param {number|string} id
   * @returns {Promise<Object|null>}
   */
  async getTrack(id) {
    await this.ensureReady();
    return await this.storage.getTrack(id);
  }

  /**
   * Get tracks matching a URL
   * @param {string} url
   * @returns {Promise<Array>}
   */
  async getTracksByUrl(url) {
    await this.ensureReady();
    return await this.storage.getTracksByUrl(url);
  }

  /**
   * Save tracks (creates backup and optionally syncs to cloud)
   * @param {Array} tracks
   * @param {Object} options - { skipSync: boolean, reason: string }
   * @returns {Promise<Object>}
   */
  async saveTracks(tracks, options = {}) {
    const { skipSync = false, reason = 'Manual save' } = options;
    
    await this.ensureReady();
    
    console.log(`[StorageManager] Saving ${tracks.length} tracks: ${reason}`);
    
    try {
      // Save to IndexedDB
      await this.storage.replaceAllTracks(tracks);
      
      this.notifyListeners('saved', { 
        trackCount: tracks.length, 
        local: true,
        reason 
      });
      
      // Queue for cloud sync if enabled
      if (!skipSync && this.syncEnabled) {
        this.pendingChanges = true;
        this.notifyListeners('pendingSync', {});
        this.debouncedSync(tracks);
      }
      
      return { success: true, trackCount: tracks.length };
    } catch (error) {
      console.error('[StorageManager] Save failed:', error);
      this.notifyListeners('saveError', { error: error.message });
      throw error;
    }
  }

  /**
   * Save a single track
   * @param {Object} track
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async saveTrack(track, options = {}) {
    await this.ensureReady();
    
    const savedTrack = await this.storage.saveTrack(track);
    
    this.notifyListeners('trackSaved', { track: savedTrack });
    
    // Queue for cloud sync if enabled
    if (!options.skipSync && this.syncEnabled) {
      this.pendingChanges = true;
      await this.storage.addToSyncQueue('update', savedTrack);
      this.debouncedSync();
    }
    
    return savedTrack;
  }

  /**
   * Delete a track
   * @param {number|string} id
   * @param {Object} options
   * @returns {Promise<boolean>}
   */
  async deleteTrack(id, options = {}) {
    await this.ensureReady();
    
    await this.storage.deleteTrack(id);
    
    this.notifyListeners('trackDeleted', { id });
    
    // Queue for cloud sync if enabled
    if (!options.skipSync && this.syncEnabled) {
      this.pendingChanges = true;
      await this.storage.addToSyncQueue('delete', { id });
      this.debouncedSync();
    }
    
    return true;
  }

  // ==================== METADATA OPERATIONS ====================

  /**
   * Get customers list
   * @returns {Promise<Array>}
   */
  async getCustomers() {
    await this.ensureReady();
    return await this.storage.getMetadata('customers') || [];
  }

  /**
   * Save customers list
   * @param {Array} customers
   */
  async saveCustomers(customers) {
    await this.ensureReady();
    await this.storage.setMetadata('customers', customers);
    this.notifyListeners('customersUpdated', { customers });
  }

  /**
   * Get custom personas
   * @returns {Promise<Array>}
   */
  async getCustomPersonas() {
    await this.ensureReady();
    return await this.storage.getMetadata('customPersonas') || [];
  }

  /**
   * Save custom personas
   * @param {Array} personas
   */
  async saveCustomPersonas(personas) {
    await this.ensureReady();
    await this.storage.setMetadata('customPersonas', personas);
  }

  /**
   * Get custom categories
   * @returns {Promise<Array>}
   */
  async getCustomCategories() {
    await this.ensureReady();
    return await this.storage.getMetadata('customCategories') || [];
  }

  /**
   * Save custom categories
   * @param {Array} categories
   */
  async saveCustomCategories(categories) {
    await this.ensureReady();
    await this.storage.setMetadata('customCategories', categories);
  }

  /**
   * Get subscribed packs
   * @returns {Promise<Array>}
   */
  async getSubscribedPacks() {
    await this.ensureReady();
    return await this.storage.getMetadata('subscribedPacks') || [];
  }

  /**
   * Save subscribed packs
   * @param {Array} packs
   */
  async saveSubscribedPacks(packs) {
    await this.ensureReady();
    await this.storage.setMetadata('subscribedPacks', packs);
  }

  /**
   * Load all metadata at once
   * @returns {Promise<Object>}
   */
  async loadMetadata() {
    await this.ensureReady();
    return {
      customCategories: await this.getCustomCategories(),
      customPersonas: await this.getCustomPersonas(),
      customers: await this.getCustomers(),
      subscribedPacks: await this.getSubscribedPacks()
    };
  }

  // ==================== SETTINGS OPERATIONS ====================

  /**
   * Get a setting value
   * @param {string} key
   * @param {any} defaultValue
   * @returns {Promise<any>}
   */
  async getSetting(key, defaultValue = null) {
    await this.ensureReady();
    return await this.storage.getSetting(key, defaultValue);
  }

  /**
   * Set a setting value
   * @param {string} key
   * @param {any} value
   */
  async setSetting(key, value) {
    await this.ensureReady();
    await this.storage.setSetting(key, value);
  }

  /**
   * Get multiple settings
   * @param {Array<string>} keys
   * @returns {Promise<Object>}
   */
  async getSettings(keys) {
    await this.ensureReady();
    return await this.storage.getSettings(keys);
  }

  // ==================== CLOUD SYNC (Pro Feature) ====================

  /**
   * Enable cloud sync for Pro users
   * @param {Object} cloudService - Cloud service instance
   */
  async enableCloudSync(cloudService) {
    this.cloudService = cloudService;
    this.syncEnabled = true;
    this.notifyListeners('syncEnabled', {});
  }

  /**
   * Disable cloud sync
   */
  async disableCloudSync() {
    this.cloudService = null;
    this.syncEnabled = false;
    await this.storage.clearSyncQueue();
    this.notifyListeners('syncDisabled', {});
  }

  /**
   * Debounced sync to cloud
   */
  debouncedSync(tracks = null) {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(async () => {
      await this.syncToCloud(tracks);
    }, this.SYNC_DEBOUNCE_MS);
  }

  /**
   * Sync to cloud
   * @param {Array|null} tracks - Tracks to sync (loads from storage if null)
   * @returns {Promise<Object>}
   */
  async syncToCloud(tracks = null) {
    if (!this.syncEnabled || !this.cloudService) {
      return { success: false, error: 'Cloud sync not enabled' };
    }

    if (this.syncInProgress) {
      console.log('[StorageManager] Sync already in progress');
      return { success: false, error: 'Sync in progress' };
    }

    this.syncInProgress = true;
    this.notifyListeners('syncStarted', {});

    try {
      // Load tracks if not provided
      if (!tracks) {
        tracks = await this.loadTracks();
      }

      // Load metadata
      const metadata = await this.loadMetadata();

      // Sync to cloud service
      const result = await this.cloudService.sync(tracks, metadata);

      if (result.success) {
        this.pendingChanges = false;
        await this.storage.clearSyncQueue();
        await this.setSetting('lastCloudSync', new Date().toISOString());
        
        this.notifyListeners('syncCompleted', {
          trackCount: tracks.length,
          timestamp: new Date().toISOString()
        });
      } else {
        this.notifyListeners('syncError', { error: result.error });
      }

      return result;
    } catch (error) {
      console.error('[StorageManager] Cloud sync error:', error);
      this.notifyListeners('syncError', { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Pull data from cloud
   * @param {string} mode - 'replace' | 'merge' | 'preview'
   * @returns {Promise<Object>}
   */
  async syncFromCloud(mode = 'preview') {
    if (!this.syncEnabled || !this.cloudService) {
      return { success: false, error: 'Cloud sync not enabled' };
    }

    try {
      const result = await this.cloudService.fetch();

      if (!result.success) {
        return result;
      }

      if (mode === 'preview') {
        const localTracks = await this.loadTracks();
        return {
          success: true,
          mode: 'preview',
          local: { trackCount: localTracks.length, tracks: localTracks },
          remote: { trackCount: result.data.tracks.length, tracks: result.data.tracks }
        };
      }

      if (mode === 'replace') {
        await this.saveTracks(result.data.tracks, { skipSync: true, reason: 'Pulled from cloud' });
        return { success: true, mode: 'replace', trackCount: result.data.tracks.length };
      }

      if (mode === 'merge') {
        const localTracks = await this.loadTracks();
        const merged = this.mergeTracks(localTracks, result.data.tracks);
        await this.saveTracks(merged, { skipSync: false, reason: 'Merged from cloud' });
        return { success: true, mode: 'merge', trackCount: merged.length };
      }

      return { success: false, error: 'Invalid sync mode' };
    } catch (error) {
      console.error('[StorageManager] Pull from cloud error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Merge remote tracks into local (non-destructive)
   */
  mergeTracks(localTracks, remoteTracks) {
    const localIds = new Set(localTracks.map(t => t.id));
    const newTracks = remoteTracks.filter(t => !localIds.has(t.id));
    
    const maxOrder = Math.max(...localTracks.map(t => t.order || 0), 0);
    newTracks.forEach((track, index) => {
      track.order = maxOrder + index + 1;
      track.source = 'cloud-merge';
      track.mergedAt = new Date().toISOString();
    });

    return [...localTracks, ...newTracks];
  }

  // ==================== SYNC STATUS ====================

  /**
   * Get current sync status
   * @returns {Promise<Object>}
   */
  async getSyncStatus() {
    await this.ensureReady();
    
    const lastSync = await this.getSetting('lastCloudSync');
    const usage = await this.storage.getStorageUsage();
    const trackCount = await this.storage.getTrackCount();
    
    return {
      isConfigured: this.syncEnabled,
      hasCloudService: !!this.cloudService,
      pendingChanges: this.pendingChanges,
      syncInProgress: this.syncInProgress,
      lastSync,
      trackCount,
      storageUsage: usage
    };
  }

  /**
   * Get sync config (for backwards compatibility)
   */
  async getSyncConfig() {
    return {
      isConfigured: this.syncEnabled,
      hasCloud: !!this.cloudService,
      pendingChanges: this.pendingChanges,
      syncInProgress: this.syncInProgress
    };
  }

  // ==================== EXPORT / IMPORT ====================

  /**
   * Export all data for backup
   * @returns {Promise<Object>}
   */
  async exportAll() {
    await this.ensureReady();
    return await this.storage.exportAll();
  }

  /**
   * Import data from backup
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async importAll(data) {
    await this.ensureReady();
    const results = await this.storage.importAll(data);
    this.notifyListeners('dataImported', results);
    return results;
  }

  /**
   * Get storage usage
   * @returns {Promise<Object>}
   */
  async getStorageUsage() {
    await this.ensureReady();
    return await this.storage.getStorageUsage();
  }

  // ==================== LEGACY COMPATIBILITY ====================

  /**
   * For backwards compatibility with GistSyncService
   * @deprecated Use cloudService directly
   */
  get gistService() {
    console.warn('[StorageManager] gistService is deprecated. Use cloud sync API instead.');
    return {
      isConfigured: () => false,
      hasGist: () => false
    };
  }

  /**
   * Force sync now (legacy compatibility)
   */
  async forceSyncNow() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    return await this.syncToCloud();
  }
}

// Create singleton instance
const storageManager = new StorageManagerV2();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StorageManagerV2, storageManager };
}
