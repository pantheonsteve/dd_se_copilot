// Track Pack Manager
// Handles fetching, subscribing, updating, and merging track packs

class TrackPackManager {
  constructor() {
    this.STORAGE_KEY = 'subscribedPacks';
    this.TRACKS_KEY = 'talkTracks';
    
    // Default official pack URLs
    this.officialPacks = [
      {
        url: 'https://raw.githubusercontent.com/pantheonsteve/DDDemoBuddy/main/official-packs/core-demo.json',
        name: 'Datadog Core Demo Pack',
        description: 'Essential talk tracks for core Datadog demos'
      }
    ];
  }
  
  /**
   * Get list of subscribed packs from storage
   * @returns {Promise<Array>} Subscribed packs
   */
  async getSubscribedPacks() {
    const result = await chrome.storage.local.get([this.STORAGE_KEY]);
    return result[this.STORAGE_KEY] || [];
  }
  
  /**
   * Save subscribed packs to storage
   * @param {Array} packs - Subscribed packs
   */
  async saveSubscribedPacks(packs) {
    await chrome.storage.local.set({ [this.STORAGE_KEY]: packs });
  }
  
  /**
   * Get all local tracks from storage
   * @returns {Promise<Array>} Local tracks
   */
  async getLocalTracks() {
    const result = await chrome.storage.local.get([this.TRACKS_KEY]);
    return result[this.TRACKS_KEY] || [];
  }
  
  /**
   * Save tracks to storage
   * @param {Array} tracks - Tracks to save
   */
  async saveTracks(tracks) {
    await chrome.storage.local.set({ [this.TRACKS_KEY]: tracks });
  }
  
