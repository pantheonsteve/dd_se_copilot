// Track Pack Schema and Validation
// Defines the standardized format for track packs and individual tracks

/**
 * Track Pack Schema
 * 
 * A track pack is a collection of talk tracks that can be shared,
 * subscribed to, and updated as a unit.
 * 
 * Example:
 * {
 *   id: "datadog-core-demo",
 *   name: "Datadog Core Demo Pack",
 *   version: "1.2.0",
 *   lastUpdated: "2024-12-05T00:00:00Z",
 *   author: "Datadog SE Team",
 *   description: "Essential talk tracks for Datadog demos",
 *   tracks: [...]
 * }
 */

class TrackPackSchema {
  
  /**
   * Validate a track pack object
   * @param {Object} pack - Track pack to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validatePack(pack) {
    const errors = [];
    
    if (!pack) {
      return { valid: false, errors: ['Pack is null or undefined'] };
    }
    
    // Required fields
    if (!pack.id || typeof pack.id !== 'string') {
      errors.push('Pack must have a string "id" field');
    }
    
    if (!pack.name || typeof pack.name !== 'string') {
      errors.push('Pack must have a string "name" field');
    }
    
    if (!pack.version || typeof pack.version !== 'string') {
      errors.push('Pack must have a string "version" field');
    } else if (!this.isValidSemver(pack.version)) {
      errors.push('Pack version must be valid semver (e.g., "1.0.0")');
    }
    
    if (!pack.tracks || !Array.isArray(pack.tracks)) {
      errors.push('Pack must have a "tracks" array');
    } else {
      // Validate each track
      pack.tracks.forEach((track, index) => {
        const trackValidation = this.validateTrack(track);
        if (!trackValidation.valid) {
          errors.push(`Track ${index}: ${trackValidation.errors.join(', ')}`);
        }
      });
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Validate an individual track object
   * @param {Object} track - Track to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateTrack(track) {
    const errors = [];
    
    if (!track) {
      return { valid: false, errors: ['Track is null or undefined'] };
    }
    
    // Required fields
    if (!track.id && track.id !== 0) {
      errors.push('Track must have an "id" field');
    }
    
    if (!track.urlPattern || typeof track.urlPattern !== 'string') {
      errors.push('Track must have a string "urlPattern" field');
    }
    
    // Optional but recommended fields
    if (track.title && typeof track.title !== 'string') {
      errors.push('Track "title" must be a string');
    }
    
    if (track.content && typeof track.content !== 'string') {
      errors.push('Track "content" must be a string');
    }
    
    if (track.category && typeof track.category !== 'string') {
      errors.push('Track "category" must be a string');
    }
    
    if (track.tags && !Array.isArray(track.tags)) {
      errors.push('Track "tags" must be an array');
    }
    
    if (track.version && !this.isValidSemver(track.version)) {
      errors.push('Track "version" must be valid semver');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Check if a string is valid semantic versioning
   * @param {string} version - Version string
   * @returns {boolean}
   */
  static isValidSemver(version) {
    const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
    return semverRegex.test(version);
  }
  
  /**
   * Compare two semantic versions
   * @param {string} v1 - First version
   * @param {string} v2 - Second version
   * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
   */
  static compareSemver(v1, v2) {
    const parse = (v) => {
      const [main] = v.split('-');
      return main.split('.').map(Number);
    };
    
    const parts1 = parse(v1);
    const parts2 = parse(v2);
    
    for (let i = 0; i < 3; i++) {
      if (parts1[i] > parts2[i]) return 1;
      if (parts1[i] < parts2[i]) return -1;
    }
    
    return 0;
  }
  
  /**
   * Create a new track pack object with defaults
   * @param {Object} options - Pack options
   * @returns {Object} Track pack object
   */
  static createPack(options = {}) {
    return {
      id: options.id || `pack-${Date.now()}`,
      name: options.name || 'Untitled Pack',
      version: options.version || '1.0.0',
      lastUpdated: options.lastUpdated || new Date().toISOString(),
      author: options.author || 'Unknown',
      description: options.description || '',
      tracks: options.tracks || []
    };
  }
  
  /**
   * Create a new track object with defaults and metadata
   * @param {Object} options - Track options
   * @param {string} source - Source identifier (e.g., pack ID or "local")
   * @returns {Object} Track object
   */
  static createTrack(options = {}, source = 'local') {
    const now = new Date().toISOString();
    
    return {
      id: options.id || Date.now(),
      title: options.title || '',
      category: options.category || 'Other',
      tags: options.tags || [],
      urlPattern: options.urlPattern || '',
      content: options.content || '',
      order: options.order ?? 0,
      // Metadata for versioning and tracking
      version: options.version || '1.0.0',
      lastModified: options.lastModified || now,
      source: source,
      originalId: options.originalId || options.id || null
    };
  }
  
  /**
   * Normalize a track to ensure all required fields exist
   * @param {Object} track - Track to normalize
   * @param {string} source - Source identifier
   * @returns {Object} Normalized track
   */
  static normalizeTrack(track, source = 'local') {
    return {
      id: track.id || Date.now(),
      title: track.title || '',
      category: track.category || 'Other',
      tags: track.tags || [],
      urlPattern: track.urlPattern || '',
      content: track.content || '',
      order: track.order ?? 0,
      version: track.version || '1.0.0',
      lastModified: track.lastModified || new Date().toISOString(),
      source: track.source || source,
      originalId: track.originalId || track.id || null,
      // Preserve any additional fields
      ...track
    };
  }
  
  /**
   * Export tracks to a shareable pack format
   * @param {Array} tracks - Tracks to export
   * @param {Object} metadata - Pack metadata
   * @returns {Object} Track pack object
   */
  static exportToPack(tracks, metadata = {}) {
    const normalizedTracks = tracks.map((track, index) => ({
      ...this.normalizeTrack(track, metadata.id || 'exported'),
      order: track.order ?? index
    }));
    
    return this.createPack({
      ...metadata,
      tracks: normalizedTracks
    });
  }
  
  /**
   * Check if a track has been modified from its original version
   * @param {Object} localTrack - Local track
   * @param {Object} originalTrack - Original track from pack
   * @returns {boolean}
   */
  static isTrackModified(localTrack, originalTrack) {
    // Compare content and key fields
    return (
      localTrack.content !== originalTrack.content ||
      localTrack.title !== originalTrack.title ||
      localTrack.urlPattern !== originalTrack.urlPattern
    );
  }
  
  /**
   * Generate a unique ID for a track
   * @returns {number}
   */
  static generateTrackId() {
    return Date.now() + Math.floor(Math.random() * 1000);
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackPackSchema;
}

