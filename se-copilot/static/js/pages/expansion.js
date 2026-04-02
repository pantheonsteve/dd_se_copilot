/**
 * Expansion Playbook page — input form, progress indicator, timeline output.
 */
window.expansionPage = (function () {
  let initialized = false;
  let _lastResponse = null;
  let _selectedProducts = [];
  let _prefill = null;

  function render() {
    const el = document.getElementById("page-expansion");
    el.innerHTML = `
      <div class="exp-layout" id="expLayout">
        <!-- Saved playbooks sidebar -->
        <div class="plans-sidebar">
          <div class="card">
            <p class="section-title">Saved Playbooks</p>
            <div id="expSavedList"><span class="empty">Loading...</span></div>
          </div>
        </div>

        <!-- Main column -->
        <div class="exp-result-area">
          <!-- Input form -->
          <div class="card exp-form-card" id="expFormCard" style="flex:unset;max-width:none;">
            <form id="expForm">
              <div class="form-row">
                <div class="field grow">
                  <label for="expCompany">Company Name <span class="required">*</span></label>
                  <input type="text" id="expCompany" placeholder="e.g. RTX" required>
                </div>
                <div class="field">
                  <label for="expDomain">Domain <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>
                  <input type="text" id="expDomain" placeholder="e.g. rtx.com">
                </div>
              </div>

              <div class="exp-section-title">Existing Datadog Footprint</div>

              <div class="field">
                <label>Products Currently Deployed</label>
                <div class="exp-chip-container" id="expProductChips" onclick="document.getElementById('expProductInput').focus()">
                  <input type="text" class="exp-chip-input" id="expProductInput" placeholder="Type a product and press Enter...">
                </div>
                <div style="font-size:.72rem;color:var(--text-muted);margin-top:.15rem;">
                  e.g. APM, Infrastructure Monitoring, Log Management, Cloud SIEM
                </div>
              </div>

              <div class="form-row">
                <div class="field grow">
                  <label for="expTeams">Teams / BUs Using Datadog</label>
                  <input type="text" id="expTeams" placeholder="e.g. Platform Engineering, SRE">
                </div>
                <div class="field grow">
                  <label for="expChampions">Known Champion(s)</label>
                  <input type="text" id="expChampions" placeholder="e.g. Jane Smith, VP Engineering">
                </div>
              </div>

              <div class="form-row">
                <div class="field grow">
                  <label for="expSpend">Approximate Spend <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>
                  <input type="text" id="expSpend" placeholder="e.g. $120k/year">
                </div>
                <div class="field grow">
                  <label for="expScope">Deployment Scope <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>
                  <input type="text" id="expScope" placeholder="e.g. Partial — US West only">
                </div>
              </div>

              <div class="exp-section-title">Linked Reports</div>

              <div class="form-row">
                <div class="field grow">
                  <label for="expHypothesis">Sales Hypothesis</label>
                  <select id="expHypothesis"><option value="">None — run fresh research</option></select>
                </div>
                <div class="field grow">
                  <label for="expOverview">Strategic Overview</label>
                  <select id="expOverview"><option value="">None</option></select>
                </div>
              </div>

              <div class="field">
                <label for="expContext">Additional Context <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(AE notes, deal context)</span></label>
                <textarea id="expContext" rows="3" placeholder="Paste any additional context the AE knows about this account..."></textarea>
              </div>

              <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.75rem;">
                <button type="submit" class="btn btn-primary" id="expGenBtn">Generate Expansion Playbook</button>
              </div>
              <div id="expFormError" style="display:none;margin-top:.5rem;color:var(--red);font-size:.82rem;font-weight:600;"></div>
            </form>
          </div>

          <!-- Loading -->
          <div id="expLoading" style="display:none;">
            <div class="card exp-loading">
              <span class="spinner"></span>
              <p><strong>Generating Expansion Playbook...</strong></p>
              <p id="expLoadingStep">Researching company and querying agents...</p>
            </div>
          </div>

          <!-- Results -->
          <div id="expResultCard" style="display:none;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
              <h2 id="expResultTitle" style="margin:0;font-size:1.15rem;"></h2>
              <div class="exp-export-bar">
                <button class="btn btn-secondary btn-sm" onclick="expansionPage.exportMarkdown()">Export Markdown</button>
                <button class="btn btn-secondary btn-sm" onclick="expansionPage.copyMarkdown()">Copy to Clipboard</button>
                <button class="btn btn-sm" onclick="expansionPage.backToForm()">New Playbook</button>
              </div>
            </div>
            <div id="expTimeline"></div>
          </div>
        </div>
      </div>
    `;
  }

  function init() {
    if (!initialized) {
      render();
      initialized = true;

      document.getElementById("expForm").addEventListener("submit", handleSubmit);
      _setupChipInput();
    }
    loadSavedPlaybooks();
    loadLinkedReports();

    if (_prefill) {
      _applyPrefill(_prefill);
      _prefill = null;
    }
  }

  function _setupChipInput() {
    const input = document.getElementById("expProductInput");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const val = input.value.trim().replace(/,/g, "");
        if (val && !_selectedProducts.includes(val)) {
          _selectedProducts.push(val);
          _renderChips();
        }
        input.value = "";
      }
      if (e.key === "Backspace" && !input.value && _selectedProducts.length) {
        _selectedProducts.pop();
        _renderChips();
      }
    });
  }

  function _renderChips() {
    const container = document.getElementById("expProductChips");
    const input = document.getElementById("expProductInput");
    const chips = _selectedProducts.map(function (p, i) {
      return '<span class="exp-chip">' + _esc(p) +
        '<button type="button" class="exp-chip-remove" onclick="expansionPage.removeProduct(' + i + ')">&times;</button></span>';
    }).join("");
    container.innerHTML = chips + '<input type="text" class="exp-chip-input" id="expProductInput" placeholder="' +
      (_selectedProducts.length ? "" : "Type a product and press Enter...") + '">';
    _setupChipInput();
  }

  function removeProduct(idx) {
    _selectedProducts.splice(idx, 1);
    _renderChips();
  }

  function _esc(s) { return (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  async function loadSavedPlaybooks() {
    const el = document.getElementById("expSavedList");
    try {
      const list = await API.listExpansionPlaybooks();
      if (!list.length) {
        el.innerHTML = '<span class="empty">No saved playbooks yet.</span>';
        return;
      }
      el.innerHTML = '<div class="exp-saved-list">' + list.map(function (pb) {
        var dateStr = pb.created_at ? new Date(pb.created_at).toLocaleDateString() : "";
        return '<div class="exp-saved-item" onclick="expansionPage.loadPlaybook(\'' + pb.id + '\')">' +
          '<div class="exp-saved-item-info">' +
            '<div class="exp-saved-item-name">' + _esc(pb.company_name) + '</div>' +
            '<div class="exp-saved-item-meta">' + dateStr + ' &middot; ' + (pb.total_opportunities || 0) + ' opportunities</div>' +
          '</div>' +
          '<button class="btn btn-sm" style="font-size:.7rem;padding:.15rem .4rem;" onclick="event.stopPropagation();expansionPage.deletePlaybook(\'' + pb.id + '\')">Delete</button>' +
        '</div>';
      }).join("") + '</div>';
    } catch (err) {
      el.innerHTML = '<span class="empty">Failed to load.</span>';
    }
  }

  async function loadLinkedReports() {
    try {
      const [hyps, reports] = await Promise.all([
        API.listHypotheses(),
        API.listReports(),
      ]);

      const hypSelect = document.getElementById("expHypothesis");
      if (hypSelect) {
        var opts = '<option value="">None — run fresh research</option>';
        hyps.forEach(function (h) {
          var dateStr = h.created_at ? new Date(h.created_at).toLocaleDateString() : "";
          opts += '<option value="' + h.id + '">' + _esc(h.company_name) + ' (' + dateStr + ')</option>';
        });
        hypSelect.innerHTML = opts;
      }

      const ovSelect = document.getElementById("expOverview");
      if (ovSelect) {
        var opts2 = '<option value="">None</option>';
        reports.forEach(function (r) {
          var label = r.title || r.query || r.id;
          opts2 += '<option value="' + r.id + '">' + _esc(label.substring(0, 60)) + '</option>';
        });
        ovSelect.innerHTML = opts2;
      }
    } catch (_) {}
  }

  async function handleSubmit(e) {
    e.preventDefault();
    var company = document.getElementById("expCompany").value.trim();
    if (!company) return;

    var errEl = document.getElementById("expFormError");
    errEl.style.display = "none";

    var footprint = null;
    var teams = document.getElementById("expTeams").value.trim();
    var champions = document.getElementById("expChampions").value.trim();
    var spend = document.getElementById("expSpend").value.trim();
    var scope = document.getElementById("expScope").value.trim();

    if (_selectedProducts.length || teams || champions || spend || scope) {
      footprint = {
        products: _selectedProducts.slice(),
        teams_using: teams ? teams.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [],
        known_champions: champions ? champions.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [],
        approximate_spend: spend || null,
        deployment_scope: scope || null,
      };
    }

    var payload = {
      company_name: company,
      domain: document.getElementById("expDomain").value.trim() || null,
      existing_footprint: footprint,
      hypothesis_id: document.getElementById("expHypothesis").value || null,
      strategic_overview_id: document.getElementById("expOverview").value || null,
      additional_context: document.getElementById("expContext").value.trim() || null,
    };

    document.getElementById("expFormCard").style.display = "none";
    document.getElementById("expLoading").style.display = "block";
    document.getElementById("expResultCard").style.display = "none";

    _animateProgress();

    try {
      var resp = await API.generateExpansionPlaybook(payload);
      _lastResponse = resp;
      showResults(resp);
      loadSavedPlaybooks();
    } catch (err) {
      document.getElementById("expFormCard").style.display = "block";
      document.getElementById("expLoading").style.display = "none";
      errEl.textContent = "Generation failed: " + err.message;
      errEl.style.display = "block";
    }
  }

  var _progressTimer = null;
  function _animateProgress() {
    var steps = [
      "Researching company and querying agents...",
      "Querying Librarian for product validation...",
      "Analyzing buyer personas and value evidence...",
      "Synthesizing expansion playbook...",
    ];
    var i = 0;
    var el = document.getElementById("expLoadingStep");
    if (el) el.textContent = steps[0];
    _progressTimer = setInterval(function () {
      i++;
      if (i < steps.length && el) el.textContent = steps[i];
      if (i >= steps.length) clearInterval(_progressTimer);
    }, 8000);
  }

  function showResults(resp) {
    if (_progressTimer) clearInterval(_progressTimer);
    document.getElementById("expLoading").style.display = "none";
    document.getElementById("expFormCard").style.display = "none";
    document.getElementById("expResultCard").style.display = "block";

    var pb = resp.playbook || resp;
    document.getElementById("expResultTitle").textContent =
      "Expansion Playbook: " + (pb.company_name || resp.company_name || "");

    PlaybookTimeline.render("expTimeline", pb);
  }

  function backToForm() {
    document.getElementById("expResultCard").style.display = "none";
    document.getElementById("expFormCard").style.display = "block";
  }

  async function loadPlaybook(id) {
    try {
      var resp = await API.getExpansionPlaybook(id);
      if (resp.error) return;
      _lastResponse = resp;
      document.getElementById("expFormCard").style.display = "none";
      document.getElementById("expLoading").style.display = "none";
      document.getElementById("expResultCard").style.display = "block";

      var pb = resp.playbook || {};
      document.getElementById("expResultTitle").textContent =
        "Expansion Playbook: " + (pb.company_name || resp.company_name || "");

      PlaybookTimeline.render("expTimeline", pb);
    } catch (_) {}
  }

  async function deletePlaybook(id) {
    if (!confirm("Delete this playbook?")) return;
    try {
      await API.deleteExpansionPlaybook(id);
      loadSavedPlaybooks();
      if (_lastResponse && (_lastResponse.id === id)) {
        _lastResponse = null;
        document.getElementById("expResultCard").style.display = "none";
        document.getElementById("expFormCard").style.display = "block";
      }
    } catch (_) {}
  }

  function exportMarkdown() {
    if (!_lastResponse) return;
    var pb = _lastResponse.playbook || _lastResponse;
    var md = PlaybookTimeline.toMarkdown(pb);
    var blob = new Blob([md], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "expansion_playbook_" + (pb.company_name || "").replace(/\s+/g, "_") + ".md";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyMarkdown() {
    if (!_lastResponse) return;
    var pb = _lastResponse.playbook || _lastResponse;
    var md = PlaybookTimeline.toMarkdown(pb);
    navigator.clipboard.writeText(md).then(function () {
      var btn = document.querySelector('.exp-export-bar button:nth-child(2)');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = orig; }, 1500);
      }
    });
  }

  function prefill(data) {
    _prefill = data;
  }

  function _applyPrefill(data) {
    if (data.company_name) {
      var el = document.getElementById("expCompany");
      if (el) el.value = data.company_name;
    }
    if (data.domain) {
      var el = document.getElementById("expDomain");
      if (el) el.value = data.domain;
    }
    if (data.hypothesis_id) {
      var el = document.getElementById("expHypothesis");
      if (el) el.value = data.hypothesis_id;
    }
    if (data.strategic_overview_id) {
      var el = document.getElementById("expOverview");
      if (el) el.value = data.strategic_overview_id;
    }
  }

  return {
    init: init,
    removeProduct: removeProduct,
    loadPlaybook: loadPlaybook,
    deletePlaybook: deletePlaybook,
    exportMarkdown: exportMarkdown,
    copyMarkdown: copyMarkdown,
    backToForm: backToForm,
    prefill: prefill,
    showResults: showResults,
  };
})();
