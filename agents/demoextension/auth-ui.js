// Auth UI Component for DemoBuddy Pro
// Handles login, signup, and account management UI

class AuthUI {
  constructor(containerSelector, cloudService) {
    this.container = document.querySelector(containerSelector);
    this.cloud = cloudService || supabaseCloud;
    this.mode = 'login'; // 'login', 'signup', 'forgot'
    
    // Listen for auth changes
    this.cloud.addAuthListener((event, data) => {
      this.render();
    });
  }

  /**
   * Initialize and render the auth UI
   */
  async init() {
    // Try to load existing config
    if (isCloudEnabled()) {
      await this.cloud.init(
        DEMOBUDDY_CONFIG.SUPABASE_URL,
        DEMOBUDDY_CONFIG.SUPABASE_ANON_KEY
      );
    }
    
    this.render();
  }

  /**
   * Render the appropriate UI based on auth state
   */
  render() {
    if (!this.container) return;

    if (!isCloudEnabled()) {
      this.renderCloudDisabled();
    } else if (this.cloud.user) {
      this.renderAccountUI();
    } else {
      this.renderAuthForm();
    }
  }

  /**
   * Render when cloud is not configured
   */
  renderCloudDisabled() {
    this.container.innerHTML = `
      <div class="auth-container">
        <div class="auth-header">
          <h3>☁️ Cloud Sync</h3>
        </div>
        <div class="auth-body">
          <p class="auth-info">
            Cloud sync is not configured. Your data is stored locally only.
          </p>
          <p class="auth-hint">
            To enable cloud features, configure your Supabase credentials in config.js
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Render the login/signup form
   */
  renderAuthForm() {
    const isLogin = this.mode === 'login';
    const isForgot = this.mode === 'forgot';

    this.container.innerHTML = `
      <div class="auth-container">
        <div class="auth-header">
          <h3>${isForgot ? '🔑 Reset Password' : isLogin ? '🔐 Sign In' : '✨ Create Account'}</h3>
        </div>
        
        <div class="auth-body">
          ${isForgot ? this.renderForgotForm() : this.renderLoginSignupForm(isLogin)}
        </div>
        
        <div class="auth-footer">
          ${isForgot ? `
            <button class="auth-link" data-action="showLogin">← Back to Sign In</button>
          ` : `
            <span>${isLogin ? "Don't have an account?" : "Already have an account?"}</span>
            <button class="auth-link" data-action="${isLogin ? 'showSignup' : 'showLogin'}">
              ${isLogin ? 'Sign Up' : 'Sign In'}
            </button>
          `}
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  renderLoginSignupForm(isLogin) {
    return `
      <form id="authForm" class="auth-form">
        <div class="form-group">
          <label for="authEmail">Email</label>
          <input 
            type="email" 
            id="authEmail" 
            placeholder="you@company.com"
            required
          />
        </div>
        
        <div class="form-group">
          <label for="authPassword">Password</label>
          <input 
            type="password" 
            id="authPassword" 
            placeholder="${isLogin ? 'Your password' : 'Create a password (min 6 chars)'}"
            minlength="6"
            required
          />
        </div>
        
        ${!isLogin ? `
          <div class="form-group">
            <label for="authPasswordConfirm">Confirm Password</label>
            <input 
              type="password" 
              id="authPasswordConfirm" 
              placeholder="Confirm your password"
              minlength="6"
              required
            />
          </div>
        ` : ''}
        
        <div id="authError" class="auth-error" style="display: none;"></div>
        <div id="authSuccess" class="auth-success" style="display: none;"></div>
        
        <button type="submit" class="auth-submit-btn" id="authSubmitBtn">
          ${isLogin ? 'Sign In' : 'Create Account'}
        </button>
        
        ${isLogin ? `
          <button type="button" class="auth-link forgot-link" data-action="showForgot">
            Forgot password?
          </button>
        ` : ''}
      </form>
      
      <div class="auth-divider">
        <span>or</span>
      </div>
      
      <button class="auth-oauth-btn google" data-provider="google">
        <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
        Continue with Google
      </button>
    `;
  }

  renderForgotForm() {
    return `
      <form id="forgotForm" class="auth-form">
        <p class="auth-info">
          Enter your email and we'll send you a link to reset your password.
        </p>
        
        <div class="form-group">
          <label for="forgotEmail">Email</label>
          <input 
            type="email" 
            id="forgotEmail" 
            placeholder="you@company.com"
            required
          />
        </div>
        
        <div id="authError" class="auth-error" style="display: none;"></div>
        <div id="authSuccess" class="auth-success" style="display: none;"></div>
        
        <button type="submit" class="auth-submit-btn">
          Send Reset Link
        </button>
      </form>
    `;
  }

  /**
   * Render the account/subscription UI for logged-in users
   */
  renderAccountUI() {
    const user = this.cloud.user;
    const profile = this.cloud.profile;

    this.container.innerHTML = `
      <div class="auth-container">
        <div class="auth-header">
          <h3>👤 Account</h3>
        </div>
        
        <div class="auth-body">
          <div class="account-info">
            <div class="account-email">${this.escapeHtml(user.email)}</div>
          </div>
          
          <div id="authError" class="auth-error" style="display: none;"></div>
          <div id="authSuccess" class="auth-success" style="display: none;"></div>
          
          <div class="sync-status">
            <div class="sync-info">
              <span class="sync-icon">☁️</span>
              <span>Cloud sync enabled</span>
            </div>
            ${profile?.last_sync_at ? `
              <div class="last-sync">
                Last synced: ${new Date(profile.last_sync_at).toLocaleString()}
              </div>
            ` : ''}
            <div class="track-count">
              ${profile?.track_count || 0} tracks synced
            </div>
          </div>
          
          <div class="sync-buttons-row">
            <button class="auth-action-btn sync-push" data-action="syncNow">
              ⬆️ Push to Cloud
            </button>
            <button class="auth-action-btn sync-pull" data-action="pullFromCloud">
              ⬇️ Pull from Cloud
            </button>
          </div>
          
          <button class="auth-action-btn danger" data-action="signOut">
            Sign Out
          </button>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  /**
   * Attach event listeners to the rendered UI
   */
  attachEventListeners() {
    // Auth form submission
    const authForm = this.container.querySelector('#authForm');
    if (authForm) {
      authForm.addEventListener('submit', (e) => this.handleAuthSubmit(e));
    }

    // Forgot form submission
    const forgotForm = this.container.querySelector('#forgotForm');
    if (forgotForm) {
      forgotForm.addEventListener('submit', (e) => this.handleForgotSubmit(e));
    }

    // Mode switching links
    this.container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleAction(e));
    });

    // OAuth buttons
    this.container.querySelectorAll('[data-provider]').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleOAuth(e));
    });
  }

  /**
   * Handle auth form submission
   */
  async handleAuthSubmit(e) {
    e.preventDefault();

    const email = this.container.querySelector('#authEmail').value.trim();
    const password = this.container.querySelector('#authPassword').value;
    const submitBtn = this.container.querySelector('#authSubmitBtn');

    // Validate
    if (!email || !password) {
      this.showError('Please fill in all fields');
      return;
    }

    if (this.mode === 'signup') {
      const confirmPassword = this.container.querySelector('#authPasswordConfirm').value;
      if (password !== confirmPassword) {
        this.showError('Passwords do not match');
        return;
      }
    }

    // Disable button
    submitBtn.disabled = true;
    submitBtn.textContent = this.mode === 'login' ? 'Signing in...' : 'Creating account...';

    try {
      let result;
      if (this.mode === 'login') {
        result = await this.cloud.signIn(email, password);
      } else {
        result = await this.cloud.signUp(email, password);
      }

      if (result.success) {
        if (result.needsConfirmation) {
          this.showSuccess('Check your email to confirm your account!');
        } else {
          // Auth successful, UI will re-render automatically
        }
      } else {
        this.showError(result.error);
      }
    } catch (error) {
      this.showError(error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = this.mode === 'login' ? 'Sign In' : 'Create Account';
    }
  }

  /**
   * Handle forgot password form
   */
  async handleForgotSubmit(e) {
    e.preventDefault();

    const email = this.container.querySelector('#forgotEmail').value.trim();
    const submitBtn = this.container.querySelector('button[type="submit"]');

    if (!email) {
      this.showError('Please enter your email');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
      const result = await this.cloud.signInWithMagicLink(email);
      if (result.success) {
        this.showSuccess('Check your email for the reset link!');
      } else {
        this.showError(result.error);
      }
    } catch (error) {
      this.showError(error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Reset Link';
    }
  }

  /**
   * Handle OAuth provider login
   */
  async handleOAuth(e) {
    const provider = e.target.closest('[data-provider]').dataset.provider;
    
    try {
      const result = await this.cloud.signInWithOAuth(provider);
      if (!result.success) {
        this.showError(result.error);
      }
    } catch (error) {
      this.showError(error.message);
    }
  }

  /**
   * Handle button actions
   */
  async handleAction(e) {
    const action = e.target.closest('[data-action]').dataset.action;
    const plan = e.target.closest('[data-plan]')?.dataset.plan;

    switch (action) {
      case 'showLogin':
        this.mode = 'login';
        this.render();
        break;

      case 'showSignup':
        this.mode = 'signup';
        this.render();
        break;

      case 'showForgot':
        this.mode = 'forgot';
        this.render();
        break;

      case 'signOut':
        await this.cloud.signOut();
        break;

      case 'syncNow':
        // This should be handled by the parent component
        if (this.onSyncRequest) {
          this.onSyncRequest();
        }
        break;

      case 'pullFromCloud':
        // This should be handled by the parent component
        if (this.onPullRequest) {
          this.onPullRequest();
        }
        break;
    }
  }

  /**
   * Show error message
   */
  showError(message) {
    const errorEl = this.container.querySelector('#authError');
    const successEl = this.container.querySelector('#authSuccess');
    
    if (successEl) successEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }

  /**
   * Show success message
   */
  showSuccess(message) {
    const errorEl = this.container.querySelector('#authError');
    const successEl = this.container.querySelector('#authSuccess');
    
    if (errorEl) errorEl.style.display = 'none';
    if (successEl) {
      successEl.textContent = message;
      successEl.style.display = 'block';
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AuthUI };
}
