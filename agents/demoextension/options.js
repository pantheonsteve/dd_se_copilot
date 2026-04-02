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

// Options page logic
class OptionsManager {
  constructor() {
    this.tracks = [];
    this.selectedTracks = new Set();
    this.searchTerm = '';
    this.filterCategory = 'all';
    this.filterTag = 'all';
    this.allTags = []; // All unique tags across tracks
    this.expandedTracks = new Set();
    this.maxBackups = 50; // Keep last 50 versions
    this.backupHistory = [];
    this.quillEditors = new Map(); // Store Quill instances by track ID
    this.packManager = new TrackPackManager(); // Track pack manager
    this.subscribedPacks = []; // Subscribed packs
    this.storageManager = null; // Will be initialized in initCloudSync
    this.defaultCategories = [
      'Dashboards',
      'APM',
      'Logs',
      'Infrastructure',
      'RUM',
      'Synthetics',
      'Security',
      'Monitors',
      'Other'
    ];
    this.customCategories = [];
    this.categories = [];
    this.defaultPersonas = [
      {
        id: 'sales-engineer',
        name: 'Sales Engineer',
        description: 'Focus on features, benefits, ROI, competitive advantages, and customer success stories',
        isDefault: true
      },
      {
        id: 'solutions-architect',
        name: 'Solutions Architect',
        description: 'Emphasize technical architecture, integrations, scalability, and implementation best practices',
        isDefault: true
      },
      {
        id: 'executive-briefing',
        name: 'Executive Briefing',
        description: 'High-level business value, strategic benefits, time-to-value, and key metrics',
        isDefault: true
      },
      {
        id: 'technical-deep-dive',
        name: 'Technical Deep Dive',
        description: 'In-depth technical details, APIs, data models, query languages, and advanced features',
        isDefault: true
      },
      {
        id: 'customer-success',
        name: 'Customer Success',
        description: 'Onboarding guidance, best practices, tips and tricks, common pitfalls, and support resources',
        isDefault: true
      }
    ];
    this.customPersonas = [];
    this.customers = []; // Customer profiles for customer-specific talk tracks
    this.selectedCustomerId = null; // Currently selected customer for filtering
    this.apiKey = '';
    this.aiService = new AIService();
    this.init();
  }

  async init() {
    try {
      await this.loadTracks();
      await this.loadBackupHistory();
      await this.loadBaseUrl();
      await this.loadApiKey();
      await this.loadCopilotUrl();
      await this.loadPersonas();
      await this.loadCustomCategories();
      await this.loadSubscribedPacks();
      await this.loadCustomers();
      await this.initCloudSync();
      this.updateCategories();
      this.renderCategoryFilter();
      this.renderCustomerFilter();
      this.render();
      this.renderPersonas();
      this.renderCategories();
      this.renderCustomers();
      this.renderBackupInfo();
      this.renderTrackPacks();
      this.renderCloudSync();
      this.setupEventListeners();
    } catch (error) {
      console.error('OptionsManager init failed:', error);
    }
  }

  // ==================== CLOUD SYNC ====================
  
  async initCloudSync() {
    window.DD_RUM.addAction('initCloudSync');
    try {
      // Use the new StorageManagerV2 singleton (IndexedDB-based)
      if (typeof storageManager === 'undefined') {
        console.warn('StorageManagerV2 not available');
        this.storageManager = null;
        return;
      }
      
      this.storageManager = storageManager;
      await this.storageManager.init();
      
      // Listen for storage events
      this.storageManager.addListener((eventType, data) => {
        this.handleSyncEvent(eventType, data);
      });
      
      console.log('[OptionsManager] Storage initialized with IndexedDB');
    } catch (error) {
      console.error('Storage init error:', error);
      this.storageManager = null;
    }
  }

  handleSyncEvent(eventType, data) {
    console.log('Sync event:', eventType, data);
    window.DD_RUM.addAction('syncEvent', eventType, data);
    
    switch (eventType) {
      case 'syncStarted':
        this.updateSyncStatus('syncing', 'Syncing...');
        break;
      case 'syncCompleted':
        this.updateSyncStatus('synced', `Synced! ${data.trackCount} tracks`);
        window.DD_RUM.addAction('syncCompleted', data.trackCount);
        this.renderCloudSync();
        break;
      case 'syncError':
        this.updateSyncStatus('error', `Sync failed: ${data.error}`);
        break;
      case 'pendingSync':
        this.updateSyncStatus('pending', 'Changes pending...');
        break;
      case 'configured':
        this.showStatus(`Connected as ${data.username}`, false);
        this.renderCloudSync();
        break;
      case 'disconnected':
        this.showStatus('GitHub disconnected', false);
        this.renderCloudSync();
        break;
    }
  }

  updateSyncStatus(status, message) {
    const container = document.getElementById('syncStatusContainer');
    if (!container) return;

    const iconMap = {
      'synced': '✅',
      'syncing': '🔄',
      'pending': '⏳',
      'error': '❌',
      'disconnected': '⚪'
    };

    container.innerHTML = `
      <div class="sync-status-indicator ${status}">
        <span class="sync-status-icon">${iconMap[status] || '⚪'}</span>
        <span class="sync-status-text">${message}</span>
      </div>
    `;
  }

  async renderCloudSync() {
    if (!this.storageManager) {
      // Cloud sync not available, show disabled state
      this.updateSyncStatus('disconnected', 'Cloud sync not available');
      const syncActions = document.getElementById('syncActions');
      if (syncActions) syncActions.style.display = 'none';
      return;
    }
    
    const syncStatus = await this.storageManager.getSyncStatus();
    const isConfigured = syncStatus.isConfigured;
    
    // Update status container
    if (isConfigured) {
      if (syncStatus.pendingChanges) {
        this.updateSyncStatus('pending', 'Changes pending sync');
      } else if (syncStatus.lastSync) {
        const lastSyncDate = new Date(syncStatus.lastSync);
        this.updateSyncStatus('synced', `Last synced: ${lastSyncDate.toLocaleString()}`);
      } else {
        this.updateSyncStatus('synced', 'Connected');
      }
    } else {
      this.updateSyncStatus('disconnected', 'Not configured');
    }

    // Show/hide elements based on config status
    const syncActions = document.getElementById('syncActions');
    const disconnectBtn = document.getElementById('disconnectGithubBtn');
    const connectBtn = document.getElementById('connectGithubBtn');
    const tokenInput = document.getElementById('githubToken');
    
    if (syncActions) {
      syncActions.style.display = isConfigured ? 'block' : 'none';
    }
    if (disconnectBtn) {
      disconnectBtn.style.display = isConfigured ? 'inline-block' : 'none';
    }
    if (connectBtn) {
      connectBtn.style.display = isConfigured ? 'none' : 'inline-block';
    }
    if (tokenInput && isConfigured) {
      tokenInput.value = '••••••••••••••••';
      tokenInput.disabled = true;
    } else if (tokenInput) {
      tokenInput.disabled = false;
      tokenInput.value = '';
    }

    // Update last sync info
    const lastSyncInfo = document.getElementById('lastSyncInfo');
    if (lastSyncInfo && syncStatus.lastSync) {
      const date = new Date(syncStatus.lastSync);
      lastSyncInfo.textContent = `Last synced: ${date.toLocaleString()}`;
    }

    // Update storage usage
    this.renderStorageUsage(syncStatus.storageUsage);
  }

  renderStorageUsage(usage) {
    const barFill = document.getElementById('storageBarFill');
    const usageText = document.getElementById('storageUsageText');
    
    if (!usage) {
      if (usageText) usageText.textContent = 'Unable to calculate storage';
      return;
    }

    if (barFill) {
      barFill.style.width = `${Math.min(usage.usedPercent, 100)}%`;
      barFill.className = 'storage-bar-fill';
      if (usage.usedPercent > 90) {
        barFill.classList.add('critical');
      } else if (usage.usedPercent > 70) {
        barFill.classList.add('warning');
      }
    }

    if (usageText) {
      usageText.textContent = `${usage.usedMB} MB used${usage.isUnlimited ? '' : ` of ${usage.quotaMB} MB`}`;
    }
  }

  async connectGitHub() {
    if (!this.storageManager) {
      this.showGitHubStatus('Cloud sync not available', true);
      return;
    }
    
    const tokenInput = document.getElementById('githubToken');
    const token = tokenInput?.value?.trim();
    
    if (!token || token === '••••••••••••••••') {
      this.showGitHubStatus('Please enter a valid GitHub token', true);
      return;
    }

    this.showGitHubStatus('Connecting...', false);

    try {
      const result = await this.storageManager.configureGitHubSync(token);
      
      if (result.valid) {
        this.showGitHubStatus(`✓ Connected as ${result.username}${result.hasExistingGist ? ' (found existing backup)' : ''}`, false);
        this.renderCloudSync();
      } else {
        this.showGitHubStatus(`✗ ${result.error}`, true);
      }
    } catch (error) {
      this.showGitHubStatus(`✗ Error: ${error.message}`, true);
    }
  }

  async disconnectGitHub() {
    if (!this.storageManager) return;
    
    if (!confirm('Disconnect GitHub sync? Your local tracks will be kept, but cloud sync will be disabled.')) {
      return;
    }

    await this.storageManager.disconnectGitHubSync();
    this.showGitHubStatus('Disconnected', false);
    this.renderCloudSync();
  }

  showGitHubStatus(message, isError) {
    const status = document.getElementById('githubStatus');
    if (status) {
      status.textContent = message;
      status.className = isError ? 'api-key-status error' : 'api-key-status success';
      
      setTimeout(() => {
        status.textContent = '';
        status.className = 'api-key-status';
      }, 5000);
    }
  }

  async syncNow() {
    if (!this.storageManager) {
      this.showStatus('Cloud sync not available', true);
      return;
    }
    
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = '⏳ Syncing...';
    }

