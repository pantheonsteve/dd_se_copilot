// Supabase Cloud Service for DemoBuddy Pro
// Handles authentication, data sync, and subscription management

class SupabaseCloudService {
  constructor() {
    // These will be set from config
    this.supabaseUrl = null;
    this.supabaseKey = null;
    this.supabase = null;
    
    // Auth state
    this.user = null;
    this.profile = null;
    this.session = null;
    
    // Listeners
    this.authListeners = new Set();
    
    // Sync state
    this.isSyncing = false;
    this.lastSyncAt = null;
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize the Supabase client
   * @param {string} url - Supabase project URL
   * @param {string} key - Supabase anon key
   */
  async init(url, key) {
    if (!url || !key) {
      console.warn('[Supabase] Missing URL or key, cloud features disabled');
      return false;
    }

    this.supabaseUrl = url;
    this.supabaseKey = key;

    // Create Supabase client using the REST API directly
    // (Chrome extensions can't use the full JS client easily due to bundling)
    this.supabase = {
      url: url,
      key: key,
      headers: {
        'apikey': key,
        'Content-Type': 'application/json'
      }
    };

    // Check for existing session
    await this.loadSession();

    console.log('[Supabase] Initialized', this.user ? `as ${this.user.email}` : '(not logged in)');
    return true;
  }

  /**
   * Load configuration from storage
   */
  async loadConfig() {
    const config = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey']);
    if (config.supabaseUrl && config.supabaseKey) {
      await this.init(config.supabaseUrl, config.supabaseKey);
      return true;
    }
    return false;
  }

  // ==================== AUTHENTICATION ====================

  /**
   * Sign up a new user
   * @param {string} email
   * @param {string} password
   */
  async signUp(email, password) {
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: this.supabase.headers,
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error_description || data.msg || 'Signup failed');
      }

      // If email confirmation is disabled, we get a session immediately
      if (data.access_token) {
        await this.setSession(data);
      }

