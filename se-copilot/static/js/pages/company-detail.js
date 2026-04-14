/**
 * Company Detail — executive-quality landing page for a single company.
 */
window.companyDetailPage = (function () {
  var _data = null;
  var _key = null;
  var _snapshot = null;
  var _snapshotLoading = false;
  var _chatState = { conversationId: null, sending: false, conversations: [] };
  var _activeTab = 'snapshot';
  var _chatExpanded = false;
  var _chatLoaded = false;
  var _nextStepsLoading = false;

  // -----------------------------------------------------------------------
  // Entry point
  // -----------------------------------------------------------------------

  function init(companyKey) {
    _key = companyKey;
    _data = null;
    _snapshot = null;
    _snapshotLoading = false;
    _nextStepsLoading = false;
    _activeTab = 'snapshot';
    _chatExpanded = false;
    _chatLoaded = false;
    _chatState = { conversationId: null, sending: false, conversations: [] };
    renderShell();
    load();
  }

  function renderShell() {
    var el = document.getElementById("page-companies");
    el.innerHTML =
      '<div class="cd-page">' +
        '<div class="cd-header">' +
          '<div class="cd-breadcrumb">' +
            '<a href="#companies" class="cd-back-link" onclick="event.preventDefault();companiesPage.showList();">Companies</a>' +
            ' <span class="cd-bc-sep">/</span> ' +
            '<span class="cd-bc-current" id="cdCompanyName">Loading\u2026</span>' +
          '</div>' +
        '</div>' +
        '<div class="cd-body">' +
          '<div class="cd-loading"><span class="spinner"></span> Loading company data\u2026</div>' +
        '</div>' +
      '</div>';
  }

  function artifactCount() {
    return (_data && _data.stats && _data.stats.total_artifacts) || 0;
  }

  function shouldAutoGenerateNextSteps() {
    if (artifactCount() === 0) return false;
    var ns = _data.next_steps;
    if (!ns) return true;
    var latest = _data.stats && _data.stats.latest_activity;
    if (latest && ns.created_at && latest > ns.created_at) return true;
    return false;
  }

  async function runNextStepsAutoGeneration() {
    try {
      var payload = { company_name: _data.company.name };
      if (_data.company.id) payload.company_id = _data.company.id;
      await API.generateNextSteps(payload);
      _data = await API.getCompanyProfile(_key);
    } catch (e) {
      console.error("Next steps auto-generation failed:", e);
    } finally {
      _nextStepsLoading = false;
      patchNextStepsRegion();
    }
  }

  function patchNextStepsRegion() {
    var mount = document.getElementById("cdNextStepsRegion");
    if (mount) mount.innerHTML = renderNextStepsBlock();
    var panel = document.querySelector('.cd-tab-panel[data-panel="next_steps"]');
    if (panel) panel.innerHTML = renderNextStepsTabContent();
  }

  async function load() {
    try {
      _data = await API.getCompanyProfile(_key);
      _nextStepsLoading = shouldAutoGenerateNextSteps();
      renderPage();
      loadSnapshot();
      loadSlack();
      if (_nextStepsLoading) {
        runNextStepsAutoGeneration();
      }
    } catch (e) {
      document.querySelector(".cd-body").innerHTML =
        '<div class="cd-error">Failed to load company: ' + MD.escapeHtml(e.message) + '</div>';
    }
  }

  // -----------------------------------------------------------------------
  // Full page render
  // -----------------------------------------------------------------------

  function renderPage() {
    var c = _data.company;
    var stats = _data.stats;

    document.getElementById("cdCompanyName").textContent = c.name;

    var typeBadge = c.is_defined
      ? '<span class="cd-badge cd-badge-defined">Defined</span>'
      : '<span class="cd-badge cd-badge-discovered">Auto-discovered</span>';

    var domainLink = c.domain
      ? '<a href="https://' + MD.escapeHtml(c.domain) + '" target="_blank" class="cd-domain">' + MD.escapeHtml(c.domain) + '</a>'
      : '';

    var headerActions = '';
    if (c.is_defined) {
      headerActions =
        '<div class="cd-header-actions">' +
          '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.editCompany()">Edit</button>' +
          '<button class="btn btn-sm btn-outline cd-btn-danger" onclick="companyDetailPage.deleteCompany()">Delete</button>' +
        '</div>';
    }

    var el = document.querySelector(".cd-page");
    el.innerHTML =
      '<div class="cd-header">' +
        '<div class="cd-breadcrumb">' +
          '<a href="#companies" class="cd-back-link" onclick="event.preventDefault();companiesPage.showList();">Companies</a>' +
          ' <span class="cd-bc-sep">/</span> ' +
          '<span class="cd-bc-current">' + MD.escapeHtml(c.name) + '</span>' +
        '</div>' +
        '<div class="cd-title-row">' +
          '<h1 class="cd-title">' + MD.escapeHtml(c.name) + '</h1>' +
          typeBadge + domainLink +
          '<span class="cd-health-inline" id="cdHealthInline"></span>' +
          headerActions +
        '</div>' +
      '</div>' +
      renderInlineChatBar() +
      '<div class="cd-body">' +
        '<div class="cd-col-left">' +
          renderTabsSection() +
        '</div>' +
        '<div class="cd-col-right">' +
          renderOverviewCard(c, stats) +
          renderQuickActions() +
          '<div id="cdNextStepsRegion">' + renderNextStepsBlock() + '</div>' +
          '<div class="cd-section cd-slack-section">' +
            '<div class="cd-section-header">' +
              '<h2>Slack Context</h2>' +
              (c.is_defined ? '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.toggleSlackForm()">+ Add</button>' : '') +
            '</div>' +
            '<div class="cd-section-body" id="cdSlackList"><div class="cd-loading-inline"><span class="spinner"></span> Loading\u2026</div></div>' +
            '<div id="cdSlackForm" style="display:none;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // -----------------------------------------------------------------------
  // Overview card (right column)
  // -----------------------------------------------------------------------

  function renderOverviewCard(c, stats) {
    var pct = Math.round((stats.completeness / stats.completeness_max) * 100);

    var detailRows = '';
    if (c.domain) {
      detailRows += '<div class="cd-overview-row"><span class="cd-overview-label">Domain</span><span>' + MD.escapeHtml(c.domain) + '</span></div>';
    }
    if (c.notes) {
      detailRows += '<div class="cd-overview-row"><span class="cd-overview-label">Notes</span><span>' + MD.escapeHtml(c.notes) + '</span></div>';
    }
    if (c.created_at) {
      detailRows += '<div class="cd-overview-row"><span class="cd-overview-label">Created</span><span>' + MD.formatDate(c.created_at) + '</span></div>';
    }
    if (stats.latest_activity) {
      detailRows += '<div class="cd-overview-row"><span class="cd-overview-label">Last Activity</span><span>' + MD.timeAgo(stats.latest_activity) + '</span></div>';
    }

    var countTags = '';
    var tagMap = [
      { key: "hypotheses", label: "Hypothesis", cls: "tag-hypothesis" },
      { key: "reports", label: "Strategy", cls: "tag-report" },
      { key: "demo_plans", label: "Demo Plan", cls: "tag-demo" },
      { key: "call_notes", label: "Call Notes", cls: "tag-call-note" },
      { key: "expansion_playbooks", label: "Expansion", cls: "tag-expansion" },
      { key: "precall_briefs", label: "Pre-Call", cls: "tag-precall" },
      { key: "release_digests", label: "Digests", cls: "tag-digest" },
    ];
    tagMap.forEach(function (t) {
      var count = stats.counts[t.key] || 0;
      if (count > 0) {
        countTags += '<span class="artifact-tag ' + t.cls + '">' + t.label + ' <span class="artifact-count">' + count + '</span></span> ';
      }
    });

    return (
      '<div class="cd-section cd-overview-card">' +
        '<div class="cd-overview-accent"></div>' +
        '<div class="cd-section-header"><h2>Overview</h2></div>' +
        '<div class="cd-section-body">' +
          detailRows +
          '<div class="cd-completeness">' +
            '<div class="cd-completeness-top"><span class="cd-completeness-label">Artifact Completeness</span><span class="cd-completeness-pct">' + pct + '%</span></div>' +
            '<div class="completeness-bar cd-completeness-bar-wide"><div class="completeness-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="cd-completeness-text">' + stats.completeness + '/' + stats.completeness_max + ' core artifacts &middot; ' + stats.total_artifacts + ' total</div>' +
          '</div>' +
          '<div class="cd-artifact-tags">' + countTags + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // -----------------------------------------------------------------------
  // Tabbed artifact sections (left column)
  // -----------------------------------------------------------------------

  function renderTabsSection() {
    var c = _data.company;
    var tabs = [
      { id: 'snapshot', label: 'Deal Snapshot', alwaysShow: true },
      { id: 'notes', label: 'Notes', count: (_data.notes_list || []).length, alwaysShow: true },
      { id: 'call_notes', label: 'Call Notes', count: (_data.call_notes || []).length, alwaysShow: true },
      { id: 'digests', label: 'Digests', count: (_data.release_digests || []).length, alwaysShow: true },
      { id: 'hypotheses', label: 'Hypotheses', count: (_data.hypotheses || []).length },
      { id: 'reports', label: 'Strategy', count: (_data.reports || []).length },
      { id: 'demo_plans', label: 'Demo Plans', count: (_data.demo_plans || []).length },
      { id: 'precall', label: 'Pre-Call', count: (_data.precall_briefs || []).length },
      { id: 'next_steps', label: 'Next Steps', count: _data.next_steps ? 1 : 0 },
      { id: 'expansion', label: 'Expansion', count: (_data.expansion_playbooks || []).length },
    ];

    var visibleTabs = tabs.filter(function (t) { return t.alwaysShow || t.count > 0; });
    if (!visibleTabs.length) return '';

    _activeTab = 'snapshot';

    var tabBar = visibleTabs.map(function (t) {
      var active = t.id === _activeTab ? ' cd-tab-active' : '';
      var badge = t.count > 0 ? '<span class="cd-tab-count">' + t.count + '</span>' : '';
      return '<button class="cd-tab' + active + '" data-tab="' + t.id + '" onclick="companyDetailPage.switchTab(\'' + t.id + '\')">' + t.label + badge + '</button>';
    }).join('');

    var contentMap = {
      snapshot: '<div id="cdSnapshotBody"><div class="cd-loading-inline"><span class="spinner"></span> Loading deal snapshot\u2026</div></div>',
      notes: renderNotesTabContent(),
      hypotheses: renderHypothesesTabContent(),
      reports: renderReportsTabContent(),
      demo_plans: renderDemoPlansTabContent(),
      call_notes: renderCallNotesTabContent(),
      precall: renderPreCallTabContent(),
      expansion: renderExpansionTabContent(),
      digests: renderDigestsTabContent(),
      next_steps: renderNextStepsTabContent(),
    };

    var panels = visibleTabs.map(function (t) {
      var active = t.id === _activeTab ? ' cd-tab-panel-active' : '';
      return '<div class="cd-tab-panel' + active + '" data-panel="' + t.id + '">' + (contentMap[t.id] || '') + '</div>';
    }).join('');

    return (
      '<div class="cd-section cd-tabs-section">' +
        '<div class="cd-tabs-bar">' + tabBar + '</div>' +
        '<div class="cd-tabs-body">' + panels + '</div>' +
      '</div>'
    );
  }

  function switchTab(tabId) {
    if (_savedTabContent[_activeTab]) closeInlineArtifact(_activeTab);
    _activeTab = tabId;
    var allTabs = document.querySelectorAll('.cd-tab');
    var allPanels = document.querySelectorAll('.cd-tab-panel');
    for (var i = 0; i < allTabs.length; i++) {
      if (allTabs[i].getAttribute('data-tab') === tabId) {
        allTabs[i].classList.add('cd-tab-active');
      } else {
        allTabs[i].classList.remove('cd-tab-active');
      }
    }
    for (var j = 0; j < allPanels.length; j++) {
      if (allPanels[j].getAttribute('data-panel') === tabId) {
        allPanels[j].classList.add('cd-tab-panel-active');
      } else {
        allPanels[j].classList.remove('cd-tab-panel-active');
      }
    }
  }

  // -- Tab content renderers ------------------------------------------------

  function renderNoteDate(n) {
    var dateVal = n.note_date || (n.created_at || '').substring(0, 10);
    var c = _data.company;
    if (c.is_defined) {
      return '<input type="date" class="cd-note-date-input" value="' + MD.escapeHtml(dateVal) + '" ' +
        'onclick="event.stopPropagation();" ' +
        'onchange="companyDetailPage.updateNoteDate(\'' + n.id + '\', this.value)">';
    }
    return '<span class="artifact-row-date">' + MD.escapeHtml(dateVal) + '</span>';
  }

  function renderNotesTabContent() {
    var c = _data.company;
    var notes = _data.notes_list || [];

    var addBtn = c.is_defined
      ? '<div class="cd-tab-actions"><button class="btn btn-sm btn-outline" onclick="companyDetailPage.toggleNoteForm()">+ Add Note</button></div>'
      : '';

    var rows = '';
    if (!notes.length) {
      rows = '<div class="cd-empty">No notes yet' + (c.is_defined ? ' \u2014 add context about this company.' : '') + '</div>';
    } else {
      rows = notes.map(function (n) {
        var preview = (n.content || '').substring(0, 200).replace(/\n/g, ' ') + (n.content && n.content.length > 200 ? '\u2026' : '');
        var deleteBtn = c.is_defined
          ? '<button class="btn btn-sm cd-note-delete" title="Delete" onclick="event.stopPropagation();companyDetailPage.deleteNote(\'' + n.id + '\')">&times;</button>'
          : '';
        return (
          '<div class="cd-artifact-row cd-note-row" onclick="companyDetailPage.toggleNoteExpand(this,\'' + n.id + '\')">' +
            '<div class="cd-artifact-row-header">' +
              '<span class="artifact-row-icon" style="background:var(--accent-light,#eef);color:var(--accent,#4361ee);">&#x1F4DD;</span>' +
              '<span class="cd-artifact-row-title">' + MD.escapeHtml(n.title) + '</span>' +
              renderNoteDate(n) +
              deleteBtn +
            '</div>' +
            '<p class="cd-artifact-preview cd-note-preview">' + MD.escapeHtml(preview) + '</p>' +
            '<div class="cd-note-expanded" style="display:none;"></div>' +
          '</div>'
        );
      }).join('');
    }

    return addBtn +
      '<div id="cdNoteForm" style="display:none;"></div>' +
      '<div id="cdNotesList">' + rows + '</div>';
  }

  function renderHypothesesTabContent() {
    var items = _data.hypotheses || [];
    if (!items.length) return '<div class="cd-empty">No hypotheses yet.</div>';
    return items.map(function (h) {
      var badge = h.confidence_level
        ? ' <span class="badge conf-' + h.confidence_level + '">' + h.confidence_level + '</span>'
        : '';
      var pubBadge = h.is_public ? ' <span class="badge tag-report">Public</span>' : '';
      var preview = h.executive_summary
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(h.executive_summary.substring(0, 250) + (h.executive_summary.length > 250 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openHypothesis(\'' + h.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-hypothesis">&#x2B50;</span>' +
            '<span class="cd-artifact-row-title">Sales Hypothesis</span>' +
            badge + pubBadge +
            '<span class="artifact-row-date">' + MD.formatDate(h.created_at) + '</span>' +
          '</div>' +
          preview +
        '</div>'
      );
    }).join('');
  }

  function renderReportsTabContent() {
    var items = _data.reports || [];
    if (!items.length) return '<div class="cd-empty">No strategy reports yet.</div>';
    return items.map(function (r) {
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openReport(\'' + r.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-report">&#x1F4CA;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(r.title || 'Strategy Report') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(r.saved_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderDemoPlansTabContent() {
    var items = _data.demo_plans || [];
    if (!items.length) return '<div class="cd-empty">No demo plans yet.</div>';
    return items.map(function (p) {
      var meta = [p.persona, p.demo_mode].filter(Boolean).map(function (s) { return s.replace(/_/g, ' '); }).join(' \u2022 ');
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openDemoPlan(\'' + p.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-demo">&#x1F3AF;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(p.title || 'Demo Plan') + '</span>' +
            (meta ? '<span class="cd-artifact-meta">' + MD.escapeHtml(meta) + '</span>' : '') +
            '<span class="artifact-row-date">' + MD.formatDate(p.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderCallNotesTabContent() {
    var items = _data.call_notes || [];
    if (!items.length) return '<div class="cd-empty">No call notes yet.</div>';
    return items.map(function (cn) {
      var preview = cn.summary_preview
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(cn.summary_preview.substring(0, 200) + (cn.summary_preview.length > 200 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openCallNote(\'' + cn.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-call-note">&#x1F4DE;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(cn.title || 'Untitled Call Note') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(cn.created_at) + '</span>' +
          '</div>' +
          preview +
        '</div>'
      );
    }).join('');
  }

  function renderPreCallTabContent() {
    var items = _data.precall_briefs || [];
    if (!items.length) return '<div class="cd-empty">No pre-call briefs yet.</div>';
    var CALL_TYPE_LABELS = {
      discovery: 'Discovery', followup: 'Follow-Up',
      technical_deep_dive: 'Technical Deep Dive', exec_briefing: 'Exec Briefing',
      poc_kickoff: 'POC Kickoff', poc_review: 'POC Review',
      champion_checkin: 'Champion Check-In', commercial: 'Commercial',
    };
    return items.map(function (pb) {
      var ctLabel = CALL_TYPE_LABELS[pb.call_type] || pb.call_type || 'Brief';
      var northStar = pb.north_star
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(pb.north_star.substring(0, 150) + (pb.north_star.length > 150 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openPreCallBrief(\'' + pb.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon" style="background:#fef3c7;color:#d97706;">&#x1F4CB;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(ctLabel) + ' Brief</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(pb.created_at) + '</span>' +
          '</div>' +
          northStar +
        '</div>'
      );
    }).join('');
  }

  function renderNextStepsTabContent() {
    if (_nextStepsLoading) {
      return '<div class="cd-loading-inline"><span class="spinner"></span> Generating next steps\u2026</div>';
    }
    var ns = _data.next_steps;
    if (!ns) return '<div class="cd-empty">No next steps plan yet.</div>';
    var raw = (ns.recommended_focus || ns.summary_preview || '').trim();
    if (!raw && ns.next_steps && ns.next_steps.length) {
      raw = (ns.next_steps[0].action || '');
    }
    var preview = raw.substring(0, 220).replace(/\n/g, ' ');
    if (raw.length > 220) preview += '\u2026';
    return (
      '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openNextSteps(\'' + ns.id + '\')">' +
        '<div class="cd-artifact-row-header">' +
          '<span class="artifact-row-icon" style="background:#dbeafe;color:#3b82f6;">&#x1F4CB;</span>' +
          '<span class="cd-artifact-row-title">Next Steps Plan</span>' +
          '<span class="artifact-row-date">' + MD.formatDate(ns.created_at) + '</span>' +
        '</div>' +
        (preview ? '<p class="cd-artifact-preview">' + MD.escapeHtml(preview) + '</p>' : '') +
      '</div>'
    );
  }

  function renderExpansionTabContent() {
    var items = _data.expansion_playbooks || [];
    if (!items.length) return '<div class="cd-empty">No expansion playbooks yet.</div>';
    return items.map(function (e) {
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openExpansion(\'' + e.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-expansion">&#x1F680;</span>' +
            '<span class="cd-artifact-row-title">Expansion Playbook</span>' +
            '<span class="cd-artifact-meta">' + (e.total_opportunities || 0) + ' opportunities</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(e.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderDigestsTabContent() {
    var items = _data.release_digests || [];
    if (!items.length) return '<div class="cd-empty">No release digests yet.</div>';
    return items.map(function (d) {
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openDigest(\'' + d.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon" style="background:#eff6ff;color:#3b82f6;">&#x1F4E6;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(d.title || 'Release Digest') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(d.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  // -- Legacy section renderers (kept for compatibility) --------------------

  function renderHypothesesSection() {
    var items = _data.hypotheses || [];
    if (!items.length) return '';

    var rows = items.map(function (h) {
      var badge = h.confidence_level
        ? ' <span class="badge conf-' + h.confidence_level + '">' + h.confidence_level + '</span>'
        : '';
      var pubBadge = h.is_public ? ' <span class="badge tag-report">Public</span>' : '';
      var preview = h.executive_summary
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(h.executive_summary.substring(0, 250) + (h.executive_summary.length > 250 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openHypothesis(\'' + h.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-hypothesis">&#x2B50;</span>' +
            '<span class="cd-artifact-row-title">Sales Hypothesis</span>' +
            badge + pubBadge +
            '<span class="artifact-row-date">' + MD.formatDate(h.created_at) + '</span>' +
          '</div>' +
          preview +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Sales Hypotheses</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderReportsSection() {
    var items = _data.reports || [];
    if (!items.length) return '';

    var rows = items.map(function (r) {
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openReport(\'' + r.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-report">&#x1F4CA;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(r.title || 'Strategy Report') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(r.saved_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Strategic Overviews</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderDemoPlansSection() {
    var items = _data.demo_plans || [];
    if (!items.length) return '';

    var rows = items.map(function (p) {
      var meta = [p.persona, p.demo_mode].filter(Boolean).map(function (s) { return s.replace(/_/g, ' '); }).join(' \u2022 ');
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openDemoPlan(\'' + p.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-demo">&#x1F3AF;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(p.title || 'Demo Plan') + '</span>' +
            (meta ? '<span class="cd-artifact-meta">' + MD.escapeHtml(meta) + '</span>' : '') +
            '<span class="artifact-row-date">' + MD.formatDate(p.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Demo Plans</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderCallNotesSection() {
    var items = _data.call_notes || [];
    if (!items.length) return '';

    var rows = items.map(function (cn) {
      var preview = cn.summary_preview
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(cn.summary_preview.substring(0, 200) + (cn.summary_preview.length > 200 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openCallNote(\'' + cn.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-call-note">&#x1F4DE;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(cn.title || 'Untitled Call Note') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(cn.created_at) + '</span>' +
          '</div>' +
          preview +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Call Notes</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderExpansionSection() {
    var items = _data.expansion_playbooks || [];
    if (!items.length) return '';

    var rows = items.map(function (e) {
      return (
        '<div class="cd-artifact-row">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon tag-expansion">&#x1F680;</span>' +
            '<span class="cd-artifact-row-title">Expansion Playbook</span>' +
            '<span class="cd-artifact-meta">' + (e.total_opportunities || 0) + ' opportunities</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(e.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Expansion Playbooks</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderPreCallSection() {
    var items = _data.precall_briefs || [];
    if (!items.length) return '';

    var CALL_TYPE_LABELS = {
      discovery: 'Discovery', followup: 'Follow-Up',
      technical_deep_dive: 'Technical Deep Dive', exec_briefing: 'Exec Briefing',
      poc_kickoff: 'POC Kickoff', poc_review: 'POC Review',
      champion_checkin: 'Champion Check-In', commercial: 'Commercial',
    };

    var rows = items.map(function (pb) {
      var ctLabel = CALL_TYPE_LABELS[pb.call_type] || pb.call_type || 'Brief';
      var northStar = pb.north_star
        ? '<p class="cd-artifact-preview">' + MD.escapeHtml(pb.north_star.substring(0, 150) + (pb.north_star.length > 150 ? '\u2026' : '')) + '</p>'
        : '';
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openPreCallBrief(\'' + pb.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon" style="background:#fef3c7;color:#d97706;">&#x1F4CB;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(ctLabel) + ' Brief</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(pb.created_at) + '</span>' +
          '</div>' +
          northStar +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Pre-Call Briefs</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  function renderDigestsSection() {
    var items = _data.release_digests || [];
    if (!items.length) return '';

    var rows = items.map(function (d) {
      return (
        '<div class="cd-artifact-row cd-clickable" onclick="companyDetailPage.openDigest(\'' + d.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon" style="background:#eff6ff;color:#3b82f6;">&#x1F4E6;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(d.title || 'Release Digest') + '</span>' +
            '<span class="artifact-row-date">' + MD.formatDate(d.created_at) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="cd-section">' +
        '<div class="cd-section-header"><h2>Release Digests</h2></div>' +
        '<div class="cd-section-body">' + rows + '</div>' +
      '</div>'
    );
  }

  // -----------------------------------------------------------------------
  // Quick Actions (right column)
  // -----------------------------------------------------------------------

  function renderQuickActions() {
    var missing = [];
    if (!_data.hypotheses || !_data.hypotheses.length) missing.push({ page: 'hypothesis', label: 'Generate Hypothesis' });
    if (!_data.reports || !_data.reports.length) missing.push({ page: 'research', label: 'Generate Strategy' });
    if (!_data.demo_plans || !_data.demo_plans.length) missing.push({ page: 'demo-planner', label: 'Create Demo Plan' });

    var dealBtns =
      '<button class="btn btn-sm btn-primary cd-action-full" onclick="companyDetailPage.quickAction(\'next-steps\')">Next Steps</button>' +
      '<button class="btn btn-sm btn-accent cd-action-full" onclick="companyDetailPage.quickAction(\'precall-brief\')">Pre-Call Brief</button>';

    var missingBtns = missing.map(function (m) {
      return '<button class="btn btn-sm btn-outline cd-action-full" onclick="companyDetailPage.quickAction(\'' + m.page + '\')">' + m.label + '</button>';
    }).join('');

    return (
      '<div class="cd-section cd-quick-actions">' +
        '<div class="cd-section-header"><h2>Quick Actions</h2></div>' +
        '<div class="cd-section-body">' +
          '<div class="cd-action-group"><span class="cd-action-label">Deal Tools</span><div class="cd-action-btns">' + dealBtns + '</div></div>' +
          (missingBtns ? '<div class="cd-action-group"><span class="cd-action-label">Create Missing Artifacts</span><div class="cd-action-btns">' + missingBtns + '</div></div>' : '') +
        '</div>' +
      '</div>'
    );
  }

  // -----------------------------------------------------------------------
  // Next Steps + close timeline (right column)
  // -----------------------------------------------------------------------

  function renderNextStepsBlock() {
    return renderNextStepsCard() + renderCloseTimelineCard();
  }

  function renderCloseTimelineCard() {
    if (_nextStepsLoading) return '';
    var ns = _data.next_steps;
    var ct = ns && ns.close_timeline;
    if (!ct || !ct.summary) return '';
    var conf = (ct.confidence || 'low').toLowerCase();
    var ev = ct.evidence || [];
    var evHtml = ev.slice(0, 8).map(function (line) {
      return '<li>' + MD.escapeHtml(line) + '</li>';
    }).join('');
    return (
      '<div class="cd-section cd-close-timeline-card">' +
        '<div class="cd-section-header cd-close-timeline-header">' +
          '<h2>Close timeline</h2>' +
          '<span class="cd-conf-badge cd-conf-' + MD.escapeHtml(conf) + '">' + MD.escapeHtml(conf) + '</span>' +
        '</div>' +
        '<div class="cd-section-body">' +
          '<p class="cd-close-timeline-summary">' + MD.escapeHtml(ct.summary) + '</p>' +
          (evHtml ? '<ul class="cd-close-timeline-evidence">' + evHtml + '</ul>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function renderNextStepsCard() {
    if (_nextStepsLoading) {
      return (
        '<div class="cd-section cd-next-steps-card">' +
          '<div class="cd-section-header"><h2>Next Steps</h2></div>' +
          '<div class="cd-section-body"><div class="cd-loading-inline"><span class="spinner"></span> Generating next steps\u2026</div></div>' +
        '</div>'
      );
    }

    var ns = _data.next_steps;
    if (!ns) {
      if (artifactCount() === 0) {
        return (
          '<div class="cd-section cd-next-steps-card">' +
            '<div class="cd-section-header"><h2>Next Steps</h2></div>' +
            '<div class="cd-section-body cd-empty">Add artifacts (hypothesis, call notes, demo plans, etc.) to generate a prioritized plan.</div>' +
          '</div>'
        );
      }
      return (
        '<div class="cd-section cd-next-steps-card">' +
          '<div class="cd-section-header"><h2>Next Steps</h2></div>' +
          '<div class="cd-section-body">' +
            '<p class="cd-empty">No plan is available right now.</p>' +
            '<button type="button" class="btn btn-sm btn-primary cd-action-full" onclick="companyDetailPage.quickAction(\'next-steps\')">Open Next Steps</button>' +
          '</div>' +
        '</div>'
      );
    }

    var STAGE_LABELS = {
      prospecting: 'Prospecting',
      discovery: 'Discovery',
      demo_complete: 'Demo complete',
      active_evaluation: 'Active evaluation',
      evaluation: 'Evaluation / POC',
      expansion_or_renewal: 'Expansion / renewal',
      unknown: 'Unknown',
    };
    var stageKey = ns.inferred_deal_stage || 'unknown';
    var stageLabel = STAGE_LABELS[stageKey] || stageKey;
    var dsc = (ns.deal_stage_confidence || 'medium').toLowerCase();

    var steps = (ns.next_steps || []).slice().sort(function (a, b) {
      return (a.priority || 99) - (b.priority || 99);
    });
    var top = steps.slice(0, 3);
    var stepRows = top.map(function (s) {
      return (
        '<div class="cd-next-step-row">' +
          '<span class="cd-next-step-priority">P' + (s.priority != null ? s.priority : '?') + '</span>' +
          '<div class="cd-next-step-body">' +
            '<div class="cd-next-step-action">' + MD.escapeHtml(s.action || '') + '</div>' +
            '<div class="cd-next-step-meta">' +
              (s.owner ? '<span>' + MD.escapeHtml(s.owner) + '</span>' : '') +
              (s.timeframe ? '<span>' + MD.escapeHtml(s.timeframe) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    var focus = (ns.recommended_focus || ns.summary_preview || '').trim();

    return (
      '<div class="cd-section cd-next-steps-card">' +
        '<div class="cd-section-header cd-next-steps-header">' +
          '<h2>Next Steps</h2>' +
          '<span class="cd-next-steps-meta">' +
            '<span class="cd-stage-pill">' + MD.escapeHtml(stageLabel) + '</span>' +
            '<span class="cd-conf-badge cd-conf-' + MD.escapeHtml(dsc) + '">' + MD.escapeHtml(dsc) + '</span>' +
          '</span>' +
        '</div>' +
        '<div class="cd-section-body">' +
          (focus
            ? '<div class="cd-next-steps-focus"><span class="cd-next-steps-focus-label">Focus</span><p>' + MD.escapeHtml(focus) + '</p></div>'
            : '') +
          (stepRows ? '<div class="cd-next-steps-list">' + stepRows + '</div>' : '') +
          '<div class="cd-next-steps-footer">' +
            '<span class="artifact-row-date">Updated ' + MD.formatDate(ns.created_at) + '</span>' +
            '<button type="button" class="btn btn-sm btn-outline" onclick="companyDetailPage.openNextSteps(\'' + ns.id + '\')">View full plan</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // -----------------------------------------------------------------------
  // Deal Snapshot (auto-load)
  // -----------------------------------------------------------------------

  function updateHeaderHealth(d) {
    var el = document.getElementById('cdHealthInline');
    if (!el || !d) return;
    var HEALTH_CONFIG = {
      green:  { dot: '#16a34a', label: 'Healthy',  bg: '#f0fdf4', border: '#bbf7d0' },
      yellow: { dot: '#d97706', label: 'At Risk',  bg: '#fffbeb', border: '#fde68a' },
      red:    { dot: '#dc2626', label: 'Stalled',  bg: '#fef2f2', border: '#fecaca' },
    };
    var health = d.health || 'yellow';
    var hc = HEALTH_CONFIG[health] || HEALTH_CONFIG.yellow;
    el.innerHTML =
      '<span class="cd-health-pill" style="background:' + hc.bg + ';border-color:' + hc.border + ';color:' + hc.dot + ';">' +
        '<span class="cd-health-dot" style="background:' + hc.dot + ';"></span>' +
        hc.label +
      '</span>';
  }

  function loadSnapshot() {
    var el = document.getElementById('cdSnapshotBody');
    if (!el) return;

    var cached = _data.cached_snapshot;
    if (cached) {
      _snapshot = cached;
      el.innerHTML = renderSnapshotContent(cached);
      updateHeaderHealth(cached);
      return;
    }

    generateSnapshotFresh();
  }

  async function generateSnapshotFresh() {
    if (_snapshotLoading) return;
    _snapshotLoading = true;
    var el = document.getElementById('cdSnapshotBody');
    if (!el) return;
    el.innerHTML = '<div class="cd-loading-inline"><span class="spinner"></span> Generating deal snapshot\u2026</div>';

    try {
      _snapshot = await API.generateDealSnapshot(_data.company.name, null);
      el.innerHTML = renderSnapshotContent(_snapshot);
      updateHeaderHealth(_snapshot);
    } catch (e) {
      el.innerHTML = '<div class="cd-empty">Failed to generate snapshot: ' + MD.escapeHtml(e.message) + '</div>';
    } finally {
      _snapshotLoading = false;
    }
  }

  function renderSnapshotContent(d) {
    var HEALTH_CONFIG = {
      green:  { dot: '#16a34a', label: 'Healthy',  bg: '#f0fdf4', border: '#bbf7d0' },
      yellow: { dot: '#d97706', label: 'At Risk',  bg: '#fffbeb', border: '#fde68a' },
      red:    { dot: '#dc2626', label: 'Stalled',  bg: '#fef2f2', border: '#fecaca' },
    };
    var health = d.health || 'yellow';
    var hc = HEALTH_CONFIG[health] || HEALTH_CONFIG.yellow;

    var STAGE_LABELS = {
      prospecting: 'Prospecting', discovery: 'Discovery',
      demo_complete: 'Demo Complete', active_evaluation: 'Active Evaluation',
      evaluation: 'Evaluation / POC', expansion_or_renewal: 'Expansion / Renewal',
      unknown: 'Unknown',
    };
    var stageLabel = STAGE_LABELS[d.inferred_stage] || d.inferred_stage || 'Unknown';

    var sig = d.computed_signals || {};
    function signalCard(label, val, good) {
      var ok = typeof good === 'boolean' ? good : (val > 0);
      var cls = ok ? 'cd-signal-card cd-signal-good' : 'cd-signal-card cd-signal-neutral';
      return '<div class="' + cls + '"><span class="cd-signal-val">' + MD.escapeHtml(String(val)) + '</span><span class="cd-signal-label">' + label + '</span></div>';
    }

    var signals =
      signalCard('Calls', sig.total_call_notes || 0) +
      signalCard('Buying Signals', sig.total_buying_signals || 0) +
      signalCard('Risk Flags', sig.total_risk_flags || 0, (sig.total_risk_flags || 0) === 0) +
      signalCard('Open Objections', sig.unresolved_objection_count || 0, (sig.unresolved_objection_count || 0) === 0) +
      signalCard('Champion', sig.has_champion ? 'Yes' : 'No', sig.has_champion) +
      signalCard('Econ. Buyer', sig.has_economic_buyer ? 'Yes' : 'No', sig.has_economic_buyer);

    var daysNote = d.days_since_last_activity != null
      ? d.days_since_last_activity + 'd since last activity'
      : '';

    var missing = d.missing_critical || [];
    var missingHtml = missing.length
      ? '<div class="cd-snapshot-warnings">' + missing.map(function (m) {
          return '<div class="cd-warning-card">&#x26A0;&#xFE0F; ' + MD.escapeHtml(m) + '</div>';
        }).join('') + '</div>'
      : '';

    return (
      '<div class="cd-snapshot-card" style="background:' + hc.bg + ';border-color:' + hc.border + ';">' +
        '<div class="cd-snapshot-top">' +
          '<div class="cd-snapshot-health">' +
            '<span class="cd-health-dot" style="background:' + hc.dot + ';"></span>' +
            '<span class="cd-health-label" style="color:' + hc.dot + ';">' + hc.label + '</span>' +
          '</div>' +
          '<span class="cd-snapshot-stage">' + MD.escapeHtml(stageLabel) + '</span>' +
          (daysNote ? '<span class="cd-snapshot-days">' + MD.escapeHtml(daysNote) + '</span>' : '') +
          (d.created_at ? '<span class="cd-snapshot-generated">Generated ' + MD.timeAgo(d.created_at) + '</span>' : '') +
          '<button class="btn btn-sm cd-snapshot-refresh" onclick="companyDetailPage.refreshSnapshot()">&#x21BB; Update</button>' +
        '</div>' +
        '<p class="cd-snapshot-status">' + MD.escapeHtml(d.deal_status_line || '') + '</p>' +
        '<p class="cd-snapshot-rationale" style="color:' + hc.dot + ';">' + MD.escapeHtml(d.health_rationale || '') + '</p>' +
        '<div class="cd-signal-grid">' + signals + '</div>' +
        (d.whats_happening ? '<div class="cd-snapshot-prose cd-prose-happening"><span class="cd-prose-label">What\'s Happening</span><p>' + MD.escapeHtml(d.whats_happening) + '</p></div>' : '') +
        (d.momentum_read ? '<div class="cd-snapshot-prose cd-prose-momentum"><span class="cd-prose-label">Momentum Read</span><p>' + MD.escapeHtml(d.momentum_read) + '</p></div>' : '') +
        (d.risk_to_watch ? '<div class="cd-snapshot-prose cd-prose-risk"><span class="cd-prose-label">Risk to Watch</span><p>' + MD.escapeHtml(d.risk_to_watch) + '</p></div>' : '') +
        missingHtml +
      '</div>'
    );
  }

  // -----------------------------------------------------------------------
  // Company Notes (left column)
  // -----------------------------------------------------------------------

  function renderNotesSection() {
    var c = _data.company;
    var notes = _data.notes_list || [];

    var addBtn = c.is_defined
      ? '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.toggleNoteForm()">+ Add Note</button>'
      : '';

    var rows = '';
    if (!notes.length) {
      rows = '<div class="cd-empty">No notes yet' + (c.is_defined ? ' \u2014 add context about this company.' : '') + '</div>';
    } else {
      rows = notes.map(function (n) {
        var preview = (n.content || '').substring(0, 200).replace(/\n/g, ' ') + (n.content && n.content.length > 200 ? '\u2026' : '');
        var deleteBtn = c.is_defined
          ? '<button class="btn btn-sm cd-note-delete" title="Delete" onclick="event.stopPropagation();companyDetailPage.deleteNote(\'' + n.id + '\')">&times;</button>'
          : '';
        return (
          '<div class="cd-artifact-row cd-note-row" onclick="companyDetailPage.toggleNoteExpand(this,\'' + n.id + '\')">' +
            '<div class="cd-artifact-row-header">' +
              '<span class="artifact-row-icon" style="background:var(--accent-light,#eef);color:var(--accent,#4361ee);">&#x1F4DD;</span>' +
              '<span class="cd-artifact-row-title">' + MD.escapeHtml(n.title) + '</span>' +
              renderNoteDate(n) +
              deleteBtn +
            '</div>' +
            '<p class="cd-artifact-preview cd-note-preview">' + MD.escapeHtml(preview) + '</p>' +
            '<div class="cd-note-expanded" style="display:none;"></div>' +
          '</div>'
        );
      }).join('');
    }

    return (
      '<div class="cd-section cd-notes-section" id="cdNotesSection">' +
        '<div class="cd-section-header">' +
          '<h2>Company Notes</h2>' +
          addBtn +
        '</div>' +
        '<div id="cdNoteForm" style="display:none;"></div>' +
        '<div class="cd-section-body" id="cdNotesList">' + rows + '</div>' +
      '</div>'
    );
  }

  function toggleNoteForm() {
    var form = document.getElementById('cdNoteForm');
    if (!form) return;
    var showing = form.style.display !== 'none';
    if (showing) {
      form.style.display = 'none';
      form.innerHTML = '';
      return;
    }
    var today = new Date().toISOString().substring(0, 10);
    form.style.display = '';
    form.innerHTML =
      '<div class="cd-note-form">' +
        '<input type="text" id="cdNoteTitle" class="input" placeholder="Note title" autocomplete="off">' +
        '<div class="cd-note-date-row">' +
          '<label for="cdNoteDate" style="font-size:.8rem;color:var(--text-secondary);font-weight:500;">Date:</label>' +
          '<input type="date" id="cdNoteDate" class="input cd-note-date-picker" value="' + today + '">' +
        '</div>' +
        '<textarea id="cdNoteContent" rows="6" class="input" placeholder="Paste company info, strategy notes, press releases, discovery notes\u2026"></textarea>' +
        '<div class="cd-note-form-row">' +
          '<label class="cd-note-file-label">' +
            '<span class="btn btn-sm btn-outline">Upload .md / .txt</span>' +
            '<input type="file" id="cdNoteFile" accept=".md,.txt" style="display:none;" onchange="companyDetailPage.onNoteFileChange(this)">' +
          '</label>' +
          '<span id="cdNoteFileName" style="font-size:.75rem;color:var(--text-muted);"></span>' +
          '<span style="flex:1;"></span>' +
          '<button class="btn btn-sm btn-primary" onclick="companyDetailPage.saveNote()">Save</button>' +
          '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.toggleNoteForm()">Cancel</button>' +
        '</div>' +
      '</div>';
    setTimeout(function () {
      var el = document.getElementById('cdNoteTitle');
      if (el) el.focus();
    }, 50);
  }

  function onNoteFileChange(input) {
    var name = input.files && input.files[0] ? input.files[0].name : '';
    var nameEl = document.getElementById('cdNoteFileName');
    if (nameEl) nameEl.textContent = name;
    if (name && input.files[0]) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var contentEl = document.getElementById('cdNoteContent');
        if (contentEl) contentEl.value = e.target.result;
        var titleEl = document.getElementById('cdNoteTitle');
        if (titleEl && !titleEl.value.trim()) {
          var stem = name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
          titleEl.value = stem;
        }
      };
      reader.readAsText(input.files[0]);
    }
  }

  async function saveNote() {
    var titleEl = document.getElementById('cdNoteTitle');
    var contentEl = document.getElementById('cdNoteContent');
    var dateEl = document.getElementById('cdNoteDate');
    if (!titleEl || !contentEl) return;
    var title = titleEl.value.trim();
    var content = contentEl.value.trim();
    var noteDate = dateEl ? dateEl.value.trim() : null;
    if (!title) { alert('Please provide a title.'); return; }
    if (!content) { alert('Please provide content or upload a file.'); return; }
    try {
      await API.createCompanyNote(_data.company.id, title, content, noteDate || null);
      toggleNoteForm();
      var refreshed = await API.getCompanyProfile(_key);
      _data.notes_list = refreshed.notes_list || [];
      var el = document.getElementById('cdNotesList');
      if (el) el.innerHTML = renderNotesListInner();
    } catch (e) {
      alert('Failed to save note: ' + e.message);
    }
  }

  async function deleteNoteById(noteId) {
    if (!confirm('Delete this note?')) return;
    try {
      await API.deleteCompanyNote(_data.company.id, noteId);
      _data.notes_list = (_data.notes_list || []).filter(function (n) { return n.id !== noteId; });
      var el = document.getElementById('cdNotesList');
      if (el) el.innerHTML = renderNotesListInner();
    } catch (e) {
      alert('Failed to delete note: ' + e.message);
    }
  }

  function toggleNoteExpand(rowEl, noteId) {
    var expanded = rowEl.querySelector('.cd-note-expanded');
    var preview = rowEl.querySelector('.cd-note-preview');
    if (!expanded) return;
    if (expanded.style.display !== 'none') {
      expanded.style.display = 'none';
      if (preview) preview.style.display = '';
      return;
    }
    var note = (_data.notes_list || []).find(function (n) { return n.id === noteId; });
    if (note) {
      expanded.innerHTML = '<div class="md-body">' + (window.marked ? marked.parse(note.content || '') : MD.escapeHtml(note.content || '')) + '</div>';
    }
    expanded.style.display = '';
    if (preview) preview.style.display = 'none';
  }

  async function updateNoteDate(noteId, newDate) {
    if (!_data || !_data.company.is_defined || !newDate) return;
    try {
      await API.updateCompanyNoteDate(_data.company.id, noteId, newDate);
      var note = (_data.notes_list || []).find(function (n) { return n.id === noteId; });
      if (note) note.note_date = newDate;
    } catch (e) {
      alert('Failed to update note date: ' + e.message);
    }
  }

  function renderNotesListInner() {
    var c = _data.company;
    var notes = _data.notes_list || [];
    if (!notes.length) {
      return '<div class="cd-empty">No notes yet' + (c.is_defined ? ' \u2014 add context about this company.' : '') + '</div>';
    }
    return notes.map(function (n) {
      var preview = (n.content || '').substring(0, 200).replace(/\n/g, ' ') + (n.content && n.content.length > 200 ? '\u2026' : '');
      var deleteBtn = c.is_defined
        ? '<button class="btn btn-sm cd-note-delete" title="Delete" onclick="event.stopPropagation();companyDetailPage.deleteNote(\'' + n.id + '\')">&times;</button>'
        : '';
      return (
        '<div class="cd-artifact-row cd-note-row" onclick="companyDetailPage.toggleNoteExpand(this,\'' + n.id + '\')">' +
          '<div class="cd-artifact-row-header">' +
            '<span class="artifact-row-icon" style="background:var(--accent-light,#eef);color:var(--accent,#4361ee);">&#x1F4DD;</span>' +
            '<span class="cd-artifact-row-title">' + MD.escapeHtml(n.title) + '</span>' +
            renderNoteDate(n) +
            deleteBtn +
          '</div>' +
          '<p class="cd-artifact-preview cd-note-preview">' + MD.escapeHtml(preview) + '</p>' +
          '<div class="cd-note-expanded" style="display:none;"></div>' +
        '</div>'
      );
    }).join('');
  }

  // -----------------------------------------------------------------------
  // Inline artifact viewer
  // -----------------------------------------------------------------------

  var _savedTabContent = {};

  function cdCard(html) {
    return '<div class="cd-inline-card">' + html + '</div>';
  }
  function cdSectionHead(title) {
    return '<div class="cd-inline-section-head">' + MD.escapeHtml(title) + '</div>';
  }
  function cdPill(text, color) {
    var colors = {
      green: '#059669', red: '#dc2626', amber: '#d97706', blue: '#3b82f6',
      teal: '#0d9488', purple: '#7c3aed', coral: '#ef4444', gray: '#6b7280'
    };
    var c = colors[color] || colors.gray;
    return '<span style="display:inline-block;font-size:.68rem;font-weight:600;padding:.12rem .45rem;border-radius:4px;background:' + c + '14;color:' + c + ';margin-right:.25rem;margin-bottom:.2rem;">' + MD.escapeHtml(text) + '</span>';
  }
  function cdInfoRow(label, value) {
    if (!value) return '';
    return '<div style="display:flex;gap:.5rem;font-size:.82rem;margin-bottom:.3rem;"><span style="color:var(--text-muted);min-width:90px;flex-shrink:0;font-weight:500;">' + MD.escapeHtml(label) + '</span><span style="color:var(--text);">' + MD.escapeHtml(value) + '</span></div>';
  }
  function cdBulletList(items, fallback) {
    if (!items || !items.length) return '<span style="font-size:.82rem;color:var(--text-muted);font-style:italic;">' + (fallback || 'None') + '</span>';
    return '<ul style="margin:0;padding-left:1.2rem;font-size:.85rem;line-height:1.7;">' +
      items.map(function (item) { return '<li>' + MD.escapeHtml(typeof item === 'string' ? item : (item.text || item.question || JSON.stringify(item))) + '</li>'; }).join('') +
    '</ul>';
  }

  function inlineDetailHeader(title, tabId, pdfAction) {
    var pdfBtn = pdfAction
      ? '<button class="btn btn-sm btn-primary cd-inline-pdf-btn" onclick="' + pdfAction + '">Export PDF</button>'
      : '';
    return '<div class="cd-inline-detail-header">' +
      '<button class="btn btn-sm btn-outline cd-inline-back-btn" onclick="companyDetailPage.closeInlineArtifact(\'' + tabId + '\')">&larr; Back to list</button>' +
      '<span class="cd-inline-detail-title">' + MD.escapeHtml(title) + '</span>' +
      pdfBtn +
    '</div>';
  }

  function printArtifactHtml(title, bodyHtml) {
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + MD.escapeHtml(title) + '</title>' +
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;color:#1a1a2e;line-height:1.7;font-size:14px;}' +
      'h1{font-size:1.5rem;margin-bottom:.5rem;}h2{font-size:1.15rem;border-bottom:1px solid #e5e7eb;padding-bottom:.3rem;margin-top:1.5rem;}h3{font-size:1rem;}' +
      'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #e5e7eb;padding:.4rem .6rem;text-align:left;font-size:.85rem;}' +
      'pre{background:#f8f9fb;padding:.75rem;border-radius:6px;overflow-x:auto;font-size:.82rem;}code{font-size:.85em;}' +
      'ul,ol{margin:.5rem 0;padding-left:1.4rem;}@page{margin:1.5cm;}</style></head><body>' +
      '<h1>' + MD.escapeHtml(title) + '</h1>' + bodyHtml + '</body></html>';
    var w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); setTimeout(function () { w.print(); }, 400); }
  }

  async function viewInlineArtifact(tabId, type, id) {
    var panel = document.querySelector('.cd-tab-panel[data-panel="' + tabId + '"]');
    if (!panel) return;
    _savedTabContent[tabId] = panel.innerHTML;
    panel.innerHTML = '<div class="cd-loading-inline"><span class="spinner"></span> Loading\u2026</div>';

    try {
      var data, html;
      if (type === 'hypothesis') {
        data = await API.getHypothesis(id);
        html = renderHypothesisInline(data, tabId, id);
      } else if (type === 'report') {
        data = await API.getReport(id);
        html = renderReportInline(data, tabId, id);
      } else if (type === 'demo_plan') {
        data = await API.getDemoPlan(id);
        html = renderDemoPlanInline(data, tabId, id);
      } else if (type === 'call_note') {
        data = await API.getCallNote(id);
        html = renderCallNoteInline(data, tabId, id);
      } else if (type === 'precall_brief') {
        data = await API.getPreCallBrief(id);
        html = renderPreCallInline(data, tabId, id);
      } else if (type === 'next_steps') {
        data = await API.getNextSteps(id);
        html = renderNextStepsInline(data, tabId);
      } else if (type === 'digest') {
        data = await API.getReleaseDigest(id);
        html = renderDigestInline(data, tabId, id);
      } else if (type === 'expansion') {
        data = await API.getExpansionPlaybook(id);
        html = renderExpansionInline(data, tabId);
      } else {
        html = '<div class="cd-empty">Unknown artifact type.</div>';
      }
      panel.innerHTML = html;
    } catch (e) {
      panel.innerHTML = inlineDetailHeader('Error', tabId, '') +
        '<div class="cd-inline-detail-body"><div style="color:var(--red);padding:1rem;">Failed to load: ' + MD.escapeHtml(e.message) + '</div></div>';
    }
  }

  function closeInlineArtifact(tabId) {
    var panel = document.querySelector('.cd-tab-panel[data-panel="' + tabId + '"]');
    if (!panel || !_savedTabContent[tabId]) return;
    panel.innerHTML = _savedTabContent[tabId];
    delete _savedTabContent[tabId];
  }

  // --- Hypothesis inline ---
  function renderHypothesisInline(data, tabId, id) {
    var title = 'Hypothesis: ' + (data.company_name || '');
    var meta = '';
    if (data.confidence_level) meta += cdPill(data.confidence_level, data.confidence_level === 'High' ? 'green' : data.confidence_level === 'Medium' ? 'amber' : 'red');
    if (data.is_public) meta += cdPill('Public', 'blue');
    if (data.created_at) meta += '<span style="font-size:.75rem;color:var(--text-muted);">' + MD.formatDate(data.created_at) + '</span>';

    var body = '<div class="cd-inline-detail-body">';
    if (meta) body += '<div style="margin-bottom:.75rem;">' + meta + '</div>';
    body += '<div class="md-body">' + MD.render(data.hypothesis_markdown || '*No hypothesis generated.*') + '</div>';
    body += '</div>';
    var pdfAction = "companyDetailPage.printHypothesisInline()";
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  // --- Research report inline ---
  function renderReportInline(data, tabId, id) {
    var resp = data.response || data;
    var title = data.title || resp._savedTitle || resp.query || 'Strategy Report';
    var body = '<div class="cd-inline-detail-body">';
    if (resp.synthesized_answer) {
      body += '<div class="md-body">' + MD.render(resp.synthesized_answer) + '</div>';
    }
    if (resp.talk_track) {
      body += cdSectionHead('Talk Track');
      body += '<div class="md-body">' + MD.render(resp.talk_track) + '</div>';
    }
    if (resp.discovery_questions && resp.discovery_questions.length) {
      body += cdSectionHead('Discovery Questions');
      body += cdBulletList(resp.discovery_questions);
    }
    body += '</div>';
    var pdfAction = "companyDetailPage.printReportInline()";
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  // --- Demo plan inline ---
  function renderDemoPlanInline(data, tabId, id) {
    var title = data.title || 'Demo Plan';
    var meta = '';
    if (data.persona) meta += cdPill(data.persona, 'blue');
    if (data.demo_mode) meta += cdPill(data.demo_mode, 'purple');
    if (data.created_at) meta += '<span style="font-size:.75rem;color:var(--text-muted);">' + MD.formatDate(data.created_at) + '</span>';

    var planMd = data.demo_plan || '';
    var body = '<div class="cd-inline-detail-body">';
    if (meta) body += '<div style="margin-bottom:.75rem;">' + meta + '</div>';
    body += '<div class="md-body">' + MD.render(planMd) + '</div>';
    body += '</div>';

    var hasPdf = data.plan_id && data.pdf_path;
    var pdfAction = hasPdf ? "API.getDemoPlanPdf('" + MD.escapeHtml(data.plan_id) + "')" : '';
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  // --- Call note inline ---
  function renderCallNoteInline(data, tabId, id) {
    var title = data.title || 'Call Note';
    var meta = '';
    if (data.created_at) meta += '<span style="font-size:.75rem;color:var(--text-muted);">' + MD.formatDate(data.created_at) + '</span>';

    var raw = data.summary_markdown || '';
    var summaryHtml;
    try {
      var s = JSON.parse(raw);
      summaryHtml = buildCallNoteDetailHtml(s);
    } catch (_) {
      summaryHtml = raw ? '<div class="md-body">' + MD.render(raw) + '</div>' : '<em>No summary available.</em>';
    }

    var body = '<div class="cd-inline-detail-body">';
    if (meta) body += '<div style="margin-bottom:.75rem;">' + meta + '</div>';
    body += summaryHtml;
    body += '</div>';

    var pdfAction = "companyDetailPage.downloadCallNotePdf('" + MD.escapeHtml(id) + "')";
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  function buildCallNoteDetailHtml(s) {
    var html = '';
    var ctx = s.call_context || {};
    html += cdSectionHead('Call Context');
    html += cdCard(cdInfoRow('Date', ctx.date) + cdInfoRow('Duration', ctx.duration_estimate) + cdInfoRow('Call type', ctx.call_type) + cdInfoRow('Deal stage', ctx.deal_stage));

    var people = s.stakeholders || [];
    if (people.length) {
      html += cdSectionHead('Stakeholders');
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.5rem;">';
      people.forEach(function (p) {
        var tags = (p.role_tags || []).map(function (t) { return cdPill(t, 'blue'); }).join('');
        html += cdCard(
          '<div style="font-size:.88rem;font-weight:600;">' + MD.escapeHtml(p.name || 'Unknown') + '</div>' +
          '<div style="font-size:.78rem;color:var(--text-muted);margin-bottom:.3rem;">' + MD.escapeHtml(p.title || '') + (p.org ? ' \u00b7 ' + MD.escapeHtml(p.org) : '') + '</div>' +
          tags +
          (p.notes ? '<div style="font-size:.78rem;color:var(--text-muted);margin-top:.25rem;">' + MD.escapeHtml(p.notes) + '</div>' : '')
        );
      });
      html += '</div>';
    }

    var tech = s.technical_requirements || {};
    if (tech.current_stack || tech.technical_goals) {
      html += cdSectionHead('Technical Requirements');
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.5rem;">';
      if (tech.current_stack && tech.current_stack.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.3rem;">Current Stack</div>' + tech.current_stack.map(function (t) { return cdPill(t, 'teal'); }).join(''));
      if (tech.technical_goals) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.3rem;">Technical Goals</div>' + cdBulletList(tech.technical_goals));
      html += '</div>';
    }

    var pains = s.pain_points || [];
    if (pains.length) {
      html += cdSectionHead('Pain Points');
      pains.forEach(function (p) {
        html += cdCard(
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;">' +
            '<div style="flex:1;"><div style="font-size:.85rem;">' + MD.escapeHtml(p.pain || '') + '</div>' +
            (p.impact ? '<div style="font-size:.78rem;color:var(--text-muted);">' + MD.escapeHtml(p.impact) + '</div>' : '') + '</div>' +
            cdPill(p.urgency || 'Unknown', p.urgency === 'High' ? 'red' : p.urgency === 'Medium' ? 'amber' : 'gray') +
          '</div>'
        );
      });
    }

    var drivers = s.business_drivers || {};
    if (drivers.why_now || drivers.business_context) {
      html += cdSectionHead('Business Drivers');
      html += cdCard(
        (drivers.why_now ? cdInfoRow('Why now', drivers.why_now) : '') +
        (drivers.business_context ? cdInfoRow('Context', drivers.business_context) : '')
      );
    }

    var comp = s.competitive_ecosystem || {};
    if (comp.incumbents || comp.also_evaluating) {
      html += cdSectionHead('Competitive Landscape');
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.5rem;">';
      if (comp.incumbents && comp.incumbents.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.3rem;">Incumbents</div>' + comp.incumbents.map(function (t) { return cdPill(t, 'amber'); }).join(''));
      if (comp.also_evaluating && comp.also_evaluating.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.3rem;">Also Evaluating</div>' + comp.also_evaluating.map(function (t) { return cdPill(t, 'red'); }).join(''));
      if (comp.required_integrations && comp.required_integrations.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.3rem;">Required Integrations</div>' + comp.required_integrations.map(function (t) { return cdPill(t, 'purple'); }).join(''));
      html += '</div>';
    }

    var objections = s.objections || [];
    if (objections.length) {
      html += cdSectionHead('Objections');
      objections.forEach(function (o) {
        var sc = o.status === 'Addressed' ? 'green' : o.status === 'Partially Addressed' ? 'amber' : 'coral';
        html += cdCard(
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;">' +
            '<div style="flex:1;font-size:.85rem;">' + MD.escapeHtml(o.objection || '') + '</div>' +
            '<div style="flex-shrink:0;">' + cdPill(o.type || 'General', 'gray') + cdPill(o.status || 'Raised', sc) + '</div>' +
          '</div>'
        );
      });
    }

    var steps = s.next_steps || [];
    if (steps.length) {
      html += cdSectionHead('Next Steps');
      steps.forEach(function (step) {
        var oc = step.owner_side === 'AE' || step.owner_side === 'SE' ? 'purple' : step.owner_side === 'Prospect' ? 'teal' : 'gray';
        html += cdCard(
          '<div style="display:flex;align-items:flex-start;gap:.5rem;">' +
            cdPill(step.owner_side || '?', oc) +
            '<div style="flex:1;"><div style="font-size:.85rem;">' + MD.escapeHtml(step.action || '') + '</div>' +
            (step.owner ? '<div style="font-size:.78rem;color:var(--text-muted);">Owner: ' + MD.escapeHtml(step.owner) + (step.due ? ' \u00b7 Due: ' + MD.escapeHtml(step.due) : '') + '</div>' : '') +
            '</div></div>'
        );
      });
    }

    var sig = s.signal_log || {};
    if ((sig.buying_signals && sig.buying_signals.length) || (sig.risk_flags && sig.risk_flags.length) || (sig.open_questions && sig.open_questions.length)) {
      html += cdSectionHead('Signal Log');
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.5rem;">';
      if (sig.buying_signals && sig.buying_signals.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:#059669;margin-bottom:.3rem;">Buying Signals</div>' + cdBulletList(sig.buying_signals));
      if (sig.risk_flags && sig.risk_flags.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:#dc2626;margin-bottom:.3rem;">Risk Flags</div>' + cdBulletList(sig.risk_flags));
      if (sig.open_questions && sig.open_questions.length) html += cdCard('<div style="font-size:.75rem;font-weight:600;color:#7c3aed;margin-bottom:.3rem;">Open Questions</div>' + cdBulletList(sig.open_questions));
      html += '</div>';
    }

    if (s.se_notes) {
      html += cdSectionHead('SE Notes');
      html += cdCard('<div style="font-size:.85rem;line-height:1.6;">' + MD.escapeHtml(s.se_notes) + '</div>');
    }

    return html;
  }

  // --- Pre-call brief inline ---
  function renderPreCallInline(data, tabId, id) {
    var title = (data.call_type ? data.call_type + ' Brief' : 'Pre-Call Brief') + ': ' + (data.company_name || '');
    var body = '<div class="cd-inline-detail-body">';

    if (data.north_star) {
      body += '<div class="cd-inline-card" style="border:2px solid var(--primary,#6366f1);background:var(--primary-light,#eef2ff);">' +
        '<div style="font-weight:700;color:var(--primary,#6366f1);margin-bottom:.3rem;">North Star</div>' +
        '<div style="font-size:.92rem;font-weight:600;">' + MD.escapeHtml(data.north_star) + '</div></div>';
    }
    if (data.situation_summary) {
      body += cdSectionHead('Where We Are');
      body += cdCard('<div style="font-size:.88rem;line-height:1.65;">' + MD.escapeHtml(data.situation_summary) + '</div>');
    }
    body += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;">';
    body += cdCard('<div style="font-size:.75rem;font-weight:600;color:#059669;margin-bottom:.4rem;">What We Know</div>' + cdBulletList(data.what_we_know));
    body += cdCard('<div style="font-size:.75rem;font-weight:600;color:#d97706;margin-bottom:.4rem;">What We Don\'t Know</div>' + cdBulletList(data.what_we_dont_know));
    body += '</div>';

    var objectives = data.call_objectives || [];
    if (objectives.length) {
      body += cdSectionHead('Call Objectives');
      body += cdCard(objectives.map(function (obj, i) {
        return '<div style="padding:.3rem 0;border-bottom:1px solid var(--border,#e5e7eb);font-size:.88rem;"><strong>' + (i + 1) + '.</strong> ' + MD.escapeHtml(obj) + '</div>';
      }).join(''));
    }

    var questions = data.questions_to_ask || [];
    if (questions.length) {
      body += cdSectionHead('Questions to Ask');
      body += questions.map(function (q) {
        return cdCard(
          '<div style="font-size:.9rem;font-weight:600;font-style:italic;margin-bottom:.2rem;">"' + MD.escapeHtml(q.question) + '"</div>' +
          '<div style="font-size:.8rem;color:var(--text-muted);">\u2192 ' + MD.escapeHtml(q.strategic_purpose || '') + '</div>' +
          (q.follow_up_if ? '<div style="font-size:.78rem;color:var(--text-muted);margin-top:.2rem;">Follow-up: ' + MD.escapeHtml(q.follow_up_if) + '</div>' : '')
        );
      }).join('');
    }

    var attendees = data.attendee_prep || [];
    if (attendees.length) {
      body += cdSectionHead('Attendee Prep');
      body += attendees.map(function (a) {
        return cdCard(
          '<div style="font-weight:600;font-size:.9rem;">' + MD.escapeHtml(a.name) + '<span style="font-weight:400;color:var(--text-muted);font-size:.78rem;margin-left:.4rem;">' + MD.escapeHtml(a.inferred_role || '') + '</span></div>' +
          (a.what_they_care_about ? '<div style="font-size:.82rem;margin-top:.2rem;">\uD83C\uDFAF ' + MD.escapeHtml(a.what_they_care_about) + '</div>' : '') +
          (a.how_to_engage ? '<div style="font-size:.82rem;color:var(--text-muted);">\uD83D\uDCA1 ' + MD.escapeHtml(a.how_to_engage) + '</div>' : '')
        );
      }).join('');
    }

    body += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;">';
    body += cdCard('<div style="font-size:.75rem;font-weight:600;margin-bottom:.4rem;">Key Proof Points</div>' + cdBulletList(data.key_proof_points));
    body += cdCard('<div style="font-size:.75rem;font-weight:600;color:#dc2626;margin-bottom:.4rem;">Things to Avoid</div>' + cdBulletList(data.things_to_avoid));
    body += '</div>';

    body += '</div>';
    var pdfAction = "API.openPreCallBriefPdf('" + MD.escapeHtml(id) + "')";
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  // --- Next steps inline ---
  function renderNextStepsInline(data, tabId) {
    var title = 'Next Steps: ' + (data.company_name || '');
    var body = '<div class="cd-inline-detail-body">';

    if (data.recommended_focus) {
      body += '<div class="cd-inline-card" style="border:2px solid var(--primary,#6366f1);background:var(--primary-light,#eef2ff);">' +
        '<div style="font-weight:700;color:var(--primary,#6366f1);margin-bottom:.3rem;">Recommended Focus</div>' +
        '<div style="font-size:.92rem;">' + MD.escapeHtml(data.recommended_focus) + '</div></div>';
    }

    var ct = data.close_timeline;
    if (ct && ct.summary) {
      var cconf = (ct.confidence || 'low').toLowerCase();
      var ev = ct.evidence || [];
      body += '<div class="cd-inline-card cd-close-timeline-inline" style="border:2px solid #0ea5e9;background:#f0f9ff;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.35rem;">' +
        '<div style="font-weight:700;color:#0369a1;">Close timeline</div>' +
        '<span class="cd-conf-badge cd-conf-' + MD.escapeHtml(cconf) + '">' + MD.escapeHtml(cconf) + '</span></div>' +
        '<div style="font-size:.92rem;margin-bottom:.4rem;">' + MD.escapeHtml(ct.summary) + '</div>' +
        (ev.length
          ? '<ul style="margin:0;padding-left:1.1rem;font-size:.82rem;color:var(--text-muted);">' +
            ev.map(function (line) { return '<li>' + MD.escapeHtml(line) + '</li>'; }).join('') +
            '</ul>'
          : '') +
        '</div>';
    }

    var steps = (data.next_steps || []).slice().sort(function (a, b) { return (a.priority || 99) - (b.priority || 99); });
    var groups = {};
    var tfOrder = ['Immediate', 'Within 1 week', 'Within 2 weeks', 'Within 1 month', 'Ongoing'];
    steps.forEach(function (s) {
      var tf = s.timeframe || 'Within 2 weeks';
      if (!groups[tf]) groups[tf] = [];
      groups[tf].push(s);
    });

    var catIcons = { 'Technical': '\uD83D\uDD27', 'Strategic': '\uD83C\uDFAF', 'Relationship': '\uD83E\uDD1D', 'Competitive': '\u2694\uFE0F', 'Process': '\uD83D\uDCCB', 'Discovery': '\uD83D\uDD0D' };
    tfOrder.concat(Object.keys(groups)).filter(function (tf, i, arr) { return arr.indexOf(tf) === i && groups[tf]; }).forEach(function (tf) {
      if (!groups[tf]) return;
      body += '<div style="margin-top:.75rem;"><div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:.4rem;">' + MD.escapeHtml(tf) + '</div>';
      groups[tf].forEach(function (s) {
        var icon = catIcons[s.category] || '\uD83D\uDCCC';
        body += cdCard(
          '<div style="display:flex;align-items:flex-start;gap:.5rem;">' +
            cdPill('P' + (s.priority || '?'), s.priority <= 2 ? 'red' : s.priority <= 4 ? 'amber' : 'gray') +
            cdPill(icon + ' ' + (s.category || ''), 'blue') +
            (s.owner ? cdPill(s.owner, 'purple') : '') +
          '</div>' +
          '<div style="font-size:.88rem;font-weight:600;margin-top:.3rem;">' + MD.escapeHtml(s.action || '') + '</div>' +
          '<div style="font-size:.8rem;color:var(--text-muted);margin-top:.15rem;">' + MD.escapeHtml(s.rationale || '') + '</div>'
        );
      });
      body += '</div>';
    });

    var risks = data.blocking_risks || [];
    if (risks.length) {
      body += cdSectionHead('Blocking Risks');
      risks.forEach(function (r) { body += cdCard('<div style="font-size:.85rem;">\u26A0\uFE0F ' + MD.escapeHtml(r) + '</div>'); });
    }

    body += '</div>';
    return inlineDetailHeader(title, tabId, '') + body;
  }

  // --- Digest inline ---
  function renderDigestInline(data, tabId, id) {
    var title = data.title || data.headline || 'Release Digest';
    var body = '<div class="cd-inline-detail-body">';

    if (data.headline) body += '<div style="font-size:1.1rem;font-weight:700;margin-bottom:.5rem;">' + MD.escapeHtml(data.headline) + '</div>';
    if (data.intro_paragraph) body += '<div style="font-size:.9rem;line-height:1.7;margin-bottom:1rem;">' + MD.escapeHtml(data.intro_paragraph) + '</div>';

    var featured = data.featured_releases || [];
    var others = data.other_relevant_releases || [];
    var additional = data.additional_releases || [];

    if (featured.length) {
      body += cdSectionHead('Featured Releases');
      featured.forEach(function (r) { body += renderDigestRelease(r, true); });
    }
    if (others.length) {
      body += cdSectionHead('Also Relevant');
      others.forEach(function (r) { body += renderDigestRelease(r, false); });
    }
    if (additional.length) {
      body += cdSectionHead('Other Releases');
      additional.forEach(function (r) {
        body += cdCard('<div style="display:flex;gap:.5rem;align-items:baseline;">' +
          cdPill(r.category || 'Other', 'gray') +
          '<span style="font-size:.85rem;font-weight:600;">' + MD.escapeHtml(r.title) + '</span></div>' +
          (r.why_it_matters ? '<div style="font-size:.8rem;color:var(--text-muted);margin-top:.2rem;">' + MD.escapeHtml(r.why_it_matters) + '</div>' : ''));
      });
    }

    if (data.closing_paragraph) {
      body += '<div style="font-size:.88rem;line-height:1.7;margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border,#e5e7eb);">' + MD.escapeHtml(data.closing_paragraph) + '</div>';
    }

    body += '</div>';
    var pdfAction = "API.openReleaseDigestPdf('" + MD.escapeHtml(id) + "')";
    return inlineDetailHeader(title, tabId, pdfAction) + body;
  }

  function renderDigestRelease(r, featured) {
    var links = '';
    if (r.link) links += ' <a href="' + MD.escapeHtml(r.link) + '" target="_blank" style="font-size:.75rem;color:var(--primary,#6366f1);">Release notes \u2197</a>';
    if (r.docs_link) links += ' <a href="' + MD.escapeHtml(r.docs_link) + '" target="_blank" style="font-size:.75rem;color:var(--primary,#6366f1);">Docs \u2197</a>';
    return cdCard(
      '<div style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;">' +
        cdPill(r.category || 'Other', 'blue') +
        '<span style="font-size:.9rem;font-weight:600;">' + MD.escapeHtml(r.title || '') + '</span>' +
        links +
      '</div>' +
      (r.what_changed ? '<div style="font-size:.85rem;margin-top:.3rem;">' + MD.escapeHtml(r.what_changed) + '</div>' : '') +
      (r.why_it_matters ? '<div style="font-size:.82rem;color:var(--text-muted);margin-top:.2rem;">' + MD.escapeHtml(r.why_it_matters) + '</div>' : '') +
      (r.talk_track ? '<div style="font-size:.82rem;font-style:italic;color:var(--text-muted);margin-top:.3rem;padding:.5rem;background:var(--surface,#f8f9fb);border-radius:6px;">' + MD.escapeHtml(r.talk_track) + '</div>' : '')
    );
  }

  // --- Expansion inline ---
  function renderExpansionInline(data, tabId) {
    var title = 'Expansion Playbook';
    var body = '<div class="cd-inline-detail-body">';

    body += cdCard(
      cdInfoRow('Current Footprint', data.current_footprint_summary || '') +
      cdInfoRow('Champion', data.current_champion || 'Unknown') +
      cdInfoRow('Next Action', data.recommended_next_action || '')
    );

    var opps = data.opportunities || [];
    if (opps.length) {
      body += cdSectionHead('Expansion Opportunities');
      opps.forEach(function (opp) {
        body += cdCard(
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;">' +
            '<div style="flex:1;"><div style="font-size:.9rem;font-weight:600;">' + MD.escapeHtml(opp.product || opp.title || '') + '</div>' +
            (opp.hook ? '<div style="font-size:.82rem;margin-top:.2rem;">' + MD.escapeHtml(opp.hook) + '</div>' : '') +
            (opp.evidence ? '<div style="font-size:.8rem;color:var(--text-muted);margin-top:.15rem;">' + MD.escapeHtml(opp.evidence) + '</div>' : '') +
            '</div>' +
            (opp.urgency ? cdPill(opp.urgency, opp.urgency === 'High' ? 'red' : opp.urgency === 'Medium' ? 'amber' : 'gray') : '') +
          '</div>'
        );
      });
    }

    body += '</div>';
    return inlineDetailHeader(title, tabId, '') + body;
  }

  // -----------------------------------------------------------------------
  // Slack context (right column)
  // -----------------------------------------------------------------------

  async function loadSlack() {
    var el = document.getElementById('cdSlackList');
    if (!el) return;
    try {
      var data = await API.getSlackSummariesByCompany(_data.company.name);
      var summaries = data.summaries || [];
      if (!summaries.length) {
        el.innerHTML = '<div class="cd-empty">No Slack summaries yet</div>';
        return;
      }
      el.innerHTML = summaries.map(function (s) {
        var channel = s.channel_name ? '<span class="cd-slack-channel">' + MD.escapeHtml(s.channel_name) + '</span>' : '';
        var preview = (s.summary_text || '').substring(0, 150).replace(/\n/g, ' ') + (s.summary_text && s.summary_text.length > 150 ? '\u2026' : '');
        return (
          '<div class="cd-slack-item">' +
            '<div class="cd-slack-item-header">' + channel + '<span class="artifact-row-date">' + MD.formatDate(s.updated_at || s.created_at) + '</span></div>' +
            '<p class="cd-artifact-preview">' + MD.escapeHtml(preview) + '</p>' +
          '</div>'
        );
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="cd-empty">Failed to load Slack data</div>';
    }
  }

  function toggleSlackForm() {
    var form = document.getElementById('cdSlackForm');
    if (!form) return;
    var showing = form.style.display !== 'none';
    if (showing) {
      form.style.display = 'none';
      form.innerHTML = '';
      return;
    }
    form.style.display = '';
    form.innerHTML =
      '<div class="cd-slack-form">' +
        '<input type="text" id="cdSlackChannel" class="input" placeholder="Channel name (optional)" autocomplete="off">' +
        '<textarea id="cdSlackText" rows="5" class="input" placeholder="Paste your Slack summary here\u2026"></textarea>' +
        '<div class="cd-slack-form-actions">' +
          '<button class="btn btn-sm btn-primary" onclick="companyDetailPage.saveSlackSummary()">Save</button>' +
          '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.toggleSlackForm()">Cancel</button>' +
        '</div>' +
      '</div>';
    setTimeout(function () {
      var ta = document.getElementById('cdSlackText');
      if (ta) ta.focus();
    }, 50);
  }

  async function saveSlackSummary() {
    var textEl = document.getElementById('cdSlackText');
    var channelEl = document.getElementById('cdSlackChannel');
    if (!textEl) return;
    var text = textEl.value.trim();
    if (!text) { alert('Please paste a Slack summary before saving.'); return; }
    try {
      await API.saveSlackSummary(_data.company.name, text, channelEl ? channelEl.value.trim() : '');
      toggleSlackForm();
      loadSlack();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    }
  }

  // -----------------------------------------------------------------------
  // Inline Company Chat (full-width, collapsible)
  // -----------------------------------------------------------------------

  function renderInlineChatBar() {
    return (
      '<div class="cd-inline-chat" id="cdInlineChat">' +
        '<div class="cd-inline-chat-toggle" onclick="companyDetailPage.toggleInlineChat()">' +
          '<span class="cd-inline-chat-label">&#x1F4AC; Ask about ' + MD.escapeHtml(_data.company.name) + '</span>' +
          '<span class="cd-inline-chat-arrow" id="cdChatArrow">&#x25BC;</span>' +
        '</div>' +
        '<div class="cd-inline-chat-body" id="cdInlineChatBody" style="display:none;">' +
          '<div class="cd-inline-chat-controls">' +
            '<select id="cdChatConvSelect" class="input cd-chat-select" onchange="companyDetailPage.switchConversation(this.value)">' +
              '<option value="">New conversation</option>' +
            '</select>' +
            '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.newChat()">+ New</button>' +
          '</div>' +
          '<div id="cdChatMessages" class="chat-messages"></div>' +
          '<div class="chat-input-row">' +
            '<input type="text" id="cdChatInput" class="input chat-input" placeholder="Ask about ' + MD.escapeHtml(_data.company.name) + '\u2026" autocomplete="off" onkeydown="if(event.key===\'Enter\')companyDetailPage.sendChat()">' +
            '<button class="btn btn-sm btn-primary chat-send-btn" id="cdChatSend" onclick="companyDetailPage.sendChat()">Send</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function toggleInlineChat() {
    var body = document.getElementById('cdInlineChatBody');
    var arrow = document.getElementById('cdChatArrow');
    var container = document.getElementById('cdInlineChat');
    if (!body) return;

    var isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    if (arrow) arrow.innerHTML = isHidden ? '&#x25B2;' : '&#x25BC;';
    if (container) container.classList.toggle('cd-inline-chat-expanded', isHidden);
    _chatExpanded = isHidden;

    if (isHidden && !_chatLoaded) {
      _chatLoaded = true;
      loadChatConversations();
    }

    if (isHidden) {
      setTimeout(function () {
        var input = document.getElementById('cdChatInput');
        if (input) input.focus();
      }, 50);
    }
  }

  // -----------------------------------------------------------------------
  // Company Chat (legacy render, kept for reference)
  // -----------------------------------------------------------------------

  function renderChatSection() {
    return (
      '<div class="cd-section cd-chat-section">' +
        '<div class="cd-section-header">' +
          '<h2>Company Chat</h2>' +
          '<div class="cd-chat-controls">' +
            '<select id="cdChatConvSelect" class="input cd-chat-select" onchange="companyDetailPage.switchConversation(this.value)">' +
              '<option value="">New conversation</option>' +
            '</select>' +
            '<button class="btn btn-sm btn-outline" onclick="companyDetailPage.newChat()">+ New</button>' +
          '</div>' +
        '</div>' +
        '<div class="cd-section-body">' +
          '<div id="cdChatMessages" class="chat-messages"></div>' +
          '<div class="chat-input-row">' +
            '<input type="text" id="cdChatInput" class="input chat-input" placeholder="Ask about ' + MD.escapeHtml(_data.company.name) + '\u2026" autocomplete="off" onkeydown="if(event.key===\'Enter\')companyDetailPage.sendChat()">' +
            '<button class="btn btn-sm btn-primary chat-send-btn" id="cdChatSend" onclick="companyDetailPage.sendChat()">Send</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  async function loadChatConversations() {
    try {
      var data = await API.companyChatConversations(_data.company.name);
      _chatState.conversations = data.conversations || [];
    } catch (e) {
      _chatState.conversations = [];
    }
    var sel = document.getElementById('cdChatConvSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">New conversation</option>';
    _chatState.conversations.forEach(function (c) {
      var label = c.title || c.preview || 'Conversation';
      if (label.length > 40) label = label.substring(0, 40) + '\u2026';
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = label;
      if (c.id === _chatState.conversationId) opt.selected = true;
      sel.appendChild(opt);
    });
    if (_chatState.conversations.length && !_chatState.conversationId) {
      _chatState.conversationId = _chatState.conversations[0].id;
      sel.value = _chatState.conversationId;
      loadConversation(_chatState.conversationId);
    }
  }

  async function loadConversation(conversationId) {
    _chatState.conversationId = conversationId;
    var el = document.getElementById('cdChatMessages');
    if (!el) return;
    if (!conversationId) {
      el.innerHTML = '<div class="chat-empty">No messages yet. Ask a question about this company.</div>';
      return;
    }
    el.innerHTML = '<div class="chat-empty">Loading\u2026</div>';
    try {
      var conv = await API.companyChatGet(conversationId);
      renderChatMessages(conv.messages || []);
    } catch (e) {
      el.innerHTML = '<div class="chat-empty">Failed to load conversation.</div>';
    }
  }

  function renderChatMessages(messages) {
    var el = document.getElementById('cdChatMessages');
    if (!el) return;
    if (!messages || !messages.length) {
      el.innerHTML = '<div class="chat-empty">No messages yet. Ask a question about this company.</div>';
      return;
    }
    el.innerHTML = messages.map(function (m) {
      var cls = m.role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-assistant';
      var content = m.role === 'assistant' && window.marked
        ? marked.parse(m.content || '')
        : MD.escapeHtml(m.content || '');
      return '<div class="' + cls + '">' + content + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    init: init,
    switchTab: switchTab,
    toggleInlineChat: toggleInlineChat,

    openHypothesis: function (id) {
      viewInlineArtifact('hypotheses', 'hypothesis', id);
    },
    openReport: function (id) {
      viewInlineArtifact('reports', 'report', id);
    },
    openDemoPlan: function (id) {
      viewInlineArtifact('demo_plans', 'demo_plan', id);
    },
    openCallNote: function (id) {
      viewInlineArtifact('call_notes', 'call_note', id);
    },
    openPreCallBrief: function (id) {
      viewInlineArtifact('precall', 'precall_brief', id);
    },
    openDigest: function (id) {
      viewInlineArtifact('digests', 'digest', id);
    },
    openNextSteps: function (id) {
      viewInlineArtifact('next_steps', 'next_steps', id);
    },
    openExpansion: function (id) {
      viewInlineArtifact('expansion', 'expansion', id);
    },
    closeInlineArtifact: closeInlineArtifact,
    printHypothesisInline: function () {
      var body = document.querySelector('.cd-tab-panel[data-panel="hypotheses"] .cd-inline-detail-body');
      if (body) printArtifactHtml('Hypothesis', body.innerHTML);
    },
    printReportInline: function () {
      var body = document.querySelector('.cd-tab-panel[data-panel="reports"] .cd-inline-detail-body');
      if (body) printArtifactHtml('Strategy Report', body.innerHTML);
    },
    downloadCallNotePdf: function (id) {
      var a = document.createElement('a');
      a.href = '/api/call-notes/' + encodeURIComponent(id) + '/pdf';
      a.target = '_blank';
      a.click();
    },

    quickAction: function (page) {
      var name = _data.company.name;
      try {
        sessionStorage.setItem('company_context_key', _key);
        sessionStorage.setItem('company_context_name', name);
      } catch (e) { /* ignore */ }
      if (page === 'hypothesis') {
        try { sessionStorage.setItem('hypothesis_prefill_company', name); } catch (e) { /* ignore */ }
      } else if (page === 'research') {
        try {
          sessionStorage.setItem('research_prefill_company', name);
          if (_data.notes_list && _data.notes_list.length) {
            var combined = _data.notes_list.map(function (n) { return '## ' + n.title + '\n' + n.content; }).join('\n\n---\n\n');
            sessionStorage.setItem('research_prefill_context', combined);
          }
        } catch (e) { /* ignore */ }
      } else if (page === 'demo-planner') {
        try { sessionStorage.setItem('demo_prefill_company', name); } catch (e) { /* ignore */ }
      } else if (page === 'next-steps') {
        try { sessionStorage.setItem('nextsteps_prefill_company', name); } catch (e) { /* ignore */ }
      } else if (page === 'precall-brief') {
        try { sessionStorage.setItem('precall_prefill', JSON.stringify({ company_name: name })); } catch (e) { /* ignore */ }
      }
      navigateTo(page);
    },

    editCompany: function () {
      if (!_data || !_data.company.is_defined) return;
      companiesPage.showList();
      setTimeout(function () { companiesPage.editCompany(_data.company.id); }, 150);
    },

    deleteCompany: async function () {
      if (!_data || !_data.company.is_defined) return;
      if (!confirm('Delete company "' + _data.company.name + '"? This will NOT delete the underlying resources.')) return;
      try {
        await API.deleteCompany(_data.company.id);
        companiesPage.showList();
      } catch (e) {
        alert('Error deleting company: ' + e.message);
      }
    },

    refreshSnapshot: function () {
      _snapshot = null;
      _snapshotLoading = false;
      generateSnapshotFresh();
    },

    toggleNoteForm: toggleNoteForm,
    onNoteFileChange: onNoteFileChange,
    saveNote: saveNote,
    deleteNote: deleteNoteById,
    toggleNoteExpand: toggleNoteExpand,
    updateNoteDate: updateNoteDate,

    toggleSlackForm: toggleSlackForm,
    saveSlackSummary: saveSlackSummary,

    sendChat: async function () {
      if (_chatState.sending) return;
      var input = document.getElementById('cdChatInput');
      var btn = document.getElementById('cdChatSend');
      if (!input) return;
      var msg = input.value.trim();
      if (!msg) return;

      _chatState.sending = true;
      input.disabled = true;
      if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }

      var msgEl = document.getElementById('cdChatMessages');
      if (msgEl) {
        var emptyEl = msgEl.querySelector('.chat-empty');
        if (emptyEl) emptyEl.remove();
        msgEl.insertAdjacentHTML('beforeend',
          '<div class="chat-msg chat-msg-user">' + MD.escapeHtml(msg) + '</div>' +
          '<div class="chat-msg chat-msg-assistant chat-msg-loading"><span class="spinner"></span> Thinking\u2026</div>'
        );
        msgEl.scrollTop = msgEl.scrollHeight;
      }
      input.value = '';

      try {
        var result = await API.companyChatSend(_data.company.name, msg, _chatState.conversationId);
        _chatState.conversationId = result.conversation_id;
        if (msgEl) {
          var loader = msgEl.querySelector('.chat-msg-loading');
          if (loader) loader.remove();
          var content = window.marked ? marked.parse(result.response || '') : MD.escapeHtml(result.response || '');
          msgEl.insertAdjacentHTML('beforeend', '<div class="chat-msg chat-msg-assistant">' + content + '</div>');
          msgEl.scrollTop = msgEl.scrollHeight;
        }
        loadChatConversations();
      } catch (e) {
        if (msgEl) {
          var loader = msgEl.querySelector('.chat-msg-loading');
          if (loader) loader.remove();
          msgEl.insertAdjacentHTML('beforeend', '<div class="chat-msg chat-msg-assistant" style="color:var(--red);">Error: ' + MD.escapeHtml(e.message) + '</div>');
        }
      } finally {
        _chatState.sending = false;
        input.disabled = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
        input.focus();
      }
    },

    switchConversation: function (conversationId) {
      loadConversation(conversationId || null);
    },

    newChat: function () {
      _chatState.conversationId = null;
      var sel = document.getElementById('cdChatConvSelect');
      if (sel) sel.value = '';
      renderChatMessages([]);
      var input = document.getElementById('cdChatInput');
      if (input) { input.value = ''; input.focus(); }
    },
  };
})();
