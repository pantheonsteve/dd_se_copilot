/**
 * Research Hub — query form, synthesized answers, talk tracks, discovery.
 * Ported from the original inline HTML in main.py with improvements.
 */
window.researchPage = (function () {
  let initialized = false;
  let _lastResponse = null;
  let _lastReportId = null;
  let _tickerOptions = [];
  let _demoPersonas = null;
  let _hypothesisContext = null;
  let _pendingQuery = null;

  function render() {
    const el = document.getElementById("page-research");
    el.innerHTML = `
      <div class="demo-layout">
        <!-- Saved reports sidebar -->
        <div class="plans-sidebar">
          <div class="card">
            <p class="section-title">Saved Reports</p>
            <div id="resSavedList"><span class="empty">Loading...</span></div>
          </div>

          <!-- 10-K Management -->
          <div class="card" id="resTenKCard">
            <p class="section-title" style="cursor:pointer;" onclick="window.researchPage.toggle10K()">
              10-K Reports <span id="resTenKToggle" style="font-size:.7rem;">&#x25B6;</span>
            </p>
            <div id="resTenKPanel" style="display:none;">
              <div style="display:flex;gap:.35rem;margin-bottom:.5rem;">
                <input type="text" id="resEdgarSearch" placeholder="Search company or ticker..." style="flex:1;padding:.35rem .5rem;font-size:.78rem;">
                <button type="button" class="btn btn-primary btn-sm" onclick="window.researchPage.edgarSearch()">Search</button>
              </div>
              <div id="resEdgarResults" style="font-size:.78rem;"></div>
              <div id="resEdgarIngested" style="margin-top:.5rem;font-size:.75rem;"></div>
            </div>
          </div>
        </div>

        <!-- Main column -->
        <div>
          <!-- Inventory bar -->
          <div class="card" id="resInvBar" style="display:none;margin-bottom:1rem;">
            <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;font-size:.78rem;" id="resInvContent"></div>
          </div>

          <!-- Report generation form -->
          <div class="card" id="resFormCard">
            <form id="resQueryForm">
              <div class="form-row">
                <div class="field">
                  <label for="resTickerSelect">Company (10-K Report)</label>
                  <select id="resTickerSelect">
                    <option value="">-- Select a company --</option>
                  </select>
                </div>
                <div class="field">
                  <label for="resPersonaSelect">Buyer Persona</label>
                  <select id="resPersonaSelect">
                    <option value="">None</option>
                    <option value="architect">Architect (App/Systems/Cloud)</option>
                    <option value="cloud_engineer">Cloud Engineer (CloudOps/Platform/Ops)</option>
                    <option value="sre_devops_platform_ops">SRE / DevOps / Platform Ops</option>
                    <option value="software_engineer">Software Engineer (Backend/App)</option>
                    <option value="frontend_engineer">Front-end Engineer (UI/Web/UX)</option>
                    <option value="network_engineer">Network Engineer</option>
                    <option value="tech_executive">VP/C-Level Technology Leader</option>
                    <option value="finops">FinOps / Cost Optimization</option>
                    <option value="product_manager_analyst">Product Managers / Product & UX Analysts</option>
                    <option value="sql_power_user">SQL Power Users</option>
                    <option value="cloud_governance_compliance">Cloud Governance / Compliance</option>
                    <option value="biz_user">Biz User (PM/Sysadmin/Ops Stakeholder)</option>
                  </select>
                </div>
                <div class="field" style="margin-left:auto;">
                  <label>&nbsp;</label>
                  <button type="submit" class="btn btn-primary" id="resAskBtn">Generate Executive Report</button>
                </div>
              </div>
              <div class="form-row" style="margin-top:.75rem;" id="resCompanyCtxRow">
                <div class="field grow">
                  <label for="resCompanyContext">Company Context <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(paste notes, strategy info, press releases if no 10-K available)</span></label>
                  <textarea id="resCompanyContext" rows="4" placeholder="Paste company info, strategy notes, annual report excerpts, press releases, or discovery notes..."></textarea>
                </div>
              </div>
              <div id="resFormError" style="display:none;margin-top:.5rem;color:var(--danger);font-size:.82rem;font-weight:600;"></div>
            </form>
          </div>

          <!-- Loading -->
          <div class="card" id="resLoadingCard" style="display:none;">
            <p><span class="spinner"></span> Routing query and synthesizing response&hellip;</p>
          </div>

          <!-- Error -->
          <div class="card" id="resErrorCard" style="display:none;">
            <div class="error-msg" id="resErrorMsg"></div>
          </div>

          <!-- Results -->
          <div id="resResults" style="display:none;">
            <!-- Report title bar -->
            <div class="res-title-bar">
              <div class="res-title-row">
                <h2 class="res-report-title" id="resReportHeading">Research Report</h2>
                <div class="res-title-actions">
                  <button onclick="window.researchPage.showForm()" class="btn-new-plan">+ New Report</button>
                  <button class="btn btn-sm" onclick="window.researchPage.toggleReportDrawer()" id="resDrawerToggle">Other Reports &#x25B6;</button>
                  <input type="text" id="resReportTitle" placeholder="Report title..." class="res-title-input">
                  <button class="btn btn-primary btn-sm" id="resSaveBtn" onclick="window.researchPage.saveReport()">Save</button>
                  <span id="resSaveStatus"></span>
                  <button class="btn btn-sm" onclick="window.researchPage.exportPDF()" title="Export as PDF">Export PDF</button>
                  <button class="btn btn-sm" onclick="window.researchPage.openExpansionPlaybook()" id="resExpansionBtn" title="Generate an Expansion Playbook from this report">Expansion Playbook</button>
                  <button class="btn btn-sm btn-accent" onclick="window.researchPage.openDemoPlanForm()" id="resDemoPlanBtn" title="Create a Demo Plan from this report">Create Demo Plan</button>
                </div>
              </div>
              <div class="meta-bar" id="resMetaBar" style="margin-top:.4rem;"></div>
              <div class="linked-artifacts" id="resLinkedArtifacts" style="display:none;"></div>

              <!-- Collapsible report drawer -->
              <div class="res-report-drawer" id="resReportDrawer" style="display:none;">
                <div id="resDrawerList"><span class="empty">Loading...</span></div>
              </div>
            </div>

            <!-- Tab bar -->
            <div class="tab-bar" id="resTabBar"></div>

            <!-- Tab panels (print mode shows all) -->
            <div id="resTabPanels">
              <div class="tab-panel" id="res-panel-answer" data-print-title="Synthesized Answer">
                <div class="card"><div class="answer-text md-body" id="resAnswerText"></div></div>
              </div>
              <div class="tab-panel" id="res-panel-talk-track" data-print-title="Talk Track">
                <div class="card"><div class="talk-track md-body" id="resTalkTrackText"></div></div>
              </div>
              <div class="tab-panel" id="res-panel-discovery" data-print-title="Discovery Questions">
                <div class="card">
                  <ol class="disc-list" id="resDiscoveryList"></ol>
                </div>
              </div>
              <div class="tab-panel" id="res-panel-sources" data-print-title="Sources">
                <div class="card">
                  <div class="src-grid" id="resSrcGrid"></div>
                </div>
              </div>
              <div class="tab-panel" id="res-panel-gaps" data-print-title="Content Gaps">
                <div class="card">
                  <ul class="gap-list" id="resGapsList"></ul>
                </div>
              </div>
            </div>

            <!-- Hidden print header (only visible when printing) -->
            <div class="print-header" id="resPrintHeader">
              <h1 id="resPrintTitle">Research Report</h1>
              <div id="resPrintMeta"></div>
            </div>
          </div>

          <!-- Demo Plan from Report modal -->
          <div class="dp-modal-overlay" id="resDpOverlay" style="display:none;" onclick="if(event.target===this)window.researchPage.closeDemoPlanForm()">
            <div class="dp-modal">
              <div class="dp-modal-header">
                <h3>Create Demo Plan from Report</h3>
                <button class="dp-modal-close" onclick="window.researchPage.closeDemoPlanForm()">&times;</button>
              </div>
              <div id="resDpFormContainer">
                <div class="dp-modal-source" id="resDpSourceLabel"></div>
                <form id="resDpForm" onsubmit="return false;">
                  <div class="dp-field">
                    <label>Demo Mode</label>
                    <div class="radio-group">
                      <label><input type="radio" name="res_dp_mode" value="discovery_driven" checked> Discovery-Driven</label>
                      <label><input type="radio" name="res_dp_mode" value="product_expansion"> Product Expansion</label>
                      <label><input type="radio" name="res_dp_mode" value="competitive_displacement"> Competitive Displacement</label>
                    </div>
                  </div>
                  <div class="dp-field">
                    <label for="resDpPersona">Persona</label>
                    <select id="resDpPersona" required></select>
                  </div>
                  <div class="dp-field">
                    <label for="resDpProducts">Specific Products (optional, comma-separated)</label>
                    <input type="text" id="resDpProducts" placeholder="e.g. APM, Log Management, Infrastructure">
                  </div>
                  <div class="dp-field">
                    <label for="resDpIncumbent">Incumbent Tooling (optional)</label>
                    <input type="text" id="resDpIncumbent" placeholder="e.g. Splunk, New Relic, Grafana">
                  </div>
                  <div class="dp-field">
                    <label for="resDpAdditional">Additional Context (optional)</label>
                    <textarea id="resDpAdditional" rows="3" placeholder="Any extra notes or context for the demo plan..."></textarea>
                  </div>
                  <div class="dp-modal-actions">
                    <button type="button" class="btn" onclick="window.researchPage.closeDemoPlanForm()">Cancel</button>
                    <button type="button" class="btn btn-primary" id="resDpSubmitBtn" onclick="window.researchPage.submitDemoPlan()">Generate Demo Plan</button>
                  </div>
                </form>
              </div>
              <div id="resDpProgress" style="display:none;">
                <div class="progress-steps">
                  <div class="step" id="resDpStepOrch"><span class="icon"></span> Orchestrating</div>
                  <div class="step" id="resDpStepRetr"><span class="icon"></span> Retrieving context</div>
                  <div class="step" id="resDpStepSynth"><span class="icon"></span> Synthesizing demo plan</div>
                </div>
              </div>
              <div id="resDpResult" style="display:none;"></div>
            </div>
          </div>

          <!-- Placeholder -->
          <div class="card" id="resPlaceholder">
            <p class="empty">Select a company or paste context to generate an executive report.</p>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    document.getElementById("resQueryForm").addEventListener("submit", handleSubmit);
    document.getElementById("resTickerSelect").addEventListener("change", () => {
      const ctxRow = document.getElementById("resCompanyCtxRow");
      if (ctxRow) ctxRow.style.display = document.getElementById("resTickerSelect").value ? "none" : "";
    });
    document.getElementById("resEdgarSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); edgarSearch(); }
    });
  }

  // --- Saved reports sidebar + drawer ---

  function buildReportListHTML(data) {
    if (!data.length) return '<span class="empty">No saved reports yet.</span>';
    return data.map((r) => {
      const date = MD.formatDate(r.saved_at);
      const title = r.title || r.query;
      return '<div class="saved-item" onclick="window.researchPage.loadReport(\'' + r.id + '\')">' +
        '<span class="si-title">' + MD.escapeHtml(title) + '</span>' +
        '<div class="si-row">' +
          '<span class="si-meta">' + r.route + ' &middot; ' + date + '</span>' +
          '<div class="si-actions">' +
            '<button class="si-btn delete" onclick="event.stopPropagation();window.researchPage.deleteReport(\'' + r.id + '\')">Del</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function loadSavedReports() {
    try {
      const data = await API.listReports();
      const html = buildReportListHTML(data);
      const sidebar = document.getElementById("resSavedList");
      if (sidebar) sidebar.innerHTML = html;
      const drawer = document.getElementById("resDrawerList");
      if (drawer) drawer.innerHTML = html;
    } catch {
      const msg = '<span class="empty">Failed to load reports.</span>';
      const sidebar = document.getElementById("resSavedList");
      if (sidebar) sidebar.innerHTML = msg;
      const drawer = document.getElementById("resDrawerList");
      if (drawer) drawer.innerHTML = msg;
    }
  }

  // --- Form submit ---

  const PERSONA_LABELS = {
    architect: "Architect", cloud_engineer: "Cloud Engineer",
    sre_devops_platform_ops: "SRE / DevOps / Platform Ops",
    software_engineer: "Software Engineer", frontend_engineer: "Front-end Engineer",
    network_engineer: "Network Engineer", tech_executive: "VP/C-Level Technology Leader",
    finops: "FinOps / Cost Optimization", product_manager_analyst: "Product Manager / Analyst",
    sql_power_user: "SQL Power User", cloud_governance_compliance: "Cloud Governance / Compliance",
    biz_user: "Business Stakeholder",
  };

  async function handleSubmit(e) {
    e.preventDefault();
    const secTicker = document.getElementById("resTickerSelect").value || null;
    const persona = document.getElementById("resPersonaSelect").value || null;
    const companyContext = document.getElementById("resCompanyContext").value.trim() || null;
    const errEl = document.getElementById("resFormError");

    if (!secTicker && !companyContext && !_hypothesisContext) {
      errEl.textContent = "Please select a 10-K report or paste company context to generate a report.";
      errEl.style.display = "";
      return;
    }
    errEl.style.display = "none";

    let query;
    if (_pendingQuery) {
      query = _pendingQuery;
      _pendingQuery = null;
    } else if (secTicker) {
      const match = _tickerOptions.find((t) => t.ticker === secTicker);
      const companyName = match ? match.company : secTicker;
      query = "Generate a comprehensive Datadog strategic overview for " + companyName +
        " (" + secTicker + "), mapping their key strategic initiatives, technology investments, " +
        "and risk factors to relevant Datadog products and capabilities.";
    } else {
      query = "Generate a comprehensive Datadog strategic overview based on the provided company context, " +
        "mapping the company's key strategic initiatives, technology investments, and challenges " +
        "to relevant Datadog products and capabilities.";
    }
    if (persona) {
      query += " Tailor the analysis for a " + (PERSONA_LABELS[persona] || persona) + " audience.";
    }

    const btn = document.getElementById("resAskBtn");
    btn.disabled = true;
    btn.textContent = "Generating\u2026";
    document.getElementById("resFormCard").style.display = "none";
    document.getElementById("resPlaceholder").style.display = "none";
    document.getElementById("resResults").style.display = "none";
    document.getElementById("resLoadingCard").style.display = "";
    document.getElementById("resErrorCard").style.display = "none";

    try {
      const payload = { query, persona, include_talk_track: true };
      if (secTicker) payload.sec_filing_ticker = secTicker;
      if (companyContext) payload.company_context = companyContext;
      if (_hypothesisContext) {
        payload.hypothesis_context = _hypothesisContext;
        _hypothesisContext = null;
      }
      const d = await API.query(payload);
      let reportTitle = "Strategic Overview";
      if (secTicker) {
        const match = _tickerOptions.find((t) => t.ticker === secTicker);
        reportTitle = (match ? match.company : secTicker) + " Strategic Overview";
      }
      if (persona) {
        reportTitle += " \u2014 " + (PERSONA_LABELS[persona] || persona);
      }
      d._reportTitle = reportTitle;
      _lastReportId = null;
      renderResponse(d);
      loadSavedReports();
    } catch (err) {
      document.getElementById("resFormCard").style.display = "";
      document.getElementById("resErrorMsg").textContent = "Error: " + err.message;
      document.getElementById("resErrorCard").style.display = "";
    } finally {
      document.getElementById("resLoadingCard").style.display = "none";
      btn.disabled = false;
      btn.textContent = "Generate Executive Report";
    }
  }

  // --- Response rendering ---

  const RES_TABS = [
    { id: "answer", label: "Answer" },
    { id: "talk-track", label: "Talk Track" },
    { id: "discovery", label: "Discovery" },
    { id: "sources", label: "Sources" },
    { id: "gaps", label: "Content Gaps" },
  ];

  function switchResTab(tabId) {
    document.querySelectorAll("#resTabBar .tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll("#resTabPanels .tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === "res-panel-" + tabId);
    });
  }

  function enterFocusMode() {
    const layout = document.querySelector("#page-research .demo-layout");
    if (layout) layout.classList.add("focus-mode");
    const inv = document.getElementById("resInvBar");
    if (inv) inv.style.display = "none";
  }

  function exitFocusMode() {
    const layout = document.querySelector("#page-research .demo-layout");
    if (layout) layout.classList.remove("focus-mode");
  }

  function renderResponse(d) {
    _lastResponse = d;
    document.getElementById("resPlaceholder").style.display = "none";
    document.getElementById("resFormCard").style.display = "none";
    enterFocusMode();

    // Meta badges
    let timingHtml = '<span class="badge time">' + (d.processing_time_ms / 1000).toFixed(1) + "s</span>";
    if (d.stage_timings_ms) {
      const st = d.stage_timings_ms;
      if (st.router != null) timingHtml += '<span class="badge time">Router ' + (st.router / 1000).toFixed(1) + "s</span>";
      if (st.retrieval != null) timingHtml += '<span class="badge time">Retrieval ' + (st.retrieval / 1000).toFixed(1) + "s</span>";
      if (st.synthesis != null) timingHtml += '<span class="badge time">Synthesis ' + (st.synthesis / 1000).toFixed(1) + "s</span>";
    }
    document.getElementById("resMetaBar").innerHTML =
      '<span class="badge route">Route: ' + d.route + "</span>" +
      MD.confBadge("Technical", d.technical_confidence) +
      MD.confBadge("Value", d.value_confidence) +
      timingHtml;

    // Report heading + print header + linked artifacts
    const queryText = d.query || "";
    const heading = d._savedTitle || d._reportTitle || "Strategic Overview";
    document.getElementById("resReportHeading").textContent = heading;
    _loadResLinkedArtifacts(heading);
    document.getElementById("resPrintTitle").textContent = heading;
    document.getElementById("resPrintMeta").innerHTML =
      "Route: " + d.route + " &middot; " +
      "Technical: " + d.technical_confidence + " &middot; " +
      "Value: " + d.value_confidence + " &middot; " +
      (d.processing_time_ms / 1000).toFixed(1) + "s";

    // Populate panels
    document.getElementById("resAnswerText").innerHTML = MD.render(d.synthesized_answer);

    if (d.talk_track) {
      document.getElementById("resTalkTrackText").innerHTML = MD.render(d.talk_track);
    }

    if (d.discovery_questions && d.discovery_questions.length) {
      document.getElementById("resDiscoveryList").innerHTML = d.discovery_questions
        .map((q) => "<li onclick=\"window.researchPage.askQuestion('" + MD.escapeHtml(q).replace(/'/g, "\\'") + "')\"><span>" + MD.escapeHtml(q) + "</span></li>")
        .join("");
    }

    const s = d.sources || {};
    const hasSources = (s.technical && s.technical.length) || (s.value && s.value.length) ||
      (s.case_studies && s.case_studies.length) || (s.sec_filings && s.sec_filings.length) ||
      (s.buyer_persona && s.buyer_persona.length);
    if (hasSources) {
      let html = "";
      [
        ["Technical Library", s.technical],
        ["Value Library", s.value],
        ["Case Studies", s.case_studies],
        ["SEC Filings", s.sec_filings],
        ["Buyer Persona", s.buyer_persona],
      ].forEach(([label, arr]) => {
        if (arr && arr.length) {
          html += '<div class="src-col"><h4>' + label + "</h4><ul>" +
            arr.map((src) => '<li title="' + MD.escapeHtml(src) + '">' + MD.shortSource(src) + "</li>").join("") +
            "</ul></div>";
        }
      });
      document.getElementById("resSrcGrid").innerHTML = html;
    }

    if (d.content_gaps && d.content_gaps.length) {
      document.getElementById("resGapsList").innerHTML = d.content_gaps.map((g) => "<li>" + MD.escapeHtml(g) + "</li>").join("");
    }

    // Build tab bar — only show tabs with content
    const tabAvailable = {
      "answer": true,
      "talk-track": !!d.talk_track,
      "discovery": d.discovery_questions && d.discovery_questions.length > 0,
      "sources": hasSources,
      "gaps": d.content_gaps && d.content_gaps.length > 0,
    };

    const tabBar = document.getElementById("resTabBar");
    tabBar.innerHTML = "";
    let firstTab = null;
    RES_TABS.forEach((tab) => {
      if (!tabAvailable[tab.id]) return;
      if (!firstTab) firstTab = tab.id;
      const btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.addEventListener("click", () => switchResTab(tab.id));
      tabBar.appendChild(btn);
    });

    if (firstTab) switchResTab(firstTab);

    // Close drawer if open, reset save state
    const drawer = document.getElementById("resReportDrawer");
    if (drawer) drawer.style.display = "none";
    const drawerBtn = document.getElementById("resDrawerToggle");
    if (drawerBtn) drawerBtn.innerHTML = "Other Reports &#x25B6;";

    document.getElementById("resSaveStatus").textContent = "";
    document.getElementById("resReportTitle").value = "";
    document.getElementById("resResults").style.display = "";
  }

  // --- Inventory + 10-K dropdown ---

  async function loadInventory() {
    try {
      const data = await API.inventory();
      if (!data.agents || !data.agents.length) return;
      const bar = document.getElementById("resInvBar");
      const content = document.getElementById("resInvContent");
      content.innerHTML = "<strong>Inventory:</strong> " + data.agents.map((a) => {
        const dot = a.status === "ok" ? "ok" : "err";
        const label = a.agent + " (" + a.total_chunks + " chunks, " + a.unique_sources + " sources)";
        return '<span style="display:inline-flex;align-items:center;gap:.3rem;background:var(--surface);padding:.2rem .6rem;border-radius:12px;"><span class="dot ' + dot + '"></span>' + label + "</span>";
      }).join("");
      bar.style.display = "";

      const edgar = data.agents.find((a) => a.agent === "sec_edgar");
      if (edgar && edgar.companies && edgar.companies.length) {
        populateTickerDropdown(edgar.companies);
        renderIngestedCompanies(edgar.companies);
      }
    } catch { /* ignore */ }
  }

  function populateTickerDropdown(companies) {
    const sel = document.getElementById("resTickerSelect");
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    companies.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.ticker;
      opt.textContent = c.ticker + " \u2014 " + c.company;
      sel.appendChild(opt);
    });
    _tickerOptions = companies;
  }

  function renderIngestedCompanies(companies) {
    const el = document.getElementById("resEdgarIngested");
    if (!el) return;
    if (!companies.length) {
      el.innerHTML = '<span class="empty">No companies ingested yet.</span>';
      return;
    }
    el.innerHTML = "<strong>Ingested:</strong> " +
      companies.map((c) => '<span class="badge">' + c.ticker + "</span>").join(" ");
  }

  // --- Linked artifacts ---

  async function _loadResLinkedArtifacts(heading) {
    const el = document.getElementById("resLinkedArtifacts");
    if (!el) return;
    // Extract company name from heading like "Waters Strategic Overview"
    let company = heading
      .replace(/\s*(Strategic Overview|Executive Report|Report).*$/i, "")
      .replace(/\s*[-—–|].*$/, "")
      .trim();
    if (!company || company.length < 2) { el.style.display = "none"; return; }

    try {
      const data = await API.linkedArtifacts(company);
      const links = [];
      if (data.hypothesis) {
        links.push(
          `<a class="linked-chip linked-hyp" href="#" onclick="event.preventDefault();window.hypothesisPage.loadHypothesis('${data.hypothesis.id}');window.navigateTo('hypothesis');">` +
          `<span class="linked-icon">&#x1F9EA;</span> Sales Hypothesis (${data.hypothesis.confidence_level})</a>`
        );
      }
      if (data.demo_plans && data.demo_plans.length) {
        data.demo_plans.forEach((p) => {
          links.push(
            `<a class="linked-chip linked-demo" href="#" onclick="event.preventDefault();window.demoPlanner.loadSavedPlan('${p.id}');window.navigateTo('demo-planner');">` +
            `<span class="linked-icon">&#x1F3AF;</span> ${MD.escapeHtml(p.title || "Demo Plan")}</a>`
          );
        });
      }
      if (links.length) {
        el.innerHTML = '<span class="linked-label">Related:</span> ' + links.join(" ");
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    } catch {
      el.style.display = "none";
    }
  }

  // --- 10-K EDGAR management ---

  async function edgarSearch() {
    const q = document.getElementById("resEdgarSearch").value.trim();
    const el = document.getElementById("resEdgarResults");
    if (!q || q.length < 2) {
      el.innerHTML = '<span class="empty">Enter at least 2 characters.</span>';
      return;
    }
    el.innerHTML = '<span class="spinner"></span> Searching...';
    try {
      const data = await API.edgarSearch(q);
      if (!data.results || !data.results.length) {
        el.innerHTML = '<span class="empty">No companies found.</span>';
        return;
      }
      el.innerHTML = data.results.slice(0, 8).map((c) => {
        const already = _tickerOptions.some((t) => t.ticker === c.ticker);
        const btn = already
          ? '<span class="badge" style="font-size:.65rem;">Ingested</span>'
          : '<button class="btn btn-primary btn-sm" style="font-size:.65rem;padding:.1rem .4rem;" ' +
            'onclick="event.stopPropagation();window.researchPage.edgarIngest(\'' +
            MD.escapeHtml(c.ticker) + "','" + MD.escapeHtml(c.cik || "") + "','" +
            MD.escapeHtml(c.company_name || c.name || "") + "')\">Ingest</button>";
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border);">' +
          '<span><strong>' + MD.escapeHtml(c.ticker) + '</strong> ' + MD.escapeHtml(c.company_name || c.name || "") + '</span>' +
          btn + '</div>';
      }).join("");
    } catch (err) {
      el.innerHTML = '<span class="error-msg" style="font-size:.78rem;">Search failed: ' + err.message + '</span>';
    }
  }

  async function edgarIngest(ticker, cik, companyName) {
    const el = document.getElementById("resEdgarResults");
    el.innerHTML = '<span class="spinner"></span> Ingesting ' + ticker + '&hellip; This may take a minute.';
    try {
      await API.edgarIngest(ticker, cik, companyName);
      el.innerHTML = '<span style="color:var(--green);">Successfully ingested ' + ticker + '.</span>';
      await loadInventory();
    } catch (err) {
      el.innerHTML = '<span class="error-msg" style="font-size:.78rem;">Ingest failed: ' + err.message + '</span>';
    }
  }

  // --- Public API ---

  function injectBreadcrumb() {
    var container = document.getElementById("page-research");
    var existing = container.querySelector(".company-breadcrumb");
    if (existing) existing.remove();
    var html = window.renderCompanyBreadcrumb ? window.renderCompanyBreadcrumb("Research Hub") : "";
    if (html) container.insertAdjacentHTML("afterbegin", html);
  }

  return {
    init() {
      if (!initialized) {
        render();
        initialized = true;
        loadInventory();
      }
      injectBreadcrumb();
      loadSavedReports();

      // Check for companies-page quick-action prefill
      try {
        const resPrefill = sessionStorage.getItem("research_prefill_company");
        const ctxPrefill = sessionStorage.getItem("research_prefill_context");
        if (resPrefill) {
          sessionStorage.removeItem("research_prefill_company");
          sessionStorage.removeItem("research_prefill_context");
          _pendingQuery = "Generate a comprehensive Datadog strategic overview for " + resPrefill +
            ", mapping their key strategic initiatives, technology investments, " +
            "and risk factors to relevant Datadog products and capabilities.";
          const ctx = document.getElementById("resCompanyContext");
          if (ctx) ctx.value = ctxPrefill || ("Company: " + resPrefill);
          setTimeout(() => {
            document.getElementById("resQueryForm").requestSubmit();
          }, 500);
        }
      } catch { /* ignore */ }

      // Check for hypothesis-to-strategy prefill
      try {
        const raw = sessionStorage.getItem("hypothesis_strategy_prefill");
        if (raw) {
          sessionStorage.removeItem("hypothesis_strategy_prefill");
          const prefill = JSON.parse(raw);
          if (prefill.hypothesis_context) _hypothesisContext = prefill.hypothesis_context;
          if (prefill.sec_filing_ticker) {
            const trySetTicker = () => {
              const sel = document.getElementById("resTickerSelect");
              if (!sel) return false;
              for (const opt of sel.options) {
                if (opt.value === prefill.sec_filing_ticker) {
                  sel.value = prefill.sec_filing_ticker;
                  return true;
                }
              }
              return false;
            };
            if (!trySetTicker()) {
              setTimeout(trySetTicker, 1000);
            }
          }
          if (prefill.hypothesis_context && !prefill.sec_filing_ticker) {
            const ctx = document.getElementById("resCompanyContext");
            if (ctx) ctx.value = prefill.hypothesis_context;
          }
          if (prefill.query) {
            _pendingQuery = prefill.query;
            setTimeout(() => {
              document.getElementById("resQueryForm").requestSubmit();
            }, 500);
          }
        }
      } catch { /* ignore sessionStorage errors */ }
    },

    showForm() {
      exitFocusMode();
      document.getElementById("resFormCard").style.display = "";
      document.getElementById("resResults").style.display = "none";
      _lastResponse = null;
      _lastReportId = null;
    },

    askQuestion(q) {
      document.getElementById("resFormCard").style.display = "";
      document.getElementById("resResults").style.display = "none";
      document.getElementById("resQueryInput").value = q;
      document.getElementById("resQueryForm").requestSubmit();
    },

    async saveReport() {
      if (!_lastResponse) return;
      const btn = document.getElementById("resSaveBtn");
      const status = document.getElementById("resSaveStatus");
      const title = document.getElementById("resReportTitle").value.trim() || null;
      btn.disabled = true;
      status.textContent = "";
      try {
        const data = await API.saveReport(_lastResponse, title);
        status.textContent = "Saved as " + data.id;
        document.getElementById("resReportTitle").value = "";
        loadSavedReports();
      } catch {
        status.textContent = "Save failed";
        status.style.color = "var(--red)";
      } finally {
        btn.disabled = false;
      }
    },

    async loadReport(id) {
      try {
        const data = await API.getReport(id);
        if (data.error) return;
        if (!initialized) { render(); initialized = true; }
        if (data.title) data.response._savedTitle = data.title;
        _lastReportId = id;
        renderResponse(data.response);
      } catch { /* ignore */ }
    },

    async deleteReport(id) {
      try {
        await API.deleteReport(id);
        loadSavedReports();
      } catch { /* ignore */ }
    },

    toggle10K() {
      const panel = document.getElementById("resTenKPanel");
      const toggle = document.getElementById("resTenKToggle");
      const open = panel.style.display === "none";
      panel.style.display = open ? "" : "none";
      toggle.innerHTML = open ? "&#x25BC;" : "&#x25B6;";
    },

    toggleReportDrawer() {
      const drawer = document.getElementById("resReportDrawer");
      const btn = document.getElementById("resDrawerToggle");
      const open = drawer.style.display === "none";
      drawer.style.display = open ? "" : "none";
      btn.innerHTML = open ? "Other Reports &#x25BC;" : "Other Reports &#x25B6;";
    },

    exportPDF() {
      if (!_lastResponse) return;
      const d = _lastResponse;
      const title = d._savedTitle || d._reportTitle || "Strategic Overview";

      const DD_PRODUCTS = [
        "APM", "RUM", "Real User Monitoring", "Cloud SIEM", "Synthetic Monitoring",
        "Synthetics", "Log Management", "Error Tracking", "Infrastructure Monitoring",
        "Database Monitoring", "Observability Pipelines", "Sensitive Data Scanner",
        "Cloud Security Management", "Application Security", "Network Monitoring",
        "Network Device Monitoring", "Container Monitoring", "Serverless Monitoring",
        "CI Visibility", "Session Replay", "Product Analytics", "Workflow Automation",
        "Watchdog", "Service Map", "Universal Service Monitoring",
        "Cloud Cost Management", "Data Streams Monitoring",
      ];

      function collectProducts(text) {
        const found = new Set();
        DD_PRODUCTS.forEach((p) => { if (text.indexOf(p) !== -1) found.add(p); });
        return Array.from(found);
      }

      function collectCaseStudies(text) {
        const studies = [];
        const seen = new Set();
        const patterns = [
          /case study[^:]*?[—–-]\s*([^:]+?):/gi,
          /the\s+(\w[\w\s&.''-]{2,40}?)\s+case study/gi,
        ];
        patterns.forEach((re) => {
          let m;
          while ((m = re.exec(text)) !== null) {
            const name = m[1].trim().replace(/\*+/g, "");
            if (name.length > 1 && name.length < 50 && !seen.has(name.toLowerCase())) {
              seen.add(name.toLowerCase());
              studies.push(name);
            }
          }
        });
        if (!studies.length) {
          const re2 = /(?:like|such as|at|from)\s+([A-Z][\w\s&.''-]{2,30}?)(?:,|\s+(?:who|which|where|that|used|achieved|reduced|saw))/g;
          let m;
          while ((m = re2.exec(text)) !== null) {
            const name = m[1].trim();
            if (!seen.has(name.toLowerCase()) && DD_PRODUCTS.indexOf(name) === -1) {
              seen.add(name.toLowerCase());
              studies.push(name);
            }
          }
        }
        return studies;
      }

      function postProcess(html) {
        const productPattern = DD_PRODUCTS
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .sort((a, b) => b.length - a.length)
          .join("|");
        const safeRe = new RegExp('(?<=^|[\\s>,(])(' + productPattern + ')(?=[\\s<,.):]|$)', "g");
        html = html.replace(safeRe, '<span class="dd-prod">$1</span>');

        html = html.replace(
          /(<blockquote>)([\s\S]*?<strong>Case Study[\s\S]*?)(<\/blockquote>)/gi,
          '<blockquote class="cs-callout">$2$3'
        );

        html = html.replace(
          /(<p><strong>Datadog Relevance:<\/strong>)([\s\S]*?)(<\/p>)/gi,
          '<div class="dd-relevance"><strong>Datadog Relevance:</strong>$2</div>'
        );

        html = html.replace(
          /<p>\s*<strong>(Strategic Theme\s*\d*\s*:\s*)(.*?)<\/strong>/gi,
          '<h3 class="theme-hdr">$1$2</h3>\n<p>'
        );

        return html;
      }

      const rawText = d.synthesized_answer + " " + (d.talk_track || "");
      const products = collectProducts(rawText);
      const caseStudies = collectCaseStudies(rawText);

      const sections = [];

      if (d.talk_track) {
        sections.push({
          heading: "Executive Summary",
          body: postProcess(MD.render(d.talk_track)),
          cls: "exec-summary",
        });
      }

      if (products.length) {
        const pills = products.map((p) => '<span class="dd-prod">' + p + '</span>').join(" ");
        sections.push({
          heading: "Datadog Products Referenced",
          body: '<div class="prod-strip">' + pills + '</div>',
          cls: "products-ref",
        });
      }

      if (caseStudies.length) {
        const items = caseStudies.map((cs) => '<li>' + MD.escapeHtml(cs) + '</li>').join("");
        sections.push({
          heading: "Case Studies Referenced",
          body: '<ul class="cs-list">' + items + '</ul>',
          cls: "cs-ref",
        });
      }

      sections.push({
        heading: "Strategic Analysis",
        body: postProcess(MD.render(d.synthesized_answer)),
        cls: "answer",
      });

      if (d.discovery_questions && d.discovery_questions.length) {
        const list = d.discovery_questions.map((q) => "<li>" + MD.escapeHtml(q) + "</li>").join("");
        sections.push({ heading: "Discovery Questions", body: "<ol>" + list + "</ol>", cls: "discovery" });
      }

      const s = d.sources || {};
      let srcHtml = "";
      [
        ["Technical Library", s.technical],
        ["Value Library", s.value],
        ["Case Studies", s.case_studies],
        ["SEC Filings", s.sec_filings],
        ["Buyer Persona", s.buyer_persona],
      ].forEach(([label, arr]) => {
        if (arr && arr.length) {
          srcHtml += '<div class="src-col"><h4>' + label + "</h4><ul>" +
            arr.map((src) => "<li>" + MD.escapeHtml(src) + "</li>").join("") + "</ul></div>";
        }
      });
      if (srcHtml) {
        sections.push({ heading: "Sources", body: '<div class="src-grid">' + srcHtml + "</div>", cls: "sources" });
      }

      if (d.content_gaps && d.content_gaps.length) {
        const list = d.content_gaps.map((g) => "<li>" + MD.escapeHtml(g) + "</li>").join("");
        sections.push({ heading: "Content Gaps", body: "<ul class='gap-list'>" + list + "</ul>", cls: "gaps" });
      }

      const bodyHtml = sections.map((sec) =>
        '<div class="section ' + sec.cls + '">' +
        '<h2>' + sec.heading + '</h2>' +
        '<div class="section-body">' + sec.body + '</div>' +
        '</div>'
      ).join("");

      const css = `
@page { margin: .75in .85in; size: letter; @bottom-center { content: counter(page) " of " counter(pages); font-size: 8pt; color: #9ca3af; } }
* { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
body { font-family: "Segoe UI", Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #1e1b4b; font-size: 10.5pt; line-height: 1.65; margin: 0; padding: 0; }

.title-block { border-bottom: 3px solid #7c3aed; padding-bottom: .6rem; margin-bottom: .75rem; }
.title-block h1 { font-size: 20pt; margin: 0 0 .15rem; color: #1e1b4b; font-weight: 800; letter-spacing: -.02em; }
.title-block .subtitle { font-size: 9pt; color: #6b7280; }
.title-block .subtitle span { margin-right: .6rem; }

.section { margin-bottom: 1rem; }
.section h2 { font-size: 11pt; color: #7c3aed; margin: 0 0 .35rem; padding-bottom: .2rem;
  border-bottom: 1.5px solid #ede9fe; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.section-body { font-size: 10.5pt; line-height: 1.65; }

.exec-summary { background: #faf5ff; border: 1px solid #ede9fe; border-radius: 8px; padding: .65rem .85rem; margin-bottom: 1rem; }
.exec-summary h2 { border-bottom: none; margin-bottom: .25rem; }
.exec-summary .section-body { font-size: 10.5pt; color: #374151; line-height: 1.7; }

.products-ref .section-body { padding: .15rem 0; }
.prod-strip { display: flex; flex-wrap: wrap; gap: .35rem; }
.dd-prod { background: #ede9fe; color: #5b21b6; padding: .1rem .4rem; border-radius: 4px;
  font-size: 8.5pt; font-weight: 700; white-space: nowrap; display: inline-block; }

.cs-ref { margin-bottom: .75rem; }
.cs-list { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .25rem .6rem; }
.cs-list li { font-size: 9pt; color: #15803d; font-weight: 600; }
.cs-list li::before { content: "\\25CF"; color: #16a34a; margin-right: .25rem; font-size: 7pt; vertical-align: middle; }

.answer .section-body { }

h3, .theme-hdr { font-size: 11.5pt; color: #1e1b4b; font-weight: 700; margin: .8rem 0 .25rem;
  padding: .35rem .6rem; background: #f5f3ff; border-left: 3px solid #7c3aed; border-radius: 0 4px 4px 0; }
h4 { font-size: 10.5pt; margin: .5rem 0 .15rem; }
p { margin: .25rem 0; }
ul, ol { margin: .25rem 0 .25rem 1.4rem; }
li { margin: .1rem 0; }
strong { font-weight: 600; }

blockquote { border-left: 2px solid #d1d5db; padding: .25rem .6rem; color: #555; margin: .4rem 0; font-size: 10pt; }
blockquote.cs-callout { border-left: 3px solid #16a34a; background: #f0fdf4;
  padding: .45rem .7rem; border-radius: 0 6px 6px 0; color: #15803d;
  margin: .5rem 0; page-break-inside: avoid; }
blockquote.cs-callout strong { color: #166534; }

.dd-relevance { background: #f5f3ff; border-left: 3px solid #7c3aed;
  padding: .25rem .65rem; margin: .4rem 0; border-radius: 0 4px 4px 0;
  font-size: 9pt; color: #5b21b6; font-weight: 600; }

.discovery ol { counter-reset: dq; list-style: none; padding-left: 0; }
.discovery ol li { counter-increment: dq; padding: .4rem 0; border-bottom: 1px solid #e5e7eb;
  display: flex; gap: .45rem; font-size: 10pt; line-height: 1.55; }
.discovery ol li:last-child { border-bottom: none; }
.discovery ol li::before { content: counter(dq); background: #ede9fe; color: #7c3aed;
  min-width: 20px; height: 20px; border-radius: 50%; display: inline-flex;
  align-items: center; justify-content: center; font-size: 8pt;
  font-weight: 700; flex-shrink: 0; margin-top: .15rem; }

.src-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
.src-col h4 { font-size: 8pt; color: #6b7280; text-transform: uppercase;
  letter-spacing: .04em; margin: 0 0 .15rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .1rem; }
.src-col ul { list-style: none; padding: 0; margin: 0; }
.src-col li { font-size: 8pt; padding: .1rem 0; color: #374151; line-height: 1.35; word-break: break-all; }
.src-col li::before { content: "\\2022"; color: #7c3aed; margin-right: .2rem; }

.gap-list { list-style: none; padding: 0; }
.gap-list li { font-size: 9pt; padding: .25rem 0; color: #b91c1c;
  border-bottom: 1px solid #fee2e2; line-height: 1.45; }
.gap-list li:last-child { border-bottom: none; }
.gap-list li::before { content: "\\26A0"; margin-right: .25rem; }

table { width: 100%; border-collapse: collapse; margin: .4rem 0; font-size: 9pt; }
th, td { padding: .2rem .4rem; border: 1px solid #d1d5db; text-align: left; }
th { background: #f3f4f6; font-weight: 600; }
code { background: #f3f4f6; padding: .05rem .2rem; border-radius: 3px; font-size: 9pt; }
pre { background: #1e1b4b; color: #e0e0e0; padding: .35rem .5rem; border-radius: 6px;
  font-size: 8pt; overflow-wrap: break-word; white-space: pre-wrap; }
pre code { background: none; padding: 0; color: inherit; }

.footer { margin-top: 1.25rem; padding-top: .35rem; border-top: 1px solid #e5e7eb;
  font-size: 7.5pt; color: #9ca3af; text-align: center; }
`;

      const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
      const metaSpans =
        '<span>Route: ' + d.route + '</span>' +
        '<span>Technical Confidence: ' + d.technical_confidence + '</span>' +
        '<span>Value Confidence: ' + d.value_confidence + '</span>' +
        (d.persona ? '<span>Persona: ' + d.persona + '</span>' : '');

      const html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>' + MD.escapeHtml(title) + '</title>' +
        '<style>' + css + '</style></head><body>' +
        '<div class="title-block">' +
        '<h1>' + MD.escapeHtml(title) + '</h1>' +
        '<div class="subtitle">' + dateStr + ' &nbsp;|&nbsp; ' + metaSpans + '</div>' +
        '</div>' +
        bodyHtml +
        '<div class="footer">Generated by SE Copilot &middot; ' + dateStr + '</div>' +
        '</body></html>';

      const w = window.open("", "_blank");
      w.document.write(html);
      w.document.close();
      setTimeout(() => { w.print(); }, 400);
    },

    openExpansionPlaybook() {
      if (!_lastResponse) return;
      var reportId = _lastResponse._savedId || "";
      var title = _lastResponse._savedTitle || _lastResponse._reportTitle || "";
      var company = "";
      if (title) {
        var parts = title.split(/\s*[-—–|]\s*/);
        company = parts[0].replace(/\s*(Strategic Overview|Executive Report|Report)\s*$/i, "").trim();
      }
      var data = { company_name: company, strategic_overview_id: reportId };
      if (window.expansionPage) window.expansionPage.prefill(data);
      window.navigateTo("expansion");
    },

    async openDemoPlanForm() {
      if (!_lastResponse) return;
      const overlay = document.getElementById("resDpOverlay");
      overlay.style.display = "";
      document.getElementById("resDpFormContainer").style.display = "";
      document.getElementById("resDpProgress").style.display = "none";
      document.getElementById("resDpResult").style.display = "none";

      const title = _lastResponse._savedTitle || _lastResponse._reportTitle || "Strategy Report";
      document.getElementById("resDpSourceLabel").textContent = "Source: " + title;

      const sel = document.getElementById("resDpPersona");
      if (sel.options.length === 0) {
        if (!_demoPersonas) {
          try { _demoPersonas = await API.personas(); } catch { _demoPersonas = null; }
        }
        if (_demoPersonas) {
          Object.entries(_demoPersonas).forEach(([key, val]) => {
            const opt = document.createElement("option");
            opt.value = key;
            opt.textContent = val.title;
            sel.appendChild(opt);
          });
        } else {
          ["vp_engineering", "platform_engineer", "sre_devops", "security_engineer",
           "developer", "engineering_manager", "cto_cio"].forEach((k) => {
            const opt = document.createElement("option");
            opt.value = k;
            opt.textContent = k.replace(/_/g, " ");
            sel.appendChild(opt);
          });
        }
      }
    },

    closeDemoPlanForm() {
      document.getElementById("resDpOverlay").style.display = "none";
    },

    async submitDemoPlan() {
      if (!_lastResponse) return;
      const btn = document.getElementById("resDpSubmitBtn");
      btn.disabled = true;
      btn.textContent = "Generating\u2026";

      // Auto-save the report if not yet saved
      if (!_lastReportId) {
        try {
          const title = _lastResponse._savedTitle || _lastResponse._reportTitle || null;
          const saved = await API.saveReport(_lastResponse, title);
          _lastReportId = saved.id;
          loadSavedReports();
        } catch (err) {
          document.getElementById("resDpResult").style.display = "";
          document.getElementById("resDpResult").innerHTML =
            '<div class="error-msg">Failed to save report first: ' + err.message + '</div>';
          btn.disabled = false;
          btn.textContent = "Generate Demo Plan";
          return;
        }
      }

      document.getElementById("resDpFormContainer").style.display = "none";
      document.getElementById("resDpProgress").style.display = "";
      setDpStep("resDpStepOrch");

      const products = document.getElementById("resDpProducts").value.trim();
      const payload = {
        report_id: _lastReportId,
        persona: document.getElementById("resDpPersona").value,
        demo_mode: document.querySelector('input[name="res_dp_mode"]:checked').value,
        additional_context: document.getElementById("resDpAdditional").value.trim(),
        selected_products: products ? products.split(",").map((s) => s.trim()).filter(Boolean) : [],
        incumbent_tooling: document.getElementById("resDpIncumbent").value.trim(),
      };

      const t1 = setTimeout(() => setDpStep("resDpStepRetr"), 4000);
      const t2 = setTimeout(() => setDpStep("resDpStepSynth"), 12000);

      try {
        const data = await API.generateDemoPlanFromReport(payload);
        clearTimeout(t1);
        clearTimeout(t2);
        document.getElementById("resDpProgress").style.display = "none";
        document.getElementById("resDpResult").style.display = "";
        document.getElementById("resDpResult").innerHTML =
          '<div class="dp-success">' +
          '<p class="dp-success-msg">Demo plan created successfully.</p>' +
          '<button class="btn btn-primary" onclick="location.hash=\'demo-planner\';window.researchPage.closeDemoPlanForm();">Open in Demo Planner</button>' +
          '<button class="btn" onclick="window.researchPage.closeDemoPlanForm()">Close</button>' +
          '</div>';
      } catch (err) {
        clearTimeout(t1);
        clearTimeout(t2);
        document.getElementById("resDpProgress").style.display = "none";
        document.getElementById("resDpFormContainer").style.display = "";
        document.getElementById("resDpResult").style.display = "";
        document.getElementById("resDpResult").innerHTML =
          '<div class="error-msg">Error: ' + err.message + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = "Generate Demo Plan";
      }
    },

    edgarSearch,
    edgarIngest,
  };

  function setDpStep(step) {
    ["resDpStepOrch", "resDpStepRetr", "resDpStepSynth"].forEach((id) => {
      document.getElementById(id).className = "step";
    });
    const order = ["resDpStepOrch", "resDpStepRetr", "resDpStepSynth"];
    const idx = order.indexOf(step);
    for (let i = 0; i < idx; i++) {
      document.getElementById(order[i]).className = "step done";
      document.getElementById(order[i]).querySelector(".icon").textContent = "\u2713";
    }
    if (idx >= 0) document.getElementById(order[idx]).className = "step active";
  }
})();
