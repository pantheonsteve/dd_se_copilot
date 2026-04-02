// API client for the se-copilot Demo Planner backend

class DemoPlanService {
  constructor() {
    this.baseUrl = 'http://localhost:5070';
    this._loadBaseUrl();
  }

  async _loadBaseUrl() {
    try {
      const result = await chrome.storage.local.get(['seCopilotUrl']);
      if (result.seCopilotUrl) {
        this.baseUrl = result.seCopilotUrl.replace(/\/+$/, '');
      }
    } catch (e) {
      console.warn('[DemoPlanService] Could not load base URL from settings:', e);
    }
  }

  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`API ${options.method || 'GET'} ${path} failed (${resp.status}): ${text}`);
    }
    return resp.json();
  }

  async listPlans() {
    return this._fetch('/api/demo-plans');
  }

  async getPlan(planId) {
    return this._fetch(`/api/demo-plans/${encodeURIComponent(planId)}`);
  }

  async getLoops(planId) {
    return this._fetch(`/api/demo-plans/${encodeURIComponent(planId)}/loops`);
  }

  async updateLoop(planId, loopId, fields) {
    return this._fetch(
      `/api/demo-plans/${encodeURIComponent(planId)}/loops/${encodeURIComponent(loopId)}`,
      { method: 'PATCH', body: JSON.stringify(fields) }
    );
  }

  async reparseLoops(planId) {
    return this._fetch(
      `/api/demo-plans/${encodeURIComponent(planId)}/reparse`,
      { method: 'POST' }
    );
  }

  async checkConnection() {
    try {
      await this._fetch('/api/health');
      return true;
    } catch {
      return false;
    }
  }
}