  /**
   * Fetch a track pack from a URL
   * @param {string} url - Pack URL
   * @returns {Promise<Object>} Pack data or error
   */
  async fetchPack(url) {
    try {
      const response = await fetch(url, {
        cache: 'no-cache',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const pack = await response.json();
      
      // Validate pack structure
      const validation = TrackPackSchema.validatePack(pack);
      if (!validation.valid) {
        throw new Error(`Invalid pack format: ${validation.errors.join(', ')}`);
      }
      
      return { success: true, pack };
    } catch (error) {
      console.error('Error fetching pack:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Subscribe to a track pack
   * @param {string} url - Pack URL
   * @returns {Promise<Object>} Result with pack info or error
   */
  async subscribeToPack(url) {
    // Fetch the pack first
    const fetchResult = await this.fetchPack(url);
    if (!fetchResult.success) {
      return fetchResult;
    }
    
    const pack = fetchResult.pack;
    
    // Check if already subscribed
    const subscribed = await this.getSubscribedPacks();
    const existingIndex = subscribed.findIndex(p => p.url === url || p.id === pack.id);
    
    if (existingIndex !== -1) {
      return { success: false, error: 'Already subscribed to this pack' };
    }
    
    // Add subscription
    const subscription = {
      id: pack.id,
      url: url,
      name: pack.name,
      version: pack.version,
      lastSynced: new Date().toISOString(),
      trackCount: pack.tracks.length
    };
    
    subscribed.push(subscription);
    await this.saveSubscribedPacks(subscribed);
    
    return { success: true, subscription, pack };
  }
  
  /**
   * Unsubscribe from a track pack
   * @param {string} packId - Pack ID to unsubscribe from
   * @param {boolean} removeTracks - Whether to remove tracks from this pack
   * @returns {Promise<Object>} Result
   */
  async unsubscribeFromPack(packId, removeTracks = false) {
    const subscribed = await this.getSubscribedPacks();
    const newSubscribed = subscribed.filter(p => p.id !== packId);
    
    if (newSubscribed.length === subscribed.length) {
      return { success: false, error: 'Pack not found in subscriptions' };
    }
    
    await this.saveSubscribedPacks(newSubscribed);
    
    // Optionally remove tracks from this pack
    if (removeTracks) {
      const tracks = await this.getLocalTracks();
      const newTracks = tracks.filter(t => t.source !== packId);
      await this.saveTracks(newTracks);
      
      return { 
        success: true, 
        removedTracks: tracks.length - newTracks.length 
      };
    }
    
    return { success: true };
  }
  
  /**
   * Check for updates to subscribed packs
   * @returns {Promise<Array>} Array of packs with available updates
   */
  async checkForUpdates() {
    const subscribed = await this.getSubscribedPacks();
    const updates = [];
    
    for (const sub of subscribed) {
      const fetchResult = await this.fetchPack(sub.url);
      
      if (!fetchResult.success) {
        updates.push({
          ...sub,
          error: fetchResult.error,
          hasUpdate: false
        });
        continue;
      }
      
      const remotePack = fetchResult.pack;
      const comparison = TrackPackSchema.compareSemver(remotePack.version, sub.version);
      
      if (comparison > 0) {
        // Remote version is newer
        const diff = this.comparePackTracks(sub.id, remotePack);
        updates.push({
          ...sub,
          hasUpdate: true,
          newVersion: remotePack.version,
          currentVersion: sub.version,
          diff: diff,
          remotePack: remotePack
        });
      } else {
        updates.push({
          ...sub,
          hasUpdate: false,
          currentVersion: sub.version
        });
      }
    }
    
    return updates;
  }
  
  /**
   * Compare local tracks with remote pack tracks
   * @param {string} packId - Pack ID
   * @param {Object} remotePack - Remote pack data
   * @returns {Object} Diff object with new, modified, and unchanged tracks
   */
  async comparePackTracks(packId, remotePack) {
    const localTracks = await this.getLocalTracks();
    const packTracks = localTracks.filter(t => t.source === packId);
    
    const diff = {
      new: [],
      modified: [],
      unchanged: [],
      locallyModified: [] // Tracks user has customized
    };
    
    for (const remoteTrack of remotePack.tracks) {
      const localTrack = packTracks.find(t => 
        t.originalId === remoteTrack.id || t.originalId === remoteTrack.originalId
      );
      
      if (!localTrack) {
        // New track
        diff.new.push(remoteTrack);
      } else if (TrackPackSchema.isTrackModified(localTrack, remoteTrack)) {
        // Check if local was modified by user or just different from remote
        const wasLocallyModified = localTrack.lastModified > (localTrack.lastSyncedAt || '1970-01-01');
        
        if (wasLocallyModified) {
          diff.locallyModified.push({
            local: localTrack,
            remote: remoteTrack
          });
        } else {
          diff.modified.push({
            local: localTrack,
            remote: remoteTrack
          });
        }
      } else {
        diff.unchanged.push(localTrack);
      }
    }
    
    return diff;
  }
  
  /**
   * Apply updates from a pack
   * @param {Object} updateInfo - Update info from checkForUpdates
   * @param {Object} options - Options for handling conflicts
   * @returns {Promise<Object>} Result with applied changes
   */
  async applyUpdate(updateInfo, options = {}) {
    const {
      applyNew = true,
      applyModified = true,
      conflictResolution = 'keep-local' // 'keep-local', 'use-remote', 'keep-both'
    } = options;
    
    const localTracks = await this.getLocalTracks();
    let tracksToAdd = [];
    let tracksToUpdate = [];
    
    // Handle new tracks
    if (applyNew && updateInfo.diff.new.length > 0) {
      tracksToAdd = updateInfo.diff.new.map(track => 
        TrackPackSchema.normalizeTrack({
          ...track,
          id: TrackPackSchema.generateTrackId(),
          originalId: track.id,
          source: updateInfo.id,
          lastSyncedAt: new Date().toISOString()
        }, updateInfo.id)
      );
    }
    
    // Handle modified tracks
    if (applyModified && updateInfo.diff.modified.length > 0) {
      for (const { local, remote } of updateInfo.diff.modified) {
        const index = localTracks.findIndex(t => t.id === local.id);
        if (index !== -1) {
          localTracks[index] = TrackPackSchema.normalizeTrack({
            ...remote,
            id: local.id,
            originalId: remote.id,
            source: updateInfo.id,
            lastSyncedAt: new Date().toISOString()
          }, updateInfo.id);
          tracksToUpdate.push(localTracks[index]);
        }
      }
    }
    
    // Handle conflicts (locally modified tracks)
    if (updateInfo.diff.locallyModified.length > 0) {
      for (const { local, remote } of updateInfo.diff.locallyModified) {
        const index = localTracks.findIndex(t => t.id === local.id);
        
        switch (conflictResolution) {
          case 'use-remote':
            if (index !== -1) {
              localTracks[index] = TrackPackSchema.normalizeTrack({
                ...remote,
                id: local.id,
                originalId: remote.id,
                source: updateInfo.id,
                lastSyncedAt: new Date().toISOString()
              }, updateInfo.id);
            }
            break;
            
          case 'keep-both':
            // Add remote as a new track
            tracksToAdd.push(TrackPackSchema.normalizeTrack({
              ...remote,
              id: TrackPackSchema.generateTrackId(),
              originalId: remote.id,
              title: `${remote.title || 'Untitled'} (Updated)`,
              source: updateInfo.id,
              lastSyncedAt: new Date().toISOString()
            }, updateInfo.id));
            break;
            
          case 'keep-local':
          default:
            // Do nothing, keep local version
            break;
        }
      }
    }
    
    // Merge and save
    const newTracks = [...localTracks, ...tracksToAdd];
    await this.saveTracks(newTracks);
    
    // Update subscription info
    const subscribed = await this.getSubscribedPacks();
    const subIndex = subscribed.findIndex(p => p.id === updateInfo.id);
    if (subIndex !== -1) {
      subscribed[subIndex].version = updateInfo.newVersion;
      subscribed[subIndex].lastSynced = new Date().toISOString();
      subscribed[subIndex].trackCount = updateInfo.remotePack.tracks.length;
      await this.saveSubscribedPacks(subscribed);
    }
    
    return {
      success: true,
      added: tracksToAdd.length,
      updated: tracksToUpdate.length,
      conflicts: updateInfo.diff.locallyModified.length,
      conflictResolution
    };
  }
  
  /**
   * Import tracks from a pack (initial install)
   * @param {Object} pack - Pack to import
   * @param {Object} options - Import options
   * @returns {Promise<Object>} Result
   */
  async importPack(pack, options = {}) {
    const {
      mergeMode = 'skip-duplicates' // 'skip-duplicates', 'overwrite', 'keep-both'
    } = options;
    
    const localTracks = await this.getLocalTracks();
    const tracksToAdd = [];
    const tracksUpdated = [];
    const tracksSkipped = [];
    
    for (const track of pack.tracks) {
      // Check for existing track with same URL pattern
      const existingIndex = localTracks.findIndex(t => 
        t.urlPattern === track.urlPattern
      );
      
      if (existingIndex !== -1) {
        switch (mergeMode) {
          case 'overwrite':
            localTracks[existingIndex] = TrackPackSchema.normalizeTrack({
              ...track,
              id: localTracks[existingIndex].id,
              originalId: track.id,
              source: pack.id,
              lastSyncedAt: new Date().toISOString()
            }, pack.id);
            tracksUpdated.push(localTracks[existingIndex]);
            break;
            
          case 'keep-both':
            tracksToAdd.push(TrackPackSchema.normalizeTrack({
              ...track,
              id: TrackPackSchema.generateTrackId(),
              originalId: track.id,
              source: pack.id,
              lastSyncedAt: new Date().toISOString()
            }, pack.id));
            break;
            
          case 'skip-duplicates':
          default:
            tracksSkipped.push(track);
            break;
        }
      } else {
        // New track
        tracksToAdd.push(TrackPackSchema.normalizeTrack({
          ...track,
          id: TrackPackSchema.generateTrackId(),
          originalId: track.id,
          source: pack.id,
          lastSyncedAt: new Date().toISOString()
        }, pack.id));
      }
    }
    
    // Save tracks
    const newTracks = [...localTracks, ...tracksToAdd];
    await this.saveTracks(newTracks);
    
    return {
      success: true,
      added: tracksToAdd.length,
      updated: tracksUpdated.length,
      skipped: tracksSkipped.length,
      total: pack.tracks.length
    };
  }
  
  /**
   * Export selected tracks as a pack
   * @param {Array} trackIds - IDs of tracks to export (null for all)
   * @param {Object} metadata - Pack metadata
   * @returns {Promise<Object>} Exported pack
   */
  async exportTracks(trackIds = null, metadata = {}) {
    const allTracks = await this.getLocalTracks();
    
    let tracksToExport;
    if (trackIds && trackIds.length > 0) {
      tracksToExport = allTracks.filter(t => trackIds.includes(t.id));
    } else {
      tracksToExport = allTracks;
    }
    
    // Clean tracks for export (remove local-only fields)
    const cleanedTracks = tracksToExport.map(track => ({
      id: track.originalId || track.id,
      title: track.title,
      category: track.category,
      tags: track.tags || [],
      urlPattern: track.urlPattern,
      content: track.content,
      order: track.order,
      version: track.version || '1.0.0'
    }));
    
    return TrackPackSchema.exportToPack(cleanedTracks, {
      id: metadata.id || `export-${Date.now()}`,
      name: metadata.name || 'Exported Talk Tracks',
      version: metadata.version || '1.0.0',
      author: metadata.author || 'Demo Buddy User',
      description: metadata.description || `Exported on ${new Date().toLocaleDateString()}`
    });
  }
  
  /**
   * Get list of official pack URLs
   * @returns {Array} Official pack info
   */
  getOfficialPacks() {
    return this.officialPacks;
  }
  
  /**
   * Add a custom pack URL to official packs
   * @param {Object} packInfo - Pack info with url, name, description
   */
  addOfficialPack(packInfo) {
    if (!this.officialPacks.find(p => p.url === packInfo.url)) {
      this.officialPacks.push(packInfo);
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackPackManager;
}

