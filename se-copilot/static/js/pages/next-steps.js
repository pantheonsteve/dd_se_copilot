/**
 * Next Steps Agent page — generate and view deal advancement plans.
 */
window.nextStepsPage = (function () {
  let _initialized = false;
  let _current = null;
  let _saved = [];

  const STAGE_LABELS = {
    prospecting:           { label: 'Prospecting',          color: 'var(--text-muted)' },
    discovery:             { label: 'Discovery',             color: 'var(--blue)' },
    demo_complete:         { label: 'Demo Complete',         color: 'var(--brand)' },
    active_evaluation:     { label: 'Active Evaluation',     color: 'var(--amber)' },
    evaluation:            { label: 'Evaluation / POC',      color: 'var(--amber)' },
    expansion_or_renewal:  { label: 'Expansion / Renewal',   color: 'var(--green)' },
    unknown:               { label: 'Unknown',               color: 'var(--text-muted)' },
  };

  const CATEGORY_ICONS = {
    Discovery:    '🔍',
    Technical:    '🔧',
    Commercial:   '💰',
    Relationship: '🤝',
    Internal:     '📋',
  };

  const OWNER_COLORS = {
    SE:         'var(--brand)',
    AE:         'var(--blue)',
    'SE + AE':  'var(--amber)',
    Prospect:   'var(--green)',
  };

  const TIMEFRAME_ORDER = {
    Today: 0,
    'This week': 1,
    'Before next call': 2,
    'Within 2 weeks': 3,
  };

  // -------------------------------------------------------------------------
  // Render shell
  // -------------------------------------------------------------------------

  function render() {
    const el = document.getElementById('page-next-steps');
    el.innerHTML = `
      <div class="demo-layout" id="nsLayout" style="align-items:flex-start;">

        <!-- Sidebar: saved plans -->
        <div class="plans-sidebar">
          <div class="card">
            <p class="section-title">Saved Plans</p>
            <div id="nsSavedList"><span class="empty">Loading…</span></div>
          </div>
        </div>

        <!-- Main column -->
        <div>
          <!-- Input form -->
          <div class="card" id="nsFormCard">
            <h2 class="card-heading">Next Steps Agent</h2>
            <p class="card-subtext">Generate a prioritized, time-boxed action plan for any deal by pulling all available artifacts for that company.</p>
            <div class="form-row" style="margin-top:1rem;">
              <div class="field grow">
                <label for="nsCompany">Company Name <span class="required">*</span></label>
                <input type="text" id="nsCompany" class="input" placeholder="e.g. Acme Corp" autocomplete="off">
              </div>
              <div class="field" style="min-width:200px;">
                <label for="nsStageOverride">Deal Stage Override <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>
                <select id="nsStageOverride" class="input">
                  <option value="">Auto-detect from artifacts</option>
                  <option value="prospecting">Prospecting</option>
                  <option value="discovery">Discovery</option>
                  <option value="demo_complete">Demo Complete</option>
                  <option value="active_evaluation">Active Evaluation</option>
                  <option value="evaluation">Evaluation / POC</option>
                  <option value="expansion_or_renewal">Expansion / Renewal</option>
                </select>
              </div>
            </div>
            <div class="form-row" style="margin-top:.75rem;">
              <div class="field grow">
                <label for="nsContext">Additional Context <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(anything the SE wants Claude to know about this deal)</span></label>
                <textarea id="nsContext" class="input" rows="3" placeholder="e.g. We just had a good exec briefing but need to identify a technical champion. Procurement process is long…"></textarea>
              </div>
            </div>
            <div class="form-actions" style="margin-top:1rem;">
              <button class="btn btn-primary" id="nsGenBtn">Generate Next Steps</button>
            </div>
            <div id="nsFormError" style="display:none;margin-top:.5rem;color:var(--danger);font-size:.82rem;font-weight:600;"></div>
          </div>

          <!-- Loading -->
          <div class="card" id="nsLoadingCard" style="display:none;">
            <div class="hyp-progress">
              <div class="hyp-step active" id="nsLoadStep">
                <span class="hyp-step-icon"><span class="spinner"></span></span>
                <span class="hyp-step-label">Gathering all artifacts for this company…</span>
              </div>
            </div>
          </div>

          <!-- Results -->
          <div id="nsResults" style="display:none;"></div>
        </div>
      </div>
    `;

    document.getElementById('nsGenBtn').addEventListener('click', generate);
    document.getElementById('nsCompany').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') generate();
    });
  }

  // -------------------------------------------------------------------------
  // Generate
  // -------------------------------------------------------------------------

  async function generate() {
    const company = document.getElementById('nsCompany').value.trim();
    if (!company) {
      showError('Company name is required.');
      return;
    }

    const stageOverride = document.getElementById('nsStageOverride').value || null;
    const context = document.getElementById('nsContext').value.trim() || null;

    hideError();
    showLoading('Gathering all artifacts for this company…');

    try {
      // Animate loading steps
      const steps = [
        'Loading hypothesis and research data…',
        'Reading call notes and discovery insights…',
        'Analyzing expansion playbook and demo plans…',
        'Synthesizing prioritized next steps…',
      ];
      let stepIdx = 0;
      const stepInterval = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, steps.length - 1);
        const el = document.getElementById('nsLoadStep');
        if (el) el.querySelector('.hyp-step-label').textContent = steps[stepIdx];
      }, 2500);

      const resp = await API.generateNextSteps({
        company_name: company,
        deal_stage_override: stageOverride,
        additional_context: context,
      });

      clearInterval(stepInterval);
      _current = resp;
      showResults(resp);
      loadSavedList();
    } catch (err) {
      showError('Failed to generate next steps: ' + err.message);
      hideLoading();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  function stageBadge(stage, confidence) {
    const info = STAGE_LABELS[stage] || STAGE_LABELS.unknown;
    const confColor = confidence === 'high' ? 'var(--green)' : confidence === 'medium' ? 'var(--amber)' : 'var(--text-muted)';
    return '<span class="badge" style="background:' + info.color + '20;color:' + info.color + '">' + info.label + '</span>' +
      '<span class="badge time" style="color:' + confColor + '">' + confidence + ' confidence</span>';
  }

  function priorityBadge(priority) {
    if (priority === 1) return '<span class="hyp-pri-badge hyp-pri-high">P1</span>';
    if (priority === 2) return '<span class="hyp-pri-badge hyp-pri-med">P2</span>';
    return '<span class="hyp-pri-badge" style="background:var(--bg-secondary);color:var(--text-muted)">P' + priority + '</span>';
  }

  function ownerBadge(owner) {
    const color = OWNER_COLORS[owner] || 'var(--text-muted)';
    return '<span class="badge" style="background:' + color + '20;color:' + color + ';font-size:.72rem">' + MD.escapeHtml(owner) + '</span>';
  }

  function timeframeBadge(timeframe) {
    const isUrgent = timeframe === 'Today';
    const style = isUrgent
      ? 'background:#fee2e2;color:var(--red);font-weight:700'
      : 'background:var(--bg);color:var(--text-muted)';
    return '<span class="badge" style="' + style + ';font-size:.72rem">' + MD.escapeHtml(timeframe) + '</span>';
  }

  function showResults(resp) {
    hideLoading();
    document.getElementById('nsFormCard').style.display = 'none';

    const steps = (resp.next_steps || []).slice().sort((a, b) => a.priority - b.priority);
    const risks = resp.blocking_risks || [];
    const missing = resp.missing_artifacts || [];
    const processSec = resp.processing_time_ms ? (resp.processing_time_ms / 1000).toFixed(1) : null;

    // Group steps by timeframe for grouped view
    const groups = {};
    steps.forEach(s => {
      const tf = s.timeframe || 'Within 2 weeks';
      if (!groups[tf]) groups[tf] = [];
      groups[tf].push(s);
    });
    const tfOrder = Object.keys(groups).sort((a, b) =>
      (TIMEFRAME_ORDER[a] ?? 99) - (TIMEFRAME_ORDER[b] ?? 99)
    );

    const stepsHtml = tfOrder.map(tf => {
      const groupSteps = groups[tf];
      const items = groupSteps.map(s => {
        const icon = CATEGORY_ICONS[s.category] || '📌';
        return `
          <div class="ns-step-card">
            <div class="ns-step-header">
              ${priorityBadge(s.priority)}
              <span class="ns-step-category">${icon} ${MD.escapeHtml(s.category)}</span>
              ${ownerBadge(s.owner)}
              ${timeframeBadge(s.timeframe)}
              <span class="ns-step-source">via ${MD.escapeHtml(s.artifact_source || 'context')}</span>
            </div>
            <p class="ns-step-action">${MD.escapeHtml(s.action)}</p>
            <p class="ns-step-rationale">${MD.escapeHtml(s.rationale)}</p>
          </div>
        `;
      }).join('');
      return `
        <div class="ns-group">
          <div class="ns-group-label">${MD.escapeHtml(tf)}</div>
          ${items}
        </div>
      `;
    }).join('');

    const risksHtml = risks.length
      ? risks.map(r => `<div class="ns-risk-item">⚠️ ${MD.escapeHtml(r)}</div>`).join('')
      : '<div class="empty">No blocking risks identified.</div>';

    const missingHtml = missing.length
      ? missing.map(m => `<div class="ns-missing-item">📋 ${MD.escapeHtml(m)}</div>`).join('')
      : '';

    document.getElementById('nsResults').innerHTML = `
      <div class="res-title-bar">
        <div class="res-title-row">
          <h2 class="res-report-title">Next Steps: ${MD.escapeHtml(resp.company_name)}</h2>
          <div class="res-title-actions">
            <button class="btn btn-sm" onclick="window.nextStepsPage.showForm()">+ New Plan</button>
            <button class="btn btn-sm" onclick="window.nextStepsPage.refreshCurrent()" id="nsRefreshBtn">Refresh</button>
            <button class="btn btn-sm" onclick="window.nextStepsPage.copyMarkdown()">Copy MD</button>
          </div>
        </div>
        <div class="meta-bar" style="margin-top:.4rem;">
          ${stageBadge(resp.inferred_deal_stage, resp.deal_stage_confidence)}
          <span class="text-muted">${steps.length} action${steps.length !== 1 ? 's' : ''}</span>
          ${processSec ? `<span class="badge time">${processSec}s</span>` : ''}
        </div>
      </div>

      <!-- North star -->
      <div class="card ns-focus-card">
        <div class="ns-focus-label">🎯 Recommended Focus</div>
        <p class="ns-focus-text">${MD.escapeHtml(resp.recommended_focus || 'No focus recommendation generated.')}</p>
      </div>

      ${resp.close_timeline && resp.close_timeline.summary ? `
      <div class="card ns-focus-card" style="border-color:#0ea5e9;background:#f0f9ff;">
        <div class="ns-focus-label">📅 Close timeline <span class="badge" style="margin-left:.35rem">${MD.escapeHtml((resp.close_timeline.confidence || 'low'))}</span></div>
        <p class="ns-focus-text">${MD.escapeHtml(resp.close_timeline.summary)}</p>
        ${(resp.close_timeline.evidence || []).length ? `<ul style="margin:.5rem 0 0 1rem;font-size:.82rem;color:var(--text-muted);line-height:1.45;">${(resp.close_timeline.evidence || []).map(e => `<li>${MD.escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}

      <!-- Steps -->
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:1rem 1.25rem .5rem;border-bottom:1px solid var(--border);">
          <h3 style="margin:0;font-size:.9rem;font-weight:700;">Action Plan</h3>
        </div>
        <div style="padding:.75rem 1rem;">
          ${stepsHtml || '<div class="empty">No steps generated.</div>'}
        </div>
      </div>

      ${risks.length ? `
      <div class="card">
        <h3 style="margin:0 0 .75rem;font-size:.9rem;font-weight:700;color:var(--danger)">Blocking Risks</h3>
        ${risksHtml}
      </div>` : ''}

      ${missing.length ? `
      <div class="card">
        <h3 style="margin:0 0 .75rem;font-size:.9rem;font-weight:700;color:var(--text-muted)">Missing Artifacts</h3>
        ${missingHtml}
      </div>` : ''}
    `;

    document.getElementById('nsResults').style.display = '';
  }

  // -------------------------------------------------------------------------
  // Saved list
  // -------------------------------------------------------------------------

  async function loadSavedList() {
    const el = document.getElementById('nsSavedList');
    if (!el) return;
    try {
      const items = await API.listNextSteps();
      _saved = items || [];
      if (!items.length) {
        el.innerHTML = '<span class="empty">No saved plans</span>';
        return;
      }
      el.innerHTML = items.map(item => {
        const info = STAGE_LABELS[item.inferred_deal_stage] || STAGE_LABELS.unknown;
        return `
          <div class="plan-item" data-id="${item.id}">
            <div class="plan-item-main" onclick="window.nextStepsPage.loadPlan('${item.id}')">
              <span class="plan-item-title">${MD.escapeHtml(item.company_name)}</span>
              <span class="plan-item-meta">
                ${MD.formatDate(item.created_at)} &middot;
                <span style="color:${info.color}">${info.label}</span> &middot;
                ${item.total_steps || 0} steps
              </span>
            </div>
            <button class="plan-item-del" onclick="event.stopPropagation();window.nextStepsPage.deletePlan('${item.id}')" title="Delete">&times;</button>
          </div>
        `;
      }).join('');
    } catch {
      el.innerHTML = '<span class="empty">Failed to load</span>';
    }
  }

  async function loadPlan(id) {
    try {
      const data = await API.getNextSteps(id);
      if (data.error) return;
      // Reconstruct next_steps as objects with expected fields
      _current = data;
      showResults(data);
    } catch { /* ignore */ }
  }

  async function deletePlan(id) {
    if (!confirm('Delete this next steps plan?')) return;
    try {
      await API.deleteNextSteps(id);
      if (_current && _current.id === id) showForm();
      loadSavedList();
    } catch { /* ignore */ }
  }

  async function refreshCurrent() {
    if (!_current || !_current.id) return;
    const btn = document.getElementById('nsRefreshBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    showLoading('Re-gathering artifacts and regenerating…');
    document.getElementById('nsResults').style.display = 'none';
    try {
      const data = await API.refreshNextSteps(_current.id);
      _current = data;
      showResults(data);
      loadSavedList();
    } catch (err) {
      showError('Refresh failed: ' + err.message);
      hideLoading();
    }
  }

  function copyMarkdown() {
    if (!_current) return;
    const resp = _current;
    const steps = (resp.next_steps || []).slice().sort((a, b) => a.priority - b.priority);
    let md = `# Next Steps: ${resp.company_name}\n\n`;
    md += `**Deal Stage:** ${resp.inferred_deal_stage} (${resp.deal_stage_confidence} confidence)\n`;
    md += `**Focus:** ${resp.recommended_focus}\n\n`;
    md += `## Action Plan\n\n`;
    steps.forEach(s => {
      md += `### P${s.priority} — ${s.action}\n`;
      md += `- **Owner:** ${s.owner} | **Timeframe:** ${s.timeframe} | **Category:** ${s.category}\n`;
      md += `- ${s.rationale}\n`;
      md += `- _Source: ${s.artifact_source}_\n\n`;
    });
    if (resp.blocking_risks && resp.blocking_risks.length) {
      md += `## Blocking Risks\n\n`;
      resp.blocking_risks.forEach(r => { md += `- ⚠️ ${r}\n`; });
      md += '\n';
    }
    if (resp.missing_artifacts && resp.missing_artifacts.length) {
      md += `## Missing Artifacts\n\n`;
      resp.missing_artifacts.forEach(m => { md += `- 📋 ${m}\n`; });
    }
    navigator.clipboard.writeText(md).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

  function showLoading(msg) {
    document.getElementById('nsLoadingCard').style.display = '';
    const step = document.getElementById('nsLoadStep');
    if (step) step.querySelector('.hyp-step-label').textContent = msg || 'Working…';
  }

  function hideLoading() {
    document.getElementById('nsLoadingCard').style.display = 'none';
  }

  function showError(msg) {
    const el = document.getElementById('nsFormError');
    if (el) { el.textContent = msg; el.style.display = ''; }
    hideLoading();
  }

  function hideError() {
    const el = document.getElementById('nsFormError');
    if (el) el.style.display = 'none';
  }

  function showForm() {
    document.getElementById('nsFormCard').style.display = '';
    document.getElementById('nsLoadingCard').style.display = 'none';
    document.getElementById('nsResults').style.display = 'none';
    _current = null;
  }

  // -------------------------------------------------------------------------
  // Public API — for use from companies.js
  // -------------------------------------------------------------------------

  function prefill(companyName) {
    showForm();
    const input = document.getElementById('nsCompany');
    if (input) { input.value = companyName; input.focus(); }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function injectBreadcrumb() {
    var container = document.getElementById("page-next-steps");
    var existing = container.querySelector(".company-breadcrumb");
    if (existing) existing.remove();
    var html = window.renderCompanyBreadcrumb ? window.renderCompanyBreadcrumb("Next Steps") : "";
    if (html) container.insertAdjacentHTML("afterbegin", html);
  }

  return {
    init() {
      if (!_initialized) {
        render();
        _initialized = true;
      }
      injectBreadcrumb();
      loadSavedList();
      // Check sessionStorage prefill (from companies page quick action)
      try {
        const pre = sessionStorage.getItem('nextsteps_prefill_company');
        if (pre) {
          sessionStorage.removeItem('nextsteps_prefill_company');
          prefill(pre);
        }
      } catch { /* ignore */ }
    },
    showForm,
    loadPlan,
    deletePlan,
    refreshCurrent,
    copyMarkdown,
    prefill,
  };
})();
