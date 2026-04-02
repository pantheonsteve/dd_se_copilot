// IndexedDB Storage Manager
// Replaces chrome.storage.local for talk tracks with a robust, high-capacity solution

class IndexedDBStorage {
  constructor() {
    this.DB_NAME = 'DemoBuddyDB';
    this.DB_VERSION = 1;
    this.db = null;
    this.isReady = false;
    this.readyPromise = null;
    
    // Store names
    this.STORES = {
      TRACKS: 'tracks',
      METADATA: 'metadata',
      SYNC_QUEUE: 'syncQueue',
      SETTINGS: 'settings'
    };
  }

  /**
   * Initialize the database connection
   * @returns {Promise<IDBDatabase>}
   */
  async init() {
    if (this.isReady && this.db) {
      return this.db;
    }
    
    if (this.readyPromise) {
      return this.readyPromise;
    }
    
    this.readyPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      
      request.onerror = (event) => {
        console.error('[IndexedDB] Failed to open database:', event.target.error);
        reject(new Error('Failed to open IndexedDB: ' + event.target.error?.message));
      };
      
      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.isReady = true;
        console.log('[IndexedDB] Database opened successfully');
        
        // Handle connection errors
        this.db.onerror = (event) => {
          console.error('[IndexedDB] Database error:', event.target.error);
        };
        
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        console.log('[IndexedDB] Upgrading database schema...');
        const db = event.target.result;
        
        // Tracks store - main storage for talk tracks
        if (!db.objectStoreNames.contains(this.STORES.TRACKS)) {
          const trackStore = db.createObjectStore(this.STORES.TRACKS, { keyPath: 'id' });
          trackStore.createIndex('urlPattern', 'urlPattern', { unique: false });
          trackStore.createIndex('category', 'category', { unique: false });
          trackStore.createIndex('customerId', 'customerId', { unique: false });
          trackStore.createIndex('source', 'source', { unique: false });
          trackStore.createIndex('lastModified', 'lastModified', { unique: false });
          console.log('[IndexedDB] Created tracks store');
        }
        
        // Metadata store - customers, personas, categories, etc.
        if (!db.objectStoreNames.contains(this.STORES.METADATA)) {
          const metaStore = db.createObjectStore(this.STORES.METADATA, { keyPath: 'key' });
          console.log('[IndexedDB] Created metadata store');
        }
        
        // Sync queue - for Pro users, pending changes to sync
        if (!db.objectStoreNames.contains(this.STORES.SYNC_QUEUE)) {
          const syncStore = db.createObjectStore(this.STORES.SYNC_QUEUE, { keyPath: 'id', autoIncrement: true });
          syncStore.createIndex('timestamp', 'timestamp', { unique: false });
          syncStore.createIndex('type', 'type', { unique: false });
          console.log('[IndexedDB] Created sync queue store');
        }
        
        // Settings store - user preferences, API keys, etc.
        if (!db.objectStoreNames.contains(this.STORES.SETTINGS)) {
          db.createObjectStore(this.STORES.SETTINGS, { keyPath: 'key' });
          console.log('[IndexedDB] Created settings store');
        }
      };
    });
    
    return this.readyPromise;
  }

  /**
   * Ensure database is ready before operations
   */
  async ensureReady() {
    if (!this.isReady || !this.db) {
      await this.init();
    }
    return this.db;
  }

  // ==================== TRACK OPERATIONS ====================

  /**
   * Get all tracks
   * @returns {Promise<Array>}
   */
  async getAllTracks() {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readonly');
      const store = tx.objectStore(this.STORES.TRACKS);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const tracks = request.result || [];
        // Sort by order field
        tracks.sort((a, b) => (a.order || 0) - (b.order || 0));
        resolve(tracks);
      };
      
      request.onerror = () => {
        console.error('[IndexedDB] Failed to get tracks:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get a single track by ID
   * @param {number|string} id
   * @returns {Promise<Object|null>}
   */
  async getTrack(id) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readonly');
      const store = tx.objectStore(this.STORES.TRACKS);
      const request = store.get(id);
      
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get tracks by URL pattern match
   * @param {string} url - Current URL to match against
   * @returns {Promise<Array>}
   */
  async getTracksByUrl(url) {
    const allTracks = await this.getAllTracks();
    return allTracks.filter(track => this.urlMatches(url, track.urlPattern));
  }

  /**
   * Get tracks by customer ID
   * @param {string|null} customerId
   * @returns {Promise<Array>}
   */
  async getTracksByCustomer(customerId) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readonly');
      const store = tx.objectStore(this.STORES.TRACKS);
      const index = store.index('customerId');
      const request = index.getAll(customerId);
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save a single track (create or update)
   * @param {Object} track
   * @returns {Promise<Object>}
   */
  async saveTrack(track) {
    await this.ensureReady();
    
    // Ensure required fields
    const now = new Date().toISOString();
    const trackToSave = {
      ...track,
      id: track.id || Date.now(),
      lastModified: now,
      version: track.version || '1.0.0'
    };
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readwrite');
      const store = tx.objectStore(this.STORES.TRACKS);
      const request = store.put(trackToSave);
      
      request.onsuccess = () => {
        console.log(`[IndexedDB] Saved track: ${trackToSave.id} - ${trackToSave.title}`);
        resolve(trackToSave);
      };
      
      request.onerror = () => {
        console.error('[IndexedDB] Failed to save track:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Save multiple tracks in a single transaction
   * @param {Array} tracks
   * @returns {Promise<Array>}
   */
  async saveTracks(tracks) {
    await this.ensureReady();
    
    const now = new Date().toISOString();
    const tracksToSave = tracks.map(track => ({
      ...track,
      id: track.id || Date.now() + Math.random(),
      lastModified: now
    }));
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readwrite');
      const store = tx.objectStore(this.STORES.TRACKS);
      
      let savedCount = 0;
      
      tracksToSave.forEach(track => {
        const request = store.put(track);
        request.onsuccess = () => savedCount++;
        request.onerror = () => console.error(`[IndexedDB] Failed to save track ${track.id}:`, request.error);
      });
      
      tx.oncomplete = () => {
        console.log(`[IndexedDB] Saved ${savedCount} tracks`);
        resolve(tracksToSave);
      };
      
      tx.onerror = () => {
        console.error('[IndexedDB] Transaction failed:', tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * Replace all tracks (atomic operation)
   * @param {Array} tracks
   * @returns {Promise<Array>}
   */
  async replaceAllTracks(tracks) {
    await this.ensureReady();
    
    const now = new Date().toISOString();
    const tracksToSave = tracks.map((track, index) => ({
      ...track,
      id: track.id || Date.now() + index,
      lastModified: track.lastModified || now,
      order: track.order ?? index
    }));
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readwrite');
      const store = tx.objectStore(this.STORES.TRACKS);
      
      // Clear existing tracks
      const clearRequest = store.clear();
      
      clearRequest.onsuccess = () => {
        // Add all new tracks
        tracksToSave.forEach(track => {
          store.put(track);
        });
      };
      
      clearRequest.onerror = () => {
        reject(new Error('Failed to clear tracks store'));
      };
      
      tx.oncomplete = () => {
        console.log(`[IndexedDB] Replaced all tracks with ${tracksToSave.length} tracks`);
        resolve(tracksToSave);
      };
      
      tx.onerror = () => {
        console.error('[IndexedDB] Replace transaction failed:', tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * Delete a track by ID
   * @param {number|string} id
   * @returns {Promise<boolean>}
   */
  async deleteTrack(id) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readwrite');
      const store = tx.objectStore(this.STORES.TRACKS);
      const request = store.delete(id);
      
      request.onsuccess = () => {
        console.log(`[IndexedDB] Deleted track: ${id}`);
        resolve(true);
      };
      
      request.onerror = () => {
        console.error('[IndexedDB] Failed to delete track:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get track count
   * @returns {Promise<number>}
   */
  async getTrackCount() {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.TRACKS, 'readonly');
      const store = tx.objectStore(this.STORES.TRACKS);
      const request = store.count();
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== METADATA OPERATIONS ====================

  /**
   * Get metadata value by key
   * @param {string} key
   * @returns {Promise<any>}
   */
  async getMetadata(key) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.METADATA, 'readonly');
      const store = tx.objectStore(this.STORES.METADATA);
      const request = store.get(key);
      
      request.onsuccess = () => {
        resolve(request.result?.value ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Set metadata value
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async setMetadata(key, value) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.METADATA, 'readwrite');
      const store = tx.objectStore(this.STORES.METADATA);
      const request = store.put({ key, value, updatedAt: new Date().toISOString() });
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all metadata
   * @returns {Promise<Object>}
   */
  async getAllMetadata() {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.METADATA, 'readonly');
      const store = tx.objectStore(this.STORES.METADATA);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const result = {};
        (request.result || []).forEach(item => {
          result[item.key] = item.value;
        });
        resolve(result);
      };
      request.onerror = () => reject(request.error);
    });
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
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SETTINGS, 'readonly');
      const store = tx.objectStore(this.STORES.SETTINGS);
      const request = store.get(key);
      
      request.onsuccess = () => {
        resolve(request.result?.value ?? defaultValue);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Set a setting value
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async setSetting(key, value) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SETTINGS, 'readwrite');
      const store = tx.objectStore(this.STORES.SETTINGS);
      const request = store.put({ key, value });
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get multiple settings at once
   * @param {Array<string>} keys
   * @returns {Promise<Object>}
   */
  async getSettings(keys) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SETTINGS, 'readonly');
      const store = tx.objectStore(this.STORES.SETTINGS);
      const result = {};
      let pending = keys.length;
      
      if (pending === 0) {
        resolve(result);
        return;
      }
      
      keys.forEach(key => {
        const request = store.get(key);
        request.onsuccess = () => {
          result[key] = request.result?.value ?? null;
          pending--;
          if (pending === 0) resolve(result);
        };
        request.onerror = () => {
          pending--;
          if (pending === 0) resolve(result);
        };
      });
    });
  }

  // ==================== SYNC QUEUE OPERATIONS (Pro Feature) ====================

  /**
   * Add an item to the sync queue
   * @param {string} type - 'create', 'update', 'delete'
   * @param {Object} data - The data to sync
   * @returns {Promise<number>} Queue item ID
   */
  async addToSyncQueue(type, data) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SYNC_QUEUE, 'readwrite');
      const store = tx.objectStore(this.STORES.SYNC_QUEUE);
      
      const item = {
        type,
        data,
        timestamp: new Date().toISOString(),
        retryCount: 0
      };
      
      const request = store.add(item);
      
      request.onsuccess = () => {
        console.log(`[IndexedDB] Added to sync queue: ${type}`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all pending sync items
   * @returns {Promise<Array>}
   */
  async getSyncQueue() {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SYNC_QUEUE, 'readonly');
      const store = tx.objectStore(this.STORES.SYNC_QUEUE);
      const index = store.index('timestamp');
      const request = index.getAll();
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Remove an item from the sync queue
   * @param {number} id
   * @returns {Promise<void>}
   */
  async removeFromSyncQueue(id) {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SYNC_QUEUE, 'readwrite');
      const store = tx.objectStore(this.STORES.SYNC_QUEUE);
      const request = store.delete(id);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear the entire sync queue
   * @returns {Promise<void>}
   */
  async clearSyncQueue() {
    await this.ensureReady();
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORES.SYNC_QUEUE, 'readwrite');
      const store = tx.objectStore(this.STORES.SYNC_QUEUE);
      const request = store.clear();
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== MIGRATION FROM CHROME.STORAGE ====================

  /**
   * Migrate data from chrome.storage.local to IndexedDB
   * @returns {Promise<Object>} Migration results
   */
  async migrateFromChromeStorage() {
    console.log('[IndexedDB] Starting migration from chrome.storage.local...');
    
    const results = {
      tracks: 0,
      customers: false,
      personas: false,
      categories: false,
      settings: 0,
      errors: []
    };
    
    try {
      await this.ensureReady();
      
      // Get all data from chrome.storage.local
      const chromeData = await new Promise((resolve) => {
        chrome.storage.local.get(null, resolve);
      });
      
      console.log('[IndexedDB] Found chrome.storage data:', Object.keys(chromeData));
      
      // Migrate tracks
      if (chromeData.talkTracks && Array.isArray(chromeData.talkTracks)) {
        await this.replaceAllTracks(chromeData.talkTracks);
        results.tracks = chromeData.talkTracks.length;
        console.log(`[IndexedDB] Migrated ${results.tracks} tracks`);
      }
      
      // Migrate customers
      if (chromeData.customers) {
        await this.setMetadata('customers', chromeData.customers);
        results.customers = true;
      }
      
      // Migrate custom personas
      if (chromeData.customPersonas) {
        await this.setMetadata('customPersonas', chromeData.customPersonas);
        results.personas = true;
      }
      
      // Migrate custom categories
      if (chromeData.customCategories) {
        await this.setMetadata('customCategories', chromeData.customCategories);
        results.categories = true;
      }
      
      // Migrate subscribed packs
      if (chromeData.subscribedPacks) {
        await this.setMetadata('subscribedPacks', chromeData.subscribedPacks);
      }
      
      // Migrate settings
      const settingsKeys = ['baseUrl', 'openaiApiKey', 'selectedCustomerId', 'githubToken', 'githubGistId', 'lastGistSync'];
      for (const key of settingsKeys) {
        if (chromeData[key] !== undefined) {
          await this.setSetting(key, chromeData[key]);
          results.settings++;
        }
      }
      
      // Mark migration as complete
      await this.setSetting('migrationCompleted', {
        timestamp: new Date().toISOString(),
        results
      });
      
      console.log('[IndexedDB] Migration completed:', results);
      return results;
      
    } catch (error) {
      console.error('[IndexedDB] Migration error:', error);
      results.errors.push(error.message);
      return results;
    }
  }

  /**
   * Check if migration has been completed
   * @returns {Promise<boolean>}
   */
  async isMigrationComplete() {
    try {
      const migration = await this.getSetting('migrationCompleted');
      return !!migration;
    } catch {
      return false;
    }
  }

  // ==================== UTILITY METHODS ====================

  /**
   * URL pattern matching
   * @param {string} url
   * @param {string} pattern
   * @returns {boolean}
   */
  urlMatches(url, pattern) {
    if (!url || !pattern) return false;
    
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }
    return url.includes(pattern);
  }

  /**
   * Get database storage usage estimate
   * @returns {Promise<Object>}
   */
  async getStorageUsage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return {
          usedBytes: estimate.usage || 0,
          quotaBytes: estimate.quota || 0,
          usedMB: ((estimate.usage || 0) / (1024 * 1024)).toFixed(2),
          quotaMB: ((estimate.quota || 0) / (1024 * 1024)).toFixed(2),
          usedPercent: estimate.quota ? Math.round((estimate.usage / estimate.quota) * 100) : 0
        };
      }
      return null;
    } catch (error) {
      console.error('[IndexedDB] Failed to get storage estimate:', error);
      return null;
    }
  }

  /**
   * Export all data for backup
   * @returns {Promise<Object>}
   */
  async exportAll() {
    const tracks = await this.getAllTracks();
    const metadata = await this.getAllMetadata();
    const settings = await this.getSettings([
      'baseUrl', 'selectedCustomerId', 'lastGistSync'
    ]);
    
    return {
      version: '2.0.0',
      exportedAt: new Date().toISOString(),
      tracks,
      metadata,
      settings
    };
  }

  /**
   * Import data from backup
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async importAll(data) {
    const results = { tracks: 0, metadata: 0, settings: 0 };
    
    if (data.tracks && Array.isArray(data.tracks)) {
      await this.replaceAllTracks(data.tracks);
      results.tracks = data.tracks.length;
    }
    
    if (data.metadata && typeof data.metadata === 'object') {
      for (const [key, value] of Object.entries(data.metadata)) {
        await this.setMetadata(key, value);
        results.metadata++;
      }
    }
    
    if (data.settings && typeof data.settings === 'object') {
      for (const [key, value] of Object.entries(data.settings)) {
        if (value !== null) {
          await this.setSetting(key, value);
          results.settings++;
        }
      }
    }
    
    return results;
  }

  /**
   * Clear all data (use with caution!)
   * @returns {Promise<void>}
   */
  async clearAll() {
    await this.ensureReady();
    
    const storeNames = Object.values(this.STORES);
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeNames, 'readwrite');
      
      storeNames.forEach(storeName => {
        tx.objectStore(storeName).clear();
      });
      
      tx.oncomplete = () => {
        console.log('[IndexedDB] All data cleared');
        resolve();
      };
      
      tx.onerror = () => reject(tx.error);
    });
  }
}

// Create singleton instance
const indexedDBStorage = new IndexedDBStorage();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IndexedDBStorage, indexedDBStorage };
}
