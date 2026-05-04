/**
 * Companies page — unified view of defined + auto-discovered companies.
 */
window.companiesPage = (function () {
  let _companies = [];
  let _showingForm = false;
  let _editingId = null;

  // -----------------------------------------------------------------------
  // Top-level render
  // -----------------------------------------------------------------------

  function render() {
    const el = document.getElementById("page-companies");
    el.innerHTML =
      '<div class="companies-header">' +
        '<div class="companies-search-row">' +
          '<input type="text" id="companyFilter" class="input" placeholder="Filter companies..." autocomplete="off">' +
          '<span id="companyCount" class="company-count"></span>' +
          '<button class="btn btn-sm btn-primary" id="btnNewCompany">+ New Company</button>' +
        '</div>' +
      '</div>' +
      '<div id="companyFormArea"></div>' +
      '<div id="companiesGrid" class="companies-grid">' +
        '<div class="empty">Loading companies\u2026</div>' +
      '</div>';

    document.getElementById("companyFilter").addEventListener("input", applyFilter);
    document.getElementById("btnNewCompany").addEventListener("click", function () {
      _editingId = null;
      showForm();
    });
  }

  // -----------------------------------------------------------------------
  // Company create / edit form
  // -----------------------------------------------------------------------

  function showForm(existing) {
    _showingForm = true;
    var name = existing ? existing.name : "";
    var domain = existing ? (existing.domain || "") : "";
    var notes = existing ? (existing.notes || "") : "";
    var heading = existing ? "Edit Company" : "New Company";
    var submitLabel = existing ? "Save Changes" : "Create Company";

    document.getElementById("companyFormArea").innerHTML =
      '<div class="company-form-card">' +
        '<h3>' + heading + '</h3>' +
        '<div class="form-row">' +
          '<label>Name <span class="required">*</span></label>' +
          '<input type="text" id="cfName" class="input" value="' + MD.escapeHtml(name) + '" placeholder="e.g. Acme Corp" autocomplete="off">' +
        '</div>' +
        '<div class="form-row">' +
          '<label>Domain</label>' +
          '<input type="text" id="cfDomain" class="input" value="' + MD.escapeHtml(domain) + '" placeholder="e.g. acme.com" autocomplete="off">' +
        '</div>' +
        '<div class="form-row">' +
          '<label>Notes</label>' +
          '<textarea id="cfNotes" class="input" rows="2" placeholder="Optional notes about this company">' + MD.escapeHtml(notes) + '</textarea>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-sm btn-primary" id="cfSubmit">' + submitLabel + '</button>' +
          '<button class="btn btn-sm btn-outline" id="cfCancel">Cancel</button>' +
        '</div>' +
      '</div>';

    document.getElementById("cfSubmit").addEventListener("click", submitForm);
    document.getElementById("cfCancel").addEventListener("click", hideForm);
    document.getElementById("cfName").focus();
  }

  function hideForm() {
    _showingForm = false;
    _editingId = null;
    document.getElementById("companyFormArea").innerHTML = "";
  }

  async function submitForm() {
    var name = document.getElementById("cfName").value.trim();
    if (!name) { alert("Company name is required."); return; }
    var domain = document.getElementById("cfDomain").value.trim();
    var notes = document.getElementById("cfNotes").value.trim();

    var btn = document.getElementById("cfSubmit");
    btn.disabled = true;
    btn.textContent = "Saving\u2026";

    try {
      if (_editingId) {
        await API.updateCompany(_editingId, { name: name, domain: domain, notes: notes });
      } else {
        await API.createCompany({ name: name, domain: domain, notes: notes });
      }
      hideForm();
      await load();
    } catch (e) {
      alert("Error: " + e.message);
      btn.disabled = false;
      btn.textContent = _editingId ? "Save Changes" : "Create Company";
    }
  }

  // -----------------------------------------------------------------------
  // Card rendering
  // -----------------------------------------------------------------------

  function artifactTag(type, label, count) {
    if (!count) return "";
    var badge = count > 1 ? ' <span class="artifact-count">' + count + "</span>" : "";
    return '<span class="artifact-tag tag-' + type + '">' + label + badge + "</span>";
  }

  function renderCompanies(list) {
    var grid = document.getElementById("companiesGrid");
    if (!list.length) {
      grid.innerHTML = '<div class="empty">No companies found. Create a company or generate artifacts to see companies here.</div>';
      return;
    }

    grid.innerHTML = list.map(function (c) {
      var hypCount = (c.hypotheses || []).length;
      var repCount = (c.reports || []).length;
      var dpCount = (c.demo_plans || []).length;
      var cardKey = c.id || c.key;

      var completeness = 0;
      if (hypCount) completeness++;
      if (repCount) completeness++;
      if (dpCount) completeness++;
      var pct = Math.round((completeness / 3) * 100);

      var cnCount = (c.call_notes || []).length;
      var hrCount = (c.homerun_opportunities || []).length;

      var tags =
        artifactTag("hypothesis", "Hypothesis", hypCount) +
        artifactTag("report", "Strategy", repCount) +
        artifactTag("demo", "Demo Plan", dpCount) +
        artifactTag("call-note", "Call Notes", cnCount) +
        artifactTag("homerun", "Homerun", hrCount);

      var typeBadge = c.is_defined
        ? '<span class="company-type-badge defined">&#x1F4C1; Defined</span>'
        : '<span class="company-type-badge discovered">Auto-discovered</span>';

      var bar =
        '<div class="completeness-bar">' +
        '<div class="completeness-fill" style="width:' + pct + '%"></div>' +
        "</div>" +
        '<span class="completeness-label">' + completeness + "/3 artifacts</span>";

      return (
        '<div class="company-card' + (c.is_defined ? " company-defined" : "") + '" data-key="' + cardKey + '" onclick="companiesPage.openDetail(\'' + cardKey + '\')">' +
          '<div class="company-card-header">' +
            '<div class="company-card-left">' +
              '<div class="company-card-name-row">' +
                '<h3 class="company-card-name">' + MD.escapeHtml(c.name) + "</h3>" +
                typeBadge +
              '</div>' +
              '<div class="company-card-tags">' + tags + "</div>" +
            "</div>" +
            '<div class="company-card-right">' +
              bar +
              '<span class="company-card-activity">' + MD.timeAgo(c.latest_activity) + "</span>" +
              '<span class="company-card-chevron">&#x276F;</span>' +
            "</div>" +
          "</div>" +
        "</div>"
      );
    }).join("");
  }

  // -----------------------------------------------------------------------
  // Filter & load
  // -----------------------------------------------------------------------

  function applyFilter() {
    var q = (document.getElementById("companyFilter").value || "").toLowerCase();
    var filtered = q ? _companies.filter(function (c) { return c.name.toLowerCase().includes(q) || (c.key || "").includes(q); }) : _companies;
    document.getElementById("companyCount").textContent = filtered.length + " compan" + (filtered.length === 1 ? "y" : "ies");
    renderCompanies(filtered);
  }

  async function load() {
    try {
      var data = await API.listCompanies();
      _companies = data.companies || [];
    } catch (e) {
      _companies = [];
    }
    document.getElementById("companyCount").textContent = _companies.length + " compan" + (_companies.length === 1 ? "y" : "ies");
    renderCompanies(_companies);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    init: function () {
      render();
      load();
    },

    showList: function () {
      navigateTo("companies");
    },

    openDetail: function (key) {
      navigateTo("companies/detail/" + key);
    },

    editCompany: function (id) {
      var c = _companies.find(function (co) { return co.id === id; });
      if (!c) return;
      _editingId = id;
      showForm(c);
    },

    deleteCompany: async function (id, name) {
      if (!confirm('Delete company "' + name + '"? This will NOT delete the underlying resources.')) return;
      try {
        await API.deleteCompany(id);
        await load();
      } catch (e) {
        alert("Error deleting company: " + e.message);
      }
    },
  };
})();
