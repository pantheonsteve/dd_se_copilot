// Storage Manager
// Unified coordinator for local storage and GitHub Gist sync

class StorageManager {
  constructor() {
    this.TRACKS_KEY = 'talkTracks';
    this.SYNC_DEBOUNCE_MS = 2000; // Wait 2 seconds after last change before syncing
    this.syncTimeout = null;
    this.gistService = new GistSyncService();
    this.syncInProgress = false;
    this.pendingChanges = false;
    this.listeners = new Set();
    this.initialized = false;
  }

  /**
   * Initialize the storage manager
   */
  async init() {
    if (this.initialized) return;
    
    await this.gistService.init();
    this.initialized = true;
    
    // Listen for storage changes from other contexts
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[this.TRACKS_KEY]) {
        this.notifyListeners('localChange', changes[this.TRACKS_KEY].newValue);
      }
    });

    return this;
  }

  /**
   * Add a listener for sync events
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
        console.error('Storage listener error:', e);
      }
    });
  }

  /**
   * Get current sync configuration status
   */
  async getSyncConfig() {
    return {
      isConfigured: this.gistService.isConfigured(),
      hasGist: this.gistService.hasGist(),
      pendingChanges: this.pendingChanges,
      syncInProgress: this.syncInProgress
    };
  }

  /**
   * Configure GitHub sync with a Personal Access Token
   * @param {string} token - GitHub PAT
   */
  async configureGitHubSync(token) {
    const result = await this.gistService.authenticate(token);
    if (result.valid) {
      this.notifyListeners('configured', { username: result.username });
    }
    return result;
  }

  /**
   * Disconnect GitHub sync
   */
  async disconnectGitHubSync() {
    await this.gistService.disconnect();
    this.notifyListeners('disconnected', {});
  }

  // ==================== LOCAL STORAGE OPERATIONS ====================

  /**
   * Load tracks from local storage
   */
  async loadTracks() {
    const result = await chrome.storage.local.get([this.TRACKS_KEY]);
    return result[this.TRACKS_KEY] || [];
  }

  /**
   * Save tracks to local storage and optionally sync to cloud
   * @param {Array} tracks - Array of talk track objects
   * @param {Object} options - { skipSync: boolean, reason: string }
   */
  async saveTracks(tracks, options = {}) {
    const { skipSync = false, reason = 'Manual save' } = options;

    // Always save to local storage first
    await chrome.storage.local.set({ [this.TRACKS_KEY]: tracks });

    // Create local backup
    await this.createLocalBackup(tracks, reason);

    this.notifyListeners('saved', { trackCount: tracks.length, local: true });

    // Trigger cloud sync if configured and not skipped
    if (!skipSync && this.gistService.isConfigured()) {
      this.pendingChanges = true;
      this.notifyListeners('pendingSync', {});
      this.debouncedSync(tracks);
    }

    return { success: true, trackCount: tracks.length };
  }

  /**
   * Debounced sync to prevent too many API calls
   */
  debouncedSync(tracks) {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(async () => {
      await this.syncToCloud(tracks);
    }, this.SYNC_DEBOUNCE_MS);
  }

  /**
   * Create a local backup before saving
   */
  async createLocalBackup(tracks, reason) {
    try {
      const result = await chrome.storage.local.get(['talkTrackBackups']);
      const backups = result.talkTrackBackups || [];
      
      const backup = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        reason: reason,
        trackCount: tracks.length,
        data: JSON.parse(JSON.stringify(tracks))
      };

      backups.unshift(backup);
      
      // Keep only last 50 backups
      const trimmedBackups = backups.slice(0, 50);
      
      await chrome.storage.local.set({ talkTrackBackups: trimmedBackups });
    } catch (error) {
      console.error('Error creating local backup:', error);
    }
  }

  // ==================== CLOUD SYNC OPERATIONS ====================

  /**
   * Sync tracks to GitHub Gist
   */
  async syncToCloud(tracks = null) {
    if (this.syncInProgress) {
      console.log('Sync already in progress, skipping');
      return { success: false, error: 'Sync in progress' };
    }

    if (!this.gistService.isConfigured()) {
      return { success: false, error: 'GitHub sync not configured' };
    }

    this.syncInProgress = true;
    this.notifyListeners('syncStarted', {});

    try {
      // Load current data if not provided
      if (!tracks) {
        tracks = await this.loadTracks();
      }

      // Load additional metadata to sync
      const metadata = await this.loadMetadata();

      // Sync to gist
      const result = await this.gistService.syncToGist(tracks, metadata);

      if (result.success) {
        await this.gistService.updateLastSyncTime();
        this.pendingChanges = false;
        this.notifyListeners('syncCompleted', {
          gistUrl: result.gistUrl,
          trackCount: tracks.length
        });
      } else {
        this.notifyListeners('syncError', { error: result.error });
      }

      return result;
    } catch (error) {
      console.error('Cloud sync error:', error);
      this.notifyListeners('syncError', { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Pull tracks from GitHub Gist
   * @param {string} mode - 'replace' | 'merge' | 'preview'
   */
  async syncFromCloud(mode = 'preview') {
    if (!this.gistService.isConfigured()) {
      return { success: false, error: 'GitHub sync not configured' };
    }

    this.syncInProgress = true;
    this.notifyListeners('syncStarted', { direction: 'pull' });

    try {
      const result = await this.gistService.syncFromGist();

      if (!result.success) {
        this.notifyListeners('syncError', { error: result.error });
        return result;
      }

      const remoteData = result.data;
      const localTracks = await this.loadTracks();

      if (mode === 'preview') {
        // Just return comparison data
        const comparison = this.compareTracks(localTracks, remoteData.tracks);
        return {
          success: true,
          mode: 'preview',
          local: {
            trackCount: localTracks.length,
            tracks: localTracks
          },
          remote: {
            trackCount: remoteData.tracks.length,
            lastModified: remoteData.lastModified,
            tracks: remoteData.tracks
          },
          comparison: comparison
        };
      }

      if (mode === 'replace') {
        // Replace local with remote
        await this.saveTracks(remoteData.tracks, { skipSync: true, reason: 'Pulled from cloud' });
        
        // Also restore metadata
        if (remoteData.metadata) {
          await this.saveMetadata(remoteData.metadata);
        }

        await this.gistService.updateLastSyncTime();
        
        this.notifyListeners('syncCompleted', {
          direction: 'pull',
          trackCount: remoteData.tracks.length
        });

        return {
          success: true,
          mode: 'replace',
          trackCount: remoteData.tracks.length
        };
      }

      if (mode === 'merge') {
        // Merge remote into local (add tracks that don't exist locally)
        const mergedTracks = this.mergeTracks(localTracks, remoteData.tracks);
        await this.saveTracks(mergedTracks, { skipSync: false, reason: 'Merged from cloud' });

        this.notifyListeners('syncCompleted', {
          direction: 'merge',
          trackCount: mergedTracks.length,
          added: mergedTracks.length - localTracks.length
        });

        return {
          success: true,
          mode: 'merge',
          trackCount: mergedTracks.length,
          added: mergedTracks.length - localTracks.length
        };
      }

      return { success: false, error: 'Invalid sync mode' };
    } catch (error) {
      console.error('Pull from cloud error:', error);
      this.notifyListeners('syncError', { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Compare local and remote tracks
   */
  compareTracks(localTracks, remoteTracks) {
    const localIds = new Set(localTracks.map(t => t.id));
    const remoteIds = new Set(remoteTracks.map(t => t.id));

    const onlyLocal = localTracks.filter(t => !remoteIds.has(t.id));
    const onlyRemote = remoteTracks.filter(t => !localIds.has(t.id));
    const inBoth = localTracks.filter(t => remoteIds.has(t.id));

    // Check for content differences in tracks that exist in both
    const modified = inBoth.filter(localTrack => {
      const remoteTrack = remoteTracks.find(t => t.id === localTrack.id);
      return remoteTrack && (
        localTrack.content !== remoteTrack.content ||
        localTrack.title !== remoteTrack.title ||
        localTrack.urlPattern !== remoteTrack.urlPattern
      );
    });

    return {
      onlyLocal: onlyLocal.length,
      onlyRemote: onlyRemote.length,
      inBoth: inBoth.length,
      modified: modified.length,
      hasConflicts: modified.length > 0
    };
  }

  /**
   * Merge remote tracks into local (non-destructive)
   */
  mergeTracks(localTracks, remoteTracks) {
    const localIds = new Set(localTracks.map(t => t.id));
    const newTracks = remoteTracks.filter(t => !localIds.has(t.id));
    
    // Add new tracks from remote with updated order
    const maxOrder = Math.max(...localTracks.map(t => t.order || 0), 0);
    newTracks.forEach((track, index) => {
      track.order = maxOrder + index + 1;
      track.source = 'cloud-merge';
      track.mergedAt = new Date().toISOString();
    });

    return [...localTracks, ...newTracks];
  }

  /**
   * Load additional metadata (categories, personas, customers)
   */
  async loadMetadata() {
    const result = await chrome.storage.local.get([
      'customCategories',
      'customPersonas', 
      'customers',
      'subscribedPacks'
    ]);

    return {
      customCategories: result.customCategories || [],
      customPersonas: result.customPersonas || [],
      customers: result.customers || [],
      subscribedPacks: result.subscribedPacks || []
    };
  }

  /**
   * Save metadata from cloud sync
   */
  async saveMetadata(metadata) {
    const updates = {};
    
    if (metadata.customCategories) {
      updates.customCategories = metadata.customCategories;
    }
    if (metadata.customPersonas) {
      updates.customPersonas = metadata.customPersonas;
    }
    if (metadata.customers) {
      updates.customers = metadata.customers;
    }
    if (metadata.subscribedPacks) {
      updates.subscribedPacks = metadata.subscribedPacks;
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  }

  // ==================== VERSION HISTORY ====================

  /**
   * Get version history from GitHub Gist
   */
  async getVersionHistory() {
    return await this.gistService.getVersionHistory();
  }

  /**
   * Restore from a specific version
   */
  async restoreVersion(revisionId) {
    const result = await this.gistService.restoreVersion(revisionId);
    
    if (result.success) {
      await this.saveTracks(result.data.tracks, { 
        skipSync: false, 
        reason: `Restored from cloud version ${result.revisionDate}` 
      });

      if (result.data.metadata) {
        await this.saveMetadata(result.data.metadata);
      }
    }

    return result;
  }

  // ==================== STORAGE USAGE ====================

  /**
   * Get storage usage information
   */
  async getStorageUsage() {
    try {
      // Get all storage data
      const data = await chrome.storage.local.get(null);
      const dataStr = JSON.stringify(data);
      const usedBytes = new Blob([dataStr]).size;
      
      // Chrome storage.local has 5MB limit by default, unlimited with permission
      const quotaBytes = chrome.storage.local.QUOTA_BYTES || 5242880;
      
      return {
        usedBytes: usedBytes,
        quotaBytes: quotaBytes,
        usedPercent: Math.round((usedBytes / quotaBytes) * 100),
        usedMB: (usedBytes / (1024 * 1024)).toFixed(2),
        quotaMB: (quotaBytes / (1024 * 1024)).toFixed(2),
        isUnlimited: !!chrome.storage.local.QUOTA_BYTES === false
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return null;
    }
  }

  /**
   * Get sync status for UI display
   */
  async getSyncStatus() {
    const config = await this.getSyncConfig();
    const lastSync = await this.gistService.getLastSyncTime();
    const usage = await this.getStorageUsage();

    return {
      ...config,
      lastSync: lastSync,
      storageUsage: usage
    };
  }

  /**
   * Force immediate sync (manual trigger)
   */
  async forceSyncNow() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    return await this.syncToCloud();
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}

