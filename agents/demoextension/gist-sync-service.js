// GitHub Gist Sync Service
// Handles cloud synchronization of talk tracks via GitHub Gists

class GistSyncService {
  constructor() {
    this.GITHUB_API_BASE = 'https://api.github.com';
    this.GIST_FILENAME = 'demo-buddy-tracks.json';
    this.GIST_DESCRIPTION = 'Demo Buddy Talk Tracks (Auto-synced)';
    this.token = null;
    this.gistId = null;
  }

  /**
   * Initialize the service by loading stored credentials
   */
  async init() {
    const result = await chrome.storage.local.get(['githubToken', 'githubGistId']);
    this.token = result.githubToken || null;
    this.gistId = result.githubGistId || null;
    return this.isConfigured();
  }

  /**
   * Check if GitHub sync is configured
   */
  isConfigured() {
    return !!(this.token);
  }

  /**
   * Check if we have an existing Gist
   */
  hasGist() {
    return !!(this.gistId);
  }

  /**
   * Validate and save a GitHub Personal Access Token
   * @param {string} token - GitHub PAT with 'gist' scope
   * @returns {Promise<Object>} - { valid: boolean, username?: string, error?: string }
   */
  async authenticate(token) {
    try {
      const response = await fetch(`${this.GITHUB_API_BASE}/user`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          return { valid: false, error: 'Invalid token. Please check your Personal Access Token.' };
        }
        return { valid: false, error: `GitHub API error: ${response.status}` };
      }

      const user = await response.json();
      
      // Save the token
      this.token = token;
      await chrome.storage.local.set({ githubToken: token });

      // Try to find an existing Demo Buddy gist
      await this.findExistingGist();

      return { 
        valid: true, 
        username: user.login,
        hasExistingGist: this.hasGist()
      };
    } catch (error) {
      console.error('GitHub authentication error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Remove GitHub token and disconnect sync
   */
  async disconnect() {
    this.token = null;
    this.gistId = null;
    await chrome.storage.local.remove(['githubToken', 'githubGistId']);
  }

  /**
   * Find an existing Demo Buddy gist for this user
   */
  async findExistingGist() {
    if (!this.token) return null;

    try {
      const response = await fetch(`${this.GITHUB_API_BASE}/gists`, {
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch gists: ${response.status}`);
      }

      const gists = await response.json();
      
      // Look for our gist by filename
      const existingGist = gists.find(gist => 
        gist.files && gist.files[this.GIST_FILENAME]
      );

      if (existingGist) {
        this.gistId = existingGist.id;
        await chrome.storage.local.set({ githubGistId: existingGist.id });
        return existingGist;
      }

      return null;
    } catch (error) {
      console.error('Error finding existing gist:', error);
      return null;
    }
  }

  /**
   * Create headers for GitHub API requests
   */
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Sync local tracks to GitHub Gist
   * @param {Array} tracks - Array of talk track objects
   * @param {Object} metadata - Additional metadata (categories, customers, etc.)
   * @returns {Promise<Object>} - { success: boolean, gistUrl?: string, error?: string }
   */
  async syncToGist(tracks, metadata = {}) {
    if (!this.token) {
      return { success: false, error: 'GitHub not configured. Please add your token in settings.' };
    }

    try {
      const payload = {
        version: '1.0',
        lastModified: new Date().toISOString(),
        trackCount: tracks.length,
        tracks: tracks,
        metadata: {
          customCategories: metadata.customCategories || [],
          customPersonas: metadata.customPersonas || [],
          customers: metadata.customers || [],
          subscribedPacks: metadata.subscribedPacks || []
        }
      };

      const content = JSON.stringify(payload, null, 2);

      if (this.gistId) {
        // Update existing gist
        return await this.updateGist(content);
      } else {
        // Create new gist
        return await this.createGist(content);
      }
    } catch (error) {
      console.error('Error syncing to gist:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a new private Gist
   */
  async createGist(content) {
    const response = await fetch(`${this.GITHUB_API_BASE}/gists`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        description: this.GIST_DESCRIPTION,
        public: false,
        files: {
          [this.GIST_FILENAME]: {
            content: content
          }
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `Failed to create gist: ${response.status}`);
    }

    const gist = await response.json();
    this.gistId = gist.id;
    await chrome.storage.local.set({ githubGistId: gist.id });

    return {
      success: true,
      gistId: gist.id,
      gistUrl: gist.html_url,
      message: 'Created new cloud backup'
    };
  }

  /**
   * Update an existing Gist
   */
  async updateGist(content) {
    const response = await fetch(`${this.GITHUB_API_BASE}/gists/${this.gistId}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({
        files: {
          [this.GIST_FILENAME]: {
            content: content
          }
        }
      })
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Gist was deleted, create a new one
        this.gistId = null;
        await chrome.storage.local.remove(['githubGistId']);
        return await this.createGist(content);
      }
      const error = await response.json();
      throw new Error(error.message || `Failed to update gist: ${response.status}`);
    }

    const gist = await response.json();
    return {
      success: true,
      gistId: gist.id,
      gistUrl: gist.html_url,
      message: 'Cloud backup updated'
    };
  }

  /**
   * Pull tracks from GitHub Gist
   * @returns {Promise<Object>} - { success: boolean, data?: Object, error?: string }
   */
  async syncFromGist() {
    if (!this.token) {
      return { success: false, error: 'GitHub not configured' };
    }

    if (!this.gistId) {
      // Try to find existing gist first
      const existingGist = await this.findExistingGist();
      if (!existingGist) {
        return { success: false, error: 'No cloud backup found' };
      }
    }

    try {
      const response = await fetch(`${this.GITHUB_API_BASE}/gists/${this.gistId}`, {
        headers: this.getHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.gistId = null;
          await chrome.storage.local.remove(['githubGistId']);
          return { success: false, error: 'Cloud backup not found. It may have been deleted.' };
        }
        throw new Error(`Failed to fetch gist: ${response.status}`);
      }

      const gist = await response.json();
      const file = gist.files[this.GIST_FILENAME];

      if (!file) {
        return { success: false, error: 'Backup file not found in gist' };
      }

      const data = JSON.parse(file.content);

      return {
        success: true,
        data: data,
        lastModified: data.lastModified,
        gistUrl: gist.html_url
      };
    } catch (error) {
      console.error('Error syncing from gist:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get the revision history of the Gist
   * @returns {Promise<Object>} - { success: boolean, revisions?: Array, error?: string }
   */
  async getVersionHistory() {
    if (!this.token || !this.gistId) {
      return { success: false, error: 'GitHub sync not configured' };
    }

    try {
      const response = await fetch(`${this.GITHUB_API_BASE}/gists/${this.gistId}/commits`, {
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch history: ${response.status}`);
      }

      const commits = await response.json();

      const revisions = commits.map(commit => ({
        id: commit.version,
        committedAt: commit.committed_at,
        changeDescription: commit.change_status ? 
          `+${commit.change_status.additions || 0} -${commit.change_status.deletions || 0}` : 
          'Unknown changes',
        url: commit.url
      }));

      return {
        success: true,
        revisions: revisions
      };
    } catch (error) {
      console.error('Error fetching version history:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Restore from a specific revision
   * @param {string} revisionId - The revision/commit SHA to restore
   * @returns {Promise<Object>} - { success: boolean, data?: Object, error?: string }
   */
  async restoreVersion(revisionId) {
    if (!this.token || !this.gistId) {
      return { success: false, error: 'GitHub sync not configured' };
    }

    try {
      const response = await fetch(`${this.GITHUB_API_BASE}/gists/${this.gistId}/${revisionId}`, {
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch revision: ${response.status}`);
      }

      const gist = await response.json();
      const file = gist.files[this.GIST_FILENAME];

      if (!file) {
        return { success: false, error: 'Backup file not found in this revision' };
      }

      const data = JSON.parse(file.content);

      return {
        success: true,
        data: data,
        revisionDate: gist.updated_at
      };
    } catch (error) {
      console.error('Error restoring version:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get the last sync timestamp from local storage
   */
  async getLastSyncTime() {
    const result = await chrome.storage.local.get(['lastGistSync']);
    return result.lastGistSync || null;
  }

  /**
   * Update the last sync timestamp
   */
  async updateLastSyncTime() {
    const timestamp = new Date().toISOString();
    await chrome.storage.local.set({ lastGistSync: timestamp });
    return timestamp;
  }

  /**
   * Get sync status information
   * @returns {Promise<Object>}
   */
  async getSyncStatus() {
    const [lastSync, localData] = await Promise.all([
      this.getLastSyncTime(),
      chrome.storage.local.get(['talkTracks'])
    ]);

    const status = {
      configured: this.isConfigured(),
      hasGist: this.hasGist(),
      lastSync: lastSync,
      localTrackCount: (localData.talkTracks || []).length
    };

    if (this.isConfigured() && this.hasGist()) {
      // Check if remote is different
      try {
        const remote = await this.syncFromGist();
        if (remote.success) {
          status.remoteLastModified = remote.lastModified;
          status.remoteTrackCount = remote.data.trackCount;
          status.needsSync = remote.lastModified !== lastSync;
        }
      } catch (e) {
        status.syncError = e.message;
      }
    }

    return status;
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GistSyncService;
}

