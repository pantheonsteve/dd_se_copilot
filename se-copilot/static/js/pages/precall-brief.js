/**
 * Pre-Call Brief Generator page — with save, load, and proper PDF export.
 */
window.preCallPage = (function () {
  let _initialized = false;
  let _current = null;       // the brief object currently displayed
  let _savedId = null;       // DB id once the brief has been saved
  let _companies = [];       // cached list of defined companies for the datalist

  const CALL_TYPE_LABELS = {
    discovery:            { label: 'Discovery',           icon: '🔍' },
    followup:             { label: 'Follow-Up',            icon: '🔄' },
    technical_deep_dive:  { label: 'Technical Deep Dive',  icon: '🔧' },
    exec_briefing:        { label: 'Exec Briefing',        icon: '📊' },
    poc_kickoff:          { label: 'POC Kickoff',          icon: '🚀' },
    poc_review:           { label: 'POC Review',           icon: '✅' },
    champion_checkin:     { label: 'Champion Check-In',    icon: '🤝' },
    commercial:           { label: 'Commercial',           icon: '💰' },
  };

  // -----------------------------------------------------------------------
  // Render shell — demo-layout with sidebar for saved briefs
  // -----------------------------------------------------------------------

  function render() {
    const el = document.getElementById('page-precall-brief');
    el.innerHTML =
      '<div class="demo-layout" id="pcLayout" style="align-items:flex-start;">' +

        // Sidebar
        '<div class="plans-sidebar">' +
          '<div class="card">' +
            '<p class="section-title">Saved Briefs</p>' +
            '<div id="pcSavedList"><span class="empty">Loading…</span></div>' +
          '</div>' +
        '</div>' +

        // Main column
        '<div>' +

          // Form card
          '<div class="card" id="pcFormCard">' +
            '<h2 style="font-size:1.1rem;font-weight:700;margin-bottom:.25rem;">Pre-Call Brief Generator</h2>' +
            '<p style="font-size:.85rem;color:var(--text-muted);margin-bottom:1.25rem;">Generate a tight, one-page brief for your next customer call. Automatically pulls from saved hypothesis, call notes, and demo plans.</p>' +

            '<div class="form-row">' +
              '<div class="field grow">' +
                '<label for="pcCompany">Company Name <span style="color:var(--red)">*</span></label>' +
                '<div style="position:relative;">' +
                  '<input type="text" id="pcCompany" placeholder="e.g. Acme Corp" autocomplete="off" list="pcCompanyList" style="padding-right:2rem;">' +
                  '<datalist id="pcCompanyList"></datalist>' +
                  '<span id="pcCompanyIndicator" style="position:absolute;right:.6rem;top:50%;transform:translateY(-50%);font-size:.75rem;display:none;"></span>' +
                '</div>' +
              '</div>' +
              '<div class="field" style="min-width:220px;">' +
                '<label for="pcCallType">Call Type <span style="color:var(--red)">*</span></label>' +
                '<select id="pcCallType">' +
                  '<option value="">Select call type…</option>' +
                  '<option value="discovery">🔍 Discovery</option>' +
                  '<option value="followup">🔄 Follow-Up</option>' +
                  '<option value="technical_deep_dive">🔧 Technical Deep Dive</option>' +
                  '<option value="exec_briefing">📊 Exec Briefing</option>' +
                  '<option value="poc_kickoff">🚀 POC Kickoff</option>' +
                  '<option value="poc_review">✅ POC Review</option>' +
                  '<option value="champion_checkin">🤝 Champion Check-In</option>' +
                  '<option value="commercial">💰 Commercial</option>' +
                '</select>' +
              '</div>' +
            '</div>' +

            '<div class="form-row" style="margin-top:.75rem;">' +
              '<div class="field grow">' +
                '<label for="pcAttendees">Attendees <span style="text-transform:none;font-weight:400;font-size:.72rem;color:var(--text-muted);">(one per line)</span></label>' +
                '<textarea id="pcAttendees" rows="2" placeholder="Sarah Chen - VP Engineering&#10;John Doe - Staff SRE"></textarea>' +
              '</div>' +
            '</div>' +

            '<div class="form-row" style="margin-top:.75rem;">' +
              '<div class="field grow">' +
                '<label for="pcObjective">Your Goal for This Call <span style="text-transform:none;font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>' +
                '<input type="text" id="pcObjective" placeholder="e.g. Confirm POC success criteria and identify the economic buyer" autocomplete="off">' +
              '</div>' +
            '</div>' +

            '<div class="form-row" style="margin-top:.75rem;">' +
              '<div class="field grow">' +
                '<label for="pcContext">Additional Context <span style="text-transform:none;font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>' +
                '<textarea id="pcContext" rows="2" placeholder="e.g. Champion is presenting to CTO next week. Pricing came up last call."></textarea>' +
              '</div>' +
            '</div>' +

            '<div style="margin-top:1rem;">' +
              '<button class="btn btn-primary" id="pcGenBtn">Generate Brief</button>' +
            '</div>' +
            '<div id="pcFormError" style="display:none;margin-top:.5rem;color:var(--red);font-size:.82rem;font-weight:600;"></div>' +
          '</div>' +

          // Loading card
          '<div class="card" id="pcLoadingCard" style="display:none;">' +
            '<div class="hyp-progress">' +
              '<div class="hyp-step active" id="pcLoadStep">' +
                '<span class="hyp-step-icon"><span class="spinner"></span></span>' +
                '<span class="hyp-step-label">Pulling artifacts for this company…</span>' +
              '</div>' +
            '</div>' +
          '</div>' +

          // Results
          '<div id="pcResults" style="display:none;"></div>' +

        '</div>' +
      '</div>';

    document.getElementById('pcGenBtn').addEventListener('click', generate);
    document.getElementById('pcCompany').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') generate();
    });
    document.getElementById('pcCompany').addEventListener('input', onCompanyInput);
  }

  // -----------------------------------------------------------------------
  // Load companies into datalist
  // -----------------------------------------------------------------------

  async function loadCompanies() {
    try {
      var data = await API.listCompanies();
      _companies = (data.companies || []).filter(function (c) { return c.is_defined; });
      var dl = document.getElementById('pcCompanyList');
      if (!dl) return;
      dl.innerHTML = _companies.map(function (c) {
        return '<option value="' + MD.escapeHtml(c.name) + '"></option>';
      }).join('');
    } catch (e) {
      // non-fatal — free text still works
    }
  }

  function onCompanyInput() {
    var val = document.getElementById('pcCompany').value.trim();
    var indicator = document.getElementById('pcCompanyIndicator');
    if (!indicator) return;
    var match = _companies.find(function (c) {
      return c.name.toLowerCase() === val.toLowerCase();
    });
    if (match) {
      indicator.textContent = '✓';
      indicator.style.color = 'var(--green)';
      indicator.style.display = '';
      indicator.title = 'Matched: ' + match.name + ' — will auto-link on save';
    } else if (val.length > 0) {
      indicator.textContent = '+';
      indicator.style.color = 'var(--text-muted)';
      indicator.style.display = '';
      indicator.title = 'New company — brief will not be auto-linked';
    } else {
      indicator.style.display = 'none';
    }
  }

  // -----------------------------------------------------------------------
  // Generate
  // -----------------------------------------------------------------------

  async function generate() {
    var company  = document.getElementById('pcCompany').value.trim();
    var callType = document.getElementById('pcCallType').value;
    if (!company)  { showError('Company name is required.'); return; }
    if (!callType) { showError('Please select a call type.'); return; }

    var attendeesRaw = document.getElementById('pcAttendees').value.trim();
    var attendees    = attendeesRaw ? attendeesRaw.split('\n').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    var objective    = document.getElementById('pcObjective').value.trim();
    var context      = document.getElementById('pcContext').value.trim();

    hideError();
    _savedId = null;
    showLoading('Pulling artifacts for this company…');

    var ctLabel = (CALL_TYPE_LABELS[callType] || { label: callType }).label;
    var stepMsgs = [
      'Reading hypothesis and tech stack data…',
      'Analyzing recent call notes…',
      'Applying ' + ctLabel + ' call type instructions…',
      'Generating your brief…',
    ];
    var stepIdx = 0;
    var stepInterval = setInterval(function () {
      stepIdx = Math.min(stepIdx + 1, stepMsgs.length - 1);
      var el = document.getElementById('pcLoadStep');
      if (el) el.querySelector('.hyp-step-label').textContent = stepMsgs[stepIdx];
    }, 2000);

    try {
      var resp = await API.generatePreCallBrief({
        company_name:       company,
        call_type:          callType,
        attendees:          attendees,
        call_objective:     objective,
        additional_context: context,
      });

      clearInterval(stepInterval);
      _current = Object.assign({}, resp, { _company: company, _callType: callType });
      showResults(_current);
    } catch (err) {
      clearInterval(stepInterval);
      showError('Failed to generate brief: ' + err.message);
      hideLoading();
    }
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  async function saveBrief() {
    if (!_current) return;
    var saveBtn = document.getElementById('pcSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
      var result = await API.savePreCallBrief(_current);
      _savedId = result.id;
      if (saveBtn) { saveBtn.textContent = '✓ Saved'; saveBtn.disabled = true; }
      // Enable the PDF button now that we have a saved ID
      var pdfBtn = document.getElementById('pcPdfBtn');
      if (pdfBtn) {
        pdfBtn.disabled = false;
        pdfBtn.removeAttribute('title');
        pdfBtn.style.opacity = '';
        pdfBtn.style.cursor = '';
      }
      loadSavedList();
    } catch (err) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Brief'; }
      alert('Failed to save: ' + err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Saved list
  // -----------------------------------------------------------------------

  async function loadSavedList() {
    var el = document.getElementById('pcSavedList');
    if (!el) return;
    try {
      var data = await API.listPreCallBriefs();
      var items = data.briefs || [];
      if (!items.length) {
        el.innerHTML = '<span class="empty">No saved briefs</span>';
        return;
      }
      el.innerHTML = items.map(function (b) {
        var ctInfo = CALL_TYPE_LABELS[b.call_type] || { label: b.call_type, icon: '📋' };
        return (
          '<div class="plan-item" data-id="' + b.id + '">' +
            '<div class="plan-item-main" onclick="window.preCallPage.loadBrief(\'' + b.id + '\')">' +
              '<span class="plan-item-title">' + MD.escapeHtml(b.company_name) + '</span>' +
              '<span class="plan-item-meta">' + MD.formatDate(b.created_at) + ' &middot; ' + ctInfo.icon + ' ' + MD.escapeHtml(ctInfo.label) + '</span>' +
            '</div>' +
            '<button class="plan-item-del" onclick="event.stopPropagation();window.preCallPage.deleteBrief(\'' + b.id + '\')" title="Delete">&times;</button>' +
          '</div>'
        );
      }).join('');
    } catch (e) {
      el.innerHTML = '<span class="empty">Failed to load</span>';
    }
  }

  async function loadBrief(id) {
    try {
      var data = await API.getPreCallBrief(id);
      if (!data || data.error) return;
      _current = data;
      _savedId = id;
      showResults(_current, true /* already saved */);
    } catch (e) { /* ignore */ }
  }

  async function deleteBrief(id) {
    if (!confirm('Delete this saved brief?')) return;
    try {
      await API.deletePreCallBrief(id);
      if (_savedId === id) showForm();
      loadSavedList();
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Results rendering
  // -----------------------------------------------------------------------

  function esc(s) { return MD.escapeHtml(String(s || '')); }

  function bulletList(items, icon) {
    if (!items || !items.length) return '<p style="color:var(--text-muted);font-size:.85rem;">None identified.</p>';
    return items.map(function (item) {
      return (
        '<div style="display:flex;gap:.5rem;padding:.3rem 0;border-bottom:1px solid var(--border);font-size:.85rem;">' +
          (icon ? '<span style="flex-shrink:0;">' + icon + '</span>' : '') +
          '<span>' + esc(item) + '</span>' +
        '</div>'
      );
    }).join('');
  }

  function sectionCard(heading, bodyHtml, accentColor) {
    var hStyle = accentColor ? 'color:' + accentColor + ';' : '';
    return (
      '<div class="card" style="margin-top:.75rem;">' +
        '<p class="section-title" style="margin-bottom:.6rem;' + hStyle + '">' + heading + '</p>' +
        bodyHtml +
      '</div>'
    );
  }

  function showResults(resp, alreadySaved) {
    hideLoading();
    document.getElementById('pcFormCard').style.display = 'none';

    var ctType = resp.call_type || resp._callType || '';
    var ctInfo = CALL_TYPE_LABELS[ctType] || { label: ctType, icon: '📞' };
    var processSec = resp.processing_time_ms ? (resp.processing_time_ms / 1000).toFixed(1) : null;
    var companyName = esc(resp.company_name || resp._company || '');

    // Save / PDF button states
    var saveLabel  = alreadySaved ? '✓ Saved' : 'Save Brief';
    var saveDisabled = alreadySaved ? 'disabled' : '';
    var pdfDisabled  = alreadySaved ? '' : 'disabled';
    var pdfTitle     = alreadySaved ? '' : ' title="Save the brief first to export PDF"';

    // Title bar
    var titleBar =
      '<div class="res-title-bar">' +
        '<div class="res-title-row">' +
          '<h2 class="res-report-title">' + ctInfo.icon + ' ' + esc(ctInfo.label) + ' Brief: ' + companyName + '</h2>' +
          '<div class="res-title-actions">' +
            '<button class="btn btn-secondary btn-sm" onclick="window.preCallPage.showForm()">+ New Brief</button>' +
            '<button class="btn btn-secondary btn-sm" id="pcSaveBtn" ' + saveDisabled + ' onclick="window.preCallPage.saveBrief()">' + saveLabel + '</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="window.preCallPage.copyMarkdown()">Copy MD</button>' +
            '<button class="btn btn-primary btn-sm" id="pcPdfBtn" ' + pdfDisabled + pdfTitle + ' onclick="window.preCallPage.exportPdf()"' + (alreadySaved ? '' : ' style="opacity:.5;cursor:not-allowed"') + '>Export PDF</button>' +
          '</div>' +
        '</div>' +
        '<div class="meta-bar" style="margin-top:.4rem;">' +
          '<span class="badge route">' + esc(ctInfo.label) + '</span>' +
          (processSec ? '<span class="badge time">' + processSec + 's</span>' : '') +
          (!alreadySaved ? '<span style="font-size:.75rem;color:var(--amber);">⚠ Unsaved — click "Save Brief" to persist and enable PDF export</span>' : '') +
        '</div>' +
      '</div>';

    // North star
    var northStar =
      '<div class="card" style="margin-top:.75rem;border:2px solid var(--brand);background:var(--brand-light);">' +
        '<p class="section-title" style="color:var(--brand);margin-bottom:.4rem;">⭐ North Star — What Makes This Call a Win</p>' +
        '<p style="font-size:.98rem;font-weight:600;color:var(--text);line-height:1.5;">' + esc(resp.north_star || 'No north star generated.') + '</p>' +
      '</div>';

    // Situation
    var situation =
      '<div class="card" style="margin-top:.75rem;">' +
        '<p class="section-title" style="margin-bottom:.5rem;">📍 Where We Are</p>' +
        '<p style="font-size:.88rem;line-height:1.65;">' + esc(resp.situation_summary || '') + '</p>' +
      '</div>';

    // Know / don't know
    var knowDontKnow =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.75rem;">' +
        '<div class="card" style="margin:0;">' +
          '<p class="section-title" style="color:var(--green);margin-bottom:.5rem;">✅ What We Know</p>' +
          bulletList(resp.what_we_know) +
        '</div>' +
        '<div class="card" style="margin:0;">' +
          '<p class="section-title" style="color:var(--amber);margin-bottom:.5rem;">❓ What We Don\'t Know</p>' +
          bulletList(resp.what_we_dont_know) +
        '</div>' +
      '</div>';

    // Objectives
    var objectives = resp.call_objectives || [];
    var objHtml = objectives.length
      ? objectives.map(function (obj, i) {
          return (
            '<div style="display:flex;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--border);font-size:.88rem;align-items:flex-start;">' +
              '<span style="flex-shrink:0;font-weight:700;color:var(--brand);min-width:20px;">' + (i + 1) + '.</span>' +
              '<span>' + esc(obj) + '</span>' +
            '</div>'
          );
        }).join('')
      : '<p style="color:var(--text-muted);font-size:.85rem;">No objectives generated.</p>';

    // Questions
    var questions = resp.questions_to_ask || [];
    var qHtml = questions.length
      ? questions.map(function (q, i) {
          var followup = q.follow_up_if
            ? '<p style="font-size:.78rem;color:var(--text-muted);background:var(--bg);padding:.2rem .45rem;border-radius:4px;display:inline-block;margin-top:.1rem;">💬 ' + esc(q.follow_up_if) + '</p>'
            : '';
          return (
            '<div style="display:flex;gap:.75rem;padding:.75rem 0;border-bottom:1px solid var(--border);">' +
              '<div style="flex-shrink:0;width:28px;height:28px;border-radius:50%;background:var(--brand-light);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:800;">Q' + (i + 1) + '</div>' +
              '<div style="flex:1;">' +
                '<p style="font-size:.9rem;font-weight:600;font-style:italic;margin-bottom:.2rem;">"' + esc(q.question) + '"</p>' +
                '<p style="font-size:.82rem;color:var(--text-muted);margin-bottom:.1rem;">→ ' + esc(q.strategic_purpose) + '</p>' +
                followup +
              '</div>' +
            '</div>'
          );
        }).join('')
      : '<p style="color:var(--text-muted);font-size:.85rem;">No questions generated.</p>';

    // Attendees
    var attendees = resp.attendee_prep || [];
    var attHtml = attendees.length
      ? attendees.map(function (a) {
          return (
            '<div style="padding:.6rem 0;border-bottom:1px solid var(--border);">' +
              '<p style="font-weight:700;font-size:.9rem;margin-bottom:.2rem;">' +
                esc(a.name) +
                '<span style="font-weight:400;color:var(--text-muted);font-size:.78rem;margin-left:.4rem;">' + esc(a.inferred_role) + '</span>' +
              '</p>' +
              '<p style="font-size:.83rem;margin-bottom:.15rem;">🎯 ' + esc(a.what_they_care_about) + '</p>' +
              '<p style="font-size:.83rem;color:var(--text-muted);">💡 ' + esc(a.how_to_engage) + '</p>' +
            '</div>'
          );
        }).join('')
      : '<p style="color:var(--text-muted);font-size:.85rem;">No attendees specified.</p>';

    // Proof points + avoid
    var proofAvoid =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.75rem;">' +
        '<div class="card" style="margin:0;">' +
          '<p class="section-title" style="margin-bottom:.5rem;">💎 Key Proof Points</p>' +
          bulletList(resp.key_proof_points, '📌') +
        '</div>' +
        '<div class="card" style="margin:0;">' +
          '<p class="section-title" style="color:var(--red);margin-bottom:.5rem;">🚫 Things to Avoid</p>' +
          bulletList(resp.things_to_avoid, '⚠️') +
        '</div>' +
      '</div>';

    document.getElementById('pcResults').innerHTML =
      titleBar +
      northStar +
      situation +
      knowDontKnow +
      sectionCard('🎯 Call Objectives', objHtml) +
      sectionCard('❓ Questions to Ask', qHtml) +
      sectionCard('👥 Attendee Prep', attHtml) +
      proofAvoid;

    document.getElementById('pcResults').style.display = '';
  }

  // -----------------------------------------------------------------------
  // Export PDF — requires brief to be saved first
  // -----------------------------------------------------------------------

  async function exportPdf() {
    if (!_savedId) {
      alert('Please save the brief before exporting PDF.');
      return;
    }
    var pdfBtn = document.getElementById('pcPdfBtn');
    if (pdfBtn) { pdfBtn.disabled = true; pdfBtn.textContent = 'Generating…'; }
    try {
      API.openPreCallBriefPdf(_savedId);
    } finally {
      // Re-enable after a short delay to allow the download to initiate
      setTimeout(function () {
        if (pdfBtn) { pdfBtn.disabled = false; pdfBtn.textContent = 'Export PDF'; }
      }, 2000);
    }
  }

  // -----------------------------------------------------------------------
  // Copy Markdown
  // -----------------------------------------------------------------------

  function copyMarkdown() {
    if (!_current) return;
    var r = _current;
    var ctInfo = CALL_TYPE_LABELS[r.call_type || r._callType] || { label: r.call_type || '' };
    var md = '# ' + ctInfo.label + ' Brief: ' + (r.company_name || r._company) + '\n\n';
    md += '**North Star:** ' + (r.north_star || '') + '\n\n';
    md += '## Where We Are\n' + (r.situation_summary || '') + '\n\n';
    if (r.call_objectives && r.call_objectives.length) {
      md += '## Call Objectives\n';
      r.call_objectives.forEach(function (o, i) { md += (i + 1) + '. ' + o + '\n'; });
      md += '\n';
    }
    if (r.what_we_know && r.what_we_know.length) {
      md += '## What We Know\n';
      r.what_we_know.forEach(function (i) { md += '- ✅ ' + i + '\n'; });
      md += '\n';
    }
    if (r.what_we_dont_know && r.what_we_dont_know.length) {
      md += "## What We Don't Know\n";
      r.what_we_dont_know.forEach(function (i) { md += '- ❓ ' + i + '\n'; });
      md += '\n';
    }
    if (r.questions_to_ask && r.questions_to_ask.length) {
      md += '## Questions to Ask\n\n';
      r.questions_to_ask.forEach(function (q, i) {
        md += '**Q' + (i + 1) + ':** "' + q.question + '"\n';
        md += '_→ ' + q.strategic_purpose + '_\n';
        if (q.follow_up_if) md += '_💬 ' + q.follow_up_if + '_\n';
        md += '\n';
      });
    }
    if (r.attendee_prep && r.attendee_prep.length) {
      md += '## Attendee Prep\n\n';
      r.attendee_prep.forEach(function (a) {
        md += '**' + a.name + '** (' + a.inferred_role + ')\n';
        md += '- 🎯 ' + a.what_they_care_about + '\n';
        md += '- 💡 ' + a.how_to_engage + '\n\n';
      });
    }
    if (r.key_proof_points && r.key_proof_points.length) {
      md += '## Key Proof Points\n';
      r.key_proof_points.forEach(function (p) { md += '- 📌 ' + p + '\n'; });
      md += '\n';
    }
    if (r.things_to_avoid && r.things_to_avoid.length) {
      md += '## Things to Avoid\n';
      r.things_to_avoid.forEach(function (t) { md += '- ⚠️ ' + t + '\n'; });
    }
    navigator.clipboard.writeText(md).catch(function () {});
  }

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------

  function showLoading(msg) {
    document.getElementById('pcLoadingCard').style.display = '';
    var step = document.getElementById('pcLoadStep');
    if (step) step.querySelector('.hyp-step-label').textContent = msg || 'Working…';
  }

  function hideLoading() {
    document.getElementById('pcLoadingCard').style.display = 'none';
  }

  function showError(msg) {
    var el = document.getElementById('pcFormError');
    if (el) { el.textContent = msg; el.style.display = ''; }
    hideLoading();
  }

  function hideError() {
    var el = document.getElementById('pcFormError');
    if (el) el.style.display = 'none';
  }

  function showForm() {
    document.getElementById('pcFormCard').style.display = '';
    document.getElementById('pcLoadingCard').style.display = 'none';
    document.getElementById('pcResults').style.display = 'none';
    _current = null;
    _savedId = null;
  }

  function prefill(companyName, callType) {
    showForm();
    var ci = document.getElementById('pcCompany');
    if (ci) {
      ci.value = companyName || '';
      onCompanyInput(); // update the match indicator
    }
    if (callType) {
      var ct = document.getElementById('pcCallType');
      if (ct) ct.value = callType;
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function injectBreadcrumb() {
    var container = document.getElementById("page-precall-brief");
    var existing = container.querySelector(".company-breadcrumb");
    if (existing) existing.remove();
    var html = window.renderCompanyBreadcrumb ? window.renderCompanyBreadcrumb("Pre-Call Brief") : "";
    if (html) container.insertAdjacentHTML("afterbegin", html);
  }

  return {
    init: function () {
      if (!_initialized) {
        render();
        _initialized = true;
      }
      injectBreadcrumb();
      loadSavedList();
      loadCompanies();
      try {
        var pre = sessionStorage.getItem('precall_prefill');
        if (pre) {
          sessionStorage.removeItem('precall_prefill');
          var data = JSON.parse(pre);
          prefill(data.company_name, data.call_type);
        }
      } catch (e) { /* ignore */ }
    },
    showForm:     showForm,
    saveBrief:    saveBrief,
    loadBrief:    loadBrief,
    deleteBrief:  deleteBrief,
    copyMarkdown: copyMarkdown,
    exportPdf:    exportPdf,
    prefill:      prefill,
  };
})();
