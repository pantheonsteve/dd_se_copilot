/**
 * Demo Planner — form, plan generation, tab viewer, slides, PDF.
 * Ported from inline HTML in main.py with sidebar plan browser.
 */
window.demoPlanner = (function () {
  let initialized = false;
  let _rawMarkdown = "";
  let _sectionMarkdown = {};
  let _planResponse = null;
  let _slidesJSON = null;
  let _selectedReportId = null;

  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "opening", label: "Opening Frame" },
    { id: "loops", label: "Demo Loops" },
    { id: "competitive", label: "Competitive" },
    { id: "slides", label: "Slides" },
    { id: "closing", label: "Closing" },
  ];

  function classifySection(header) {
    const h = header.toUpperCase();
    if (h.includes("DEMO PLAN") || h.includes("EXECUTIVE SUMMARY") || h.includes("PRE-CALL INTEL")) return "overview";
    if (h.includes("OPENING FRAME")) return "opening";
    if (h.includes("TELL") && h.includes("SHOW")) return "loops";
    if (h.includes("COMPETITIVE")) return "competitive";
    if (h.includes("SLIDE")) return "slides";
    if (h.includes("CLOSING") || h.includes("NEXT STEPS")) return "closing";
    if (h.includes("QUICK REFERENCE")) return "qr";
    return "overview";
  }

  function render() {
    const el = document.getElementById("page-demo-planner");
    el.innerHTML = `
      <div class="demo-layout">
        <!-- Saved plans sidebar -->
        <div class="plans-sidebar">
          <div class="card">
            <p class="section-title">Saved Plans</p>
            <div id="dpSavedList"><span class="empty">Loading...</span></div>
          </div>
        </div>

        <!-- Main column -->
        <div>
          <!-- Form -->
          <div class="card" id="dpFormCard">
            <div class="dp-form-tabs">
              <button class="dp-form-tab active" id="dpTabScratch" onclick="window.demoPlanner.switchFormTab('scratch')">From Scratch</button>
              <button class="dp-form-tab" id="dpTabReport" onclick="window.demoPlanner.switchFormTab('report')">From Report</button>
            </div>

            <!-- From Scratch form -->
            <form id="dpForm">
              <div class="form-grid">
                <div class="field full">
                  <label>Demo Mode</label>
                  <div class="radio-group">
                    <label><input type="radio" name="dp_demo_mode" value="discovery_driven" checked> Discovery-Driven</label>
                    <label><input type="radio" name="dp_demo_mode" value="product_expansion"> Product Expansion</label>
                    <label><input type="radio" name="dp_demo_mode" value="competitive_displacement"> Competitive Displacement</label>
                  </div>
                </div>
                <div class="field">
                  <label for="dpPersonaSel">Persona</label>
                  <select id="dpPersonaSel" required></select>
                </div>
                <div class="field">
                  <label for="dpCompanyName">Company Name</label>
                  <input type="text" id="dpCompanyName" placeholder="e.g. Acme Corp" required>
                </div>
                <div class="field">
                  <label>&nbsp;</label>
                  <div class="check-row">
                    <input type="checkbox" id="dpIsPublic">
                    <label for="dpIsPublic">Public company (include 10-K analysis)</label>
                  </div>
                </div>
                <div class="field">
                  <label for="dpIncumbent">Incumbent Tooling</label>
                  <input type="text" id="dpIncumbent" placeholder="e.g. Splunk, New Relic, Grafana">
                </div>
                <div class="field full">
                  <label for="dpProducts">Specific Products to Cover (comma-separated, optional)</label>
                  <input type="text" id="dpProducts" placeholder="e.g. APM, Log Management, Infrastructure Monitoring">
                </div>
                <div class="field full">
                  <label for="dpPainPoints">Customer Pain Points (from discovery)</label>
                  <textarea id="dpPainPoints" rows="2" placeholder="e.g. MTTR is over 45 minutes, drowning in alerts, three different tools for logs/metrics/traces"></textarea>
                </div>
                <div class="field full">
                  <label for="dpDiscoveryNotes">Discovery Notes (raw paste)</label>
                  <textarea id="dpDiscoveryNotes" rows="3" placeholder="Paste call notes, summaries, or key quotes from prior conversations..."></textarea>
                </div>
                <div class="field">
                  <label for="dpEvalReason">Evaluation Reason</label>
                  <input type="text" id="dpEvalReason" placeholder="e.g. cost, vendor consolidation, capability gaps">
                </div>
                <div class="field" style="display:flex;align-items:flex-end;">
                  <button type="submit" class="btn btn-primary" id="dpSubmitBtn">Generate Demo Plan</button>
                </div>
              </div>
            </form>

            <!-- From Report form -->
            <div id="dpFromReportForm" style="display:none;">
              <div class="dp-report-picker">
                <label class="dp-picker-label">Select a saved report</label>
                <div id="dpReportList"><span class="empty">Loading reports...</span></div>
              </div>
              <div id="dpReportSelected" style="display:none;">
                <div class="dp-modal-source" id="dpReportSelectedLabel"></div>
                <div class="form-grid">
                  <div class="field full">
                    <label>Demo Mode</label>
                    <div class="radio-group">
                      <label><input type="radio" name="dp_rpt_mode" value="discovery_driven" checked> Discovery-Driven</label>
                      <label><input type="radio" name="dp_rpt_mode" value="product_expansion"> Product Expansion</label>
                      <label><input type="radio" name="dp_rpt_mode" value="competitive_displacement"> Competitive Displacement</label>
                    </div>
                  </div>
                  <div class="field">
                    <label for="dpRptPersona">Persona</label>
                    <select id="dpRptPersona" required></select>
                  </div>
                  <div class="field">
                    <label for="dpRptProducts">Specific Products (optional)</label>
                    <input type="text" id="dpRptProducts" placeholder="e.g. APM, Log Management">
                  </div>
                  <div class="field">
                    <label for="dpRptIncumbent">Incumbent Tooling (optional)</label>
                    <input type="text" id="dpRptIncumbent" placeholder="e.g. Splunk, New Relic">
                  </div>
                  <div class="field full">
                    <label for="dpRptAdditional">Additional Context (optional)</label>
                    <textarea id="dpRptAdditional" rows="3" placeholder="Any extra notes or context..."></textarea>
                  </div>
                  <div class="field" style="display:flex;align-items:flex-end;">
                    <button type="button" class="btn btn-primary" id="dpRptSubmitBtn" onclick="window.demoPlanner.submitFromReport()">Generate Demo Plan</button>
                  </div>
                </div>
              </div>
              <div id="dpRptError" class="error-msg" style="display:none;margin-top:.5rem;"></div>
            </div>
          </div>

          <!-- Progress -->
          <div class="card" id="dpProgressCard" style="display:none;">
            <div class="progress-steps">
              <div class="step" id="dpStepOrch"><span class="icon"></span> Orchestrating</div>
              <div class="step" id="dpStepRetr"><span class="icon"></span> Retrieving context</div>
              <div class="step" id="dpStepSynth"><span class="icon"></span> Synthesizing demo plan</div>
            </div>
          </div>

          <!-- Error -->
          <div class="error-msg" id="dpErrorMsg" style="display:none;"></div>

          <!-- Results -->
          <div id="dpResults" style="display:none;">
            <div class="card">
              <div class="plan-header">
                <div class="meta-bar" id="dpMetaBar"></div>
                <div class="linked-artifacts" id="dpLinkedArtifacts" style="display:none;"></div>
                <div class="top-actions">
                  <button onclick="window.demoPlanner.showForm()" class="btn-new-plan" id="dpNewPlanBtn">+ New Plan</button>
                  <button onclick="window.demoPlanner.generateSlides()" id="dpSlidesBtn" style="display:none;">Generate Slides</button>
                  <button onclick="window.demoPlanner.viewSlides()" id="dpViewSlidesBtn" style="display:none;">View Slides</button>
                  <button onclick="window.demoPlanner.downloadPDF()" id="dpPdfBtn" style="display:none;">Download PDF</button>
                  <button onclick="window.demoPlanner.copyPlan()" id="dpCopyFullBtn">Copy Full Plan</button>
                  <button onclick="window.demoPlanner.exportMarkdown()">Export .md</button>
                </div>
              </div>
            </div>

            <div class="tab-bar" id="dpTabBar"></div>
            <div id="dpTabPanels"></div>

            <div class="card" id="dpSourcesCard" style="display:none;">
              <p class="section-title">Sources</p>
              <div id="dpSourcesList"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    document.getElementById("dpForm").addEventListener("submit", handleSubmit);
  }

  // Personas
  async function loadPersonas() {
    const sel = document.getElementById("dpPersonaSel");
    if (!sel || sel.options.length > 0) return;
    try {
      const data = await API.personas();
      Object.entries(data).forEach(([key, val]) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = val.title;
        sel.appendChild(opt);
      });
    } catch {
      ["vp_engineering", "platform_engineer", "sre_devops", "security_engineer",
       "developer", "engineering_manager", "cto_cio"].forEach((k) => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k.replace(/_/g, " ");
        sel.appendChild(opt);
      });
    }
  }

  // Linked artifacts
  async function _loadDpLinkedArtifacts(company) {
    const el = document.getElementById("dpLinkedArtifacts");
    if (!el || !company || company.length < 2) { if (el) el.style.display = "none"; return; }
    try {
      const data = await API.linkedArtifacts(company);
      const links = [];
      if (data.hypothesis) {
        links.push(
          `<a class="linked-chip linked-hyp" href="#" onclick="event.preventDefault();window.hypothesisPage.loadHypothesis('${data.hypothesis.id}');window.navigateTo('hypothesis');">` +
          `<span class="linked-icon">&#x1F9EA;</span> Sales Hypothesis (${data.hypothesis.confidence_level})</a>`
        );
      }
      if (data.reports && data.reports.length) {
        data.reports.forEach((r) => {
          links.push(
            `<a class="linked-chip linked-report" href="#" onclick="event.preventDefault();window.researchPage.loadReport('${r.id}');window.navigateTo('research');">` +
            `<span class="linked-icon">&#x1F4CA;</span> ${MD.escapeHtml(r.title || "Strategy Report")}</a>`
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

  // Saved plans sidebar
  async function loadSavedPlans() {
    const el = document.getElementById("dpSavedList");
    if (!el) return;
    try {
      const data = await API.listDemoPlans();
      if (!data.length) {
        el.innerHTML = '<span class="empty">No saved plans yet.</span>';
        return;
      }
      el.innerHTML = data.map((p) => {
        const date = MD.formatDate(p.created_at);
        const mode = p.demo_mode.replace(/_/g, " ");
        let actions = '';
        if (p.has_slides) actions += '<button class="si-btn" onclick="event.stopPropagation();window.demoPlanner.loadSavedSlides(\'' + p.id + '\')">Slides</button>';
        if (p.has_pdf) actions += '<button class="si-btn" onclick="event.stopPropagation();API.getDemoPlanPdf(\'' + p.id + '\')">PDF</button>';
        actions += '<button class="si-btn delete" onclick="event.stopPropagation();window.demoPlanner.deletePlan(\'' + p.id + '\')">Del</button>';
        return '<div class="saved-item" onclick="window.demoPlanner.loadSavedPlan(\'' + p.id + '\')">' +
          '<span class="si-title">' + MD.escapeHtml(p.title) + '</span>' +
          '<div class="si-row">' +
            '<span class="si-meta">' + mode + ' &middot; ' + date + '</span>' +
            '<div class="si-actions">' + actions + '</div>' +
          '</div>' +
          '</div>';
      }).join("");
    } catch {
      el.innerHTML = '<span class="empty">Failed to load plans.</span>';
    }
  }

  // Progress stepper
  function setStep(step) {
    ["dpStepOrch", "dpStepRetr", "dpStepSynth"].forEach((id) => {
      document.getElementById(id).className = "step";
    });
    const order = ["dpStepOrch", "dpStepRetr", "dpStepSynth"];
    const idx = order.indexOf(step);
    for (let i = 0; i < idx; i++) {
      document.getElementById(order[i]).className = "step done";
      document.getElementById(order[i]).querySelector(".icon").textContent = "\u2713";
    }
    if (idx >= 0) document.getElementById(order[idx]).className = "step active";
  }

  // Form submit
  async function handleSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById("dpSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Generating\u2026";

    document.getElementById("dpFormCard").style.display = "none";
    document.getElementById("dpResults").style.display = "none";
    document.getElementById("dpErrorMsg").style.display = "none";
    document.getElementById("qrFab").classList.remove("show");
    document.getElementById("dpProgressCard").style.display = "";
    setStep("dpStepOrch");

    const products = document.getElementById("dpProducts").value.trim();
    const payload = {
      demo_mode: document.querySelector('input[name="dp_demo_mode"]:checked').value,
      persona: document.getElementById("dpPersonaSel").value,
      company_name: document.getElementById("dpCompanyName").value.trim(),
      is_public_company: document.getElementById("dpIsPublic").checked,
      selected_products: products ? products.split(",").map((s) => s.trim()).filter(Boolean) : [],
      customer_pain_points: document.getElementById("dpPainPoints").value.trim(),
      discovery_notes: document.getElementById("dpDiscoveryNotes").value.trim(),
      incumbent_tooling: document.getElementById("dpIncumbent").value.trim(),
      evaluation_reason: document.getElementById("dpEvalReason").value.trim(),
    };

    const t1 = setTimeout(() => setStep("dpStepRetr"), 4000);
    const t2 = setTimeout(() => setStep("dpStepSynth"), 12000);

    try {
      const data = await API.generateDemoPlan(payload);
      _planResponse = data;
      renderPlan(data);
      loadSavedPlans();
    } catch (err) {
      document.getElementById("dpFormCard").style.display = "";
      document.getElementById("dpErrorMsg").textContent = "Error: " + err.message;
      document.getElementById("dpErrorMsg").style.display = "";
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      document.getElementById("dpProgressCard").style.display = "none";
      btn.disabled = false;
      btn.textContent = "Generate Demo Plan";
    }
  }

  // Section parsing
  function parseSections(md) {
    const parts = md.split(/^(###\s+.+)$/m);
    const sections = [];
    if (parts[0] && parts[0].trim()) {
      sections.push({ header: "Preamble", content: parts[0].trim(), raw: parts[0].trim() });
    }
    for (let i = 1; i < parts.length; i += 2) {
      const header = parts[i].replace(/^###\s+/, "").trim();
      const content = (parts[i + 1] || "").trim();
      sections.push({ header, content, raw: parts[i] + "\n" + (parts[i + 1] || "") });
    }
    return sections;
  }

  // Main plan render
  function renderPlan(data) {
    _rawMarkdown = data.demo_plan;
    _sectionMarkdown = {};

    // Meta badges
    const t = data.stage_timings_ms || {};
    let badges = '<span class="badge mode">' +
      (document.querySelector('input[name="dp_demo_mode"]:checked')?.value || data.demo_mode || "").replace(/_/g, " ") + "</span>";
    badges += '<span class="badge time">' + (data.processing_time_ms / 1000).toFixed(1) + "s</span>";
    if (t.orchestrator) badges += '<span class="badge time">Orch ' + (t.orchestrator / 1000).toFixed(1) + "s</span>";
    if (t.retrieval) badges += '<span class="badge time">Retrieval ' + (t.retrieval / 1000).toFixed(1) + "s</span>";
    if (t.synthesis) badges += '<span class="badge time">Synthesis ' + (t.synthesis / 1000).toFixed(1) + "s</span>";
    document.getElementById("dpMetaBar").innerHTML = badges;

    // Load linked artifacts for the company
    const dpCompany = data.company_name || (document.getElementById("dpCompanyName") || {}).value || "";
    _loadDpLinkedArtifacts(dpCompany);

    // Parse sections
    const sections = parseSections(_rawMarkdown);
    const tabContent = {};
    TABS.forEach((tab) => { tabContent[tab.id] = []; });
    let qrMarkdown = "";

    sections.forEach((sec) => {
      const tabId = classifySection(sec.header);
      if (tabId === "qr") { qrMarkdown = sec.content; return; }
      if (!tabContent[tabId]) tabContent[tabId] = [];
      tabContent[tabId].push(sec);
      if (!_sectionMarkdown[tabId]) _sectionMarkdown[tabId] = "";
      _sectionMarkdown[tabId] += sec.raw + "\n\n";
    });

    // Build tabs
    const tabBar = document.getElementById("dpTabBar");
    const panels = document.getElementById("dpTabPanels");
    tabBar.innerHTML = "";
    panels.innerHTML = "";
    let firstTab = null;

    TABS.forEach((tab) => {
      if (!tabContent[tab.id] || !tabContent[tab.id].length) return;
      if (!firstTab) firstTab = tab.id;

      const btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.addEventListener("click", () => switchTab(tab.id));
      tabBar.appendChild(btn);

      const panel = document.createElement("div");
      panel.className = "tab-panel";
      panel.id = "dp-panel-" + tab.id;
      panel.innerHTML = renderTabPanel(tab.id, tabContent[tab.id]);
      panels.appendChild(panel);
    });

    if (firstTab) switchTab(firstTab);

    // QR panel
    populateQR(qrMarkdown, data);
    document.getElementById("qrFab").classList.add("show");

    // PDF button
    document.getElementById("dpPdfBtn").style.display = data.plan_id && data.pdf_path ? "" : "none";

    // Slides button
    showSlidesBtn();

    // Sources
    renderSources(data.sources_used || {});

    document.getElementById("dpFormCard").style.display = "none";
    document.getElementById("dpResults").style.display = "";
  }

  function renderTabPanel(tabId, sections) {
    if (tabId === "overview") return renderOverview(sections);
    if (tabId === "loops") return renderLoops(sections);

    const extraClass = tabId === "opening" ? " opening-frame" : tabId === "competitive" ? " competitive" : "";
    let html = '<div class="section-card' + extraClass + '">';
    html += '<div class="section-card-header">';
    html += "<h2>" + sections.map((s) => s.header).join(" / ") + "</h2>";
    html += '<button class="copy-section-btn" onclick="window.demoPlanner.copySection(\'' + tabId + '\')">Copy</button>';
    html += "</div>";
    html += '<div class="section-body">';
    sections.forEach((sec) => { html += MD.render(sec.content); });
    html += "</div></div>";
    return html;
  }

  function renderOverview(sections) {
    let html = "";
    sections.forEach((sec) => {
      const isExecSummary = sec.header.toUpperCase().includes("EXECUTIVE SUMMARY");
      const isDemoPlan = sec.header.toUpperCase().includes("DEMO PLAN");
      if (isDemoPlan) {
        html += '<div class="section-card"><div class="section-body">' + MD.render(sec.content) + "</div></div>";
      } else if (isExecSummary) {
        html += '<div class="section-card">';
        html += '<div class="section-card-header"><h2>' + sec.header + "</h2>";
        html += '<button class="copy-section-btn" onclick="window.demoPlanner.copySection(\'overview\')">Copy</button></div>';
        html += '<div class="hero-summary">' + MD.render(sec.content) + "</div></div>";
      } else {
        html += '<div class="section-card">';
        html += '<div class="section-card-header"><h2>' + sec.header + "</h2></div>";
        html += '<div class="section-body">' + MD.render(sec.content) + "</div></div>";
      }
    });
    return html;
  }

  function renderLoops(sections) {
    let combinedMd = sections.map((s) => s.content).join("\n\n");
    let html = '<div class="section-card">';
    html += '<div class="section-card-header"><h2>Tell-Show-Tell Loops</h2>';
    html += '<button class="copy-section-btn" onclick="window.demoPlanner.copySection(\'loops\')">Copy</button></div>';

    const loopParts = combinedMd.split(/^(####\s+.+)$/m);
    let preamble = (loopParts[0] || "").trim();
    if (preamble) html += '<div class="section-body">' + MD.render(preamble) + "</div>";

    for (let i = 1; i < loopParts.length; i += 2) {
      const loopHeader = loopParts[i].replace(/^####\s+/, "").trim();
      const loopContent = (loopParts[i + 1] || "").trim();

      const painMatch = loopContent.match(/\*\*Pain Point Addressed:\*\*\s*(.+)/i);
      const productMatch = loopContent.match(/\*\*Primary Product:\*\*\s*(.+)/i);
      const metaText = [painMatch ? painMatch[1] : "", productMatch ? productMatch[1] : ""].filter(Boolean).join(" \u2022 ");

      html += '<div class="loop-toggle" onclick="this.classList.toggle(\'open\');this.nextElementSibling.classList.toggle(\'open\')">';
      html += '<span class="arrow">\u25B6</span>';
      html += "<span>" + loopHeader + "</span>";
      if (metaText) html += '<span class="loop-meta">' + metaText + "</span>";
      html += "</div>";
      html += '<div class="loop-body">';
      html += styleLoopPhases(loopContent);
      html += "</div>";
    }

    html += "</div>";
    return html;
  }

  function styleLoopPhases(md) {
    const phases = [
      { pattern: /^\*\*TELL\s*\(Setup/im, cls: "phase-tell", label: "TELL (Setup)" },
      { pattern: /^\*\*SHOW\s*\(Live/im, cls: "phase-show", label: "SHOW (Live Demo)" },
      { pattern: /^\*\*TELL\s*\(Connection/im, cls: "phase-tell", label: "TELL (Connection)" },
      { pattern: /^\*\*DISCOVERY/im, cls: "phase-discovery", label: "DISCOVERY QUESTIONS" },
      { pattern: /^\*\*TRANSITION/im, cls: "phase-transition", label: "TRANSITION" },
    ];

    let markers = [];
    phases.forEach((ph) => {
      const m = md.match(ph.pattern);
      if (m) markers.push({ idx: m.index, cls: ph.cls, label: ph.label });
    });
    markers.sort((a, b) => a.idx - b.idx);

    if (!markers.length) return '<div class="section-body">' + MD.render(md) + "</div>";

    let result = "";
    const preamble = md.slice(0, markers[0].idx).trim();
    if (preamble) result += '<div class="section-body">' + MD.render(preamble) + "</div>";

    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].idx;
      const end = i + 1 < markers.length ? markers[i + 1].idx : md.length;
      const phaseContent = md.slice(start, end).trim();
      result += '<div class="loop-phase ' + markers[i].cls + '">';
      result += '<div class="phase-label">' + markers[i].label + "</div>";
      result += '<div class="section-body">' + MD.render(phaseContent) + "</div></div>";
    }
    return result;
  }

  // QR panel
  function populateQR(qrMarkdown, data) {
    const qrCard = document.getElementById("qrCard");
    if (qrMarkdown) {
      qrCard.innerHTML = MD.render(qrMarkdown);
    } else {
      const cp = data.context_plan;
      if (!cp) { qrCard.innerHTML = "<p>No quick reference available.</p>"; return; }
      let h = "";
      h += "<h4>North Star</h4><p>" + (cp.narrative_angle || "\u2014") + "</p>";
      if (cp.persona_context && cp.persona_context.combined_pain_priority.length) {
        h += "<h4>Top Pains</h4><ul>" + cp.persona_context.combined_pain_priority.slice(0, 5).map((p) => "<li>" + p + "</li>").join("") + "</ul>";
      }
      if (cp.product_mapping && cp.product_mapping.primary_products.length) {
        h += "<h4>Products to Show</h4><ul>" + cp.product_mapping.primary_products.map((p) => "<li>" + p + "</li>").join("") + "</ul>";
      }
      qrCard.innerHTML = h;
    }
  }

  // Tab switching
  function switchTab(tabId) {
    document.querySelectorAll("#dpTabBar .tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll("#dpTabPanels .tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === "dp-panel-" + tabId);
    });
  }

  // Sources
  function renderSources(src) {
    const hasSrc = (src.librarian && src.librarian.length) || (src.value && src.value.length) || (src.sec_filings && src.sec_filings.length);
    if (!hasSrc) { document.getElementById("dpSourcesCard").style.display = "none"; return; }
    let html = "";
    if (src.librarian && src.librarian.length) {
      html += "<strong>Librarian:</strong><ul class='src-list'>" + src.librarian.map((s) => "<li>" + MD.shortSource(s) + "</li>").join("") + "</ul>";
    }
    if (src.value && src.value.length) {
      html += "<strong>Value:</strong><ul class='src-list'>" + src.value.map((s) => "<li>" + MD.shortSource(s) + "</li>").join("") + "</ul>";
    }
    if (src.sec_filings && src.sec_filings.length) {
      html += "<strong>SEC Filings:</strong><ul class='src-list'>" + src.sec_filings.map((s) => "<li>" + MD.shortSource(s) + "</li>").join("") + "</ul>";
    }
    document.getElementById("dpSourcesList").innerHTML = html;
    document.getElementById("dpSourcesCard").style.display = "";
  }

  // Slides
  function showSlidesBtn() {
    const genBtn = document.getElementById("dpSlidesBtn");
    const viewBtn = document.getElementById("dpViewSlidesBtn");
    if (_planResponse && _planResponse.plan_id) {
      if (_planResponse.has_slides) {
        genBtn.style.display = "none";
        viewBtn.style.display = "";
      } else {
        genBtn.style.display = "";
        viewBtn.style.display = "none";
      }
    } else {
      genBtn.style.display = "none";
      viewBtn.style.display = "none";
    }
  }

  let _activeSlideIdx = 0;

  function switchSlide(idx) {
    const tabs = document.querySelectorAll("#slidesContent .slide-tab");
    const panes = document.querySelectorAll("#slidesContent .slide-pane");
    if (idx < 0 || idx >= panes.length) return;
    _activeSlideIdx = idx;
    tabs.forEach((t, i) => t.classList.toggle("active", i === idx));
    panes.forEach((p, i) => p.classList.toggle("active", i === idx));
    const counter = document.getElementById("slideCounter");
    if (counter) counter.textContent = (idx + 1) + " / " + panes.length;
    const prevBtn = document.getElementById("slidePrev");
    const nextBtn = document.getElementById("slideNext");
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === panes.length - 1;
    tabs[idx].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  function formatSlideContent(lines) {
    const cleaned = lines.filter((l) => l.trim() !== "");
    if (!cleaned.length) return "";
    let html = '<div class="slide-body">';
    let inSub = false;
    cleaned.forEach((line) => {
      const trimmed = line.replace(/^[\u2014\u2013\-]\s*/, "");
      const isSub = /^[\u2014\u2013\-]\s/.test(line);
      if (isSub) {
        if (!inSub) { html += "<ul>"; inSub = true; }
        html += "<li>" + trimmed + "</li>";
      } else {
        if (inSub) { html += "</ul>"; inSub = false; }
        html += '<p class="slide-heading">' + line + "</p>";
      }
    });
    if (inSub) html += "</ul>";
    html += "</div>";
    return html;
  }

  function formatNotes(notes) {
    const cleaned = notes.filter((n) => n.trim() !== "");
    if (!cleaned.length) return "";
    let html = '<div class="notes-body">';
    cleaned.forEach((note) => {
      const label = note.match(/^(Talk track|Demo click path|Discovery question|Internal note|Do|Don't|Reminder|Timing note|Tip):\s*/i);
      if (label) {
        html += '<div class="note-item"><span class="note-label">' +
          label[1] + ":</span> " + note.slice(label[0].length) + "</div>";
      } else {
        html += '<div class="note-item">' + note + "</div>";
      }
    });
    html += "</div>";
    return html;
  }

  function renderSlides(data) {
    const deck = data.slide_deck;
    document.getElementById("slidesDeckTitle").textContent = deck.deck_title || "Generated Slides";

    let meta = '<div class="slides-meta">' +
      "<strong>Audience:</strong> " + (deck.audience || "\u2014") +
      " &middot; <strong>Goal:</strong> " + (deck.source_summary?.demo_goal || "\u2014") +
      " &middot; <strong>Time:</strong> " + (deck.source_summary?.timebox_minutes || 60) + " min" +
      (data.processing_time_ms ? " &middot; Generated in " + (data.processing_time_ms / 1000).toFixed(1) + "s" : "") +
      "</div>";

    let tabs = '<div class="slide-tabs">';
    let panes = "";

    deck.slides.forEach((slide, i) => {
      tabs += '<button class="slide-tab' + (i === 0 ? " active" : "") +
        '" onclick="window.demoPlanner.switchSlide(' + i + ')">' +
        slide.slide_number + "</button>";

      panes += '<div class="slide-pane' + (i === 0 ? " active" : "") + '">' +
        '<div class="slide-layout">';

      panes += '<div class="slide-card">' +
        '<div class="slide-num">Slide ' + slide.slide_number + "</div>" +
        "<h4>" + slide.title + "</h4>";

      if (slide.tags && slide.tags.length) {
        panes += '<div class="slide-tags">';
        slide.tags.forEach((t) => { panes += '<span class="slide-tag">' + t + "</span>"; });
        panes += "</div>";
      }

      panes += formatSlideContent(slide.customer_facing_text || []);
      panes += "</div>";

      panes += '<div class="notes-section">' +
        '<div class="notes-label">Speaker Notes</div>';
      if (slide.internal_speaker_notes && slide.internal_speaker_notes.length) {
        panes += formatNotes(slide.internal_speaker_notes);
      } else {
        panes += '<p class="notes-empty">No speaker notes for this slide.</p>';
      }
      panes += "</div>";

      panes += "</div></div>";
    });

    tabs += "</div>";

    const total = deck.slides.length;
    const nav = '<div class="slide-nav">' +
      '<button id="slidePrev" onclick="window.demoPlanner.switchSlide(window.demoPlanner._activeSlideIdx-1)" disabled>&larr; Previous</button>' +
      '<span class="slide-counter" id="slideCounter">1 / ' + total + "</span>" +
      '<button id="slideNext" onclick="window.demoPlanner.switchSlide(window.demoPlanner._activeSlideIdx+1)"' +
      (total <= 1 ? " disabled" : "") + ">Next &rarr;</button></div>";

    document.getElementById("slidesContent").innerHTML = meta + tabs + panes + nav;
    document.getElementById("slidesContent").classList.add("visible");
    _activeSlideIdx = 0;
  }

  function injectBreadcrumb() {
    var container = document.getElementById("page-demo-planner");
    var existing = container.querySelector(".company-breadcrumb");
    if (existing) existing.remove();
    var html = window.renderCompanyBreadcrumb ? window.renderCompanyBreadcrumb("Demo Planner") : "";
    if (html) container.insertAdjacentHTML("afterbegin", html);
  }

  return {
    init() {
      if (!initialized) {
        render();
        initialized = true;
        loadPersonas();
      }
      injectBreadcrumb();
      loadSavedPlans();

      // Check for companies-page quick-action prefill
      try {
        const demoPrefill = sessionStorage.getItem("demo_prefill_company");
        if (demoPrefill) {
          sessionStorage.removeItem("demo_prefill_company");
          const el = document.getElementById("dpCompanyName");
          if (el) el.value = demoPrefill;
        }
      } catch { /* ignore */ }

      // Check for hypothesis prefill data
      try {
        const raw = sessionStorage.getItem("hypothesis_prefill");
        if (raw) {
          sessionStorage.removeItem("hypothesis_prefill");
          const prefill = JSON.parse(raw);
          const companyEl = document.getElementById("dpCompanyName");
          const publicEl = document.getElementById("dpIsPublic");
          const incumbentEl = document.getElementById("dpIncumbent");
          const painsEl = document.getElementById("dpPains");
          if (companyEl && prefill.company_name) companyEl.value = prefill.company_name;
          if (publicEl && prefill.is_public_company) publicEl.checked = true;
          if (incumbentEl && prefill.incumbent_tooling) incumbentEl.value = prefill.incumbent_tooling;
          if (painsEl && prefill.customer_pain_points) painsEl.value = prefill.customer_pain_points;
        }
      } catch { /* sessionStorage unavailable or parse error */ }
    },

    async loadSavedPlan(id) {
      try {
        const data = await API.getDemoPlan(id);
        if (data.error) return;
        const restored = {
          demo_plan: data.markdown,
          context_plan: data.context_plan_json ? JSON.parse(data.context_plan_json) : null,
          sources_used: data.sources_json ? JSON.parse(data.sources_json) : {},
          stage_timings_ms: {},
          processing_time_ms: data.processing_time_ms || 0,
          plan_id: data.id,
          pdf_path: data.pdf_path || "",
          has_slides: !!data.slides_json,
        };
        _planResponse = restored;
        renderPlan(restored);
      } catch { /* ignore */ }
    },

    async loadSavedSlides(id) {
      const overlay = document.getElementById("slidesOverlay");
      overlay.classList.add("show");
      document.getElementById("slidesLoading").style.display = "";
      document.getElementById("slidesContent").classList.remove("visible");
      try {
        const data = await API.getSlides(id);
        if (data.error) throw new Error(data.error);
        _slidesJSON = data;
        renderSlides(data);
      } catch (err) {
        document.getElementById("slidesContent").innerHTML = '<div class="error-msg">Failed to load slides: ' + err.message + "</div>";
        document.getElementById("slidesContent").classList.add("visible");
      } finally {
        document.getElementById("slidesLoading").style.display = "none";
      }
    },

    async deletePlan(id) {
      try {
        await API.deleteDemoPlan(id);
        loadSavedPlans();
      } catch { /* ignore */ }
    },

    async generateSlides() {
      if (!_planResponse || !_planResponse.plan_id) return;
      const overlay = document.getElementById("slidesOverlay");
      overlay.classList.add("show");
      document.getElementById("slidesLoading").style.display = "";
      document.getElementById("slidesContent").classList.remove("visible");
      _slidesJSON = null;
      try {
        const data = await API.generateSlides(_planResponse.plan_id);
        if (data.error) throw new Error(data.error);
        _slidesJSON = data;
        _planResponse.has_slides = true;
        showSlidesBtn();
        renderSlides(data);
      } catch (err) {
        document.getElementById("slidesContent").innerHTML = '<div class="error-msg">Error generating slides: ' + err.message + "</div>";
        document.getElementById("slidesContent").classList.add("visible");
      } finally {
        document.getElementById("slidesLoading").style.display = "none";
      }
    },

    async viewSlides() {
      if (!_planResponse || !_planResponse.plan_id) return;
      const overlay = document.getElementById("slidesOverlay");
      overlay.classList.add("show");
      document.getElementById("slidesLoading").style.display = "";
      document.getElementById("slidesContent").classList.remove("visible");
      try {
        const data = await API.getSlides(_planResponse.plan_id);
        if (data.error) throw new Error(data.error);
        _slidesJSON = data;
        renderSlides(data);
      } catch (err) {
        document.getElementById("slidesContent").innerHTML = '<div class="error-msg">Failed to load slides: ' + err.message + "</div>";
        document.getElementById("slidesContent").classList.add("visible");
      } finally {
        document.getElementById("slidesLoading").style.display = "none";
      }
    },

    async regenerateSlides() {
      _planResponse.has_slides = false;
      this.closeSlides();
      await this.generateSlides();
    },

    closeSlides() {
      document.getElementById("slidesOverlay").classList.remove("show");
    },

    get _activeSlideIdx() { return _activeSlideIdx; },
    switchSlide,

    showForm() {
      document.getElementById("dpFormCard").style.display = "";
      document.getElementById("dpResults").style.display = "none";
      document.getElementById("qrFab").classList.remove("show");
      _planResponse = null;
      _rawMarkdown = "";
      _sectionMarkdown = {};
    },

    toggleQR() {
      document.getElementById("qrPanel").classList.toggle("show");
      document.getElementById("qrOverlay").classList.toggle("show");
    },

    downloadPDF() {
      if (!_planResponse || !_planResponse.plan_id) return;
      API.getDemoPlanPdf(_planResponse.plan_id);
    },

    copyPlan() {
      navigator.clipboard.writeText(_rawMarkdown).then(() => {
        const btn = document.getElementById("dpCopyFullBtn");
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy Full Plan"; btn.classList.remove("copied"); }, 1500);
      });
    },

    copySection(tabId) {
      const text = _sectionMarkdown[tabId] || "";
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector("#dp-panel-" + tabId + " .copy-section-btn");
        if (!btn) return;
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      });
    },

    exportMarkdown() {
      const blob = new Blob([_rawMarkdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const company = (document.getElementById("dpCompanyName")?.value || "demo").trim().replace(/\s+/g, "_");
      a.href = url;
      a.download = "demo_plan_" + company + ".md";
      a.click();
      URL.revokeObjectURL(url);
    },

    copySlidesJSON() {
      if (!_slidesJSON) return;
      navigator.clipboard.writeText(JSON.stringify(_slidesJSON, null, 2)).then(() => {
        const btn = document.getElementById("copySlidesBtn");
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy JSON"; btn.classList.remove("copied"); }, 1500);
      });
    },

    exportSlidesJSON() {
      if (!_slidesJSON) return;
      const blob = new Blob([JSON.stringify(_slidesJSON, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const company = (document.getElementById("dpCompanyName")?.value || "demo").trim().replace(/\s+/g, "_");
      a.href = url;
      a.download = "slides_" + company + ".json";
      a.click();
      URL.revokeObjectURL(url);
    },

    switchFormTab(tab) {
      const scratchTab = document.getElementById("dpTabScratch");
      const reportTab = document.getElementById("dpTabReport");
      const scratchForm = document.getElementById("dpForm");
      const reportForm = document.getElementById("dpFromReportForm");

      if (tab === "scratch") {
        scratchTab.classList.add("active");
        reportTab.classList.remove("active");
        scratchForm.style.display = "";
        reportForm.style.display = "none";
      } else {
        scratchTab.classList.remove("active");
        reportTab.classList.add("active");
        scratchForm.style.display = "none";
        reportForm.style.display = "";
        this._loadReportPicker();
      }
    },

    async _loadReportPicker() {
      const list = document.getElementById("dpReportList");
      const personaSel = document.getElementById("dpRptPersona");
      try {
        const reports = await API.listReports();
        if (!reports.length) {
          list.innerHTML = '<span class="empty">No saved reports. Generate a report in the Research tab first.</span>';
          return;
        }
        list.innerHTML = reports.map((r) => {
          const title = r.title || r.query;
          const date = MD.formatDate(r.saved_at);
          return '<div class="dp-report-item' + (r.id === _selectedReportId ? ' selected' : '') +
            '" data-report-id="' + r.id + '" onclick="window.demoPlanner.selectReport(\'' + r.id + '\',\'' +
            MD.escapeHtml(title).replace(/'/g, "\\'") + '\')">' +
            '<span class="dp-report-title">' + MD.escapeHtml(title) + '</span>' +
            '<span class="dp-report-meta">' + r.route + ' &middot; ' + date + '</span>' +
            '</div>';
        }).join("");
      } catch {
        list.innerHTML = '<span class="empty">Failed to load reports.</span>';
      }

      if (personaSel.options.length === 0) {
        try {
          const personas = await API.personas();
          Object.entries(personas).forEach(([key, val]) => {
            const opt = document.createElement("option");
            opt.value = key;
            opt.textContent = val.title;
            personaSel.appendChild(opt);
          });
        } catch {
          ["vp_engineering", "platform_engineer", "sre_devops", "security_engineer",
           "developer", "engineering_manager", "cto_cio"].forEach((k) => {
            const opt = document.createElement("option");
            opt.value = k;
            opt.textContent = k.replace(/_/g, " ");
            personaSel.appendChild(opt);
          });
        }
      }
    },

    selectReport(id, title) {
      _selectedReportId = id;
      document.querySelectorAll(".dp-report-item").forEach((el) => {
        el.classList.toggle("selected", el.dataset.reportId === id);
      });
      document.getElementById("dpReportSelectedLabel").textContent = "Selected: " + title;
      document.getElementById("dpReportSelected").style.display = "";
    },

    async submitFromReport() {
      if (!_selectedReportId) return;
      const btn = document.getElementById("dpRptSubmitBtn");
      const errEl = document.getElementById("dpRptError");
      btn.disabled = true;
      btn.textContent = "Generating\u2026";
      errEl.style.display = "none";

      document.getElementById("dpFormCard").style.display = "none";
      document.getElementById("dpResults").style.display = "none";
      document.getElementById("dpErrorMsg").style.display = "none";
      document.getElementById("qrFab").classList.remove("show");
      document.getElementById("dpProgressCard").style.display = "";
      setStep("dpStepOrch");

      const products = document.getElementById("dpRptProducts").value.trim();
      const payload = {
        report_id: _selectedReportId,
        persona: document.getElementById("dpRptPersona").value,
        demo_mode: document.querySelector('input[name="dp_rpt_mode"]:checked').value,
        additional_context: document.getElementById("dpRptAdditional").value.trim(),
        selected_products: products ? products.split(",").map((s) => s.trim()).filter(Boolean) : [],
        incumbent_tooling: document.getElementById("dpRptIncumbent").value.trim(),
      };

      const t1 = setTimeout(() => setStep("dpStepRetr"), 4000);
      const t2 = setTimeout(() => setStep("dpStepSynth"), 12000);

      try {
        const data = await API.generateDemoPlanFromReport(payload);
        _planResponse = data;
        renderPlan(data);
        loadSavedPlans();
      } catch (err) {
        document.getElementById("dpFormCard").style.display = "";
        document.getElementById("dpErrorMsg").textContent = "Error: " + err.message;
        document.getElementById("dpErrorMsg").style.display = "";
      } finally {
        clearTimeout(t1);
        clearTimeout(t2);
        document.getElementById("dpProgressCard").style.display = "none";
        btn.disabled = false;
        btn.textContent = "Generate Demo Plan";
      }
    },
  };
})();