      return { success: true, data, needsConfirmation: !data.access_token };
    } catch (error) {
      console.error('[Supabase] Signup error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign in an existing user
   * @param {string} email
   * @param {string} password
   */
  async signIn(email, password) {
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: this.supabase.headers,
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error_description || data.msg || 'Login failed');
      }

      await this.setSession(data);
      return { success: true, user: this.user };
    } catch (error) {
      console.error('[Supabase] SignIn error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign in with magic link (passwordless)
   * @param {string} email
   */
  async signInWithMagicLink(email) {
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/magiclink`, {
        method: 'POST',
        headers: this.supabase.headers,
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error_description || data.msg || 'Failed to send magic link');
      }

      return { success: true, message: 'Check your email for the login link' };
    } catch (error) {
      console.error('[Supabase] Magic link error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign in with OAuth provider
   * @param {string} provider - 'google', 'github', etc.
   */
  async signInWithOAuth(provider) {
    // OAuth requires opening a browser window
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${this.supabaseUrl}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectUrl)}`;

    return new Promise((resolve) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        async (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            resolve({ success: false, error: chrome.runtime.lastError?.message || 'Auth cancelled' });
            return;
          }

          // Parse the tokens from the URL fragment
          const url = new URL(responseUrl);
          const hashParams = new URLSearchParams(url.hash.substring(1));
          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');

          if (accessToken) {
            await this.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
              token_type: 'bearer'
            });
            resolve({ success: true, user: this.user });
          } else {
            resolve({ success: false, error: 'No access token received' });
          }
        }
      );
    });
  }

  /**
   * Sign out the current user
   */
  async signOut() {
    try {
      if (this.session?.access_token) {
        await fetch(`${this.supabaseUrl}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            ...this.supabase.headers,
            'Authorization': `Bearer ${this.session.access_token}`
          }
        });
      }
    } catch (error) {
      console.warn('[Supabase] Logout error:', error);
    }

    await this.clearSession();
    return { success: true };
  }

  /**
   * Set and persist the session
   */
  async setSession(data) {
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    };

    this.user = data.user || await this.getUser();
    this.profile = await this.getProfile();

    // Persist session
    await chrome.storage.local.set({
      supabaseSession: this.session,
      supabaseUser: this.user
    });

    this.notifyAuthListeners('signedIn', this.user);
  }

  /**
   * Load session from storage
   */
  async loadSession() {
    const stored = await chrome.storage.local.get(['supabaseSession', 'supabaseUser']);
    
    if (stored.supabaseSession) {
      this.session = stored.supabaseSession;
      this.user = stored.supabaseUser;

      // Check if session is expired
      if (this.session.expires_at < Date.now()) {
        await this.refreshSession();
      } else {
        // Verify session is still valid
        const user = await this.getUser();
        if (!user) {
          await this.clearSession();
        } else {
          this.user = user;
          this.profile = await this.getProfile();
        }
      }
    }
  }

  /**
   * Refresh the access token
   */
  async refreshSession() {
    if (!this.session?.refresh_token) {
      await this.clearSession();
      return false;
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: this.supabase.headers,
        body: JSON.stringify({ refresh_token: this.session.refresh_token })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error('Token refresh failed');
      }

      await this.setSession(data);
      return true;
    } catch (error) {
      console.error('[Supabase] Refresh error:', error);
      await this.clearSession();
      return false;
    }
  }

  /**
   * Clear the session
   */
  async clearSession() {
    this.session = null;
    this.user = null;
    this.profile = null;

    await chrome.storage.local.remove(['supabaseSession', 'supabaseUser']);
    this.notifyAuthListeners('signedOut', null);
  }

  /**
   * Get the current user
   */
  async getUser() {
    if (!this.session?.access_token) return null;

    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`
        }
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('[Supabase] Get user error:', error);
      return null;
    }
  }

  /**
   * Get the user's profile (includes subscription status)
   */
  async getProfile() {
    if (!this.user?.id) return null;

    try {
      const response = await this.query('profiles', {
        select: '*',
        filter: `id=eq.${this.user.id}`,
        single: true
      });

      return response.data;
    } catch (error) {
      console.error('[Supabase] Get profile error:', error);
      return null;
    }
  }

  // ==================== AUTH LISTENERS ====================

  addAuthListener(callback) {
    this.authListeners.add(callback);
  }

  removeAuthListener(callback) {
    this.authListeners.delete(callback);
  }

  notifyAuthListeners(event, data) {
    this.authListeners.forEach(cb => {
      try {
        cb(event, data);
      } catch (e) {
        console.error('[Supabase] Auth listener error:', e);
      }
    });
  }

  // ==================== DATABASE OPERATIONS ====================

  /**
   * Generic query helper
   */
  async query(table, options = {}) {
    if (!this.session?.access_token) {
      return { data: null, error: 'Not authenticated' };
    }

    let url = `${this.supabaseUrl}/rest/v1/${table}`;
    
    // Build query params
    const params = new URLSearchParams();
    if (options.select) params.append('select', options.select);
    if (options.filter) url += `?${options.filter}`;
    if (options.order) params.append('order', options.order);
    if (options.limit) params.append('limit', options.limit);
    if (options.offset) params.append('offset', options.offset);

    const queryString = params.toString();
    if (queryString && !options.filter) {
      url += `?${queryString}`;
    } else if (queryString) {
      url += `&${queryString}`;
    }

    try {
      const response = await fetch(url, {
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`,
          'Prefer': options.single ? 'return=representation' : 'return=representation'
        }
      });

      const data = await response.json();

      if (!response.ok) {
        return { data: null, error: data.message || 'Query failed' };
      }

      return { data: options.single ? data[0] : data, error: null };
    } catch (error) {
      return { data: null, error: error.message };
    }
  }

  /**
   * Insert data
   */
  async insert(table, data) {
    if (!this.session?.access_token) {
      return { data: null, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(Array.isArray(data) ? data : [data])
      });

      const result = await response.json();

      if (!response.ok) {
        return { data: null, error: result.message || 'Insert failed' };
      }

      return { data: result, error: null };
    } catch (error) {
      return { data: null, error: error.message };
    }
  }

  /**
   * Upsert data (insert or update)
   */
  async upsert(table, data, onConflict = 'id') {
    if (!this.session?.access_token) {
      return { data: null, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`,
          'Prefer': 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(Array.isArray(data) ? data : [data])
      });

      const result = await response.json();

      if (!response.ok) {
        return { data: null, error: result.message || 'Upsert failed' };
      }

      return { data: result, error: null };
    } catch (error) {
      return { data: null, error: error.message };
    }
  }

  /**
   * Update data
   */
  async update(table, filter, data) {
    if (!this.session?.access_token) {
      return { data: null, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}?${filter}`, {
        method: 'PATCH',
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
      });

      const result = await response.json();

      if (!response.ok) {
        return { data: null, error: result.message || 'Update failed' };
      }

      return { data: result, error: null };
    } catch (error) {
      return { data: null, error: error.message };
    }
  }

  /**
   * Delete data
   */
  async delete(table, filter) {
    if (!this.session?.access_token) {
      return { data: null, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}?${filter}`, {
        method: 'DELETE',
        headers: {
          ...this.supabase.headers,
          'Authorization': `Bearer ${this.session.access_token}`,
          'Prefer': 'return=representation'
        }
      });

      const result = await response.json();

      if (!response.ok) {
        return { data: null, error: result.message || 'Delete failed' };
      }

      return { data: result, error: null };
    } catch (error) {
      return { data: null, error: error.message };
    }
  }

  // ==================== SYNC OPERATIONS ====================

  /**
   * Check if user has Pro subscription
   * All features are now free - no subscription required
   */
  isPro() {
    return true;
  }

  /**
   * Sync tracks to cloud
   * @param {Array} tracks - Local tracks to sync
   * @param {Object} metadata - Additional metadata (customers, personas, etc.)
   */
  async sync(tracks, metadata = {}) {
    if (!this.user?.id) {
      return { success: false, error: 'Not authenticated' };
    }

    if (!this.isPro()) {
      return { success: false, error: 'Pro subscription required' };
    }

    if (this.isSyncing) {
      return { success: false, error: 'Sync already in progress' };
    }

    this.isSyncing = true;

    try {
      // Prepare tracks for upload
      const cloudTracks = tracks.map(track => ({
        id: track.id,
        user_id: this.user.id,
        title: track.title || '',
        category: track.category || 'Other',
        url_pattern: track.urlPattern,
        content: track.content || '',
        html_backup: track.htmlBackup || null,
        tags: track.tags || [],
        order: track.order || 0,
        customer_id: track.customerId || null,
        source: track.source || 'local',
        original_id: track.originalId || null,
        version: track.version || '1.0.0',
        updated_at: track.lastModified || new Date().toISOString(),
        is_deleted: false
      }));

      // Upsert all tracks
      const { data, error } = await this.upsert('tracks', cloudTracks);

      if (error) {
        throw new Error(error);
      }

      // Sync metadata
      for (const [key, value] of Object.entries(metadata)) {
        if (value !== null && value !== undefined) {
          await this.upsert('user_metadata', {
            user_id: this.user.id,
            key,
            value
          }, 'user_id,key');
        }
      }

      // Update last sync time
      this.lastSyncAt = new Date().toISOString();
      await this.update('profiles', `id=eq.${this.user.id}`, {
        last_sync_at: this.lastSyncAt
      });

      // Log sync
      await this.insert('sync_log', {
        user_id: this.user.id,
        action: 'push',
        track_count: tracks.length,
        status: 'success'
      });

      return { 
        success: true, 
        trackCount: tracks.length,
        syncedAt: this.lastSyncAt
      };
    } catch (error) {
      console.error('[Supabase] Sync error:', error);

      // Log error
      await this.insert('sync_log', {
        user_id: this.user.id,
        action: 'push',
        track_count: tracks.length,
        status: 'failed',
        error_message: error.message
      });

      return { success: false, error: error.message };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Fetch tracks from cloud
   */
  async fetch() {
    if (!this.user?.id) {
      return { success: false, error: 'Not authenticated' };
    }

    if (!this.isPro()) {
      return { success: false, error: 'Pro subscription required' };
    }

    try {
      // Get tracks
      const { data: tracks, error: tracksError } = await this.query('tracks', {
        filter: `user_id=eq.${this.user.id}&is_deleted=eq.false`,
        order: 'order.asc'
      });

      if (tracksError) throw new Error(tracksError);

      // Get metadata
      const { data: metadataRows, error: metaError } = await this.query('user_metadata', {
        filter: `user_id=eq.${this.user.id}`
      });

      if (metaError) throw new Error(metaError);

      // Convert metadata to object
      const metadata = {};
      (metadataRows || []).forEach(row => {
        metadata[row.key] = row.value;
      });

      // Convert tracks from DB format to local format
      const localTracks = (tracks || []).map(track => ({
        id: track.id,
        title: track.title,
        category: track.category,
        urlPattern: track.url_pattern,
        content: track.content,
        htmlBackup: track.html_backup,
        tags: track.tags || [],
        order: track.order,
        customerId: track.customer_id,
        source: track.source,
        originalId: track.original_id,
        version: track.version,
        lastModified: track.updated_at,
        lastSyncedAt: track.last_synced_at
      }));

      return {
        success: true,
        data: {
          tracks: localTracks,
          metadata,
          lastModified: tracks?.[0]?.updated_at
        }
      };
    } catch (error) {
      console.error('[Supabase] Fetch error:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== SUBSCRIPTION ====================

  /**
   * Get Stripe checkout URL for upgrading to Pro
   */
  async getCheckoutUrl(priceId) {
    if (!this.session?.access_token) {
      console.error('[Supabase] getCheckoutUrl: No access token');
      return { success: false, error: 'Not authenticated' };
    }

    const url = `${this.supabaseUrl}/functions/v1/create-checkout`;
    console.log('[Supabase] Calling checkout URL:', url);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.session.access_token}`
        },
        body: JSON.stringify({ priceId })
      });

      console.log('[Supabase] Checkout response status:', response.status);
      
      const data = await response.json();
      console.log('[Supabase] Checkout response data:', data);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create checkout session');
      }

      return { success: true, url: data.url };
    } catch (error) {
      console.error('[Supabase] Checkout error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get Stripe billing portal URL
   */
  async getBillingPortalUrl() {
    if (!this.session?.access_token) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/billing-portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.session.access_token}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create billing portal session');
      }

      return { success: true, url: data.url };
    } catch (error) {
      console.error('[Supabase] Billing portal error:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== STATUS ====================

  /**
   * Get current auth and subscription status
   */
  getStatus() {
    return {
      isAuthenticated: !!this.user,
      isPro: this.isPro(),
      user: this.user,
      profile: this.profile,
      lastSyncAt: this.lastSyncAt
    };
  }
}

// Create singleton instance
const supabaseCloud = new SupabaseCloudService();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SupabaseCloudService, supabaseCloud };
}
