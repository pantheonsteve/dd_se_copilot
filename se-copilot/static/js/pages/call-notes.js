/**
 * Call Notes page — SE framework renderer.
 * Supports .txt and .pdf upload, structured JSON summary, export to markdown.
 */
window.callNotesPage = (function () {
  var _notes = [];
  var _expandedId = null;
  var _expandedData = null;
  var _companies = [];
  var _inputMode = "paste";

  // -----------------------------------------------------------------------
  // Top-level render
  // -----------------------------------------------------------------------

  function render() {
    var el = document.getElementById("page-call-notes");
    el.innerHTML =
      '<div class="cn-layout">' +
        '<div class="cn-form-section">' +
          '<h3>New Call Note</h3>' +
          '<div class="cn-input-toggle">' +
            '<button class="cn-toggle-btn active" id="cnTogglePaste" data-mode="paste">Paste Text</button>' +
            '<button class="cn-toggle-btn" id="cnToggleUpload" data-mode="upload">Upload File</button>' +
          '</div>' +
          '<div id="cnInputArea"></div>' +
          '<div class="form-row" style="margin-top:.6rem">' +
            '<div style="flex:1;min-width:180px">' +
              '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">Title <span class="optional">(optional)</span></label>' +
              '<input type="text" id="cnTitle" class="input" placeholder="e.g. Discovery call with Acme" autocomplete="off">' +
            '</div>' +
            '<div style="flex:1;min-width:180px">' +
              '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">Company <span class="optional">(optional)</span></label>' +
              '<select id="cnCompany" class="input"><option value="">-- None --</option></select>' +
            '</div>' +
          '</div>' +
          '<div class="form-actions" style="margin-top:.8rem">' +
            '<button class="btn btn-primary" id="cnSubmit">Summarize &amp; Save</button>' +
          '</div>' +
          '<div id="cnStatus" class="cn-status" style="display:none"></div>' +
        '</div>' +
        '<div class="cn-list-section">' +
          '<div class="cn-list-header">' +
            '<h3>Saved Call Notes</h3>' +
            '<span id="cnCount" class="company-count"></span>' +
          '</div>' +
          '<div id="cnList" class="cn-list"><div class="empty">Loading\u2026</div></div>' +
        '</div>' +
      '</div>';

    document.getElementById("cnTogglePaste").addEventListener("click", function () { setInputMode("paste"); });
    document.getElementById("cnToggleUpload").addEventListener("click", function () { setInputMode("upload"); });
    document.getElementById("cnSubmit").addEventListener("click", submitNote);
    setInputMode("paste");
  }

  function setInputMode(mode) {
    _inputMode = mode;
    document.querySelectorAll(".cn-toggle-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    var area = document.getElementById("cnInputArea");
    if (mode === "paste") {
      area.innerHTML =
        '<div style="margin-top:.6rem">' +
          '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">Call Transcript / Notes</label>' +
          '<textarea id="cnText" class="input cn-textarea" rows="10" placeholder="Paste your call transcript or notes here\u2026"></textarea>' +
        '</div>';
    } else {
      area.innerHTML =
        '<div style="margin-top:.6rem">' +
          '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">Upload file (.txt or .pdf)</label>' +
          '<div class="cn-drop-zone" id="cnDropZone">' +
            '<input type="file" id="cnFile" accept=".txt,.pdf,text/plain,application/pdf" class="cn-file-input">' +
            '<div class="cn-drop-label">' +
              '<span>Click to choose or drag &amp; drop</span>' +
              '<span class="cn-drop-hint">.txt or .pdf</span>' +
            '</div>' +
          '</div>' +
          '<div id="cnFileName" class="cn-file-name" style="display:none"></div>' +
        '</div>';

      var dropZone = document.getElementById("cnDropZone");
      var fileInput = document.getElementById("cnFile");
      dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("dragover"); });
      dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("dragover"); });
      dropZone.addEventListener("drop", function (e) {
        e.preventDefault(); dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener("change", function () {
        if (fileInput.files.length) handleFileSelect(fileInput.files[0]);
      });
    }
  }

  var _uploadedText = "";

  function handleFileSelect(file) {
    var isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    var isTxt = file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
    if (!isPdf && !isTxt) { alert("Please select a .txt or .pdf file."); return; }

    if (isPdf) {
      // For PDFs, we send the raw binary as base64 and let the server extract text.
      // For now, read as text (most transcript PDFs are text-based).
      var reader = new FileReader();
      reader.onload = function (e) {
        _uploadedText = e.target.result;
        showFileName(file);
      };
      reader.readAsText(file);
    } else {
      var reader = new FileReader();
      reader.onload = function (e) { _uploadedText = e.target.result; showFileName(file); };
      reader.readAsText(file);
    }
  }

  function showFileName(file) {
    var nameEl = document.getElementById("cnFileName");
    if (!nameEl) return;
    nameEl.textContent = file.name + " (" + Math.round(file.size / 1024) + " KB)";
    nameEl.style.display = "block";
  }

  function getTranscriptText() {
    if (_inputMode === "paste") {
      var ta = document.getElementById("cnText");
      return ta ? ta.value.trim() : "";
    }
    return _uploadedText.trim();
  }

  // -----------------------------------------------------------------------
  // Company dropdown
  // -----------------------------------------------------------------------

  async function loadCompanies() {
    try {
      var data = await API.listCompanies();
      _companies = (data.companies || []).filter(function (c) { return c.is_defined; });
    } catch (e) { _companies = []; }
    var sel = document.getElementById("cnCompany");
    if (!sel) return;
    sel.innerHTML = '<option value="">-- None --</option>';
    _companies.forEach(function (c) {
      sel.innerHTML += '<option value="' + c.id + '">' + MD.escapeHtml(c.name) + '</option>';
    });
  }

  // -----------------------------------------------------------------------
  // Submit
  // -----------------------------------------------------------------------

  async function submitNote() {
    var text = getTranscriptText();
    if (!text) { alert("Please enter or upload a call transcript."); return; }

    var title = (document.getElementById("cnTitle").value || "").trim();
    var companyId = document.getElementById("cnCompany").value || "";

    var btn = document.getElementById("cnSubmit");
    btn.disabled = true; btn.textContent = "Summarizing\u2026";

    var status = document.getElementById("cnStatus");
    status.style.display = "block";
    status.className = "cn-status cn-status-loading";
    status.innerHTML = '<span class="spinner"></span> Sending to Claude for analysis\u2026 this may take a moment.';

    try {
      var result = await API.submitCallNote({ raw_transcript: text, title: title, company_id: companyId });
      status.className = "cn-status cn-status-success";
      status.textContent = "Saved and summarized in " + (result.processing_time_ms / 1000).toFixed(1) + "s.";

      if (_inputMode === "paste") { var ta = document.getElementById("cnText"); if (ta) ta.value = ""; }
      else { _uploadedText = ""; setInputMode("upload"); }
      document.getElementById("cnTitle").value = "";
      document.getElementById("cnCompany").value = "";

      await loadNotes();
      _expandedId = result.id; _expandedData = result;
      renderNotes();
    } catch (e) {
      status.className = "cn-status cn-status-error";
      status.textContent = "Error: " + e.message;
    }
    btn.disabled = false; btn.textContent = "Summarize & Save";
  }

  // -----------------------------------------------------------------------
  // List & detail rendering
  // -----------------------------------------------------------------------

  async function loadNotes() {
    try { var data = await API.listCallNotes(); _notes = data.call_notes || []; }
    catch (e) { _notes = []; }
    renderNotes();
  }

  function renderNotes() {
    var container = document.getElementById("cnList");
    var countEl = document.getElementById("cnCount");
    if (countEl) countEl.textContent = _notes.length + " note" + (_notes.length === 1 ? "" : "s");

    if (!_notes.length) {
      container.innerHTML = '<div class="empty">No call notes yet. Submit your first transcript above.</div>';
      return;
    }

    container.innerHTML = _notes.map(function (n) {
      var expanded = _expandedId === n.id;
      var title = n.title || "Untitled Call Note";
      var company = n.company_name ? '<span class="cn-card-company">' + MD.escapeHtml(n.company_name) + '</span>' : '';
      return (
        '<div class="cn-card' + (expanded ? " expanded" : "") + '" data-id="' + n.id + '">' +
          '<div class="cn-card-header" onclick="callNotesPage.toggle(\'' + n.id + '\')">' +
            '<div class="cn-card-left">' +
              '<h4 class="cn-card-title">' + MD.escapeHtml(title) + '</h4>' +
              company +
            '</div>' +
            '<div class="cn-card-right">' +
              '<span class="cn-card-date">' + MD.timeAgo(n.created_at) + '</span>' +
              '<button class="btn-icon btn-icon-danger" title="Delete" onclick="event.stopPropagation();callNotesPage.deleteNote(\'' + n.id + '\')">&#x1F5D1;</button>' +
              '<span class="company-expand-icon">' + (expanded ? "\u25B2" : "\u25BC") + '</span>' +
            '</div>' +
          '</div>' +
          (expanded ? '<div class="cn-card-detail" id="cnDetail-' + n.id + '"></div>' : '') +
        '</div>'
      );
    }).join("");

    if (_expandedId && _expandedData) renderDetail(_expandedId, _expandedData);
    else if (_expandedId) loadAndRenderDetail(_expandedId);
  }

  async function loadAndRenderDetail(id) {
    var detailEl = document.getElementById("cnDetail-" + id);
    if (!detailEl) return;
    detailEl.innerHTML = '<div class="empty" style="padding:1rem">Loading\u2026</div>';
    try {
      var data = await API.getCallNote(id);
      _expandedData = data;
      renderDetail(id, data);
    } catch (e) {
      detailEl.innerHTML = '<div class="empty" style="padding:1rem">Error: ' + MD.escapeHtml(e.message) + '</div>';
    }
  }

  function renderDetail(id, data) {
    var detailEl = document.getElementById("cnDetail-" + id);
    if (!detailEl) return;

    // Parse summary — try JSON first, fall back to markdown
    var summary = null;
    var isJson = false;
    var raw = data.summary_markdown || "";
    try {
      summary = JSON.parse(raw);
      isJson = true;
    } catch (_) { summary = raw; }

    var summaryHtml = isJson ? buildFrameworkHtml(summary, id) : (raw ? MD.render(raw) : '<em>No summary available.</em>');

    detailEl.innerHTML =
      '<div class="cn-detail-tabs">' +
        '<button class="cn-detail-tab active" onclick="callNotesPage.showTab(\'' + id + '\', \'summary\')">Summary</button>' +
        '<button class="cn-detail-tab" onclick="callNotesPage.showTab(\'' + id + '\', \'raw\')">Raw Transcript</button>' +
        '<button class="cn-detail-tab" id="cnDebriefTab-' + id + '" onclick="callNotesPage.showTab(\'' + id + '\', \'debrief\')" style="display:none;">&#x1F4CA; Debrief vs. Brief</button>' +
      '</div>' +
      '<div class="cn-detail-content" id="cnTabContent-' + id + '">' +
        summaryHtml +
      '</div>' +
      '<div class="cn-detail-actions">' +
        '<button class="btn btn-sm btn-secondary" onclick="callNotesPage.exportMarkdown(\'' + id + '\')">&#x2193; Export Markdown</button>' +
        '<button class="btn btn-sm btn-secondary" onclick="callNotesPage.exportPdf(\'' + id + '\')">&#x2193; Export PDF</button>' +
      '</div>' +
      '<div class="cn-detail-meta">' +
        '<span>Processed in ' + (data.processing_time_ms / 1000).toFixed(1) + 's</span>' +
        (data.company_name ? ' &middot; <span>' + MD.escapeHtml(data.company_name) + '</span>' : '') +
      '</div>';

    // Stash for tab switching
    detailEl._summaryHtml = summaryHtml;
    detailEl._rawFull = data.raw_transcript || "";
    detailEl._summaryJson = isJson ? summary : null;
    detailEl._noteData = data;
    detailEl._debriefHtml = null;
    detailEl._debriefBriefId = null;
    detailEl._availableBriefs = [];

    // Async: check if a pre-call brief exists for this company and show debrief tab
    if (data.company_name) {
      checkForMatchingBrief(id, data.company_name, detailEl);
    }
  }

  async function checkForMatchingBrief(noteId, companyName, detailEl) {
    try {
      var resp = await API.getPreCallBriefsByCompany(companyName);
      var briefs = resp.briefs || [];
      if (!briefs.length) return;
      detailEl._availableBriefs = briefs;
      // Reveal the debrief tab
      var tabBtn = document.getElementById('cnDebriefTab-' + noteId);
      if (tabBtn) tabBtn.style.display = '';
    } catch (e) { /* non-fatal */ }
  }

  // -----------------------------------------------------------------------
  // Framework HTML builder
  // -----------------------------------------------------------------------

  function pill(text, color) {
    var c = color || "gray";
    var map = {
      purple: "background:#EEEDFE;color:#534AB7",
      teal:   "background:#E1F5EE;color:#0F6E56",
      coral:  "background:#FAECE7;color:#993C1D",
      blue:   "background:#E6F1FB;color:#185FA5",
      amber:  "background:#FAEEDA;color:#854F0B",
      green:  "background:#EAF3DE;color:#3B6D11",
      red:    "background:#FCEBEB;color:#A32D2D",
      gray:   "background:#F1EFE8;color:#5F5E5A",
    };
    var style = map[c] || map.gray;
    return '<span style="display:inline-block;' + style + ';font-size:11px;font-weight:500;padding:2px 8px;border-radius:4px;margin:2px 2px 2px 0">' + MD.escapeHtml(String(text)) + '</span>';
  }

  function sectionHead(icon, title) {
    return '<div style="font-size:11px;font-weight:500;color:var(--text-muted);letter-spacing:.07em;text-transform:uppercase;margin:1.25rem 0 .6rem;border-top:.5px solid var(--border);padding-top:.9rem">' + icon + ' ' + title + '</div>';
  }

  function card(content) {
    return '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.85rem 1.1rem;margin-bottom:.5rem">' + content + '</div>';
  }

  function infoRow(label, value) {
    if (!value) return "";
    return '<div style="display:flex;gap:8px;margin-bottom:6px"><span style="font-size:12px;color:var(--text-muted);min-width:100px;flex-shrink:0">' + label + '</span><span style="font-size:13px;color:var(--text);font-weight:500">' + MD.escapeHtml(String(value)) + '</span></div>';
  }

  function bulletList(arr) {
    if (!arr || !arr.length) return '<span style="font-size:13px;color:var(--text-muted);font-style:italic">None noted</span>';
    return arr.map(function (item) {
      return '<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:4px;padding-left:12px;position:relative"><span style="position:absolute;left:0;color:var(--text-muted)">&mdash;</span>' + MD.escapeHtml(String(item)) + '</div>';
    }).join("");
  }

  function urgencyColor(u) {
    if (!u) return "gray";
    var l = u.toLowerCase();
    if (l === "high") return "red";
    if (l === "medium") return "amber";
    if (l === "low") return "green";
    return "gray";
  }

  function ownerColor(side) {
    if (!side) return "gray";
    var l = side.toLowerCase();
    if (l === "se") return "coral";
    if (l === "ae") return "purple";
    if (l === "prospect") return "teal";
    return "gray";
  }

  function buildFrameworkHtml(s, id) {
    var html = "";

    // --- 1. Call Context ---
    html += sectionHead("", "Call context");
    var ctx = s.call_context || {};
    html += card(
      infoRow("Date", ctx.date) +
      infoRow("Duration", ctx.duration_estimate) +
      infoRow("Call type", ctx.call_type) +
      infoRow("Deal stage", ctx.deal_stage)
    );

    // --- 2. Stakeholders ---
    html += sectionHead("", "Stakeholders");
    var people = s.stakeholders || [];
    if (!people.length) {
      html += '<div style="font-size:13px;color:var(--text-muted);font-style:italic;margin-bottom:.5rem">No stakeholders identified</div>';
    } else {
      // Two-column grid
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">';
      people.forEach(function (p) {
        var initials = (p.name || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
        var avatarColors = { Prospect: "background:#E1F5EE;color:#085041", Vendor: "background:#FAECE7;color:#712B13", Partner: "background:#E6F1FB;color:#0C447C" };
        var avatarStyle = avatarColors[p.org] || avatarColors["Prospect"];
        var tags = (p.role_tags || []).map(function (t) { return pill(t, "blue"); }).join("");
        html += card(
          '<div style="display:flex;align-items:flex-start;gap:10px">' +
            '<div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;flex-shrink:0;' + avatarStyle + '">' + MD.escapeHtml(initials) + '</div>' +
            '<div style="min-width:0">' +
              '<div style="font-size:14px;font-weight:500;color:var(--text)">' + MD.escapeHtml(p.name || "Unknown") + '</div>' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">' + MD.escapeHtml(p.title || "") + (p.org ? ' &middot; ' + MD.escapeHtml(p.org) : '') + '</div>' +
              '<div style="margin-bottom:4px">' + tags + '</div>' +
              (p.notes ? '<div style="font-size:12px;color:var(--text-muted);line-height:1.4">' + MD.escapeHtml(p.notes) + '</div>' : '') +
            '</div>' +
          '</div>'
        );
      });
      html += '</div>';
    }

    // --- 3. Technical Requirements ---
    html += sectionHead("", "Technical requirements & stack");
    var tech = s.technical_requirements || {};
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">';
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Current stack</div>' + (tech.current_stack && tech.current_stack.length ? tech.current_stack.map(function (t) { return pill(t, "teal"); }).join("") : '<span style="font-size:12px;color:var(--text-muted);font-style:italic">Not mentioned</span>'));
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Technical goals</div>' + bulletList(tech.technical_goals));
    if (tech.infrastructure_notes) {
      html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Infrastructure</div><div style="font-size:13px;color:var(--text);line-height:1.5">' + MD.escapeHtml(tech.infrastructure_notes) + '</div>');
    }
    if (tech.security_compliance && tech.security_compliance.length) {
      html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Security / compliance</div>' + tech.security_compliance.map(function (t) { return pill(t, "coral"); }).join(""));
    }
    html += '</div>';

    // --- 4. Pain Points & Business Drivers ---
    html += sectionHead("", "Pain points & business drivers");
    var pains = s.pain_points || [];
    var drivers = s.business_drivers || {};
    if (pains.length) {
      pains.forEach(function (p) {
        html += '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:.4rem;display:flex;gap:8px;align-items:flex-start">' +
          '<div style="flex:1">' +
            '<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:4px">' + MD.escapeHtml(p.pain || "") + '</div>' +
            (p.impact ? '<div style="font-size:12px;color:var(--text-muted)">' + MD.escapeHtml(p.impact) + '</div>' : '') +
          '</div>' +
          '<div style="flex-shrink:0">' + pill(p.urgency || "Unknown", urgencyColor(p.urgency)) + '</div>' +
        '</div>';
      });
    }
    if (drivers.why_now || drivers.business_context) {
      html += card(
        (drivers.why_now ? '<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:500;color:var(--text-muted)">Why now — </span><span style="font-size:13px;color:var(--text)">' + MD.escapeHtml(drivers.why_now) + '</span></div>' : '') +
        (drivers.business_context ? '<div><span style="font-size:11px;font-weight:500;color:var(--text-muted)">Context — </span><span style="font-size:13px;color:var(--text)">' + MD.escapeHtml(drivers.business_context) + '</span></div>' : '')
      );
    }

    // --- 5. Competitive & Ecosystem ---
    html += sectionHead("", "Competitive & ecosystem");
    var comp = s.competitive_ecosystem || {};
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">';
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Incumbents</div>' + (comp.incumbents && comp.incumbents.length ? comp.incumbents.map(function (t) { return pill(t, "amber"); }).join("") : '<span style="font-size:12px;color:var(--text-muted);font-style:italic">None mentioned</span>'));
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Also evaluating</div>' + (comp.also_evaluating && comp.also_evaluating.length ? comp.also_evaluating.map(function (t) { return pill(t, "red"); }).join("") : '<span style="font-size:12px;color:var(--text-muted);font-style:italic">None mentioned</span>'));
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Required integrations</div>' + (comp.required_integrations && comp.required_integrations.length ? comp.required_integrations.map(function (t) { return pill(t, "purple"); }).join("") : '<span style="font-size:12px;color:var(--text-muted);font-style:italic">None mentioned</span>'));
    html += '</div>';
    if (comp.notes) {
      html += '<div style="font-size:12px;color:var(--text-muted);margin-top:.3rem;margin-bottom:.5rem">' + MD.escapeHtml(comp.notes) + '</div>';
    }

    // --- 6. Decision Criteria ---
    html += sectionHead("", "Decision criteria");
    var dc = s.decision_criteria || {};
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">';
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Must-haves</div>' + bulletList(dc.must_haves));
    html += card('<div style="font-size:11px;font-weight:500;color:var(--text-muted);margin-bottom:6px">Nice-to-haves</div>' + bulletList(dc.nice_to_haves));
    html += '</div>';
    if (dc.success_definition || dc.evaluation_timeline) {
      html += card(
        (dc.success_definition ? infoRow("Success looks like", dc.success_definition) : "") +
        (dc.evaluation_timeline ? infoRow("Timeline", dc.evaluation_timeline) : "")
      );
    }

    // --- 7. Objections ---
    var objections = s.objections || [];
    if (objections.length) {
      html += sectionHead("", "Objections & concerns");
      objections.forEach(function (o) {
        var statusColor = o.status === "Addressed" ? "green" : o.status === "Partially Addressed" ? "amber" : "coral";
        html += '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.7rem 1rem;margin-bottom:.4rem;display:flex;gap:8px;align-items:flex-start">' +
          '<div style="flex:1"><div style="font-size:13px;color:var(--text);line-height:1.5">' + MD.escapeHtml(o.objection || "") + '</div></div>' +
          '<div style="flex-shrink:0;display:flex;flex-direction:column;gap:3px;align-items:flex-end">' +
            pill(o.type || "General", "gray") + pill(o.status || "Raised", statusColor) +
          '</div>' +
        '</div>';
      });
    }

    // --- 8. Next Steps ---
    var steps = s.next_steps || [];
    if (steps.length) {
      html += sectionHead("", "Next steps & action items");
      steps.forEach(function (step) {
        html += '<div style="display:flex;align-items:flex-start;gap:8px;padding:.55rem 0;border-bottom:.5px solid var(--border)">' +
          '<div style="flex-shrink:0;padding-top:2px">' + pill(step.owner_side || "?", ownerColor(step.owner_side)) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;color:var(--text);line-height:1.5">' + MD.escapeHtml(step.action || "") + '</div>' +
            (step.owner ? '<div style="font-size:12px;color:var(--text-muted)">Owner: ' + MD.escapeHtml(step.owner) + (step.due ? ' &middot; Due: ' + MD.escapeHtml(step.due) : '') + '</div>' : '') +
          '</div>' +
        '</div>';
      });
    }

    // --- Signal Log ---
    html += sectionHead("", "SE signal log");
    var sig = s.signal_log || {};
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">';
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#0F6E56;margin-bottom:6px">Buying signals</div>' +
      bulletList(sig.buying_signals)
    );
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#993C1D;margin-bottom:6px">Risk flags</div>' +
      bulletList(sig.risk_flags)
    );
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#534AB7;margin-bottom:6px">Open questions</div>' +
      bulletList(sig.open_questions)
    );
    html += '</div>';

    // --- SE Notes ---
    if (s.se_notes) {
      html += sectionHead("", "SE notes");
      html += card('<div style="font-size:13px;color:var(--text);line-height:1.6">' + MD.escapeHtml(s.se_notes) + '</div>');
    }

    return '<div class="cn-framework-body" style="padding-bottom:.5rem">' + html + '</div>';
  }

  // -----------------------------------------------------------------------
  // Tab switching
  // -----------------------------------------------------------------------

  function showTab(id, tab) {
    var detailEl = document.getElementById("cnDetail-" + id);
    if (!detailEl) return;
    var contentEl = document.getElementById("cnTabContent-" + id);

    // Update active state on all visible tabs
    detailEl.querySelectorAll(".cn-detail-tab").forEach(function (t) {
      var tabVal = t.getAttribute("onclick") && t.getAttribute("onclick").match(/\'(\w+)\'\)/)[1];
      t.classList.toggle("active", tabVal === tab);
    });

    if (tab === "summary") {
      contentEl.innerHTML = detailEl._summaryHtml || "";
    } else if (tab === "raw") {
      contentEl.innerHTML = '<pre class="cn-raw-content">' + MD.escapeHtml(detailEl._rawFull || "") + '</pre>';
    } else if (tab === "debrief") {
      // If we already generated the debrief for this brief, re-render it
      if (detailEl._debriefHtml) {
        contentEl.innerHTML = detailEl._debriefHtml;
        return;
      }
      // Otherwise show the brief picker / generate UI
      contentEl.innerHTML = buildDebriefLaunchHtml(id, detailEl._availableBriefs || []);
    }
  }

  function buildDebriefLaunchHtml(noteId, briefs) {
    var CALL_TYPE_LABELS = {
      discovery: 'Discovery', followup: 'Follow-Up',
      technical_deep_dive: 'Technical Deep Dive', exec_briefing: 'Exec Briefing',
      poc_kickoff: 'POC Kickoff', poc_review: 'POC Review',
      champion_checkin: 'Champion Check-In', commercial: 'Commercial',
    };

    var briefOptions = briefs.map(function (b) {
      var ct = CALL_TYPE_LABELS[b.call_type] || b.call_type || 'Brief';
      var date = MD.formatDate(b.created_at);
      return '<option value="' + b.id + '">' + MD.escapeHtml(ct) + ' Brief &mdash; ' + date + '</option>';
    }).join('');

    var selectHtml = briefs.length === 1
      ? '<input type="hidden" id="cnDebriefBriefSel-' + noteId + '" value="' + briefs[0].id + '">' +
        '<p style="font-size:.85rem;color:var(--text-muted);margin-bottom:1rem;">Comparing against: <strong>' +
        MD.escapeHtml((CALL_TYPE_LABELS[briefs[0].call_type] || briefs[0].call_type) + ' Brief') +
        '</strong> (' + MD.formatDate(briefs[0].created_at) + ')</p>'
      : '<div style="margin-bottom:1rem;">' +
          '<label style="font-size:.78rem;font-weight:600;color:var(--text-muted);display:block;margin-bottom:.3rem;">SELECT PRE-CALL BRIEF</label>' +
          '<select id="cnDebriefBriefSel-' + noteId + '" style="width:100%;max-width:420px;padding:.5rem .75rem;border:1.5px solid var(--border);border-radius:8px;font:inherit;font-size:.9rem;">' +
          briefOptions +
          '</select>' +
        '</div>';

    return (
      '<div style="padding:1rem 0;">' +
        '<div style="background:var(--brand-light);border:1px solid var(--brand);border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.25rem;">' +
          '<p style="font-size:.82rem;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem;">&#x1F4CA; Debrief vs. Brief</p>' +
          '<p style="font-size:.88rem;color:var(--text);margin:0;">Claude will compare what you <strong>planned</strong> in the Pre-Call Brief against what <strong>actually happened</strong> in this call note &mdash; grading your objectives, surfacing surprises, and sharpening your next steps.</p>' +
        '</div>' +
        selectHtml +
        '<button class="btn btn-primary" id="cnDebriefGenBtn-' + noteId + '" onclick="callNotesPage.generateDebrief(\'' + noteId + '\')">Generate Debrief</button>' +
        '<div id="cnDebriefStatus-' + noteId + '" style="display:none;margin-top:.75rem;"></div>' +
      '</div>'
    );
  }

  async function generateDebrief(noteId) {
    var detailEl = document.getElementById('cnDetail-' + noteId);
    if (!detailEl) return;

    var sel = document.getElementById('cnDebriefBriefSel-' + noteId);
    var briefId = sel ? sel.value : (detailEl._availableBriefs[0] && detailEl._availableBriefs[0].id);
    if (!briefId) { alert('No pre-call brief selected.'); return; }

    var btn = document.getElementById('cnDebriefGenBtn-' + noteId);
    var statusEl = document.getElementById('cnDebriefStatus-' + noteId);
    if (btn) { btn.disabled = true; btn.textContent = 'Generating\u2026'; }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<span class="spinner"></span> Comparing brief vs. call note\u2026';
    }

    try {
      var result = await API.generateDebrief(noteId, briefId);
      var debriefHtml = buildDebriefHtml(result);
      detailEl._debriefHtml = debriefHtml;
      detailEl._debriefBriefId = briefId;
      var contentEl = document.getElementById('cnTabContent-' + noteId);
      if (contentEl) contentEl.innerHTML = debriefHtml;
    } catch (e) {
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--red)">Error: ' + MD.escapeHtml(e.message) + '</span>';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Debrief'; }
    }
  }

  function buildDebriefHtml(d) {
    var GRADE_STYLES = {
      A: 'background:#dcfce7;color:#16a34a;',
      B: 'background:#dbeafe;color:#1d4ed8;',
      C: 'background:#fef3c7;color:#d97706;',
      D: 'background:#fee2e2;color:#dc2626;',
    };
    var STATUS_STYLES = {
      achieved:      'background:#dcfce7;color:#16a34a;',
      partial:       'background:#fef3c7;color:#d97706;',
      missed:        'background:#fee2e2;color:#dc2626;',
      not_attempted: 'background:#f1f5f9;color:#64748b;',
    };
    var ACHIEVED_STYLES = {
      'true':    'background:#dcfce7;color:#16a34a;',
      'false':   'background:#fee2e2;color:#dc2626;',
      'partial': 'background:#fef3c7;color:#d97706;',
    };

    function badge(text, style) {
      return '<span style="display:inline-block;' + style + 'font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">' + MD.escapeHtml(String(text)) + '</span>';
    }

    var grade = d.overall_call_grade || 'C';
    var gradeStyle = GRADE_STYLES[grade] || GRADE_STYLES.C;

    var html = '<div style="padding:1rem 0;">';

    // --- Overall ---
    html += '<div style="display:flex;align-items:flex-start;gap:1rem;margin-bottom:1.25rem;">' +
      '<div style="' + gradeStyle + 'font-size:2rem;font-weight:800;width:56px;height:56px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + MD.escapeHtml(grade) + '</div>' +
      '<div>' +
        '<p style="font-size:.82rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem;">Overall Assessment</p>' +
        '<p style="font-size:.92rem;color:var(--text);line-height:1.6;margin:0;">' + MD.escapeHtml(d.overall_assessment || '') + '</p>' +
      '</div>' +
    '</div>';

    // --- North Star ---
    var ns = d.north_star_outcome || {};
    var nsAchieved = String(ns.achieved);
    var nsStyle = ACHIEVED_STYLES[nsAchieved] || ACHIEVED_STYLES['false'];
    var nsLabel = nsAchieved === 'true' ? 'Achieved' : nsAchieved === 'partial' ? 'Partial' : 'Missed';
    html += sectionHead('', 'North Star');
    html += '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;margin-bottom:.5rem;display:flex;gap:.75rem;align-items:flex-start;">' +
      '<div style="flex:1;">' +
        '<p style="font-size:.88rem;font-style:italic;color:var(--text);margin-bottom:.3rem;">&ldquo;' + MD.escapeHtml(ns.north_star || '') + '&rdquo;</p>' +
        (ns.evidence ? '<p style="font-size:.82rem;color:var(--text-muted);margin:0;">' + MD.escapeHtml(ns.evidence) + '</p>' : '') +
      '</div>' +
      '<div style="flex-shrink:0;">' + badge(nsLabel, nsStyle) + '</div>' +
    '</div>';

    // --- Objectives Scorecard ---
    var objectives = d.objectives_scorecard || [];
    if (objectives.length) {
      html += sectionHead('', 'Objectives Scorecard');
      objectives.forEach(function (obj, i) {
        var st = (obj.status || 'missed').toLowerCase();
        var stStyle = STATUS_STYLES[st] || STATUS_STYLES.missed;
        var stLabel = st.replace('_', ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });
        html += '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.7rem 1rem;margin-bottom:.4rem;display:flex;gap:.75rem;align-items:flex-start;">' +
          '<span style="flex-shrink:0;font-weight:700;color:var(--brand);min-width:20px;">' + (i + 1) + '.</span>' +
          '<div style="flex:1;">' +
            '<p style="font-size:.88rem;color:var(--text);margin-bottom:' + (obj.evidence ? '.25rem' : '0') + ';">' + MD.escapeHtml(obj.objective || '') + '</p>' +
            (obj.evidence ? '<p style="font-size:.8rem;color:var(--text-muted);margin:0;">' + MD.escapeHtml(obj.evidence) + '</p>' : '') +
          '</div>' +
          '<div style="flex-shrink:0;">' + badge(stLabel, stStyle) + '</div>' +
        '</div>';
      });
    }

    // --- Questions Scorecard ---
    var questions = d.questions_scorecard || [];
    if (questions.length) {
      html += sectionHead('', 'Questions Scorecard');
      questions.forEach(function (q, i) {
        var asked = q.asked;
        var askedStyle = asked === true ? ACHIEVED_STYLES['true'] : asked === 'unclear' ? ACHIEVED_STYLES['partial'] : ACHIEVED_STYLES['false'];
        var askedLabel = asked === true ? 'Asked' : asked === 'unclear' ? 'Unclear' : 'Not Asked';
        html += '<div style="background:var(--surface);border:.5px solid var(--border);border-radius:var(--radius);padding:.7rem 1rem;margin-bottom:.4rem;">' +
          '<div style="display:flex;gap:.75rem;align-items:flex-start;">' +
            '<div style="flex:1;">' +
              '<p style="font-size:.88rem;font-style:italic;color:var(--text);margin-bottom:.2rem;">&ldquo;' + MD.escapeHtml(q.question || '') + '&rdquo;</p>' +
              '<p style="font-size:.78rem;color:var(--text-muted);margin-bottom:' + (q.answer_received ? '.2rem' : '0') + ';">Purpose: ' + MD.escapeHtml(q.strategic_purpose || '') + '</p>' +
              (q.answer_received ? '<p style="font-size:.82rem;color:var(--text);background:var(--bg);padding:.3rem .5rem;border-radius:4px;margin:0;">Answer: ' + MD.escapeHtml(q.answer_received) + '</p>' : '') +
            '</div>' +
            '<div style="flex-shrink:0;">' + badge(askedLabel, askedStyle) + '</div>' +
          '</div>' +
        '</div>';
      });
    }

    // --- Surprises ---
    var surprises = d.surprises || [];
    if (surprises.length) {
      html += sectionHead('', 'Surprises');
      surprises.forEach(function (s) {
        html += '<div style="background:#fffbeb;border:.5px solid #fde68a;border-radius:var(--radius);padding:.7rem 1rem;margin-bottom:.4rem;">' +
          '<p style="font-size:.88rem;font-weight:600;color:var(--text);margin-bottom:.2rem;">&#x26A0;&#xFE0F; ' + MD.escapeHtml(s.surprise || '') + '</p>' +
          (s.implication ? '<p style="font-size:.82rem;color:var(--text-muted);margin:0;">Implication: ' + MD.escapeHtml(s.implication) + '</p>' : '') +
        '</div>';
      });
    }

    // --- Brief Accuracy ---
    var ba = d.brief_accuracy || {};
    html += sectionHead('', 'Brief Accuracy');
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;">';
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#16a34a;margin-bottom:6px;">What the brief got right</div>' +
      bulletList(ba.what_the_brief_got_right)
    );
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#dc2626;margin-bottom:6px;">What the brief got wrong</div>' +
      bulletList(ba.what_the_brief_got_wrong)
    );
    html += card(
      '<div style="font-size:11px;font-weight:500;color:#d97706;margin-bottom:6px;">Gaps in preparation</div>' +
      bulletList(ba.gaps_in_preparation)
    );
    html += '</div>';

    // --- Sharpened Next Steps ---
    var steps = d.sharpened_next_steps || [];
    if (steps.length) {
      html += sectionHead('', 'Sharpened Next Steps');
      var URGENCY_STYLES = {
        'immediate':        'background:#fee2e2;color:#dc2626;',
        'this week':        'background:#fef3c7;color:#d97706;',
        'before next call': 'background:#dbeafe;color:#1d4ed8;',
      };
      var OWNER_COLORS_MAP = { SE: 'coral', AE: 'purple', 'SE + AE': 'amber', Prospect: 'teal' };
      steps.forEach(function (step) {
        var urgencyStyle = URGENCY_STYLES[(step.urgency || '').toLowerCase()] || 'background:#f1f5f9;color:#64748b;';
        var ownerC = OWNER_COLORS_MAP[step.owner] || 'gray';
        html += '<div style="display:flex;align-items:flex-start;gap:8px;padding:.55rem 0;border-bottom:.5px solid var(--border);">' +
          '<div style="flex-shrink:0;padding-top:2px;">' + pill(step.owner || '?', ownerC) + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;color:var(--text);line-height:1.5;">' + MD.escapeHtml(step.action || '') + '</div>' +
            (step.rationale ? '<div style="font-size:12px;color:var(--text-muted);">' + MD.escapeHtml(step.rationale) + '</div>' : '') +
          '</div>' +
          '<div style="flex-shrink:0;">' + badge(step.urgency || '?', urgencyStyle) + '</div>' +
        '</div>';
      });
    }

    // --- Coaching Note ---
    if (d.coaching_note) {
      html += sectionHead('', 'Coaching Note');
      html += '<div style="background:var(--brand-light);border-left:3px solid var(--brand);padding:.75rem 1rem;border-radius:0 8px 8px 0;font-size:.88rem;color:var(--text);line-height:1.6;">' +
        '&#x1F4A1; ' + MD.escapeHtml(d.coaching_note) +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  function exportMarkdown(id) {
    var detailEl = document.getElementById("cnDetail-" + id);
    var data = detailEl ? detailEl._noteData : (_expandedData && _expandedData.id === id ? _expandedData : null);
    if (!data) { alert("Note data not loaded yet."); return; }

    var md = buildMarkdownExport(data);
    var blob = new Blob([md], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "call-note-" + id + ".md";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function exportPdf(id) {
    var a = document.createElement("a");
    a.href = "/api/call-notes/" + encodeURIComponent(id) + "/pdf";
    a.download = "call-note-" + id + ".pdf";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
  }

  function buildMarkdownExport(data) {
    var title = data.title || "Call Note";
    var date = data.created_at ? new Date(data.created_at).toLocaleDateString() : "";
    var lines = ["# " + title, date ? "_" + date + "_" : "", ""];

    var raw = data.summary_markdown || "";
    var s = null;
    try { s = JSON.parse(raw); } catch (_) {}

    if (!s) { lines.push(raw); return lines.join("\n"); }

    var ctx = s.call_context || {};
    lines.push("## Call Context");
    if (ctx.date) lines.push("- **Date:** " + ctx.date);
    if (ctx.call_type) lines.push("- **Type:** " + ctx.call_type);
    if (ctx.deal_stage) lines.push("- **Stage:** " + ctx.deal_stage);
    lines.push("");

    var people = s.stakeholders || [];
    if (people.length) {
      lines.push("## Stakeholders");
      people.forEach(function (p) {
        lines.push("**" + (p.name || "?") + "** — " + (p.title || "") + (p.org ? " (" + p.org + ")" : ""));
        if (p.role_tags && p.role_tags.length) lines.push("Tags: " + p.role_tags.join(", "));
        if (p.notes) lines.push(p.notes);
        lines.push("");
      });
    }

    var tech = s.technical_requirements || {};
    lines.push("## Technical Requirements & Stack");
    if (tech.current_stack && tech.current_stack.length) lines.push("**Stack:** " + tech.current_stack.join(", "));
    if (tech.infrastructure_notes) lines.push("**Infra:** " + tech.infrastructure_notes);
    if (tech.technical_goals && tech.technical_goals.length) { lines.push("**Goals:**"); tech.technical_goals.forEach(function (g) { lines.push("- " + g); }); }
    lines.push("");

    var pains = s.pain_points || [];
    if (pains.length) {
      lines.push("## Pain Points");
      pains.forEach(function (p) { lines.push("- **[" + (p.urgency || "?") + "]** " + p.pain + (p.impact ? " — " + p.impact : "")); });
      lines.push("");
    }

    var drivers = s.business_drivers || {};
    if (drivers.why_now || drivers.business_context) {
      lines.push("## Business Drivers");
      if (drivers.why_now) lines.push("**Why now:** " + drivers.why_now);
      if (drivers.business_context) lines.push("**Context:** " + drivers.business_context);
      lines.push("");
    }

    var comp = s.competitive_ecosystem || {};
    lines.push("## Competitive & Ecosystem");
    if (comp.incumbents && comp.incumbents.length) lines.push("**Incumbents:** " + comp.incumbents.join(", "));
    if (comp.also_evaluating && comp.also_evaluating.length) lines.push("**Also evaluating:** " + comp.also_evaluating.join(", "));
    if (comp.required_integrations && comp.required_integrations.length) lines.push("**Required integrations:** " + comp.required_integrations.join(", "));
    if (comp.notes) lines.push(comp.notes);
    lines.push("");

    var dc = s.decision_criteria || {};
    lines.push("## Decision Criteria");
    if (dc.must_haves && dc.must_haves.length) { lines.push("**Must-haves:**"); dc.must_haves.forEach(function (m) { lines.push("- " + m); }); }
    if (dc.nice_to_haves && dc.nice_to_haves.length) { lines.push("**Nice-to-haves:**"); dc.nice_to_haves.forEach(function (m) { lines.push("- " + m); }); }
    if (dc.success_definition) lines.push("**Success:** " + dc.success_definition);
    if (dc.evaluation_timeline) lines.push("**Timeline:** " + dc.evaluation_timeline);
    lines.push("");

    var objs = s.objections || [];
    if (objs.length) {
      lines.push("## Objections");
      objs.forEach(function (o) { lines.push("- **[" + (o.type || "?") + " / " + (o.status || "?") + "]** " + o.objection); });
      lines.push("");
    }

    var steps = s.next_steps || [];
    if (steps.length) {
      lines.push("## Next Steps");
      steps.forEach(function (step, i) {
        lines.push((i + 1) + ". **[" + (step.owner_side || "?") + "]** " + step.action + (step.owner ? " (" + step.owner + ")" : "") + (step.due ? " — " + step.due : ""));
      });
      lines.push("");
    }

    var sig = s.signal_log || {};
    lines.push("## Signal Log");
    if (sig.buying_signals && sig.buying_signals.length) { lines.push("**Buying signals:**"); sig.buying_signals.forEach(function (b) { lines.push("- " + b); }); }
    if (sig.risk_flags && sig.risk_flags.length) { lines.push("**Risk flags:**"); sig.risk_flags.forEach(function (r) { lines.push("- " + r); }); }
    if (sig.open_questions && sig.open_questions.length) { lines.push("**Open questions:**"); sig.open_questions.forEach(function (q) { lines.push("- " + q); }); }
    lines.push("");

    if (s.se_notes) { lines.push("## SE Notes"); lines.push(s.se_notes); lines.push(""); }

    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    init: function () { render(); loadCompanies(); loadNotes(); },

    toggle: function (id) {
      if (_expandedId === id) { _expandedId = null; _expandedData = null; }
      else { _expandedId = id; _expandedData = null; }
      renderNotes();
    },

    deleteNote: async function (id) {
      if (!confirm("Delete this call note?")) return;
      try {
        await API.deleteCallNote(id);
        if (_expandedId === id) { _expandedId = null; _expandedData = null; }
        await loadNotes();
      } catch (e) { alert("Error deleting note: " + e.message); }
    },

    showTab: showTab,
    exportMarkdown: exportMarkdown,
    exportPdf: exportPdf,
    generateDebrief: generateDebrief,

    openNote: async function (id) {
      _expandedId = id; _expandedData = null;
      renderNotes();
    },
  };
})();