    try {
      const result = await this.storageManager.forceSyncNow();
      
      if (result.success) {
        this.showStatus('Synced to cloud successfully!', false);
      } else {
        this.showStatus(`Sync failed: ${result.error}`, true);
      }
    } catch (error) {
      this.showStatus(`Sync error: ${error.message}`, true);
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.textContent = '⬆️ Sync Now';
      }
      this.renderCloudSync();
    }
  }

  async pullFromCloud() {
    if (!this.storageManager) {
      this.showStatus('Cloud sync not available', true);
      return;
    }
    
    const pullBtn = document.getElementById('pullFromCloudBtn');
    if (pullBtn) {
      pullBtn.disabled = true;
      pullBtn.textContent = '⏳ Loading...';
    }

    try {
      // First get a preview
      const preview = await this.storageManager.syncFromCloud('preview');
      
      if (!preview.success) {
        this.showStatus(`Failed to fetch cloud data: ${preview.error}`, true);
        return;
      }

      // Show conflict/merge modal
      this.showPullConfirmModal(preview);
    } catch (error) {
      this.showStatus(`Error: ${error.message}`, true);
    } finally {
      if (pullBtn) {
        pullBtn.disabled = false;
        pullBtn.textContent = '⬇️ Pull from Cloud';
      }
    }
  }

  showPullConfirmModal(preview) {
    const existing = document.getElementById('pullConfirmModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'pullConfirmModal';
    modal.className = 'modal conflict-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>⬇️ Pull from Cloud</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="conflict-comparison">
            <div class="conflict-side local">
              <h4>📱 Local</h4>
              <div class="conflict-stat"><strong>${preview.local.trackCount}</strong> tracks</div>
            </div>
            <div class="conflict-side remote">
              <h4>☁️ Cloud</h4>
              <div class="conflict-stat"><strong>${preview.remote.trackCount}</strong> tracks</div>
              <div class="conflict-stat">Last modified: ${new Date(preview.remote.lastModified).toLocaleString()}</div>
            </div>
          </div>
          
          ${preview.comparison.hasConflicts ? `
            <div class="conflict-warning" style="background: var(--dd-warning-bg); padding: 12px; border-radius: 6px; margin-bottom: 16px;">
              ⚠️ <strong>${preview.comparison.modified}</strong> track(s) have different content between local and cloud.
            </div>
          ` : ''}
          
          <div class="conflict-options">
            <h4>Choose an action:</h4>
            <label class="conflict-option">
              <input type="radio" name="pullAction" value="replace" checked>
              <div class="conflict-option-text">
                <div class="conflict-option-title">Replace local with cloud</div>
                <div class="conflict-option-desc">Overwrite all local tracks with cloud version. A backup will be created first.</div>
              </div>
            </label>
            <label class="conflict-option">
              <input type="radio" name="pullAction" value="merge">
              <div class="conflict-option-text">
                <div class="conflict-option-title">Merge (add new tracks only)</div>
                <div class="conflict-option-desc">Keep local tracks and add ${preview.comparison.onlyRemote} track(s) that only exist in cloud.</div>
              </div>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Cancel</button>
          <button class="save-btn" id="confirmPullBtn">Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelector('#confirmPullBtn').addEventListener('click', async () => {
      const action = modal.querySelector('input[name="pullAction"]:checked').value;
      modal.remove();
      
      const result = await this.storageManager.syncFromCloud(action);
      
      if (result.success) {
        this.showStatus(`Successfully ${action === 'replace' ? 'replaced' : 'merged'} with cloud data!`, false);
        await this.loadTracks();
        this.render();
        this.renderCloudSync();
      } else {
        this.showStatus(`Failed: ${result.error}`, true);
      }
    });
  }

  async showVersionHistory() {
    if (!this.storageManager) {
      this.showStatus('Cloud sync not available', true);
      return;
    }
    
    const result = await this.storageManager.getVersionHistory();
    
    if (!result.success) {
      this.showStatus(`Failed to load history: ${result.error}`, true);
      return;
    }

    const existing = document.getElementById('versionHistoryModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'versionHistoryModal';
    modal.className = 'modal version-history-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>📜 Version History</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${result.revisions.length === 0 ? 
            '<p style="text-align: center; color: var(--dd-gray-500);">No version history yet. Sync to cloud to start tracking versions.</p>' :
            `<div class="version-list">
              ${result.revisions.map((rev, index) => `
                <div class="version-item" data-revision-id="${rev.id}">
                  <div class="version-info">
                    <div class="version-date">${new Date(rev.committedAt).toLocaleString()}</div>
                    <div class="version-changes">${rev.changeDescription}</div>
                  </div>
                  <div class="version-actions">
                    ${index > 0 ? `<button class="restore-version-btn" data-revision-id="${rev.id}">↩️ Restore</button>` : '<span style="font-size: 10px; color: var(--dd-gray-400);">Current</span>'}
                  </div>
                </div>
              `).join('')}
            </div>`
          }
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelectorAll('.restore-version-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const revisionId = e.target.dataset.revisionId;
        
        if (!confirm('Restore this version? Your current tracks will be backed up first.')) {
          return;
        }

        modal.remove();
        
        const restoreResult = await this.storageManager.restoreVersion(revisionId);
        
        if (restoreResult.success) {
          this.showStatus('Version restored successfully!', false);
          await this.loadTracks();
          this.render();
        } else {
          this.showStatus(`Restore failed: ${restoreResult.error}`, true);
        }
      });
    });
  }

  async loadBackupHistory() {
    try {
      const result = await chrome.storage.local.get(['talkTrackBackups']);
      this.backupHistory = result.talkTrackBackups || [];
    } catch (error) {
      console.error('Error loading backup history:', error);
      this.backupHistory = [];
    }
  }

  async createBackup(reason = 'Manual save') {
    try {
      const backup = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        reason: reason,
        trackCount: this.tracks.length,
        data: JSON.parse(JSON.stringify(this.tracks)) // Deep clone
      };

      this.backupHistory.unshift(backup);

      // Keep only the last N backups
      if (this.backupHistory.length > this.maxBackups) {
        this.backupHistory = this.backupHistory.slice(0, this.maxBackups);
      }

      await chrome.storage.local.set({ talkTrackBackups: this.backupHistory });
      console.log(`Backup created: ${reason} (${this.tracks.length} tracks)`);
      
      return backup;
    } catch (error) {
      console.error('Error creating backup:', error);
      throw error;
    }
  }

  async restoreBackup(backupId) {
    const backup = this.backupHistory.find(b => b.id === backupId);
    if (!backup) {
      this.showStatus('Backup not found!', true);
      return;
    }

    // Create a backup of current state before restoring
    await this.createBackup('Pre-restore backup');

    // Restore the backup using storageManager (IndexedDB)
    this.tracks = JSON.parse(JSON.stringify(backup.data));
    if (this.storageManager) {
      await this.storageManager.saveTracks(this.tracks, { reason: 'Restored from backup' });
    } else {
      await chrome.storage.local.set({ talkTracks: this.tracks });
    }
    
    this.showStatus(`Restored backup from ${new Date(backup.timestamp).toLocaleString()} (${backup.trackCount} tracks)`, false);
    this.notifySidepanelOfUpdate();
    this.render();
    this.renderBackupInfo();
  }

  renderBackupInfo() {
    const backupContainer = document.getElementById('backupInfo');
    if (!backupContainer) return;

    const latestBackup = this.backupHistory[0];
    const backupCount = this.backupHistory.length;

    backupContainer.innerHTML = `
      <div class="backup-status">
        <span class="backup-icon">💾</span>
        <span class="backup-text">
          ${backupCount} backups saved
          ${latestBackup ? `<br><small>Last: ${new Date(latestBackup.timestamp).toLocaleString()}</small>` : ''}
        </span>
        <button type="button" class="backup-btn" id="showBackupsBtn">
          📂 Restore
        </button>
      </div>
    `;
  }

  showBackupModal() {
    // Create modal if it doesn't exist
    let modal = document.getElementById('backupModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'backupModal';
      modal.className = 'backup-modal';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div class="backup-modal-content">
        <div class="backup-modal-header">
          <h2>📂 Backup History</h2>
          <button type="button" class="close-modal-btn" id="closeBackupModal">✕</button>
        </div>
        <div class="backup-list">
          ${this.backupHistory.length === 0 ? 
            '<p class="no-backups">No backups yet. Backups are created automatically when you save.</p>' :
            this.backupHistory.map(backup => `
              <div class="backup-item" data-backup-id="${backup.id}">
                <div class="backup-item-info">
                  <strong>${new Date(backup.timestamp).toLocaleString()}</strong>
                  <span class="backup-reason">${backup.reason}</span>
                  <span class="backup-tracks">${backup.trackCount} tracks</span>
                </div>
                <div class="backup-item-actions">
                  <button type="button" class="restore-backup-btn" data-backup-id="${backup.id}">
                    ↩️ Restore
                  </button>
                  <button type="button" class="export-backup-btn" data-backup-id="${backup.id}">
                    📤 Export
                  </button>
                </div>
              </div>
            `).join('')
          }
        </div>
        <div class="backup-modal-footer">
          <button type="button" class="create-backup-btn" id="createManualBackup">
            💾 Create Backup Now
          </button>
          <button type="button" class="export-all-btn" id="exportCurrentTracks">
            📤 Export Current Tracks
          </button>
        </div>
      </div>
    `;

    modal.style.display = 'flex';

    // Add event listeners
    document.getElementById('closeBackupModal').addEventListener('click', () => {
      modal.style.display = 'none';
    });

    modal.querySelectorAll('.restore-backup-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const backupId = parseInt(e.target.dataset.backupId);
        if (confirm('Are you sure you want to restore this backup? Your current tracks will be backed up first.')) {
          await this.restoreBackup(backupId);
          modal.style.display = 'none';
        }
      });
    });

    modal.querySelectorAll('.export-backup-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const backupId = parseInt(e.target.dataset.backupId);
        this.exportBackup(backupId);
      });
    });

    document.getElementById('createManualBackup').addEventListener('click', async () => {
      await this.createBackup('Manual backup');
      this.showBackupModal(); // Refresh the modal
      this.renderBackupInfo();
    });

    document.getElementById('exportCurrentTracks').addEventListener('click', () => {
      this.exportTracks();
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  }

  exportBackup(backupId) {
    const backup = this.backupHistory.find(b => b.id === backupId);
    if (!backup) return;

    const dataStr = JSON.stringify(backup.data, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    const date = new Date(backup.timestamp).toISOString().split('T')[0];
    link.download = `talk-tracks-backup-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  renderCategoryFilter() {
    const filterSelect = document.getElementById('categoryFilter');
    if (filterSelect) {
      const allCategories = ['All', ...this.defaultCategories, ...this.customCategories];
      
      // Determine which value should be selected
      // this.filterCategory stores 'all' (lowercase) for "All", but dropdown value is 'All' (capital)
      const selectedValue = this.filterCategory === 'all' ? 'All' : this.filterCategory;
      
      filterSelect.innerHTML = allCategories.map(cat => 
        `<option value="${cat}" ${cat === selectedValue ? 'selected' : ''}>${cat}</option>`
      ).join('');
      
      // Also set the value programmatically to ensure sync
      filterSelect.value = selectedValue;
    }

    // Update tag filter
    this.updateTagFilter();

    // Also update bulk category dropdown
    const bulkSelect = document.getElementById('bulkCategorySelect');
    if (bulkSelect) {
      const categoriesForBulk = [...this.defaultCategories, ...this.customCategories];
      
      bulkSelect.innerHTML = '<option value="">Change Category...</option>' +
        categoriesForBulk.map(cat => 
          `<option value="${cat}">${cat}</option>`
        ).join('');
    }
  }

  updateTagFilter() {
    // Collect all unique tags from tracks
    const tagSet = new Set();
    this.tracks.forEach(track => {
      if (track.tags && Array.isArray(track.tags)) {
        track.tags.forEach(tag => tagSet.add(tag.trim().toLowerCase()));
      }
    });
    this.allTags = Array.from(tagSet).sort();

    // Populate tag filter dropdown
    const tagFilter = document.getElementById('tagFilter');
    if (tagFilter) {
      const currentValue = tagFilter.value;
      tagFilter.innerHTML = '<option value="all">All Tags</option>' +
        this.allTags.map(tag => 
          `<option value="${tag}" ${currentValue === tag ? 'selected' : ''}>${tag}</option>`
        ).join('');
    }
  }

  async loadCustomCategories() {
    const result = await chrome.storage.local.get(['customCategories']);
    this.customCategories = result.customCategories || [];
  }

  async saveCustomCategories() {
    await chrome.storage.local.set({ customCategories: this.customCategories });
  }

  // Customer Methods
  async loadCustomers() {
    const result = await chrome.storage.local.get(['customers', 'selectedCustomerId']);
    this.customers = result.customers || [];
    this.selectedCustomerId = result.selectedCustomerId || null;
  }

  async saveCustomers() {
    await chrome.storage.local.set({ customers: this.customers });
  }

  async saveSelectedCustomer() {
    await chrome.storage.local.set({ selectedCustomerId: this.selectedCustomerId });
  }

  getCustomerById(id) {
    return this.customers.find(c => c.id === id);
  }

  addCustomer() {
    const name = prompt('Enter customer/company name:');
    if (!name) return;

    const industry = prompt('Enter industry (e.g., E-commerce, Finance, Healthcare):') || '';

    const newCustomer = {
      id: `customer-${Date.now()}`,
      name: name.trim(),
      industry: industry.trim(),
      color: this.generateCustomerColor(),
      discoveryNotes: '',
      createdAt: new Date().toISOString(),
      lastUsed: null
    };

    this.customers.push(newCustomer);
    this.saveCustomers();
    this.renderCustomers();
    this.renderCustomerFilter();
    this.render(); // Re-render tracks to update customer dropdowns
    
    // Open edit modal for discovery notes
    this.editCustomerNotes(newCustomer.id);
  }

  editCustomer(id) {
    const customer = this.getCustomerById(id);
    if (!customer) return;

    const name = prompt('Enter customer name:', customer.name);
    if (!name) return;

    const industry = prompt('Enter industry:', customer.industry);

    customer.name = name.trim();
    customer.industry = industry ? industry.trim() : '';
    this.saveCustomers();
    this.renderCustomers();
    this.renderCustomerFilter();
    this.render();
  }

  editCustomerNotes(id) {
    const customer = this.getCustomerById(id);
    if (!customer) return;

    // Create a modal for editing discovery notes
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'customerNotesModal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 600px;">
        <div class="modal-header">
          <h2>📝 Discovery Notes: ${this.escapeHtml(customer.name)}</h2>
          <button class="modal-close" id="closeNotesModal">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 12px; color: #666;">
            Add notes from discovery calls about what this customer wants to see. 
            These notes will be used to tailor AI-generated talk tracks.
          </p>
          <textarea 
            id="customerNotesTextarea" 
            style="width: 100%; min-height: 200px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; font-family: inherit; font-size: 14px; line-height: 1.6;"
            placeholder="e.g., Interested in APM latency tracking, migrating from New Relic, have 50+ microservices, concerned about cost optimization..."
          >${this.escapeHtml(customer.discoveryNotes || '')}</textarea>
        </div>
        <div class="modal-footer">
          <button class="secondary-btn" id="cancelNotesBtn">Cancel</button>
          <button class="save-btn" id="saveNotesBtn">Save Notes</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    document.getElementById('closeNotesModal').onclick = () => modal.remove();
    document.getElementById('cancelNotesBtn').onclick = () => modal.remove();
    document.getElementById('saveNotesBtn').onclick = () => {
      const notes = document.getElementById('customerNotesTextarea').value;
      customer.discoveryNotes = notes;
      this.saveCustomers();
      this.renderCustomers();
      modal.remove();
      this.showStatus('Discovery notes saved!', false);
    };

    // Close on outside click
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  deleteCustomer(id) {
    const customer = this.getCustomerById(id);
    if (!customer) return;

    const trackCount = this.tracks.filter(t => t.customerId === id).length;
    const message = trackCount > 0 
      ? `Delete "${customer.name}"?\n\n${trackCount} talk track(s) are associated with this customer and will become generic.`
      : `Delete "${customer.name}"?`;

    if (!confirm(message)) return;

    // Remove customer association from tracks
    this.tracks.forEach(track => {
      if (track.customerId === id) {
        track.customerId = null;
      }
    });

    // Remove customer
    this.customers = this.customers.filter(c => c.id !== id);
    
    // Clear selection if deleted customer was selected
    if (this.selectedCustomerId === id) {
      this.selectedCustomerId = null;
      this.saveSelectedCustomer();
    }

    this.saveCustomers();
    this.saveTracks();
    this.renderCustomers();
    this.renderCustomerFilter();
    this.render();
  }

  generateCustomerColor() {
    // Generate a visually distinct color
    const colors = [
      '#FF6B35', '#F7C59F', '#2EC4B6', '#E71D36', '#011627',
      '#9B5DE5', '#F15BB5', '#00BBF9', '#00F5D4', '#FEE440',
      '#8338EC', '#3A86FF', '#FF006E', '#FB5607', '#FFBE0B'
    ];
    // Pick a color not already used
    const usedColors = this.customers.map(c => c.color);
    const available = colors.filter(c => !usedColors.includes(c));
    return available.length > 0 ? available[0] : colors[Math.floor(Math.random() * colors.length)];
  }

  setCustomerFilter(customerId) {
    this.selectedCustomerId = customerId === 'all' ? null : customerId;
    this.saveSelectedCustomer();
    this.renderCustomerFilter();
    this.render();
  }

  renderCustomerFilter() {
    const filterContainer = document.getElementById('customerFilter');
    if (!filterContainer) return;

    const options = [
      '<option value="all">All Customers (Generic + Specific)</option>',
      '<option value="generic">Generic Only</option>',
      ...this.customers.map(c => 
        `<option value="${c.id}" ${this.selectedCustomerId === c.id ? 'selected' : ''}>
          ${this.escapeHtml(c.name)}
        </option>`
      )
    ];

    filterContainer.innerHTML = options.join('');
    
    // Set the current value
    if (this.selectedCustomerId) {
      filterContainer.value = this.selectedCustomerId;
    } else {
      filterContainer.value = 'all';
    }
  }

  renderCustomers() {
    const list = document.getElementById('customersList');
    if (!list) return;

    if (this.customers.length === 0) {
      list.innerHTML = '<p class="empty-state">No customers yet. Add a customer to create tailored talk tracks.</p>';
      return;
    }

    list.innerHTML = this.customers.map(customer => {
      const trackCount = this.tracks.filter(t => t.customerId === customer.id).length;
      const hasNotes = customer.discoveryNotes && customer.discoveryNotes.trim().length > 0;
      
      return `
        <div class="customer-item" data-customer-id="${customer.id}">
          <div class="customer-color" style="background-color: ${customer.color}"></div>
          <div class="customer-info">
            <div class="customer-name">${this.escapeHtml(customer.name)}</div>
            <div class="customer-meta">
              ${customer.industry ? `<span class="customer-industry">${this.escapeHtml(customer.industry)}</span>` : ''}
              <span class="customer-track-count">${trackCount} track${trackCount !== 1 ? 's' : ''}</span>
              ${hasNotes ? '<span class="has-notes" title="Has discovery notes">📝</span>' : ''}
            </div>
          </div>
          <div class="customer-actions">
            <button class="customer-notes-btn" data-id="${customer.id}" title="Edit discovery notes">📝</button>
            <button class="customer-edit-btn" data-id="${customer.id}" title="Edit customer">✏️</button>
            <button class="customer-delete-btn" data-id="${customer.id}" title="Delete customer">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Track Pack Methods
  async loadSubscribedPacks() {
    this.subscribedPacks = await this.packManager.getSubscribedPacks();
  }

  renderTrackPacks() {
    this.renderSubscribedPacks();
    this.renderAvailablePacks();
  }

  renderSubscribedPacks() {
    const container = document.getElementById('subscribedPacksList');
    if (!container) return;

    if (this.subscribedPacks.length === 0) {
      container.innerHTML = '<p class="no-packs-message">No packs subscribed yet. Browse official packs below or import a pack.</p>';
      return;
    }

    container.innerHTML = this.subscribedPacks.map(pack => `
      <div class="pack-card" data-pack-id="${pack.id}">
        <div class="pack-card-header">
          <span class="pack-name">${this.escapeHtml(pack.name)}</span>
          <span class="pack-version">v${pack.version}</span>
        </div>
        <div class="pack-meta">
          <span class="pack-track-count">${pack.trackCount || '?'} tracks</span>
          <span>Last synced: ${pack.lastSynced ? new Date(pack.lastSynced).toLocaleDateString() : 'Never'}</span>
        </div>
        <div class="pack-card-actions">
          <button class="preview-btn" data-pack-url="${pack.url}">Preview</button>
          <button class="unsubscribe-btn" data-pack-id="${pack.id}">Unsubscribe</button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    container.querySelectorAll('.unsubscribe-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleUnsubscribe(e.target.dataset.packId));
    });

    container.querySelectorAll('.preview-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.handlePreviewPack(e.target.dataset.packUrl));
    });
  }

  renderAvailablePacks() {
    const container = document.getElementById('availablePacksList');
    if (!container) return;

    const officialPacks = this.packManager.getOfficialPacks();
    
    container.innerHTML = officialPacks.map(pack => {
      const isSubscribed = this.subscribedPacks.some(sp => sp.url === pack.url);
      
      return `
        <div class="pack-card">
          <div class="pack-card-header">
            <span class="pack-name">${this.escapeHtml(pack.name)}</span>
          </div>
          <div class="pack-description">${this.escapeHtml(pack.description)}</div>
          <div class="pack-card-actions">
            <button class="preview-btn" data-pack-url="${pack.url}">Preview</button>
            ${isSubscribed 
              ? '<button class="subscribe-btn" disabled>✓ Subscribed</button>'
              : `<button class="subscribe-btn" data-pack-url="${pack.url}">Subscribe</button>`
            }
          </div>
        </div>
      `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('.subscribe-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleSubscribe(e.target.dataset.packUrl));
    });

    container.querySelectorAll('.preview-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.handlePreviewPack(e.target.dataset.packUrl));
    });
  }

  async handleSubscribe(url) {
    const btn = document.querySelector(`.subscribe-btn[data-pack-url="${url}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }

    try {
      const result = await this.packManager.subscribeToPack(url);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      // Import the tracks
      const importResult = await this.packManager.importPack(result.pack, {
        mergeMode: 'skip-duplicates'
      });

      await this.loadSubscribedPacks();
      await this.loadTracks();
      this.renderTrackPacks();
      this.render();

      this.showStatus(
        `Subscribed to "${result.pack.name}"! Added ${importResult.added} tracks, skipped ${importResult.skipped} duplicates.`,
        false
      );
    } catch (error) {
      console.error('Subscribe error:', error);
      this.showStatus(`Failed to subscribe: ${error.message}`, true);
      
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Subscribe';
      }
    }
  }

  async handleUnsubscribe(packId) {
    if (!confirm('Are you sure you want to unsubscribe from this pack? Your tracks will be kept.')) {
      return;
    }

    try {
      const result = await this.packManager.unsubscribeFromPack(packId, false);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      await this.loadSubscribedPacks();
      this.renderTrackPacks();

      this.showStatus('Unsubscribed from pack. Tracks were kept.', false);
    } catch (error) {
      console.error('Unsubscribe error:', error);
      this.showStatus(`Failed to unsubscribe: ${error.message}`, true);
    }
  }

  async handlePreviewPack(url) {
    try {
      const result = await this.packManager.fetchPack(url);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      const pack = result.pack;
      
      // Show preview modal
      this.showPackPreviewModal(pack);
    } catch (error) {
      console.error('Preview error:', error);
      this.showStatus(`Failed to load pack: ${error.message}`, true);
    }
  }

  showPackPreviewModal(pack) {
    // Remove existing modal if any
    const existing = document.getElementById('packPreviewModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'packPreviewModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content pack-preview-modal">
        <div class="modal-header">
          <h2>${this.escapeHtml(pack.name)}</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="pack-preview-info">
            <p><strong>Version:</strong> ${pack.version}</p>
            <p><strong>Author:</strong> ${this.escapeHtml(pack.author || 'Unknown')}</p>
            <p><strong>Description:</strong> ${this.escapeHtml(pack.description || 'No description')}</p>
            <p><strong>Tracks:</strong> ${pack.tracks.length}</p>
          </div>
          <h3>Included Tracks:</h3>
          <div class="pack-tracks-list">
            ${pack.tracks.map(track => `
              <div class="pack-track-item">
                <span class="pack-track-title">${this.escapeHtml(track.title || 'Untitled')}</span>
                <span class="pack-track-category">${track.category || 'Other'}</span>
                <span class="pack-track-pattern">${this.escapeHtml(track.urlPattern)}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Close handlers
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }

  async handleCheckUpdates() {
    const btn = document.getElementById('checkUpdatesBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '🔄 Checking...';
    }

    try {
      const updates = await this.packManager.checkForUpdates();
      
      const packsWithUpdates = updates.filter(u => u.hasUpdate);
      
      if (packsWithUpdates.length === 0) {
        this.showStatus('All packs are up to date!', false);
      } else {
        // Show update modal
        this.showUpdateModal(packsWithUpdates);
      }

      // Update last sync time
      const lastSyncEl = document.getElementById('lastSyncTime');
      if (lastSyncEl) {
        lastSyncEl.textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
      }
    } catch (error) {
      console.error('Check updates error:', error);
      this.showStatus(`Failed to check updates: ${error.message}`, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Check for Updates';
      }
    }
  }

  showUpdateModal(packsWithUpdates) {
    const existing = document.getElementById('updateModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'updateModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content update-modal">
        <div class="modal-header">
          <h2>Updates Available</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${packsWithUpdates.map(pack => `
            <div class="update-pack-item" data-pack-id="${pack.id}">
              <div class="update-pack-header">
                <span class="pack-name">${this.escapeHtml(pack.name)}</span>
                <span class="version-change">${pack.currentVersion} → ${pack.newVersion}</span>
              </div>
              <div class="update-diff">
                <span class="diff-new">+${pack.diff.new.length} new</span>
                <span class="diff-modified">${pack.diff.modified.length} updated</span>
                ${pack.diff.locallyModified.length > 0 
                  ? `<span class="diff-conflict">${pack.diff.locallyModified.length} conflicts</span>` 
                  : ''}
              </div>
              ${pack.diff.locallyModified.length > 0 ? `
                <div class="conflict-resolution" style="margin-top: 12px;">
                  <h4 style="margin: 0 0 8px 0; font-size: 13px;">Conflict Resolution:</h4>
                  <label class="import-option">
                    <input type="radio" name="conflict-${pack.id}" value="keep-local" checked>
                    Keep my local changes
                  </label>
                  <label class="import-option">
                    <input type="radio" name="conflict-${pack.id}" value="use-remote">
                    Use updated version (discard my changes)
                  </label>
                  <label class="import-option">
                    <input type="radio" name="conflict-${pack.id}" value="keep-both">
                    Keep both versions
                  </label>
                </div>
              ` : ''}
              <div class="update-actions">
                <button class="update-btn apply-update-btn" data-pack-id="${pack.id}">Apply Update</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Store updates for apply action
    this._pendingUpdates = packsWithUpdates;

    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelectorAll('.apply-update-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const packId = e.target.dataset.packId;
        const conflictRadio = modal.querySelector(`input[name="conflict-${packId}"]:checked`);
        const conflictResolution = conflictRadio ? conflictRadio.value : 'keep-local';
        await this.handleApplyUpdate(packId, conflictResolution);
        modal.remove();
      });
    });
  }

  async handleApplyUpdate(packId, conflictResolution = 'keep-local') {
    const updateInfo = this._pendingUpdates?.find(u => u.id === packId);
    if (!updateInfo) return;

    try {
      const result = await this.packManager.applyUpdate(updateInfo, {
        applyNew: true,
        applyModified: true,
        conflictResolution: conflictResolution
      });

      await this.loadSubscribedPacks();
      await this.loadTracks();
      this.renderTrackPacks();
      this.render();

      this.showStatus(
        `Updated "${updateInfo.name}"! Added ${result.added}, updated ${result.updated}, ${result.conflicts} conflicts kept local.`,
        false
      );
    } catch (error) {
      console.error('Apply update error:', error);
      this.showStatus(`Failed to apply update: ${error.message}`, true);
    }
  }

  async handleAddCustomPack() {
    const input = document.getElementById('customPackUrl');
    const url = input?.value?.trim();

    if (!url) {
      this.showStatus('Please enter a pack URL', true);
      return;
    }

    try {
      new URL(url); // Validate URL format
    } catch {
      this.showStatus('Please enter a valid URL', true);
      return;
    }

    await this.handleSubscribe(url);
    if (input) input.value = '';
  }

  updateCategories() {
    this.categories = ['All', ...this.defaultCategories, ...this.customCategories];
  }

  addCustomCategory() {
    const name = prompt('Enter new category name:');
    if (!name) return;

    const trimmedName = name.trim();
    
    // Check if category already exists
    if (this.defaultCategories.includes(trimmedName) || this.customCategories.includes(trimmedName)) {
      alert('A category with this name already exists!');
      return;
    }

    if (trimmedName.length === 0) {
      alert('Category name cannot be empty!');
      return;
    }

    this.customCategories.push(trimmedName);
    this.customCategories.sort(); // Keep alphabetically sorted
    this.updateCategories();
    this.saveCustomCategories();
    this.renderCategoryFilter();
    this.renderCategories();
    this.render(); // Re-render to update dropdowns
  }

  editCustomCategory(oldName) {
    const newName = prompt('Edit category name:', oldName);
    if (!newName || newName === oldName) return;

    const trimmedName = newName.trim();
    
    // Check if new name already exists
    if (this.defaultCategories.includes(trimmedName) || 
        (this.customCategories.includes(trimmedName) && trimmedName !== oldName)) {
      alert('A category with this name already exists!');
      return;
    }

    // Update the category name
    const index = this.customCategories.indexOf(oldName);
    if (index !== -1) {
      this.customCategories[index] = trimmedName;
      this.customCategories.sort(); // Keep alphabetically sorted
    }

    // Update all tracks using this category
    this.tracks.forEach(track => {
      if (track.category === oldName) {
        track.category = trimmedName;
      }
    });

    // If we were filtering by the old category name, update to the new name
    if (this.filterCategory === oldName) {
      this.filterCategory = trimmedName;
    }

    this.updateCategories();
    this.saveCustomCategories();
    this.renderCategoryFilter();
    this.renderCategories();
    this.render();
  }

  deleteCustomCategory(name) {
    if (!confirm(`Delete category "${name}"?\n\nTracks using this category will be moved to "Other".`)) {
      return;
    }

    // Move tracks to "Other"
    this.tracks.forEach(track => {
      if (track.category === name) {
        track.category = 'Other';
      }
    });

    // Remove from custom categories
    this.customCategories = this.customCategories.filter(cat => cat !== name);
    
    // If we were filtering by this category, reset to show all
    if (this.filterCategory === name) {
      this.filterCategory = 'all';
    }
    
    this.updateCategories();
    this.saveCustomCategories();
    this.renderCategoryFilter();
    this.renderCategories();
    this.render();
  }

  renderCategories() {
    const list = document.getElementById('categoriesList');
    if (!list) return;

    const customCats = this.customCategories;

    if (customCats.length === 0) {
      list.innerHTML = '<p style="color: #999; font-style: italic; font-size: 13px;">No custom categories yet. Click the button below to add one.</p>';
      return;
    }

    list.innerHTML = customCats.map(category => `
      <div class="category-item">
        <div class="category-name">
          <span class="category-badge" style="background: ${this.getCategoryColor(category)}">${this.escapeHtml(category)}</span>
          <span class="category-count">${this.tracks.filter(t => t.category === category).length} tracks</span>
        </div>
        <div class="category-actions">
          <button class="category-edit-btn" data-name="${this.escapeHtml(category)}">Edit</button>
          <button class="category-delete-btn" data-name="${this.escapeHtml(category)}">Delete</button>
        </div>
      </div>
    `).join('');
  }

  async loadTracks() {
    try {
      // Use IndexedDB via StorageManagerV2 if available
      if (this.storageManager) {
        this.tracks = await this.storageManager.loadTracks();
      } else if (typeof storageManager !== 'undefined') {
        // Try to use the singleton directly
        await storageManager.init();
        this.tracks = await storageManager.loadTracks();
        this.storageManager = storageManager;
      } else {
        // Fallback to chrome.storage.local
        const result = await chrome.storage.local.get(['talkTracks']);
        this.tracks = result.talkTracks || [];
      }
    } catch (error) {
      console.error('Error loading tracks:', error);
      // Fallback to chrome.storage.local
      const result = await chrome.storage.local.get(['talkTracks']);
      this.tracks = result.talkTracks || [];
    }
    
    // Normalize tracks structure while preserving all existing fields
    this.tracks = this.tracks.map((track, index) => ({
      id: track.id || Date.now() + index,
      title: track.title || '',
      category: track.category || 'Other',
      customerId: track.customerId || null,
      tags: track.tags || [],
      urlPattern: track.urlPattern || '',
      content: track.content || '',
      htmlBackup: track.htmlBackup || null,
      order: track.order !== undefined ? track.order : index
    }));
    
    // Sort by order
    this.tracks.sort((a, b) => a.order - b.order);
    
    // Initialize with one empty track if none exist
    if (this.tracks.length === 0) {
      this.tracks = [{
        id: Date.now(),
        title: '',
        category: 'Other',
        urlPattern: '',
        content: '',
        order: 0
      }];
    }
    
    console.log(`[OptionsManager] Loaded ${this.tracks.length} tracks`);
  }

  setupEventListeners() {
    // Main action buttons
    const addTrackBtn = document.getElementById('addTrack');
    if (addTrackBtn) {
      addTrackBtn.addEventListener('click', () => this.addTrack());
    }

    const saveButton = document.getElementById('saveButton');
    if (saveButton) {
      saveButton.addEventListener('click', () => this.saveTracks());
    }

    // Backup button listener (delegated since it's rendered dynamically)
    document.addEventListener('click', (e) => {
      if (e.target.id === 'showBackupsBtn' || e.target.closest('#showBackupsBtn')) {
        this.showBackupModal();
      }
    });

    // Cloud Sync buttons
    const connectGithubBtn = document.getElementById('connectGithubBtn');
    if (connectGithubBtn) {
      connectGithubBtn.addEventListener('click', () => this.connectGitHub());
    }

    const disconnectGithubBtn = document.getElementById('disconnectGithubBtn');
    if (disconnectGithubBtn) {
      disconnectGithubBtn.addEventListener('click', () => this.disconnectGitHub());
    }

    const syncNowBtn = document.getElementById('syncNowBtn');
    if (syncNowBtn) {
      syncNowBtn.addEventListener('click', () => this.syncNow());
    }

    const pullFromCloudBtn = document.getElementById('pullFromCloudBtn');
    if (pullFromCloudBtn) {
      pullFromCloudBtn.addEventListener('click', () => this.pullFromCloud());
    }

    const viewVersionsBtn = document.getElementById('viewVersionsBtn');
    if (viewVersionsBtn) {
      viewVersionsBtn.addEventListener('click', () => this.showVersionHistory());
    }

    // Search
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchTerm = e.target.value;
        this.render();
      });
    }

    // Category filter
    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
      categoryFilter.addEventListener('change', (e) => {
        this.filterCategory = e.target.value === 'All' ? 'all' : e.target.value;
        this.render();
      });
    }

    // Tag filter
    const tagFilter = document.getElementById('tagFilter');
    if (tagFilter) {
      tagFilter.addEventListener('change', (e) => {
        this.filterTag = e.target.value;
        this.render();
      });
    }

    // Expand/collapse all
    const expandAllBtn = document.getElementById('expandAll');
    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', () => this.expandAll());
    }

    const collapseAllBtn = document.getElementById('collapseAll');
    if (collapseAllBtn) {
      collapseAllBtn.addEventListener('click', () => this.collapseAll());
    }

    // Track Pack buttons
    const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', () => this.handleCheckUpdates());
    }

    const addCustomPackBtn = document.getElementById('addCustomPackBtn');
    if (addCustomPackBtn) {
      addCustomPackBtn.addEventListener('click', () => this.handleAddCustomPack());
    }

    const customPackUrl = document.getElementById('customPackUrl');
    if (customPackUrl) {
      customPackUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.handleAddCustomPack();
      });
    }

    // Import/Export
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportTracks());
    }

    const importBtn = document.getElementById('importBtn');
    if (importBtn) {
      importBtn.addEventListener('click', () => this.importTracks());
    }

    // URL Pattern Tester
    const testBtn = document.getElementById('testBtn');
    if (testBtn) {
      testBtn.addEventListener('click', () => this.testUrlPattern());
    }

    const testUrl = document.getElementById('testUrl');
    if (testUrl) {
      testUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.testUrlPattern();
      });
    }

    // Base URL Settings
    const saveBaseUrlBtn = document.getElementById('saveBaseUrlBtn');
    if (saveBaseUrlBtn) {
      saveBaseUrlBtn.addEventListener('click', () => this.saveBaseUrl());
    }

    // Base URL Preset buttons
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.dataset.url;
        const input = document.getElementById('baseUrl');
        if (input && url) {
          input.value = url;
          this.saveBaseUrl();
        }
      });
    });

    // AI Settings
    const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
    if (saveApiKeyBtn) {
      saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
    }

    const testApiKeyBtn = document.getElementById('testApiKeyBtn');
    if (testApiKeyBtn) {
      testApiKeyBtn.addEventListener('click', () => this.testApiKey());
    }

    const saveCopilotUrlBtn = document.getElementById('saveCopilotUrlBtn');
    if (saveCopilotUrlBtn) {
      saveCopilotUrlBtn.addEventListener('click', () => this.saveCopilotUrl());
    }
    const testCopilotUrlBtn = document.getElementById('testCopilotUrlBtn');
    if (testCopilotUrlBtn) {
      testCopilotUrlBtn.addEventListener('click', () => this.testCopilotUrl());
    }

    const addPersonaBtn = document.getElementById('addPersonaBtn');
    if (addPersonaBtn) {
      addPersonaBtn.addEventListener('click', () => this.addPersona());
    }

    // Persona management (event delegation)
    const personasList = document.getElementById('personasList');
    if (personasList) {
      personasList.addEventListener('click', (e) => {
        if (e.target.classList.contains('persona-edit-btn')) {
          const id = e.target.dataset.id;
          this.editPersona(id);
        } else if (e.target.classList.contains('persona-delete-btn')) {
          const id = e.target.dataset.id;
          this.deletePersona(id);
        }
      });
    }

    // Category management
    const addCategoryBtn = document.getElementById('addCategoryBtn');
    if (addCategoryBtn) {
      addCategoryBtn.addEventListener('click', () => this.addCustomCategory());
    }

    const categoriesList = document.getElementById('categoriesList');
    if (categoriesList) {
      categoriesList.addEventListener('click', (e) => {
        if (e.target.classList.contains('category-edit-btn')) {
          const name = e.target.dataset.name;
          this.editCustomCategory(name);
        } else if (e.target.classList.contains('category-delete-btn')) {
          const name = e.target.dataset.name;
          this.deleteCustomCategory(name);
        }
      });
    }

    // Customer management
    const addCustomerBtn = document.getElementById('addCustomerBtn');
    if (addCustomerBtn) {
      addCustomerBtn.addEventListener('click', () => this.addCustomer());
    }

    const customersList = document.getElementById('customersList');
    if (customersList) {
      customersList.addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        if (e.target.classList.contains('customer-edit-btn')) {
          this.editCustomer(id);
        } else if (e.target.classList.contains('customer-delete-btn')) {
          this.deleteCustomer(id);
        } else if (e.target.classList.contains('customer-notes-btn')) {
          this.editCustomerNotes(id);
        }
      });
    }

    const customerFilter = document.getElementById('customerFilter');
    if (customerFilter) {
      customerFilter.addEventListener('change', (e) => {
        this.setCustomerFilter(e.target.value);
      });
    }

    // Bulk actions
    const selectAllBtn = document.getElementById('selectAllBtn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => this.selectAll());
    }

    const deselectAllBtn = document.getElementById('deselectAllBtn');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', () => this.deselectAll());
    }

    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener('click', () => this.deleteBulk());
    }

    const bulkCategorySelect = document.getElementById('bulkCategorySelect');
    if (bulkCategorySelect) {
      bulkCategorySelect.addEventListener('change', (e) => {
        if (e.target.value) {
          this.bulkChangeCategory(e.target.value);
          e.target.value = '';
        }
      });
    }

    // Event delegation for dynamically created elements
    const tracksList = document.getElementById('tracksList');
    
    // Track expansion/collapse
    tracksList.addEventListener('click', (e) => {
      if (e.target.classList.contains('expand-toggle')) {
        const trackId = parseInt(e.target.dataset.trackId);
        this.toggleTrackExpansion(trackId);
        return;
      }

      if (e.target.classList.contains('track-summary')) {
        const trackId = parseInt(e.target.dataset.trackId);
        this.toggleTrackExpansion(trackId);
        return;
      }

      // Preview toggle
      if (e.target.classList.contains('preview-toggle-btn')) {
        const trackId = parseInt(e.target.dataset.trackId);
        this.togglePreview(trackId);
        return;
      }

      // Debug HTML button
      if (e.target.classList.contains('debug-html-btn')) {
        const trackId = parseInt(e.target.dataset.trackId);
        this.debugTrackHtml(trackId);
        return;
      }

      // Checkbox selection
      if (e.target.classList.contains('track-checkbox')) {
        const trackItem = e.target.closest('.track-item');
        const trackId = parseInt(trackItem.dataset.id);
        this.toggleSelection(trackId);
        return;
      }
      
      // Delete button
      if (e.target.classList.contains('delete-button')) {
        const trackItem = e.target.closest('.track-item');
        const trackId = parseInt(trackItem.dataset.id);
        this.deleteTrack(trackId);
        return;
      }
      
      // Formatting buttons
      if (e.target.classList.contains('format-btn')) {
        const toolbar = e.target.closest('.editor-toolbar');
        const editorId = toolbar.dataset.editor;
        const editor = document.getElementById(editorId);
        const format = e.target.dataset.format;
        this.applyFormatting(editor, format);
        return;
      }
    });

    // Handle input changes
    tracksList.addEventListener('change', (e) => {
      const trackItem = e.target.closest('.track-item');
      if (!trackItem) return;
      
      const trackId = parseInt(trackItem.dataset.id);
      const track = this.tracks.find(t => t.id === trackId);
      if (!track) return;

      if (e.target.id.startsWith('title-')) {
        track.title = e.target.value;
      } else if (e.target.id.startsWith('category-')) {
        track.category = e.target.value;
      } else if (e.target.id.startsWith('customer-')) {
        track.customerId = e.target.value || null; // null for generic
      } else if (e.target.id.startsWith('url-')) {
        track.urlPattern = e.target.value;
      } else if (e.target.id.startsWith('content-')) {
        track.content = e.target.value;
        this.updatePreview(trackId);
      }
    });

    // Handle real-time preview updates on input
    tracksList.addEventListener('input', (e) => {
      if (e.target.id.startsWith('content-')) {
        const trackItem = e.target.closest('.track-item');
        if (!trackItem) return;
        
        const trackId = parseInt(trackItem.dataset.id);
        this.updatePreview(trackId);
      }
    });

    // Handle paste events for Google Docs compatibility
    tracksList.addEventListener('paste', (e) => {
      // Only handle paste in contenteditable editors
      if (e.target.classList.contains('content-wysiwyg')) {
        e.preventDefault();
        
        const clipboardData = e.clipboardData || window.clipboardData;
        const htmlData = clipboardData.getData('text/html');
        const textData = clipboardData.getData('text/plain');
        
        if (htmlData) {
          // Clean and insert HTML
          const cleanHtml = ContentConverter.cleanPastedHtml(htmlData);
          document.execCommand('insertHTML', false, cleanHtml);
        } else if (textData) {
          // Insert plain text
          document.execCommand('insertText', false, textData);
        }
      }
    });

    // Keyboard shortcuts
    tracksList.addEventListener('keydown', (e) => {
      const isTextEditor = e.target.tagName === 'TEXTAREA' || 
                          e.target.classList.contains('content-wysiwyg');
      
      if (isTextEditor && (e.ctrlKey || e.metaKey)) {
        let format = null;
        if (e.key === 'b') format = 'bold';
        else if (e.key === 'i') format = 'italic';
        else if (e.key === 'u') format = 'underline';
        
        if (format) {
          e.preventDefault();
          this.applyFormatting(e.target, format);
        }
      }
    });

    // Drag and drop
    tracksList.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('track-item')) {
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', e.target.dataset.id);
      }
    });

    tracksList.addEventListener('dragend', (e) => {
      if (e.target.classList.contains('track-item')) {
        e.target.classList.remove('dragging');
      }
    });

    tracksList.addEventListener('dragover', (e) => {
      e.preventDefault();
      const draggingItem = document.querySelector('.dragging');
      if (!draggingItem) return;

      const afterElement = this.getDragAfterElement(tracksList, e.clientY);
      if (afterElement == null) {
        tracksList.appendChild(draggingItem);
      } else {
        tracksList.insertBefore(draggingItem, afterElement);
      }
    });

    tracksList.addEventListener('drop', (e) => {
      e.preventDefault();
      this.updateTrackOrder();
    });
  }

  getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.track-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  updateTrackOrder() {
    const trackItems = document.querySelectorAll('.track-item');
    const newOrder = [];
    
    trackItems.forEach((item, index) => {
      const trackId = parseInt(item.dataset.id);
      const track = this.tracks.find(t => t.id === trackId);
      if (track) {
        track.order = index;
        newOrder.push(track);
      }
    });
    
    this.tracks = newOrder;
    this.render();
  }

  applyFormatting(editor, format) {
    if (!editor) return;
    
    // Check if it's contenteditable (WYSIWYG) or textarea (Markdown)
    const isContentEditable = editor.contentEditable === 'true';
    
    if (isContentEditable) {
      // WYSIWYG formatting using execCommand
      editor.focus();
      
      switch(format) {
        case 'bold':
          document.execCommand('bold', false, null);
          break;
        case 'italic':
          document.execCommand('italic', false, null);
          break;
        case 'underline':
          document.execCommand('underline', false, null);
          break;
        case 'list':
          document.execCommand('insertUnorderedList', false, null);
          break;
        case 'heading':
          document.execCommand('formatBlock', false, 'h2');
          break;
      }
      
      // Trigger input event to notify of changes
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Markdown formatting for textarea
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const selectedText = editor.value.substring(start, end);
      const beforeText = editor.value.substring(0, start);
      const afterText = editor.value.substring(end);
      
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
          
        case 'underline':
          formattedText = selectedText ? `<u>${selectedText}</u>` : '<u>underlined text</u>';
          cursorOffset = selectedText ? selectedText.length + 7 : 3;
          break;
          
        case 'list':
          if (selectedText) {
            const lines = selectedText.split('\n');
            formattedText = lines.map(line => line.trim() ? `- ${line.trim()}` : '').join('\n');
            cursorOffset = formattedText.length;
          } else {
            formattedText = '- List item\n- Another item';
            cursorOffset = 2;
          }
          break;
          
        case 'heading':
          formattedText = selectedText ? `## ${selectedText}` : '## Heading';
          cursorOffset = selectedText ? selectedText.length + 3 : 3;
          break;
      }
      
      editor.value = beforeText + formattedText + afterText;
      const newCursorPos = start + cursorOffset;
      editor.setSelectionRange(newCursorPos, newCursorPos);
      editor.focus();
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  addTrack() {
    const newTrack = {
      id: Date.now(),
      title: '',
      category: 'Other',
      urlPattern: '',
      content: '',
      order: this.tracks.length,
      tags: []
    };
    this.tracks.push(newTrack);
    this.expandedTracks.add(newTrack.id);
    this.render();
    
    // Scroll to the new track
    setTimeout(() => {
      const trackElement = document.querySelector(`[data-id="${newTrack.id}"]`);
      if (trackElement) {
        trackElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  }

  async deleteTrack(id) {
    if (!confirm('Are you sure you want to delete this talk track?')) {
      return;
    }
    
    this.tracks = this.tracks.filter(track => track.id !== id);
    this.selectedTracks.delete(id);
    this.expandedTracks.delete(id);
    
    // Persist to storage using storageManager (IndexedDB)
    if (this.storageManager) {
      await this.storageManager.saveTracks(this.tracks, { reason: 'Deleted track' });
    } else {
      await chrome.storage.local.set({ talkTracks: this.tracks });
    }
    this.showStatus('Talk track deleted', false);
    this.notifySidepanelOfUpdate();
    this.render();
  }

  async deleteBulk() {
    if (this.selectedTracks.size === 0) return;
    if (!confirm(`Delete ${this.selectedTracks.size} selected talk tracks?`)) return;
    
    this.tracks = this.tracks.filter(track => !this.selectedTracks.has(track.id));
    this.selectedTracks.clear();
    
    // Persist to storage using storageManager (IndexedDB)
    if (this.storageManager) {
      await this.storageManager.saveTracks(this.tracks, { reason: 'Bulk delete' });
    } else {
      await chrome.storage.local.set({ talkTracks: this.tracks });
    }
    this.showStatus('Talk tracks deleted', false);
    this.notifySidepanelOfUpdate();
    this.render();
  }

  toggleTrackExpansion(id) {
    if (this.expandedTracks.has(id)) {
      this.expandedTracks.delete(id);
    } else {
      this.expandedTracks.add(id);
    }
    this.render();
  }

  expandAll() {
    const filtered = this.getFilteredTracks();
    filtered.forEach(track => this.expandedTracks.add(track.id));
    this.render();
  }

  collapseAll() {
    this.expandedTracks.clear();
    this.render();
  }

  toggleSelection(id) {
    if (this.selectedTracks.has(id)) {
      this.selectedTracks.delete(id);
    } else {
      this.selectedTracks.add(id);
    }
    this.render();
  }

  selectAll() {
    const filtered = this.getFilteredTracks();
    filtered.forEach(track => this.selectedTracks.add(track.id));
    this.render();
  }

  deselectAll() {
    this.selectedTracks.clear();
    this.render();
  }

  bulkChangeCategory(category) {
    if (this.selectedTracks.size === 0) return;
    
    this.tracks.forEach(track => {
      if (this.selectedTracks.has(track.id)) {
        track.category = category;
      }
    });
    this.render();
  }

  getFilteredTracks() {
    return this.tracks.filter(track => {
      // Customer filter
      if (this.selectedCustomerId) {
        if (this.selectedCustomerId === 'generic') {
          // Show only generic tracks (tracks without a customer)
          if (track.customerId) return false;
        } else {
          // Show ONLY tracks for the specific customer (not generic tracks)
          if (track.customerId !== this.selectedCustomerId) {
            return false;
          }
        }
      }
      
      // Category filter
      if (this.filterCategory !== 'all' && track.category !== this.filterCategory) {
        return false;
      }
      
      // Tag filter
      if (this.filterTag !== 'all') {
        const trackTags = (track.tags || []).map(t => t.trim().toLowerCase());
        if (!trackTags.includes(this.filterTag.toLowerCase())) {
          return false;
        }
      }
      
      // Search filter (also search in tags and customer)
      if (this.searchTerm) {
        const term = this.searchTerm.toLowerCase();
        const tagsString = (track.tags || []).join(' ').toLowerCase();
        const customerName = track.customerId ? (this.getCustomerById(track.customerId)?.name || '') : '';
        return (
          (track.title || '').toLowerCase().includes(term) ||
          (track.urlPattern || '').toLowerCase().includes(term) ||
          (track.content || '').toLowerCase().includes(term) ||
          (track.category || '').toLowerCase().includes(term) ||
          tagsString.includes(term) ||
          customerName.toLowerCase().includes(term)
        );
      }
      
      return true;
    });
  }

  updateTrack(id, field, value) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track[field] = value;
    }
  }

  async saveTracks() {
    // Create backup before saving
    try {
      if (this.tracks.length > 0) {
        await this.createBackup('Auto-backup before save');
      }
    } catch (backupError) {
      console.error('Backup failed, but continuing with save:', backupError);
    }

    // Collect current values from form, preserving tracks without DOM elements
    const tracksData = [];
    const conversionWarnings = [];
    let tracksUpdatedFromDOM = 0;
    let tracksPreservedWithoutDOM = 0;
    
    for (const track of this.tracks) {
      const titleEl = document.getElementById(`title-${track.id}`);
      const categoryEl = document.getElementById(`category-${track.id}`);
      const urlEl = document.getElementById(`url-${track.id}`);
      const markdownEl = document.getElementById(`markdown-${track.id}`);
      const quill = this.quillEditors.get(track.id);
      
      if (titleEl && categoryEl && urlEl) {
        // Track has DOM elements - update from form values
        const urlPattern = urlEl.value.trim();
        
        // Get content from whichever editor is visible
        let content = '';
        if (markdownEl && markdownEl.style.display !== 'none') {
          // Markdown editor is visible - use directly
          content = markdownEl.value.trim();
        } else if (quill) {
          // Quill editor is active - convert HTML to markdown
          const htmlContent = quill.root.innerHTML;
          
          // Get the original markdown for comparison
          const originalMarkdown = track.content || '';
          
          // Convert HTML to markdown
          content = ContentConverter.htmlToMarkdown(htmlContent).trim();
          
          // Check for significant content loss
          if (originalMarkdown.length > 100 && content.length < originalMarkdown.length * 0.5) {
            conversionWarnings.push({
              title: titleEl.value || 'Untitled',
              original: originalMarkdown.length,
              converted: content.length
            });
          }
        } else {
          // Fall back to stored content
          content = track.content || '';
        }
        
        // Only save tracks that have at least a URL pattern
        if (urlPattern) {
          // Get tags
          const tagsEl = document.getElementById(`tags-${track.id}`);
          const tagsValue = tagsEl ? tagsEl.value : '';
          const tags = tagsValue.split(',').map(t => t.trim()).filter(t => t.length > 0);
          
          // Get customer
          const customerEl = document.getElementById(`customer-${track.id}`);
          const customerId = customerEl ? (customerEl.value || null) : (track.customerId || null);
          
          const trackData = {
            id: track.id,
            title: titleEl.value.trim(),
            category: categoryEl.value,
            customerId: customerId,
            tags: tags,
            urlPattern,
            content,
            order: track.order
          };
          
          // Also store raw HTML as backup (for recovery if conversion fails)
          if (quill && markdownEl && markdownEl.style.display === 'none') {
            trackData.htmlBackup = quill.root.innerHTML;
          }
          
          tracksData.push(trackData);
          tracksUpdatedFromDOM++;
        }
      } else {
        // Track doesn't have DOM elements (filtered out, collapsed, etc.)
        // PRESERVE the track as-is to prevent data loss!
        if (track.urlPattern) {
          tracksData.push({ ...track });
          tracksPreservedWithoutDOM++;
          console.log(`[SAVE] Preserved track without DOM: "${track.title}" (id: ${track.id})`);
        }
      }
    }
    
    console.log(`[SAVE] Updated ${tracksUpdatedFromDOM} tracks from DOM, preserved ${tracksPreservedWithoutDOM} tracks without DOM`);
    
    // Safety check: warn if we're about to save fewer tracks than we had
    if (tracksData.length < this.tracks.length) {
      console.warn(`[SAVE] WARNING: Saving ${tracksData.length} tracks but had ${this.tracks.length} - some tracks may be lost!`);
    }

    // Warn about potential data loss
    if (conversionWarnings.length > 0) {
      const warningMsg = conversionWarnings.map(w => 
        `"${w.title}": ${w.original} chars → ${w.converted} chars`
      ).join('\n');
      
      console.warn('Potential content loss detected:', conversionWarnings);
      
      if (!confirm(`Warning: Some tracks may have lost content during conversion:\n\n${warningMsg}\n\nDo you want to continue saving? A backup has been created.`)) {
        this.showStatus('Save cancelled. Use backup to restore if needed.', true);
        this.renderBackupInfo();
        return;
      }
    }

    try {
      // Use storageManager for IndexedDB storage (same as sidepanel)
      if (this.storageManager) {
        await this.storageManager.saveTracks(tracksData, { reason: 'Options page save' });
      } else {
        // Fallback to chrome.storage.local if storageManager not available
        await chrome.storage.local.set({ talkTracks: tracksData });
      }
      
      this.tracks = tracksData;
      this.showStatus(`Saved ${tracksData.length} tracks successfully! (Backup created)`, false);
      this.renderBackupInfo();
      this.updateTagFilter(); // Refresh tag filter with any new tags
      this.renderCloudSync();
      
      // Notify sidepanel to reload tracks from IndexedDB
      this.notifySidepanelOfUpdate();
    } catch (error) {
      this.showStatus('Error saving settings: ' + error.message, true);
    }
  }
  
  /**
   * Signal to other extension views (sidepanel) that tracks have been updated
   * Uses chrome.storage.local as a cross-context notification mechanism
   */
  notifySidepanelOfUpdate() {
    // Update a signal in chrome.storage.local that the sidepanel listens for
    // This triggers the sidepanel's chrome.storage.onChanged listener
    chrome.storage.local.set({ 
      tracksLastUpdated: Date.now(),
      tracksUpdateSource: 'options'
    }).catch(e => {
      console.warn('Failed to set update signal:', e);
    });
  }

  exportTracks() {
    // Check if there are selected tracks
    if (this.selectedTracks.size > 0) {
      this.showExportModal();
    } else {
      // Export all tracks
      this.performExport(null);
    }
  }

  showExportModal() {
    const existing = document.getElementById('exportModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'exportModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Export Tracks</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p>You have ${this.selectedTracks.size} track(s) selected.</p>
          <div class="export-options">
            <label class="export-option">
              <input type="radio" name="exportChoice" value="selected" checked>
              Export selected tracks only (${this.selectedTracks.size})
            </label>
            <label class="export-option">
              <input type="radio" name="exportChoice" value="all">
              Export all tracks (${this.tracks.length})
            </label>
          </div>
          <div class="export-metadata" style="margin-top: 16px;">
            <h4>Pack Metadata (optional)</h4>
            <input type="text" id="exportPackName" placeholder="Pack name (e.g., My Demo Pack)" style="width: 100%; margin-bottom: 8px;">
            <input type="text" id="exportAuthor" placeholder="Author name" style="width: 100%; margin-bottom: 8px;">
            <textarea id="exportDescription" placeholder="Description" rows="2" style="width: 100%;"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Cancel</button>
          <button class="save-btn" id="confirmExportBtn">Export</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelector('#confirmExportBtn').addEventListener('click', () => {
      const choice = modal.querySelector('input[name="exportChoice"]:checked').value;
      const metadata = {
        name: modal.querySelector('#exportPackName').value || undefined,
        author: modal.querySelector('#exportAuthor').value || undefined,
        description: modal.querySelector('#exportDescription').value || undefined
      };
      
      this.performExport(choice === 'selected' ? Array.from(this.selectedTracks) : null, metadata);
      modal.remove();
    });
  }

  async performExport(trackIds = null, metadata = {}) {
    try {
      const pack = await this.packManager.exportTracks(trackIds, metadata);
      const dataStr = JSON.stringify(pack, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      
      const filename = metadata.name 
        ? `${metadata.name.toLowerCase().replace(/\s+/g, '-')}.json`
        : `talk-tracks-${new Date().toISOString().split('T')[0]}.json`;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      
      this.showStatus(`Exported ${pack.tracks.length} tracks as pack "${pack.name}"!`, false);
    } catch (error) {
      this.showStatus('Error exporting: ' + error.message, true);
    }
  }

  importTracks() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        
        // Check if it's a pack format or legacy array format
        if (imported.tracks && Array.isArray(imported.tracks)) {
          // Pack format
          this.showImportModal(imported);
        } else if (Array.isArray(imported)) {
          // Legacy format - convert to pack
          const legacyPack = TrackPackSchema.exportToPack(imported, {
            name: file.name.replace('.json', ''),
            description: 'Imported from legacy format'
          });
          this.showImportModal(legacyPack);
        } else {
          throw new Error('Invalid format: expected a track pack or array of tracks');
        }
      } catch (error) {
        this.showStatus('Error reading file: ' + error.message, true);
      }
    };
    
    input.click();
  }

  showImportModal(pack) {
    const existing = document.getElementById('importModal');
    if (existing) existing.remove();

    // Check for duplicates
    const duplicates = pack.tracks.filter(track => 
      this.tracks.some(t => t.urlPattern === track.urlPattern)
    );

    const modal = document.createElement('div');
    modal.id = 'importModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Import Tracks</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="import-pack-info">
            <h3>${this.escapeHtml(pack.name)}</h3>
            <p><strong>Version:</strong> ${pack.version || '1.0.0'}</p>
            <p><strong>Author:</strong> ${this.escapeHtml(pack.author || 'Unknown')}</p>
            <p><strong>Tracks:</strong> ${pack.tracks.length}</p>
            ${duplicates.length > 0 ? `
              <p class="import-warning">⚠️ ${duplicates.length} track(s) have matching URL patterns</p>
            ` : ''}
          </div>
          
          <div class="import-options" style="margin-top: 16px;">
            <h4>How to handle duplicates:</h4>
            <label class="import-option">
              <input type="radio" name="mergeMode" value="skip-duplicates" checked>
              Skip duplicates (keep existing tracks)
            </label>
            <label class="import-option">
              <input type="radio" name="mergeMode" value="overwrite">
              Overwrite existing (replace with imported)
            </label>
            <label class="import-option">
              <input type="radio" name="mergeMode" value="keep-both">
              Keep both (may create duplicates)
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="control-btn modal-close-btn">Cancel</button>
          <button class="save-btn" id="confirmImportBtn">Import ${pack.tracks.length} Tracks</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Store pack for import
    this._pendingImport = pack;

    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.modal-close-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelector('#confirmImportBtn').addEventListener('click', async () => {
      const mergeMode = modal.querySelector('input[name="mergeMode"]:checked').value;
      await this.performImport(this._pendingImport, mergeMode);
      modal.remove();
    });
  }

  async performImport(pack, mergeMode) {
    try {
      const result = await this.packManager.importPack(pack, { mergeMode });
      
      await this.loadTracks();
      this.render();
      
      this.showStatus(
        `Imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`,
        false
      );
    } catch (error) {
      this.showStatus('Error importing: ' + error.message, true);
    }
  }

  testUrlPattern() {
    const testUrl = document.getElementById('testUrl').value.trim();
    const resultsDiv = document.getElementById('testResults');
    
    if (!testUrl) {
      resultsDiv.innerHTML = '<p style="color: #666;">Enter a URL to test</p>';
      return;
    }
    
    const matches = [];
    for (const track of this.tracks) {
      if (this.urlMatches(testUrl, track.urlPattern)) {
        matches.push({
          ...track,
          specificity: this.getPatternSpecificity(track.urlPattern)
        });
      }
    }
    
    // Sort by specificity (most specific first)
    matches.sort((a, b) => b.specificity - a.specificity);
    
    if (matches.length === 0) {
      resultsDiv.innerHTML = '<p style="color: #dc3545;">❌ No matching tracks found</p>';
    } else if (matches.length === 1) {
      const track = matches[0];
      resultsDiv.innerHTML = `
        <p style="color: #28a745;">✅ Match found!</p>
        <div style="background: #f8f9fa; padding: 12px; border-radius: 4px; margin-top: 8px;">
          <strong>${this.escapeHtml(track.title || 'Untitled')}</strong><br>
          <small style="color: #666;">Category: ${track.category}</small><br>
          <code style="font-size: 12px;">${this.escapeHtml(track.urlPattern)}</code>
          <small style="color: #999; margin-left: 8px;">Specificity: ${track.specificity}</small>
        </div>
      `;
    } else {
      resultsDiv.innerHTML = `
        <p style="color: #ff8800;">⚠️ Multiple matches found (${matches.length}) - most specific match will be used:</p>
        ${matches.map((track, i) => `
          <div style="background: #f8f9fa; padding: 12px; border-radius: 4px; margin-top: 8px; border-left: 3px solid ${i === 0 ? '#28a745' : '#dee2e6'}">
            <strong>${this.escapeHtml(track.title || 'Untitled')}</strong> ${i === 0 ? '<span style="color: #28a745;">(active - most specific)</span>' : ''}<br>
            <small style="color: #666;">Category: ${track.category}</small><br>
            <code style="font-size: 12px;">${this.escapeHtml(track.urlPattern)}</code>
            <small style="color: #999; margin-left: 8px;">Specificity: ${track.specificity}</small>
          </div>
        `).join('')}
      `;
    }
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
    // Simple pattern matching - same as in sidepanel.js
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }
    return url.includes(pattern);
  }

  showStatus(message, isError = false) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = isError ? 'status error' : 'status';
    
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  }

  render() {
    const tracksList = document.getElementById('tracksList');
    const filteredTracks = this.getFilteredTracks();
    
    // Update filter info
    const filterInfo = document.getElementById('filterInfo');
    if (filterInfo) {
      const total = this.tracks.length;
      const shown = filteredTracks.length;
      
      // Build filter description
      const activeFilters = [];
      
      if (this.selectedCustomerId) {
        if (this.selectedCustomerId === 'generic') {
          activeFilters.push('Generic only');
        } else {
          const customer = this.getCustomerById(this.selectedCustomerId);
          activeFilters.push(`Customer: ${customer?.name || 'Unknown'}`);
        }
      }
      
      if (this.filterCategory !== 'all') {
        activeFilters.push(`Category: ${this.filterCategory}`);
      }
      
      if (this.filterTag !== 'all') {
        activeFilters.push(`Tag: ${this.filterTag}`);
      }
      
      if (this.searchTerm) {
        activeFilters.push(`Search: "${this.searchTerm}"`);
      }
      
      const filterText = activeFilters.length > 0 
        ? ` (${activeFilters.join(', ')})` 
        : '';
      
      filterInfo.textContent = shown === total 
        ? `Showing all ${total} tracks` 
        : `Showing ${shown} of ${total} tracks${filterText}`;
    }
    
    // Update bulk actions visibility
    const bulkActions = document.getElementById('bulkActions');
    if (bulkActions) {
      bulkActions.style.display = this.selectedTracks.size > 0 ? 'flex' : 'none';
      const bulkCount = document.getElementById('bulkCount');
      if (bulkCount) {
        bulkCount.textContent = `${this.selectedTracks.size} selected`;
      }
    }
    
    if (filteredTracks.length === 0) {
      tracksList.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #666;">
          <p>No tracks found matching your filters.</p>
          <button class="add-button" style="width: auto; margin-top: 16px;" onclick="optionsManager.addTrack()">+ Add New Talk Track</button>
        </div>
      `;
      return;
    }
    
    tracksList.innerHTML = filteredTracks.map((track, index) => {
      const isExpanded = this.expandedTracks.has(track.id);
      const isSelected = this.selectedTracks.has(track.id);
      
      return `
      <div class="track-item ${isExpanded ? 'expanded' : 'collapsed'} ${isSelected ? 'selected' : ''}" 
           data-id="${track.id}" 
           draggable="true">
        <div class="track-header-collapsed">
          <input 
            type="checkbox" 
            class="track-checkbox" 
            ${isSelected ? 'checked' : ''}
            title="Select for bulk actions"
          />
          <div class="track-summary" data-track-id="${track.id}">
            <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
            <span class="track-title-preview">${this.escapeHtml(track.title || 'Untitled Track')}</span>
            ${track.customerId ? `
              <span class="track-customer-badge" style="background: ${this.getCustomerById(track.customerId)?.color || '#666'}" title="${this.escapeHtml(this.getCustomerById(track.customerId)?.name || 'Customer')}">
                👤 ${this.escapeHtml(this.getCustomerById(track.customerId)?.name || 'Customer')}
              </span>
            ` : ''}
            <span class="track-category-badge" style="background: ${this.getCategoryColor(track.category)}">${track.category}</span>
            ${(track.tags && track.tags.length > 0) ? `
              <span class="track-tags-preview">
                ${track.tags.slice(0, 3).map(tag => `<span class="tag-pill">${this.escapeHtml(tag)}</span>`).join('')}
                ${track.tags.length > 3 ? `<span class="tag-more">+${track.tags.length - 3}</span>` : ''}
              </span>
            ` : ''}
            <span class="track-url-preview">${this.escapeHtml(track.urlPattern || 'No pattern')}</span>
          </div>
          <button class="expand-toggle" data-track-id="${track.id}" title="${isExpanded ? 'Collapse' : 'Expand'}">
            ${isExpanded ? '▼' : '▶'}
          </button>
        </div>
        
        <div class="track-content" style="display: ${isExpanded ? 'block' : 'none'}">
          <div class="track-header-expanded">
            <div class="track-number">Talk Track #${this.tracks.indexOf(track) + 1}</div>
            <button class="delete-button">
              Delete
            </button>
          </div>
          
          <div class="form-group">
            <label for="title-${track.id}">Track Title</label>
            <input 
              type="text" 
              id="title-${track.id}" 
              value="${this.escapeHtml(track.title)}"
              placeholder="e.g., Dashboard Overview Demo"
            />
          </div>
          
          <div class="form-group">
            <label for="category-${track.id}">Category</label>
            <select id="category-${track.id}">
              ${this.categories.filter(c => c !== 'All').map(cat => 
                `<option value="${cat}" ${track.category === cat ? 'selected' : ''}>${cat}</option>`
              ).join('')}
            </select>
          </div>
          
          <div class="form-group">
            <label for="customer-${track.id}">Customer <span class="label-hint">(optional - for customer-specific tracks)</span></label>
            <select id="customer-${track.id}" class="customer-select">
              <option value="">Generic (all customers)</option>
              ${this.customers.map(c => 
                `<option value="${c.id}" ${track.customerId === c.id ? 'selected' : ''}>
                  ${this.escapeHtml(c.name)}${c.industry ? ` (${this.escapeHtml(c.industry)})` : ''}
                </option>`
              ).join('')}
            </select>
          </div>
          
          <div class="form-group">
            <label for="tags-${track.id}">Tags <span class="label-hint">(comma-separated)</span></label>
            <input 
              type="text" 
              id="tags-${track.id}" 
              value="${this.escapeHtml((track.tags || []).join(', '))}"
              placeholder="e.g., demo, sales, technical"
              class="tags-input"
            />
          </div>
          
          <div class="form-group">
            <label for="url-${track.id}">URL Pattern</label>
            <input 
              type="text" 
              id="url-${track.id}" 
              value="${this.escapeHtml(track.urlPattern)}"
              placeholder="e.g., */dashboards/* or */apm/services"
            />
          </div>
          
          <div class="form-group">
            <div class="content-editor-header">
              <label for="content-${track.id}">Talk Track Content</label>
              <div class="editor-mode-buttons">
                <button type="button" class="preview-toggle-btn" data-track-id="${track.id}" title="Toggle between WYSIWYG and Markdown view">
                  📝 View Markdown
                </button>
                <button type="button" class="debug-html-btn" data-track-id="${track.id}" title="Debug: Show raw HTML structure">
                  🔍
                </button>
              </div>
            </div>
            <div class="editor-container">
              <div id="quill-editor-${track.id}" class="quill-editor-container" data-track-id="${track.id}"></div>
              <textarea 
                id="markdown-${track.id}"
                class="content-markdown"
                style="display: none;"
                placeholder="Raw markdown..."
              >${this.escapeHtml(track.content)}</textarea>
            </div>
          </div>
        </div>
      </div>
      `;
    }).join('');
    
    // Initialize Quill editors after DOM is ready
    setTimeout(() => this.initializeQuillEditors(), 0);
  }

  initializeQuillEditors() {
    // Clean up existing editors
    this.quillEditors.forEach((editor, id) => {
      // Quill doesn't have a destroy method, so we just remove the reference
    });
    this.quillEditors.clear();

    // Initialize Quill for each expanded track
    const filteredTracks = this.getFilteredTracks();
    filteredTracks.forEach(track => {
      if (this.expandedTracks.has(track.id)) {
        this.initQuillForTrack(track);
      }
    });
  }

  initQuillForTrack(track) {
    const containerId = `quill-editor-${track.id}`;
    const container = document.getElementById(containerId);
    
    if (!container || this.quillEditors.has(track.id)) return;
    
    // Create Quill editor with Google Docs-like toolbar including navigation link button
    const quill = new Quill(container, {
      theme: 'snow',
      placeholder: 'Start typing your talk track... Use the toolbar to format text.',
      modules: {
        toolbar: {
          container: [
            [{ 'header': [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            [{ 'indent': '-1'}, { 'indent': '+1' }],
            ['blockquote', 'code-block'],
            ['link', 'insertNavLink'],
            [{ 'color': [] }, { 'background': [] }],
            ['clean']
          ],
          handlers: {
            'insertNavLink': () => this.insertNavigationLink(track.id)
          }
        },
        clipboard: {
          matchVisual: false
        }
      }
    });

    // Add tooltip to the custom navigation link button
    const toolbar = container.previousElementSibling;
    if (toolbar) {
      const navLinkBtn = toolbar.querySelector('.ql-insertNavLink');
      if (navLinkBtn) {
        navLinkBtn.title = 'Insert Navigation Link';
      }
    }

    // Load initial content using Quill's clipboard for proper Delta conversion
    if (track.content) {
      const html = ContentConverter.markdownToHtml(track.content);
      console.log(`Loading HTML into Quill for track ${track.id}:`, html.substring(0, 200) + '...');
      
      try {
        // Quill 2.x uses clipboard.convert({ html }), older versions use clipboard.convert(html)
        let delta;
        if (typeof quill.clipboard.convert === 'function') {
          try {
            delta = quill.clipboard.convert({ html });
          } catch (e) {
            delta = quill.clipboard.convert(html);
          }
        }
        
        if (delta) {
          quill.setContents(delta, 'silent');
        } else {
          quill.root.innerHTML = html;
        }
      } catch (error) {
        console.warn('Error loading content into Quill, using fallback:', error);
        quill.root.innerHTML = html;
      }
    }

    // Store reference
    this.quillEditors.set(track.id, quill);

    // Auto-save on text change (debounced)
    let saveTimeout;
    quill.on('text-change', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.onQuillChange(track.id);
      }, 500);
    });
  }

  onQuillChange(trackId) {
    const quill = this.quillEditors.get(trackId);
    if (!quill) return;

    const track = this.tracks.find(t => t.id === trackId);
    if (track) {
      // Store as HTML temporarily, will convert on save
      track._quillHtml = quill.root.innerHTML;
    }
  }

  getQuillContent(trackId) {
    const quill = this.quillEditors.get(trackId);
    if (quill) {
      return quill.root.innerHTML;
    }
    return null;
  }

  /**
   * Insert a navigation link at the current cursor position in a Quill editor
   * @param {number} trackId - The track ID whose editor to insert into
   */
  insertNavigationLink(trackId) {
    const quill = this.quillEditors.get(trackId);
    if (!quill) {
      alert('Editor not initialized');
      return;
    }

    // Prompt for link text
    const linkText = prompt('Enter the link text (e.g., "Go to Dashboard"):');
    if (!linkText) return;

    // Prompt for URL path
    const urlPath = prompt('Enter the URL path (e.g., "/dashboard/abc-123" or full URL):');
    if (!urlPath) return;

    // Build the full URL
    const fullUrl = this.buildFullUrl(urlPath);

    // Get current selection or cursor position
    const range = quill.getSelection(true);
    
    if (range) {
      // Insert the link at cursor position
      quill.insertText(range.index, linkText, 'link', fullUrl);
      // Move cursor after the inserted text
      quill.setSelection(range.index + linkText.length);
    } else {
      // If no selection, append to end
      const length = quill.getLength();
      quill.insertText(length - 1, linkText, 'link', fullUrl);
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
      const url = new URL(href, this.baseUrl || 'https://app.datadoghq.com');
      return url.href;
    } catch {
      // Fallback: simple concatenation
      const base = (this.baseUrl || 'https://app.datadoghq.com').replace(/\/$/, '');
      const path = href.startsWith('/') ? href : '/' + href;
      return base + path;
    }
  }

  renderMarkdown(text) {
    if (!text) return '<p style="color: #999; font-style: italic;">No content yet. Start typing to see preview...</p>';
    
    // Configure marked options
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    
    // Parse markdown to HTML
    const rawHtml = marked.parse(text);
    
    // Sanitize HTML
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'strike', 'del', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a', 'hr'],
      ALLOWED_ATTR: ['href', 'title', 'target']
    });
    
    return cleanHtml;
  }

  togglePreview(trackId) {
    const quillContainer = document.getElementById(`quill-editor-${trackId}`);
    const markdownEditor = document.getElementById(`markdown-${trackId}`);
    const toggleBtn = document.querySelector(`.preview-toggle-btn[data-track-id="${trackId}"]`);
    const quill = this.quillEditors.get(trackId);
    
    if (!quillContainer || !markdownEditor) return;
    
    const isMarkdownVisible = markdownEditor.style.display !== 'none';
    
    if (isMarkdownVisible) {
      // Switch back to WYSIWYG (Quill)
      const markdown = markdownEditor.value;
      const html = ContentConverter.markdownToHtml(markdown);
      
      if (quill) {
        try {
          // Quill 2.x uses clipboard.convert({ html }), older versions use clipboard.convert(html)
          let delta;
          try {
            delta = quill.clipboard.convert({ html });
          } catch (e) {
            delta = quill.clipboard.convert(html);
          }
          
          if (delta) {
            quill.setContents(delta, 'silent');
          } else {
            quill.root.innerHTML = html;
          }
        } catch (error) {
          console.warn('Error loading content into Quill, using fallback:', error);
          quill.root.innerHTML = html;
        }
      }
      
      quillContainer.style.display = 'block';
      markdownEditor.style.display = 'none';
      if (toggleBtn) toggleBtn.textContent = '📝 View Markdown';
    } else {
      // Switch to Markdown view
      let html = '';
      if (quill) {
        html = quill.root.innerHTML;
      }
      const markdown = ContentConverter.htmlToMarkdown(html);
      markdownEditor.value = markdown;
      quillContainer.style.display = 'none';
      markdownEditor.style.display = 'block';
      if (toggleBtn) toggleBtn.textContent = '👁️ View WYSIWYG';
    }
  }

  debugTrackHtml(trackId) {
    const wysiwygEditor = document.getElementById(`content-${trackId}`);
    const markdownEditor = document.getElementById(`markdown-${trackId}`);
    const track = this.tracks.find(t => t.id === trackId);
    
    if (!wysiwygEditor) return;
    
    const html = wysiwygEditor.innerHTML;
    const markdown = ContentConverter.htmlToMarkdown(html);
    
    // Create debug modal
    let modal = document.getElementById('debugModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'debugModal';
      modal.className = 'backup-modal';
      document.body.appendChild(modal);
    }
    
    modal.innerHTML = `
      <div class="backup-modal-content" style="max-width: 900px;">
        <div class="backup-modal-header">
          <h2>🔍 Content Debug</h2>
          <button type="button" class="close-modal-btn" id="closeDebugModal">✕</button>
        </div>
        <div style="padding: 20px; max-height: 70vh; overflow-y: auto;">
          <h3>Original Stored Markdown (${track?.content?.length || 0} chars):</h3>
          <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; white-space: pre-wrap; font-size: 12px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(track?.content || 'No stored content')}</pre>
          
          <h3>Current WYSIWYG HTML (${html.length} chars):</h3>
          <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; white-space: pre-wrap; font-size: 12px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(html)}</pre>
          
          <h3>Converted back to Markdown (${markdown.length} chars):</h3>
          <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; white-space: pre-wrap; font-size: 12px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(markdown)}</pre>
          
          ${track?.htmlBackup ? `
            <h3>HTML Backup (${track.htmlBackup.length} chars):</h3>
            <pre style="background: #fff3cd; padding: 10px; border-radius: 4px; white-space: pre-wrap; font-size: 12px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(track.htmlBackup)}</pre>
            <button type="button" class="restore-html-backup-btn" data-track-id="${trackId}" style="margin-top: 10px; padding: 8px 16px; background: #ffc107; border: none; border-radius: 4px; cursor: pointer;">
              ↩️ Restore from HTML Backup
            </button>
          ` : ''}
          
          <div style="margin-top: 20px; padding: 15px; background: #e8f4fd; border-radius: 8px;">
            <strong>💡 Tips:</strong>
            <ul style="margin: 10px 0 0 20px;">
              <li>If converted markdown is shorter than original, content may have been lost</li>
              <li>Use "📝 View Markdown" to edit in pure markdown mode (safer)</li>
              <li>Backups are created before every save - use "📂 Restore" to recover</li>
              <li>For complex formatting, consider editing in markdown mode directly</li>
            </ul>
          </div>
        </div>
      </div>
    `;
    
    modal.style.display = 'flex';
    
    document.getElementById('closeDebugModal').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    
    // Restore from HTML backup handler
    const restoreBtn = modal.querySelector('.restore-html-backup-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => {
        if (confirm('Restore WYSIWYG editor content from HTML backup?')) {
          wysiwygEditor.innerHTML = track.htmlBackup;
          modal.style.display = 'none';
          this.showStatus('Restored from HTML backup', false);
        }
      });
    }
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  }

  updatePreview(trackId) {
    // No longer needed since we use WYSIWYG by default
    // Keeping for backwards compatibility
  }

  getCategoryColor(category) {
    const colors = {
      'Dashboards': '#632ca6',
      'APM': '#00a8e1',
      'Logs': '#00b377',
      'Infrastructure': '#ff8800',
      'RUM': '#e32d84',
      'Synthetics': '#8943ef',
      'Security': '#dc3545',
      'Monitors': '#ffc107',
      'Other': '#6c757d'
    };
    
    // Return predefined color if it exists
    if (colors[category]) {
      return colors[category];
    }
    
    // Generate a consistent color for custom categories based on name
    return this.generateColorFromString(category);
  }

  generateColorFromString(str) {
    // Generate a consistent color from a string
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Generate nice colors (avoid too light or too dark)
    const hue = Math.abs(hash % 360);
    const saturation = 60 + (Math.abs(hash) % 20); // 60-80%
    const lightness = 45 + (Math.abs(hash >> 8) % 15); // 45-60%
    
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // === Settings methods ===

  async loadBaseUrl() {
    const result = await chrome.storage.local.get(['baseUrl']);
    this.baseUrl = result.baseUrl || 'https://app.datadoghq.com';
    const input = document.getElementById('baseUrl');
    if (input) {
      input.value = this.baseUrl;
    }
  }

  async saveBaseUrl() {
    const input = document.getElementById('baseUrl');
    if (!input) return;
    
    let url = input.value.trim();
    
    // Remove trailing slash
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      this.showStatus('Invalid URL format', true, 'baseUrlStatus');
      return;
    }
    
    this.baseUrl = url;
    await chrome.storage.local.set({ baseUrl: url });
    this.showStatus('Base URL saved!', false, 'baseUrlStatus');
  }

  // === Demo Planner connection methods ===

  async loadCopilotUrl() {
    const result = await chrome.storage.local.get(['seCopilotUrl']);
    const url = result.seCopilotUrl || '';
    const input = document.getElementById('seCopilotUrl');
    if (input && url) {
      input.value = url;
    }
  }

  async saveCopilotUrl() {
    const input = document.getElementById('seCopilotUrl');
    const url = (input?.value || '').trim();
    if (!url) {
      this.showCopilotStatus('Please enter a URL', true);
      return;
    }
    try {
      new URL(url);
    } catch {
      this.showCopilotStatus('Invalid URL format', true);
      return;
    }
    await chrome.storage.local.set({ seCopilotUrl: url });
    this.showCopilotStatus('URL saved!', false);
  }

  async testCopilotUrl() {
    const input = document.getElementById('seCopilotUrl');
    const url = (input?.value || '').trim() || 'http://localhost:5070';
    this.showCopilotStatus('Testing connection...', false);
    try {
      const resp = await fetch(`${url.replace(/\/+$/, '')}/api/health`);
      if (resp.ok) {
        this.showCopilotStatus('Connected successfully!', false);
      } else {
        this.showCopilotStatus(`Server responded with ${resp.status}`, true);
      }
    } catch (e) {
      this.showCopilotStatus('Cannot reach server: ' + e.message, true);
    }
  }

  showCopilotStatus(message, isError) {
    const el = document.getElementById('copilotUrlStatus');
    if (el) {
      el.textContent = message;
      el.className = isError ? 'api-key-status error' : 'api-key-status success';
    }
  }

  // === AI-related methods ===

  async loadApiKey() {
    const result = await chrome.storage.local.get(['openaiApiKey']);
    this.apiKey = result.openaiApiKey || '';
    const input = document.getElementById('openaiApiKey');
    if (input && this.apiKey) {
      input.value = this.apiKey;
    }
  }

  async saveApiKey() {
    const input = document.getElementById('openaiApiKey');
    const apiKey = input.value.trim();
    
    if (!apiKey) {
      this.showApiKeyStatus('Please enter an API key', true);
      return;
    }

    try {
      await chrome.storage.local.set({ openaiApiKey: apiKey });
      this.apiKey = apiKey;
      this.showApiKeyStatus('API key saved successfully!', false);
    } catch (error) {
      this.showApiKeyStatus('Error saving API key: ' + error.message, true);
    }
  }

  async testApiKey() {
    const input = document.getElementById('openaiApiKey');
    const apiKey = input.value.trim();
    
    if (!apiKey) {
      this.showApiKeyStatus('Please enter an API key to test', true);
      return;
    }

    this.showApiKeyStatus('Testing API key...', false);

    try {
      const isValid = await this.aiService.validateApiKey(apiKey);
      if (isValid) {
        this.showApiKeyStatus('✓ API key is valid!', false);
      } else {
        this.showApiKeyStatus('✗ API key is invalid', true);
      }
    } catch (error) {
      this.showApiKeyStatus('Error testing API key: ' + error.message, true);
    }
  }

  showApiKeyStatus(message, isError) {
    const status = document.getElementById('apiKeyStatus');
    if (status) {
      status.textContent = message;
      status.className = isError ? 'api-key-status error' : 'api-key-status success';
      
      setTimeout(() => {
        status.textContent = '';
        status.className = 'api-key-status';
      }, 5000);
    }
  }

  async loadPersonas() {
    const result = await chrome.storage.local.get(['customPersonas']);
    this.customPersonas = result.customPersonas || [];
  }

  async savePersonas() {
    await chrome.storage.local.set({ customPersonas: this.customPersonas });
  }

  getAllPersonas() {
    return [...this.defaultPersonas, ...this.customPersonas];
  }

  addPersona() {
    const name = prompt('Enter persona name:');
    if (!name) return;

    const description = prompt('Enter persona description (focus and approach):');
    if (!description) return;

    const newPersona = {
      id: 'custom-' + Date.now(),
      name: name.trim(),
      description: description.trim(),
      isDefault: false
    };

    this.customPersonas.push(newPersona);
    this.savePersonas();
    this.renderPersonas();
  }

  deletePersona(id) {
    if (!confirm('Delete this persona?')) return;
    
    this.customPersonas = this.customPersonas.filter(p => p.id !== id);
    this.savePersonas();
    this.renderPersonas();
  }

  editPersona(id) {
    const persona = this.customPersonas.find(p => p.id === id);
    if (!persona) return;

    const name = prompt('Enter persona name:', persona.name);
    if (!name) return;

    const description = prompt('Enter persona description:', persona.description);
    if (!description) return;

    persona.name = name.trim();
    persona.description = description.trim();
    this.savePersonas();
    this.renderPersonas();
  }

  renderPersonas() {
    const list = document.getElementById('personasList');
    if (!list) return;

    const allPersonas = this.getAllPersonas();

    list.innerHTML = allPersonas.map(persona => `
      <div class="persona-item ${persona.isDefault ? 'default' : 'custom'}">
        <div class="persona-header">
          <strong>${this.escapeHtml(persona.name)}</strong>
          ${persona.isDefault ? '<span class="default-badge">Default</span>' : ''}
        </div>
        <div class="persona-description">${this.escapeHtml(persona.description)}</div>
        ${!persona.isDefault ? `
          <div class="persona-actions">
            <button class="persona-edit-btn" data-id="${persona.id}">Edit</button>
            <button class="persona-delete-btn" data-id="${persona.id}">Delete</button>
          </div>
        ` : ''}
      </div>
    `).join('');
  }
}

// Initialize
const optionsManager = new OptionsManager();

// Initialize Auth UI
let authUI = null;
if (typeof AuthUI !== 'undefined' && typeof isCloudEnabled === 'function') {
  authUI = new AuthUI('#authContainer');
  authUI.init().then(() => {
    // Show legacy GitHub sync if cloud is not enabled
    const githubSection = document.getElementById('githubSyncSection');
    if (githubSection && !isCloudEnabled()) {
      githubSection.style.display = 'block';
    }
  });
  
  // Wire up sync callback (push to cloud)
  authUI.onSyncRequest = async () => {
    if (typeof supabaseCloud !== 'undefined' && supabaseCloud.isPro()) {
      // Trigger cloud sync
      const tracks = optionsManager.tracks || [];
      const result = await supabaseCloud.sync(tracks);
      if (result.success) {
        alert(`Pushed ${result.trackCount} tracks to cloud!`);
      } else {
        alert('Sync failed: ' + result.error);
      }
    }
  };

  // Wire up pull callback (pull from cloud)
  authUI.onPullRequest = async () => {
    if (typeof supabaseCloud !== 'undefined' && supabaseCloud.isPro()) {
      try {
        const result = await supabaseCloud.fetch();
        if (result.success && result.data) {
          const cloudTracks = result.data.tracks || [];
          
          if (cloudTracks.length === 0) {
            alert('No tracks found in the cloud.');
            return;
          }
          
          // Confirm before replacing
          const localCount = optionsManager.tracks?.length || 0;
          const confirmed = confirm(
            `Pull ${cloudTracks.length} tracks from cloud?\n\n` +
            `This will replace your ${localCount} local tracks.\n` +
            `A backup will be created first.`
          );
          
          if (confirmed) {
            // Create backup first
            await optionsManager.storageManager?.createBackup?.();
            
            // Replace local tracks with cloud tracks
            optionsManager.tracks = cloudTracks;
            await optionsManager.saveTracks();
            optionsManager.renderTracks();
            
            alert(`Successfully pulled ${cloudTracks.length} tracks from cloud!`);
          }
        } else {
          alert('Pull failed: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        alert('Pull failed: ' + error.message);
      }
    }
  };
}
