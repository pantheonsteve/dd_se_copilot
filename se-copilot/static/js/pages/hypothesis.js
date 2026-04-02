/**
 * Sales Hypothesis Generator — input form, progress stepper, tabbed output.
 */
window.hypothesisPage = (function () {
  let initialized = false;
  let _lastResponse = null;

  const HYP_TABS = [
    { id: "hypothesis", label: "Hypothesis" },
    { id: "actions", label: "Recommended Actions" },
    { id: "tech-landscape", label: "Tech Landscape" },
    { id: "strategic-intel", label: "Strategic Intel" },
    { id: "sources", label: "Data Sources" },
  ];

  let _hypCompanies = [];

  function render() {
    const el = document.getElementById("page-hypothesis");
    el.innerHTML = `
      <div class="demo-layout" id="hypLayout">
        <!-- Saved hypotheses sidebar -->
        <div class="plans-sidebar">
          <div class="card">
            <p class="section-title">Saved Hypotheses</p>
            <div id="hypSavedList"><span class="empty">Loading...</span></div>
          </div>
        </div>

        <!-- Main column -->
        <div>
          <!-- Input form -->
          <div class="card" id="hypFormCard">
            <form id="hypForm">
              <div class="form-row">
                <div class="field grow">
                  <label for="hypCompanyName">Company Name <span class="required">*</span></label>
                  <div style="position:relative;">
                    <input type="text" id="hypCompanyName" placeholder="e.g. Acme Corp" required
                      list="hypCompanyList" autocomplete="off" style="padding-right:2rem;">
                    <datalist id="hypCompanyList"></datalist>
                    <span id="hypCompanyIndicator" style="position:absolute;right:.6rem;top:50%;transform:translateY(-50%);font-size:.75rem;display:none;"></span>
                  </div>
                </div>
                <div class="field">
                  <label for="hypDomain">Company Domain <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional)</span></label>
                  <input type="text" id="hypDomain" placeholder="e.g. acme.com">
                </div>
                <div class="field" style="margin-left:auto;">
                  <label>&nbsp;</label>
                  <button type="submit" class="btn btn-primary" id="hypGenBtn">Generate Hypothesis</button>
                </div>
              </div>
              <div class="form-row" style="margin-top:.75rem;">
                <div class="field grow">
                  <label for="hypContext">Additional Context <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(anything the AE already knows about the account)</span></label>
                  <textarea id="hypContext" rows="3" placeholder="Paste discovery notes, AE insights, deal context..."></textarea>
                </div>
              </div>
              <div id="hypFormError" style="display:none;margin-top:.5rem;color:var(--danger);font-size:.82rem;font-weight:600;"></div>
            </form>
          </div>

          <!-- Existing artifacts preview (shown when a known company is selected) -->
          <div id="hypArtifactsPreview" style="display:none;"></div>

          <!-- Progress stepper -->
          <div class="card" id="hypProgressCard" style="display:none;">
            <div class="hyp-progress">
              <div class="hyp-step active" id="hypStep1">
                <span class="hyp-step-icon"><span class="spinner"></span></span>
                <span class="hyp-step-label">Researching company...</span>
              </div>
              <div class="hyp-step" id="hypStep2">
                <span class="hyp-step-icon"></span>
                <span class="hyp-step-label">Analyzing buyer personas...</span>
              </div>
              <div class="hyp-step" id="hypStep3">
                <span class="hyp-step-icon"></span>
                <span class="hyp-step-label">Finding relevant case studies...</span>
              </div>
              <div class="hyp-step" id="hypStep4">
                <span class="hyp-step-icon"></span>
                <span class="hyp-step-label">Mapping product capabilities...</span>
              </div>
              <div class="hyp-step" id="hypStep5">
                <span class="hyp-step-icon"></span>
                <span class="hyp-step-label">Synthesizing hypothesis...</span>
              </div>
            </div>
          </div>

          <!-- Error -->
          <div class="card" id="hypErrorCard" style="display:none;">
            <div class="error-msg" id="hypErrorMsg"></div>
          </div>

          <!-- Results -->
          <div id="hypResults" style="display:none;">
            <!-- Title bar (matches research page) -->
            <div class="res-title-bar">
              <div class="res-title-row">
                <h2 class="res-report-title" id="hypHeading">Sales Hypothesis</h2>
                <div class="res-title-actions">
                  <button onclick="window.hypothesisPage.showForm()" class="btn-new-plan">+ New Hypothesis</button>
                  <button class="btn btn-sm" onclick="window.hypothesisPage.copyMarkdown()" title="Copy as Markdown">Copy MD</button>
                  <button class="btn btn-sm" onclick="window.hypothesisPage.exportPDF()" title="Print / Export PDF">Export PDF</button>
                  <button class="btn btn-sm" onclick="window.hypothesisPage.generateStrategy()" id="hypStrategyBtn" title="Generate a Strategic Overview using this hypothesis data">Generate Strategy</button>
                  <button class="btn btn-sm" onclick="window.hypothesisPage.generateExpansion()" id="hypExpansionBtn" title="Generate an Expansion Playbook using this hypothesis data">Expansion Playbook</button>
                  <button class="btn btn-sm btn-accent" onclick="window.hypothesisPage.createDemoPlan()" id="hypDemoPlanBtn" title="Generate a Demo Plan from this hypothesis">Generate Deal Prep</button>
                </div>
              </div>
              <div class="meta-bar" id="hypMetaBar" style="margin-top:.4rem;"></div>
              <div class="linked-artifacts" id="hypLinkedArtifacts" style="display:none;"></div>
            </div>

            <!-- Tab bar -->
            <div class="tab-bar" id="hypTabBar"></div>

            <!-- Tab panels -->
            <div id="hypTabPanels">
              <div class="tab-panel" id="hyp-panel-hypothesis" data-print-title="Sales Hypothesis">
                <div class="card"><div class="answer-text md-body" id="hypBodyContent"></div></div>
              </div>

              <div class="tab-panel" id="hyp-panel-actions" data-print-title="Recommended Actions">
                <div class="card"><div class="answer-text md-body" id="hypActionsContent"></div></div>
              </div>

              <div class="tab-panel" id="hyp-panel-tech-landscape" data-print-title="Technology Landscape">
                <div id="hypTechContent"></div>
              </div>

              <div class="tab-panel" id="hyp-panel-strategic-intel" data-print-title="Strategic Intelligence">
                <div id="hypStrategicContent"></div>
              </div>

              <div class="tab-panel" id="hyp-panel-sources" data-print-title="Data Sources">
                <div class="card" id="hypSourcesContent"></div>
              </div>
            </div>

            <!-- Hidden print header -->
            <div class="print-header" id="hypPrintHeader">
              <h1 id="hypPrintTitle">Sales Hypothesis</h1>
              <div id="hypPrintMeta"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    document.getElementById("hypForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await generate();
    });
    document.getElementById("hypCompanyName").addEventListener("input", onHypCompanyInput);
  }

  async function loadHypCompanies() {
    try {
      var data = await API.listCompanies();
      _hypCompanies = (data.companies || []).filter(function(c) { return c.is_defined; });
      var dl = document.getElementById("hypCompanyList");
      if (dl) {
        dl.innerHTML = _hypCompanies.map(function(c) {
          return '<option value="' + MD.escapeHtml(c.name) + '"></option>';
        }).join("");
      }
    } catch(e) { /* non-fatal */ }
  }

  function onHypCompanyInput() {
    var val = document.getElementById("hypCompanyName").value.trim();
    var indicator = document.getElementById("hypCompanyIndicator");
    var preview = document.getElementById("hypArtifactsPreview");
    if (!indicator) return;

    var match = _hypCompanies.find(function(c) {
      return c.name.toLowerCase() === val.toLowerCase();
    });

    if (match) {
      indicator.textContent = "\u2713";
      indicator.style.color = "var(--green)";
      indicator.style.display = "";
      indicator.title = "Matched: " + match.name + " \u2014 existing artifacts will be included";
      // Auto-fill domain if blank and company has one
      var domainEl = document.getElementById("hypDomain");
      if (domainEl && !domainEl.value.trim() && match.domain) {
        domainEl.value = match.domain;
      }
      showArtifactsPreview(match);
    } else if (val.length > 0) {
      indicator.textContent = "+";
      indicator.style.color = "var(--text-muted)";
      indicator.style.display = "";
      indicator.title = "New company \u2014 no existing artifacts";
      if (preview) preview.style.display = "none";
    } else {
      indicator.style.display = "none";
      if (preview) preview.style.display = "none";
    }
  }

  function showArtifactsPreview(company) {
    var preview = document.getElementById("hypArtifactsPreview");
    if (!preview) return;

    var chips = [];
    if (company.call_notes && company.call_notes.length)
      chips.push('<span style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x1F4DE; ' + company.call_notes.length + ' Call Note' + (company.call_notes.length > 1 ? 's' : '') + '</span>');
    if (company.demo_plans && company.demo_plans.length)
      chips.push('<span style="background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x1F3AF; ' + company.demo_plans.length + ' Demo Plan' + (company.demo_plans.length > 1 ? 's' : '') + '</span>');
    if (company.expansion_playbooks && company.expansion_playbooks.length)
      chips.push('<span style="background:#ecfdf5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x1F680; Expansion Playbook</span>');
    if (company.precall_briefs && company.precall_briefs.length)
      chips.push('<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x1F4CB; ' + company.precall_briefs.length + ' Brief' + (company.precall_briefs.length > 1 ? 's' : '') + '</span>');
    if (company.reports && company.reports.length)
      chips.push('<span style="background:#fce7f3;color:#9d174d;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x1F4CA; ' + company.reports.length + ' Report' + (company.reports.length > 1 ? 's' : '') + '</span>');
    if (company.hypotheses && company.hypotheses.length)
      chips.push('<span style="background:#fff7ed;color:#9a3412;padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;">&#x2B50; Prior Hypothesis</span>');

    if (!chips.length) {
      preview.style.display = "none";
      return;
    }

    preview.innerHTML =
      '<div class="card" style="margin-top:.5rem;background:#f0fdf4;border:1.5px solid #bbf7d0;">' +
        '<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;">' +
          '<span style="font-size:.78rem;font-weight:700;color:#15803d;">&#x2713; Existing artifacts will be included in synthesis:</span>' +
          chips.join(' ') +
        '</div>' +
        '<p style="font-size:.75rem;color:var(--text-muted);margin:.3rem 0 0;">' +
          'Call notes, briefs, and deal artifacts will inform the hypothesis. External research (10-K, tech stack, hiring) still runs.' +
        '</p>' +
      '</div>';
    preview.style.display = "";
  }

  async function loadSavedList() {
    const container = document.getElementById("hypSavedList");
    try {
      const items = await API.listHypotheses();
      if (!items.length) {
        container.innerHTML = '<span class="empty">No saved hypotheses</span>';
        return;
      }
      container.innerHTML = items.map((h) => `
        <div class="plan-item" data-id="${h.id}">
          <div class="plan-item-main" onclick="window.hypothesisPage.loadHypothesis('${h.id}')">
            <span class="plan-item-title">${MD.escapeHtml(h.company_name)}</span>
            <span class="plan-item-meta">${MD.formatDate(h.created_at)} &middot; ${confidenceBadge(h.confidence_level)}</span>
          </div>
          <button class="plan-item-del" onclick="event.stopPropagation();window.hypothesisPage.deleteHypothesis('${h.id}')" title="Delete">&times;</button>
        </div>
      `).join("");
    } catch {
      container.innerHTML = '<span class="empty">Failed to load</span>';
    }
  }

  function confidenceBadge(level) {
    const colors = {
      high: "var(--success)", medium: "var(--warning, #f59e0b)", low: "var(--danger)",
      confirmed: "var(--success)", likely: "var(--warning, #f59e0b)", unverified: "var(--text-muted, #9ca3af)",
    };
    const color = colors[level] || colors.low;
    return `<span class="hyp-confidence-badge" style="background:${color}">${(level || "low").toUpperCase()}</span>`;
  }

  function showProgress() {
    document.getElementById("hypFormCard").style.display = "none";
    document.getElementById("hypProgressCard").style.display = "";
    document.getElementById("hypErrorCard").style.display = "none";
    document.getElementById("hypResults").style.display = "none";

    for (let i = 1; i <= 5; i++) {
      const step = document.getElementById("hypStep" + i);
      step.className = "hyp-step" + (i === 1 ? " active" : "");
      step.querySelector(".hyp-step-icon").innerHTML = i === 1 ? '<span class="spinner"></span>' : "";
    }

    const delays = [0, 3000, 5000, 7000, 10000];
    for (let i = 1; i < 5; i++) {
      setTimeout(() => {
        const prev = document.getElementById("hypStep" + i);
        const next = document.getElementById("hypStep" + (i + 1));
        if (prev && document.getElementById("hypProgressCard").style.display !== "none") {
          prev.className = "hyp-step done";
          prev.querySelector(".hyp-step-icon").innerHTML = "&#x2713;";
        }
        if (next && document.getElementById("hypProgressCard").style.display !== "none") {
          next.className = "hyp-step active";
          next.querySelector(".hyp-step-icon").innerHTML = '<span class="spinner"></span>';
        }
      }, delays[i]);
    }
  }

  async function generate() {
    const name = document.getElementById("hypCompanyName").value.trim();
    if (!name) return;

    const domain = document.getElementById("hypDomain").value.trim() || null;
    const context = document.getElementById("hypContext").value.trim() || null;

    document.getElementById("hypFormError").style.display = "none";
    showProgress();

    try {
      const resp = await API.generateHypothesis({
        company_name: name,
        domain: domain,
        additional_context: context,
      });

      _lastResponse = resp;
      showResults(resp);
      loadSavedList();
    } catch (err) {
      document.getElementById("hypProgressCard").style.display = "none";
      document.getElementById("hypErrorCard").style.display = "";
      document.getElementById("hypErrorMsg").textContent = "Failed to generate hypothesis: " + err.message;
    }
  }

  // --- Tab management ---

  function switchTab(tabId) {
    document.querySelectorAll("#hypTabBar .tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll("#hypTabPanels .tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === "hyp-panel-" + tabId);
    });
  }

  function enterFocusMode() {
    const layout = document.getElementById("hypLayout");
    if (layout) layout.classList.add("focus-mode");
  }

  function exitFocusMode() {
    const layout = document.getElementById("hypLayout");
    if (layout) layout.classList.remove("focus-mode");
  }

  // --- Tech stack chip helper ---

  function techChip(name, type, opts) {
    const cls = {
      obs: "hyp-chip hyp-chip-obs",
      cloud: "hyp-chip hyp-chip-cloud",
      infra: "hyp-chip hyp-chip-infra",
      security: "hyp-chip hyp-chip-sec",
      competitor: "hyp-chip hyp-chip-competitor",
      db: "hyp-chip hyp-chip-db",
      mq: "hyp-chip hyp-chip-mq",
      lang: "hyp-chip hyp-chip-lang",
      data: "hyp-chip hyp-chip-data",
      cicd: "hyp-chip hyp-chip-cicd",
      ff: "hyp-chip hyp-chip-ff",
      sless: "hyp-chip hyp-chip-sless",
      net: "hyp-chip hyp-chip-net",
    };
    if (!opts) {
      return `<span class="${cls[type] || "hyp-chip"}">${MD.escapeHtml(name)}</span>`;
    }
    const conf = opts.confidence || "";
    const signals = opts.signals || 0;
    const rationale = MD.escapeHtml(opts.rationale || "");
    const isCompetitive = opts.competitive || false;
    let chipCls = `hyp-chip hyp-chip-${conf}`;
    if (isCompetitive) chipCls += " hyp-chip-competitive";
    let inner = MD.escapeHtml(name);
    if (isCompetitive) inner += ' <span class="hyp-chip-sword">&#x2694;</span>';
    if (signals > 0) inner += ` <span class="hyp-signal-count">(${signals})</span>`;
    return `<span class="${chipCls}" title="${rationale}">${inner}</span>`;
  }

  // --- Results rendering ---

  function showResults(resp) {
    document.getElementById("hypProgressCard").style.display = "none";
    document.getElementById("hypFormCard").style.display = "none";
    document.getElementById("hypResults").style.display = "";
    enterFocusMode();

    const rs = resp.research_summary || {};

    // --- Title & meta badges ---
    document.getElementById("hypHeading").textContent =
      "Sales Hypothesis: " + (resp.company_name || "Unknown");

    const meta = [];
    meta.push(confidenceBadge(resp.confidence_level));
    if (resp.is_public) meta.push('<span class="badge badge-info">Public Company</span>');
    else meta.push('<span class="badge badge-muted">Private Company</span>');
    if (resp.domain) meta.push(`<span class="text-muted">${MD.escapeHtml(resp.domain)}</span>`);
    if (resp.processing_time_ms)
      meta.push(`<span class="badge time">${(resp.processing_time_ms / 1000).toFixed(1)}s</span>`);
    document.getElementById("hypMetaBar").innerHTML = meta.join(" &middot; ");

    // Load linked artifacts
    loadLinkedArtifacts(resp.company_name);

    // Print header
    document.getElementById("hypPrintTitle").textContent =
      "Sales Hypothesis: " + (resp.company_name || "Unknown");
    document.getElementById("hypPrintMeta").innerHTML =
      (resp.is_public ? "Public" : "Private") + " &middot; " +
      "Confidence: " + (resp.confidence_level || "low") + " &middot; " +
      (resp.processing_time_ms ? (resp.processing_time_ms / 1000).toFixed(1) + "s" : "");

    // --- Tab 1: Hypothesis body ---
    document.getElementById("hypBodyContent").innerHTML =
      MD.render(resp.hypothesis_markdown || "*No hypothesis generated.*");

    // --- Tab 2: Recommended Actions ---
    const actions = buildActions(rs, resp);
    renderActions(actions);

    // --- Tab 3: Tech Landscape ---
    renderTechLandscape(rs);

    // --- Tab 4: Strategic Intel ---
    renderStrategicIntel(rs, resp);

    // --- Tab 5: Sources ---
    renderSources(resp);

    // --- Build tab bar ---
    const hasStrategicData = (rs.strategic_priorities && rs.strategic_priorities.length) ||
      (rs.risk_factors && rs.risk_factors.length) ||
      (rs.technology_investments && rs.technology_investments.length);

    const hasLandscape = !!(rs.technology_landscape && rs.technology_landscape.technologies && rs.technology_landscape.technologies.length);
    const tabAvailable = {
      "hypothesis": true,
      "actions": actions.length > 0,
      "tech-landscape": hasLandscape ||
        !!(rs.current_observability_tools && rs.current_observability_tools.length) ||
        !!(rs.current_cloud_platforms && rs.current_cloud_platforms.length) ||
        !!(rs.current_databases && rs.current_databases.length) ||
        !!(rs.current_languages && rs.current_languages.length) ||
        !!(rs.current_message_queues && rs.current_message_queues.length),
      "strategic-intel": hasStrategicData,
      "sources": true,
    };

    const tabBar = document.getElementById("hypTabBar");
    tabBar.innerHTML = "";
    let firstTab = null;
    HYP_TABS.forEach((tab) => {
      if (!tabAvailable[tab.id]) return;
      if (!firstTab) firstTab = tab.id;
      const btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.addEventListener("click", () => switchTab(tab.id));
      tabBar.appendChild(btn);
    });
    if (firstTab) switchTab(firstTab);
  }

  // --- Linked artifacts ---

  async function loadLinkedArtifacts(companyName) {
    const el = document.getElementById("hypLinkedArtifacts");
    if (!el || !companyName) return;
    try {
      const data = await API.linkedArtifacts(companyName);
      const links = [];
      if (data.reports && data.reports.length) {
        data.reports.forEach((r) => {
          links.push(
            `<a class="linked-chip linked-report" href="#" onclick="event.preventDefault();window.researchPage.loadReport('${r.id}');window.navigateTo('research');">` +
            `<span class="linked-icon">&#x1F4CA;</span> ${MD.escapeHtml(r.title || "Strategy Report")}</a>`
          );
        });
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

  // --- Recommended Actions builder ---

  function buildActions(rs, resp) {
    const actions = [];

    // Entry persona recommendation
    const entry = rs.recommended_entry_persona || {};
    if (entry.title) {
      actions.push({
        category: "Prospecting",
        icon: "🎯",
        action: entry.name
          ? `Target ${entry.name} (${entry.title}) as the primary entry point.`
          : `Recommend targeting a ${entry.title} as the typical decision-maker for observability platform investments.`,
        rationale: entry.rationale || "",
        priority: "high",
      });
    }

    // Competitive displacement — use confidence tiers when available
    const landscape = rs.technology_landscape || {};
    const landscapeTechs = landscape.technologies || [];
    const targets = rs.competitive_displacement_targets || [];

    if (landscapeTechs.length && targets.length) {
      const competitiveTechs = landscapeTechs.filter((t) => t.is_competitive_target);
      const confirmedTargets = competitiveTechs.filter((t) => t.confidence === "confirmed").map((t) => t.canonical_name);
      const likelyTargets = competitiveTechs.filter((t) => t.confidence === "likely").map((t) => t.canonical_name);
      const unverifiedTargets = competitiveTechs.filter((t) => t.confidence === "unverified").map((t) => t.canonical_name);

      if (confirmedTargets.length) {
        actions.push({
          category: "Competitive",
          icon: "⚔️",
          action: `Lead with displacement against confirmed tools: ${confirmedTargets.slice(0, 3).join(", ")}.`,
          rationale: `${confirmedTargets.length} confirmed competitive tool${confirmedTargets.length > 1 ? "s" : ""} detected by multiple sources. Consolidation opportunity is clear — position Datadog's unified platform vs. tool sprawl.`,
          priority: "high",
        });
      }
      if (likelyTargets.length) {
        actions.push({
          category: "Competitive",
          icon: "⚔️",
          action: `Validate and position against likely tools: ${likelyTargets.slice(0, 3).join(", ")}.`,
          rationale: `${likelyTargets.length} likely competitive tool${likelyTargets.length > 1 ? "s" : ""} detected with strong single-source signal. Confirm during discovery, then build displacement narrative.`,
          priority: "medium",
        });
      }
      if (unverifiedTargets.length) {
        actions.push({
          category: "Discovery",
          icon: "❓",
          action: `Ask whether ${unverifiedTargets.slice(0, 3).join(", ")} ${unverifiedTargets.length > 1 ? "are" : "is"} still in active use.`,
          rationale: `${unverifiedTargets.length} unverified competitive tool${unverifiedTargets.length > 1 ? "s" : ""} detected with weak signal. These may be legacy remnants — validate before building a displacement case.`,
          priority: "low",
        });
      }
      const allConfirmedLikely = [...confirmedTargets, ...likelyTargets];
      if (allConfirmedLikely.some((t) => ["Splunk", "ELK"].includes(t))) {
        actions.push({
          category: "Competitive",
          icon: "📊",
          action: "Emphasize Log Management cost savings vs. Splunk/ELK indexing model.",
          rationale: "Splunk/ELK users frequently cite cost unpredictability. Datadog's Flex Logs and log patterns offer a compelling TCO story.",
          priority: "medium",
        });
      }
    } else if (targets.length) {
      const topTargets = targets.slice(0, 3).join(", ");
      actions.push({
        category: "Competitive",
        icon: "⚔️",
        action: `Lead with a displacement narrative against ${topTargets}.`,
        rationale: `${targets.length} competitive tool${targets.length > 1 ? "s" : ""} detected in tech stack. Position Datadog's unified platform vs. tool sprawl — consolidation ROI is a strong opener.`,
        priority: "high",
      });
      if (targets.some((t) => ["Splunk", "ELK", "Elastic/ELK"].includes(t))) {
        actions.push({
          category: "Competitive",
          icon: "📊",
          action: "Emphasize Log Management cost savings vs. Splunk/ELK indexing model.",
          rationale: "Splunk/ELK users frequently cite cost unpredictability. Datadog's Flex Logs and log patterns offer a compelling TCO story.",
          priority: "medium",
        });
      }
    }

    // Cloud platform alignment
    const cloud = rs.current_cloud_platforms || [];
    if (cloud.length > 1) {
      actions.push({
        category: "Positioning",
        icon: "☁️",
        action: `Highlight multi-cloud observability across ${cloud.join(", ")}.`,
        rationale: "Multi-cloud environments create visibility gaps. Datadog's 700+ integrations and unified dashboard across all providers is a key differentiator.",
        priority: "medium",
      });
    } else if (cloud.length === 1) {
      actions.push({
        category: "Positioning",
        icon: "☁️",
        action: `Lead with native ${cloud[0]} integration depth and migration readiness.`,
        rationale: `Single-cloud shops often plan multi-cloud expansion. Position Datadog as the platform that scales with them.`,
        priority: "medium",
      });
    }

    // Hiring-based timing signals
    const velocity = rs.hiring_velocity || "unknown";
    if (velocity === "aggressive") {
      actions.push({
        category: "Timing",
        icon: "🚀",
        action: "Aggressive tech hiring signals high urgency — engage now before tooling decisions solidify.",
        rationale: "Rapid team growth typically precedes platform standardization decisions. Early engagement captures the evaluation window.",
        priority: "high",
      });
    } else if (velocity === "moderate") {
      actions.push({
        category: "Timing",
        icon: "📅",
        action: "Moderate hiring pace suggests active investment — time discovery around new team needs.",
        rationale: "Growing teams need shared tooling standards. Frame Datadog as the platform that onboards new engineers faster.",
        priority: "medium",
      });
    }

    // Hiring themes
    const themes = rs.key_hiring_themes || [];
    themes.forEach((theme) => {
      const themeActions = {
        "observability consolidation": {
          action: "Align messaging to their active observability consolidation initiative.",
          rationale: "They're already looking to consolidate — Datadog's single-pane-of-glass story directly addresses this stated priority.",
        },
        "platform engineering": {
          action: "Position Datadog as the backbone for their internal developer platform.",
          rationale: "Platform engineering teams are key buyers. Lead with self-service dashboards, SLO management, and CI/CD visibility.",
        },
        "cloud migration": {
          action: "Map Datadog capabilities to their cloud migration journey.",
          rationale: "Migrations create temporary complexity spikes. Datadog provides visibility across legacy and modern stacks simultaneously.",
        },
        "security & compliance": {
          action: "Include Cloud SIEM and Application Security in the demo.",
          rationale: "Active security hiring indicates budget allocation for security tooling. Datadog's unified security-observability story resonates.",
        },
        "SRE & reliability": {
          action: "Lead with SLO management, error budgets, and Watchdog AI anomaly detection.",
          rationale: "SRE teams are natural champions. Service-level objectives and automated alerting are entry-point conversations.",
        },
      };
      if (themeActions[theme]) {
        actions.push({
          category: "Positioning",
          icon: "💡",
          ...themeActions[theme],
          priority: "medium",
        });
      }
    });

    // Strategic priorities alignment (from EDGAR)
    const priorities = rs.strategic_priorities || [];
    if (priorities.length) {
      actions.push({
        category: "Executive Messaging",
        icon: "📈",
        action: "Anchor the executive pitch to their published strategic priorities.",
        rationale: `Reference their ${resp.is_public ? "10-K" : "stated"} priorities (e.g., "${priorities[0].substring(0, 80)}...") to demonstrate preparation and credibility.`,
        priority: "medium",
      });
    }

    // Kubernetes / container infrastructure
    const infra = rs.current_infrastructure || [];
    if (infra.some((t) => ["Kubernetes", "Docker"].includes(t))) {
      actions.push({
        category: "Demo Focus",
        icon: "🐳",
        action: "Include container and Kubernetes monitoring in the technical demo.",
        rationale: "Active K8s/Docker usage means they need pod-level observability, cluster maps, and orchestrator health views.",
        priority: "medium",
      });
    }

    // Database Monitoring
    const dbs = rs.current_databases || [];
    if (dbs.length) {
      actions.push({
        category: "Demo Focus",
        icon: "🗄️",
        action: `Showcase Database Monitoring for ${dbs.slice(0, 3).join(", ")}.`,
        rationale: `${dbs.length} database technolog${dbs.length > 1 ? "ies" : "y"} detected. Datadog DBM provides query-level performance insights, explain plans, and slow query detection — a high-value use case.`,
        priority: "medium",
      });
    }

    // Message Queues / Streaming
    const mq = rs.current_message_queues || [];
    if (mq.length) {
      actions.push({
        category: "Demo Focus",
        icon: "📨",
        action: `Highlight streaming pipeline monitoring for ${mq.join(", ")}.`,
        rationale: "Message queue visibility is critical for async architectures. Show Datadog's consumer lag tracking, throughput dashboards, and end-to-end trace correlation.",
        priority: "medium",
      });
    }

    // CI/CD Visibility
    const cicd = rs.current_cicd_tools || [];
    if (cicd.length) {
      actions.push({
        category: "Demo Focus",
        icon: "🚀",
        action: `Include CI Visibility for their ${cicd.join(", ")} pipelines.`,
        rationale: "CI/CD pipeline visibility reduces deployment failures and MTTR. Show test performance tracking and pipeline analytics.",
        priority: "low",
      });
    }

    // Serverless Monitoring
    const sless = rs.current_serverless || [];
    if (sless.length) {
      actions.push({
        category: "Demo Focus",
        icon: "⚡",
        action: `Demo serverless monitoring for ${sless.join(", ")}.`,
        rationale: "Serverless functions lack traditional APM visibility. Datadog's serverless view tracks cold starts, invocation errors, and cost per function.",
        priority: "medium",
      });
    }

    // Feature Flags
    const ff = rs.current_feature_flags || [];
    if (ff.length) {
      actions.push({
        category: "Positioning",
        icon: "🏴",
        action: `Highlight Feature Flag Tracking integration with ${ff.join(", ")}.`,
        rationale: "Correlating feature flag changes with performance metrics reduces incident resolution time and de-risks rollouts.",
        priority: "low",
      });
    }

    // APM by language
    const langs = rs.current_languages || [];
    if (langs.length >= 2) {
      actions.push({
        category: "Demo Focus",
        icon: "💻",
        action: `Emphasize APM auto-instrumentation across their polyglot stack (${langs.slice(0, 4).join(", ")}).`,
        rationale: "Multi-language environments need unified tracing. Datadog's auto-instrumentation covers all their languages with minimal code changes.",
        priority: "low",
      });
    }

    return actions;
  }

  function renderActions(actions) {
    if (!actions.length) {
      document.getElementById("hypActionsContent").innerHTML = "<em>No actions generated.</em>";
      return;
    }

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    actions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

    const html = actions.map((a) => {
      const priBadge = a.priority === "high"
        ? '<span class="hyp-pri-badge hyp-pri-high">HIGH PRIORITY</span>'
        : a.priority === "medium"
          ? '<span class="hyp-pri-badge hyp-pri-med">MEDIUM</span>'
          : '<span class="hyp-pri-badge">LOW</span>';
      return `
        <div class="hyp-action-item">
          <div class="hyp-action-header">
            <span class="hyp-action-icon">${a.icon}</span>
            <span class="hyp-action-category">${MD.escapeHtml(a.category)}</span>
            ${priBadge}
          </div>
          <p class="hyp-action-text">${MD.escapeHtml(a.action)}</p>
          ${a.rationale ? `<p class="hyp-action-rationale">${MD.escapeHtml(a.rationale)}</p>` : ""}
        </div>
      `;
    }).join("");

    document.getElementById("hypActionsContent").innerHTML = html;
  }

  function renderTechLandscape(rs) {
    const landscape = rs.technology_landscape || {};
    const landscapeTechs = landscape.technologies || [];

    // Use confidence-tiered layout if landscape data is available
    if (landscapeTechs.length) {
      renderTieredLandscape(rs, landscape, landscapeTechs);
      return;
    }

    // Fallback: flat layout for backward compat with old cached data
    renderFlatLandscape(rs);
  }

  function renderTieredLandscape(rs, landscape, techs) {
    const sections = [];
    const summary = landscape.confidence_summary || {};

    // Confidence summary bar
    const confirmed = techs.filter((t) => t.confidence === "confirmed");
    const likely = techs.filter((t) => t.confidence === "likely");
    const unverified = techs.filter((t) => t.confidence === "unverified");
    const sources = (summary.sources_used || []).map((s) => {
      const labels = { sumble_enrich: "Sumble", sumble_jobs: "Sumble", sumble_people: "Sumble", builtwith: "BuiltWith", sec_edgar: "SEC EDGAR" };
      return labels[s] || s;
    });
    const uniqueSources = [...new Set(sources)];

    sections.push(`
      <div class="card hyp-confidence-bar">
        <span class="hyp-conf-label">Tech Stack Confidence:</span>
        <span class="hyp-conf-pill hyp-conf-confirmed">${confirmed.length} confirmed</span>
        <span class="hyp-conf-pill hyp-conf-likely">${likely.length} likely</span>
        <span class="hyp-conf-pill hyp-conf-unverified">${unverified.length} unverified</span>
        <span class="hyp-conf-sources">Sources: ${uniqueSources.join(", ")}</span>
      </div>
    `);

    // Tier sections
    if (confirmed.length) {
      sections.push(renderTierSection("confirmed", "Confirmed", "Detected by multiple sources or live on website", confirmed));
    }
    if (likely.length) {
      sections.push(renderTierSection("likely", "Likely", "Strong single-source signal or inferred dependency", likely));
    }
    if (unverified.length) {
      sections.push(renderTierSection("unverified", "Unverified", "Validate during discovery", unverified));
    }

    // Hiring signals and entry persona (same as flat layout)
    sections.push(...renderHiringAndPersona(rs));

    document.getElementById("hypTechContent").innerHTML =
      `<div class="hyp-landscape-grid">${sections.join("")}</div>`;
  }

  function renderTierSection(tier, label, subtitle, techs) {
    const chips = techs.map((t) => {
      return techChip(t.canonical_name, null, {
        confidence: t.confidence,
        signals: t.signal_strength,
        rationale: t.confidence_rationale,
        competitive: t.is_competitive_target,
      });
    }).join("");

    const competitiveCount = techs.filter((t) => t.is_competitive_target).length;
    const tierIcons = { confirmed: "&#x2713;", likely: "&#x007E;", unverified: "&#x003F;" };

    return `
      <div class="card hyp-section-card hyp-tier-${tier}">
        <div class="hyp-section-header">
          <span class="hyp-tier-icon hyp-tier-icon-${tier}">${tierIcons[tier]}</span>
          <div>
            <h3>${label} <span class="hyp-tier-count">(${techs.length})</span></h3>
            <span class="hyp-tier-subtitle">${subtitle}</span>
          </div>
        </div>
        <div class="hyp-chip-grid">${chips}</div>
        ${competitiveCount ? `<p class="hyp-section-note">${competitiveCount} competitive displacement target${competitiveCount > 1 ? "s" : ""} &#x2694;</p>` : ""}
      </div>
    `;
  }

  function renderHiringAndPersona(rs) {
    const sections = [];
    const roles = rs.relevant_open_roles || [];
    const themes = rs.key_hiring_themes || [];
    if (roles.length || rs.hiring_velocity) {
      let hiringHtml = "";
      if (rs.hiring_velocity && rs.hiring_velocity !== "unknown") {
        const velColors = { aggressive: "var(--success)", moderate: "var(--warning, #f59e0b)", stable: "var(--text-muted)" };
        hiringHtml += `<p style="margin:0 0 .5rem;"><strong>Velocity:</strong> <span class="hyp-confidence-badge" style="background:${velColors[rs.hiring_velocity] || "var(--text-muted)"}">${rs.hiring_velocity.toUpperCase()}</span></p>`;
      }
      if (themes.length) {
        hiringHtml += `<p style="margin:0 0 .5rem;"><strong>Themes:</strong> ${themes.map((t) => `<span class="hyp-chip">${MD.escapeHtml(t)}</span>`).join("")}</p>`;
      }
      if (roles.length) {
        hiringHtml += `<div class="hyp-roles-list">`;
        roles.slice(0, 8).forEach((r) => {
          hiringHtml += `<div class="hyp-role-item"><span class="hyp-role-title">${MD.escapeHtml(r.title)}</span>`;
          if (r.department) hiringHtml += `<span class="hyp-role-dept">${MD.escapeHtml(r.department)}</span>`;
          hiringHtml += `</div>`;
        });
        hiringHtml += `</div>`;
      }
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header">
            <span class="hyp-section-icon">📋</span>
            <h3>Hiring Signals</h3>
          </div>
          ${hiringHtml}
        </div>
      `);
    }

    const entry = rs.recommended_entry_persona || {};
    if (entry.title) {
      sections.push(`
        <div class="card hyp-section-card hyp-persona-card">
          <div class="hyp-section-header">
            <span class="hyp-section-icon">🎯</span>
            <h3>Recommended Entry Persona</h3>
          </div>
          <div class="hyp-persona-detail">
            <p class="hyp-persona-name">${MD.escapeHtml(entry.name || "Unknown Contact")} &mdash; ${MD.escapeHtml(entry.title)}</p>
            ${entry.rationale ? `<p class="hyp-persona-rationale">${MD.escapeHtml(entry.rationale)}</p>` : ""}
          </div>
        </div>
      `);
    }
    return sections;
  }

  function renderFlatLandscape(rs) {
    const sections = [];

    const obs = rs.current_observability_tools || [];
    const targets = new Set(rs.competitive_displacement_targets || []);
    if (obs.length) {
      const chips = obs.map((t) =>
        targets.has(t)
          ? techChip(t + " \u2014 displace", "competitor")
          : techChip(t, "obs")
      ).join("");
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header">
            <span class="hyp-section-icon">📡</span>
            <h3>Observability & Monitoring</h3>
          </div>
          <div class="hyp-chip-grid">${chips}</div>
          ${targets.size ? `<p class="hyp-section-note">${targets.size} displacement target${targets.size > 1 ? "s" : ""} identified</p>` : ""}
        </div>
      `);
    }

    const cloud = rs.current_cloud_platforms || [];
    if (cloud.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">☁️</span><h3>Cloud Platforms</h3></div>
          <div class="hyp-chip-grid">${cloud.map((t) => techChip(t, "cloud")).join("")}</div>
        </div>
      `);
    }

    const infra = rs.current_infrastructure || [];
    if (infra.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">🔧</span><h3>Infrastructure</h3></div>
          <div class="hyp-chip-grid">${infra.map((t) => techChip(t, "infra")).join("")}</div>
        </div>
      `);
    }

    const dbs = rs.current_databases || [];
    if (dbs.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">🗄️</span><h3>Databases</h3></div>
          <div class="hyp-chip-grid">${dbs.map((t) => techChip(t, "db")).join("")}</div>
        </div>
      `);
    }

    const mq = rs.current_message_queues || [];
    if (mq.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">📨</span><h3>Message Queues & Streaming</h3></div>
          <div class="hyp-chip-grid">${mq.map((t) => techChip(t, "mq")).join("")}</div>
        </div>
      `);
    }

    const langs = rs.current_languages || [];
    if (langs.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">💻</span><h3>Languages & Frameworks</h3></div>
          <div class="hyp-chip-grid">${langs.map((t) => techChip(t, "lang")).join("")}</div>
        </div>
      `);
    }

    const dp = rs.current_data_platforms || [];
    if (dp.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">📊</span><h3>Data Platforms & BI</h3></div>
          <div class="hyp-chip-grid">${dp.map((t) => techChip(t, "data")).join("")}</div>
        </div>
      `);
    }

    const cicd = rs.current_cicd_tools || [];
    if (cicd.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">🚀</span><h3>CI/CD & DevOps</h3></div>
          <div class="hyp-chip-grid">${cicd.map((t) => techChip(t, "cicd")).join("")}</div>
        </div>
      `);
    }

    const ff = rs.current_feature_flags || [];
    const sless = rs.current_serverless || [];
    const net = rs.current_networking || [];
    const extras = [
      ...ff.map((t) => techChip(t, "ff")),
      ...sless.map((t) => techChip(t, "sless")),
      ...net.map((t) => techChip(t, "net")),
    ];
    if (extras.length) {
      sections.push(`
        <div class="card hyp-section-card">
          <div class="hyp-section-header"><span class="hyp-section-icon">🌐</span><h3>Feature Flags, Serverless & Networking</h3></div>
          <div class="hyp-chip-grid">${extras.join("")}</div>
        </div>
      `);
    }

    sections.push(...renderHiringAndPersona(rs));

    document.getElementById("hypTechContent").innerHTML =
      sections.length ? `<div class="hyp-landscape-grid">${sections.join("")}</div>` : '<div class="card"><em>No technology data available</em></div>';
  }

  function renderStrategicIntel(rs, resp) {
    const parts = [];

    const priorities = rs.strategic_priorities || [];
    if (priorities.length) {
      parts.push(`
        <div class="card">
          <h3 class="hyp-intel-heading">Strategic Priorities</h3>
          <ul class="hyp-intel-list hyp-intel-priorities">
            ${priorities.slice(0, 8).map((p) => `<li>${MD.escapeHtml(p)}</li>`).join("")}
          </ul>
        </div>
      `);
    }

    const risks = rs.risk_factors || [];
    if (risks.length) {
      parts.push(`
        <div class="card">
          <h3 class="hyp-intel-heading">Risk Factors</h3>
          <ul class="hyp-intel-list hyp-intel-risks">
            ${risks.slice(0, 8).map((r) => `<li>${MD.escapeHtml(r)}</li>`).join("")}
          </ul>
        </div>
      `);
    }

    const tech = rs.technology_investments || [];
    if (tech.length) {
      parts.push(`
        <div class="card">
          <h3 class="hyp-intel-heading">Technology Investments</h3>
          <ul class="hyp-intel-list hyp-intel-tech">
            ${tech.slice(0, 10).map((t) => `<li>${MD.escapeHtml(t)}</li>`).join("")}
          </ul>
        </div>
      `);
    }

    document.getElementById("hypStrategicContent").innerHTML =
      parts.length ? parts.join("") : '<div class="card"><em>No SEC filing data available — company may be private or 10-K not yet ingested.</em></div>';
  }

  function renderSources(resp) {
    const sourceIcons = {
      sec_edgar: { label: "SEC EDGAR (10-K)", icon: "📄" },
      sumble_enrich: { label: "Sumble Tech Stack", icon: "🔌" },
      sumble_jobs: { label: "Sumble Hiring Data", icon: "💼" },
      sumble_people: { label: "Sumble People Intel", icon: "👥" },
      builtwith: { label: "BuiltWith Web Scan", icon: "🌐" },
      buyer_persona: { label: "Buyer Persona Agent", icon: "🎯" },
      value_library: { label: "Value & ROI Library", icon: "💰" },
      case_studies: { label: "Case Studies Agent", icon: "📚" },
      technical_library: { label: "Technical Library", icon: "🔧" },
      existing_artifacts: { label: "Existing Company Artifacts", icon: "🗂️" },
    };

    let html = "";

    // Source cards
    const sources = resp.data_sources || [];
    if (sources.length) {
      html += '<div class="hyp-source-grid">';
      sources.forEach((s) => {
        const info = sourceIcons[s] || { label: s, icon: "📦" };
        html += `<div class="hyp-source-card"><span class="hyp-source-icon">${info.icon}</span><span class="hyp-source-label">${info.label}</span></div>`;
      });
      html += "</div>";
    }

    // Timing
    if (resp.stage_timings_ms) {
      html += '<div style="margin-top:1rem;"><h4 style="font-size:.85rem;margin-bottom:.5rem;">Stage Timings</h4>';
      html += '<div class="hyp-timing-grid">';
      Object.entries(resp.stage_timings_ms).forEach(([k, v]) => {
        html += `<div class="hyp-timing-item"><span class="hyp-timing-label">${k}</span><span class="hyp-timing-value">${(v / 1000).toFixed(1)}s</span></div>`;
      });
      html += "</div></div>";
    }

    if (resp.processing_time_ms) {
      html += `<p style="margin-top:.75rem;font-size:.8rem;color:var(--text-muted);">Total processing time: <strong>${(resp.processing_time_ms / 1000).toFixed(1)}s</strong></p>`;
    }

    document.getElementById("hypSourcesContent").innerHTML = html || "<em>No source data</em>";
  }

  // --- Public methods ---

  function showForm() {
    exitFocusMode();
    document.getElementById("hypFormCard").style.display = "";
    document.getElementById("hypProgressCard").style.display = "none";
    document.getElementById("hypErrorCard").style.display = "none";
    document.getElementById("hypResults").style.display = "none";
    var preview = document.getElementById("hypArtifactsPreview");
    if (preview) preview.style.display = "none";
    _lastResponse = null;
  }

  async function loadHypothesis(id) {
    try {
      const data = await API.getHypothesis(id);
      if (data.error) return;
      _lastResponse = data;
      showResults(data);
      loadSavedList();
    } catch {
      // ignore
    }
  }

  async function deleteHypothesis(id) {
    if (!confirm("Delete this hypothesis?")) return;
    try {
      await API.deleteHypothesis(id);
      loadSavedList();
      if (_lastResponse && _lastResponse.id === id) showForm();
    } catch {
      // ignore
    }
  }

  function copyMarkdown() {
    if (!_lastResponse) return;
    const resp = _lastResponse;
    const rs = resp.research_summary || {};
    let md = `# Sales Hypothesis: ${resp.company_name || "Unknown"}\n\n`;

    // Actions section
    const actions = buildActions(rs, resp);
    if (actions.length) {
      md += "## Recommended Actions\n\n";
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      actions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));
      actions.forEach((a) => {
        md += `- **[${a.priority.toUpperCase()}] ${a.category}:** ${a.action}\n`;
        if (a.rationale) md += `  _${a.rationale}_\n`;
      });
      md += "\n";
    }

    // Technology landscape (tiered if available)
    const landscape = rs.technology_landscape || {};
    const lTechs = landscape.technologies || [];
    if (lTechs.length) {
      md += "## Technology Landscape\n\n";
      const tiers = { confirmed: [], likely: [], unverified: [] };
      lTechs.forEach((t) => { if (tiers[t.confidence]) tiers[t.confidence].push(t); });
      if (tiers.confirmed.length) {
        md += `**CONFIRMED (${tiers.confirmed.length}):**\n`;
        tiers.confirmed.forEach((t) => {
          md += `- ${t.canonical_name} (${t.signal_strength} signals)${t.is_competitive_target ? " [COMPETITIVE]" : ""}\n`;
        });
        md += "\n";
      }
      if (tiers.likely.length) {
        md += `**LIKELY (${tiers.likely.length}):**\n`;
        tiers.likely.forEach((t) => {
          md += `- ${t.canonical_name} (${t.signal_strength} signals)${t.is_competitive_target ? " [COMPETITIVE]" : ""}\n`;
        });
        md += "\n";
      }
      if (tiers.unverified.length) {
        md += `**UNVERIFIED (${tiers.unverified.length}):**\n`;
        tiers.unverified.forEach((t) => {
          md += `- ${t.canonical_name} (${t.signal_strength} signals)\n`;
        });
        md += "\n";
      }
    }

    // Hypothesis body
    if (resp.hypothesis_markdown) {
      md += "## Hypothesis\n\n" + resp.hypothesis_markdown + "\n\n";
    }

    navigator.clipboard.writeText(md).then(() => {
      const btn = document.querySelector('#hypResults .res-title-actions .btn');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = orig), 1500);
      }
    });
  }

  function _splitHypothesisSections(markdown) {
    if (!markdown) return {};
    const parts = {};
    const sectionRe = /^##\s+\d+\.\s+(.+)$/gm;
    let match;
    const cuts = [];
    while ((match = sectionRe.exec(markdown)) !== null) {
      cuts.push({ key: match[1].trim().toUpperCase(), start: match.index, headEnd: match.index + match[0].length });
    }
    for (let i = 0; i < cuts.length; i++) {
      const bodyStart = cuts[i].headEnd;
      const bodyEnd = i + 1 < cuts.length ? cuts[i + 1].start : markdown.length;
      parts[cuts[i].key] = markdown.slice(bodyStart, bodyEnd).trim();
    }
    return parts;
  }

  function exportPDF() {
    if (!_lastResponse) return;
    const resp = _lastResponse;
    const rs = resp.research_summary || {};
    const title = "Sales Hypothesis: " + (resp.company_name || "Unknown");

    const sections = [];

    // Parse hypothesis markdown into named sections
    const hypSections = _splitHypothesisSections(resp.hypothesis_markdown || "");

    // 1. Company Snapshot
    if (hypSections["COMPANY SNAPSHOT"]) {
      sections.push({
        heading: "Company Snapshot",
        body: MD.render(hypSections["COMPANY SNAPSHOT"]),
        cls: "hypothesis-body",
      });
    }

    // 2. Strategic Hypothesis
    if (hypSections["STRATEGIC HYPOTHESIS"]) {
      sections.push({
        heading: "Strategic Hypothesis",
        body: MD.render(hypSections["STRATEGIC HYPOTHESIS"]),
        cls: "hypothesis-body",
      });
    }

    // 3. Recommended Approach
    if (hypSections["RECOMMENDED APPROACH"]) {
      sections.push({
        heading: "Recommended Approach",
        body: MD.render(hypSections["RECOMMENDED APPROACH"]),
        cls: "hypothesis-body",
      });
    }

    // 4. Recommended Actions
    const actions = buildActions(rs, resp);
    if (actions.length) {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      actions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));
      const rows = actions.map((a) => {
        const pri = a.priority === "high"
          ? '<span class="pri-high">HIGH</span>'
          : a.priority === "medium"
            ? '<span class="pri-med">MEDIUM</span>'
            : '<span class="pri-low">LOW</span>';
        return `<div class="action-row">
          <div class="action-hdr"><span class="action-icon">${a.icon}</span><span class="action-cat">${MD.escapeHtml(a.category)}</span>${pri}</div>
          <p class="action-text">${MD.escapeHtml(a.action)}</p>
          ${a.rationale ? `<p class="action-rationale">${MD.escapeHtml(a.rationale)}</p>` : ""}
        </div>`;
      }).join("");
      sections.push({ heading: "Recommended Actions", body: rows, cls: "actions" });
    }

    // Tech landscape — tiered if available, flat as fallback
    const pdfLandscape = rs.technology_landscape || {};
    const pdfLandscapeTechs = pdfLandscape.technologies || [];

    if (pdfLandscapeTechs.length) {
      let techHtml = "";
      const pdfSummary = pdfLandscape.confidence_summary || {};
      techHtml += `<p style="margin-bottom:.5rem;font-size:9pt;"><strong>Confidence:</strong> ${pdfSummary.confirmed || 0} confirmed, ${pdfSummary.likely || 0} likely, ${pdfSummary.unverified || 0} unverified</p>`;

      const tierLabel = { confirmed: "CONFIRMED", likely: "LIKELY", unverified: "UNVERIFIED" };
      const tierChipCls = { confirmed: "chip-obs", likely: "chip-cloud", unverified: "chip-infra" };
      ["confirmed", "likely", "unverified"].forEach((tier) => {
        const tierTechs = pdfLandscapeTechs.filter((t) => t.confidence === tier);
        if (!tierTechs.length) return;
        const chips = tierTechs.map((t) => {
          const cls = t.is_competitive_target ? "chip-competitor" : tierChipCls[tier];
          return `<span class="${cls}">${MD.escapeHtml(t.canonical_name)}${t.is_competitive_target ? " ✕" : ""} (${t.signal_strength})</span>`;
        }).join(" ");
        techHtml += `<div class="tech-row"><h4>${tierLabel[tier]} (${tierTechs.length})</h4><div class="chip-wrap">${chips}</div></div>`;
      });

      const pdfCompetitive = pdfLandscapeTechs.filter((t) => t.is_competitive_target);
      if (pdfCompetitive.length) {
        techHtml += `<p class="displace-note">${pdfCompetitive.length} competitive displacement target${pdfCompetitive.length > 1 ? "s" : ""} identified (marked with ✕)</p>`;
      }
      sections.push({ heading: "Technology Landscape", body: techHtml, cls: "tech" });
    } else {
    const obs = rs.current_observability_tools || [];
    const cloud = rs.current_cloud_platforms || [];
    const infra = rs.current_infrastructure || [];
    const targets = rs.competitive_displacement_targets || [];
    const pdfDbs = rs.current_databases || [];
    const pdfMq = rs.current_message_queues || [];
    const pdfLangs = rs.current_languages || [];
    const pdfDp = rs.current_data_platforms || [];
    const pdfCicd = rs.current_cicd_tools || [];
    const pdfFf = rs.current_feature_flags || [];
    const pdfSless = rs.current_serverless || [];
    const pdfNet = rs.current_networking || [];
    const hasTech = obs.length || cloud.length || infra.length || pdfDbs.length || pdfMq.length || pdfLangs.length || pdfDp.length || pdfCicd.length;
    if (hasTech) {
      let techHtml = "";
      const chipRow = (label, items, cls) => {
        if (!items.length) return "";
        return `<div class="tech-row"><h4>${label}</h4><div class="chip-wrap">${items.map((t) => `<span class="chip-${cls}">${MD.escapeHtml(t)}</span>`).join(" ")}</div></div>`;
      };
      if (obs.length) {
        const chips = obs.map((t) => {
          const isTarget = targets.includes(t);
          return `<span class="${isTarget ? "chip-competitor" : "chip-obs"}">${MD.escapeHtml(t)}${isTarget ? " ✕" : ""}</span>`;
        }).join(" ");
        techHtml += `<div class="tech-row"><h4>Observability & Monitoring</h4><div class="chip-wrap">${chips}</div></div>`;
      }
      techHtml += chipRow("Cloud Platforms", cloud, "cloud");
      techHtml += chipRow("Databases", pdfDbs, "infra");
      techHtml += chipRow("Message Queues & Streaming", pdfMq, "infra");
      techHtml += chipRow("Languages & Frameworks", pdfLangs, "cloud");
      techHtml += chipRow("Data Platforms & BI", pdfDp, "infra");
      techHtml += chipRow("Infrastructure", infra, "infra");
      techHtml += chipRow("CI/CD & DevOps", pdfCicd, "infra");
      const extras = [...pdfFf, ...pdfSless, ...pdfNet];
      techHtml += chipRow("Feature Flags, Serverless & Networking", extras, "cloud");
      if (targets.length) {
        techHtml += `<p class="displace-note">${targets.length} competitive displacement target${targets.length > 1 ? "s" : ""} identified (marked with ✕)</p>`;
      }
      sections.push({ heading: "Technology Landscape", body: techHtml, cls: "tech" });
    }
    } // end else (flat fallback)

    // 6. Objection Forecast
    if (hypSections["OBJECTION FORECAST"]) {
      sections.push({
        heading: "Objection Forecast",
        body: MD.render(hypSections["OBJECTION FORECAST"]),
        cls: "hypothesis-body",
      });
    }

    // 7. Key Assumptions
    if (hypSections["KEY ASSUMPTIONS"]) {
      sections.push({
        heading: "Key Assumptions",
        body: MD.render(hypSections["KEY ASSUMPTIONS"]),
        cls: "hypothesis-body",
      });
    }

    // If we couldn't parse any sections from the markdown, include the full
    // hypothesis body as a fallback so no content is lost
    if (!Object.keys(hypSections).length && resp.hypothesis_markdown) {
      sections.push({
        heading: "Sales Hypothesis",
        body: MD.render(resp.hypothesis_markdown),
        cls: "hypothesis-body",
      });
    }

    // Strategic intel
    const priorities = rs.strategic_priorities || [];
    const risks = rs.risk_factors || [];
    const techInv = rs.technology_investments || [];
    if (priorities.length || risks.length || techInv.length) {
      let intelHtml = "";
      if (priorities.length) {
        intelHtml += '<h4 class="intel-sub priorities-hdr">Strategic Priorities</h4><ul class="intel-list priorities-list">' +
          priorities.slice(0, 8).map((p) => `<li>${MD.escapeHtml(p)}</li>`).join("") + "</ul>";
      }
      if (risks.length) {
        intelHtml += '<h4 class="intel-sub risks-hdr">Risk Factors</h4><ul class="intel-list risks-list">' +
          risks.slice(0, 6).map((r) => `<li>${MD.escapeHtml(r)}</li>`).join("") + "</ul>";
      }
      if (techInv.length) {
        intelHtml += '<h4 class="intel-sub tech-hdr">Technology Investments</h4><ul class="intel-list tech-list">' +
          techInv.slice(0, 8).map((t) => `<li>${MD.escapeHtml(t)}</li>`).join("") + "</ul>";
      }
      sections.push({ heading: "Strategic Intelligence (10-K)", body: intelHtml, cls: "intel" });
    }

    // Hiring signals
    const roles = rs.relevant_open_roles || [];
    if (roles.length || (rs.hiring_velocity && rs.hiring_velocity !== "unknown")) {
      let hiringHtml = "";
      if (rs.hiring_velocity) {
        hiringHtml += `<p><strong>Hiring Velocity:</strong> ${rs.hiring_velocity.toUpperCase()}</p>`;
      }
      if (roles.length) {
        hiringHtml += "<table><thead><tr><th>Role</th><th>Department</th></tr></thead><tbody>" +
          roles.slice(0, 8).map((r) => `<tr><td>${MD.escapeHtml(r.title)}</td><td>${MD.escapeHtml(r.department || "—")}</td></tr>`).join("") +
          "</tbody></table>";
      }
      sections.push({ heading: "Hiring Signals", body: hiringHtml, cls: "hiring" });
    }

    // Sources
    const sourceLabels = {
      sec_edgar: "SEC EDGAR (10-K)",
      sumble_enrich: "Sumble Tech Stack",
      sumble_jobs: "Sumble Hiring Data",
      sumble_people: "Sumble People Intel",
      builtwith: "BuiltWith Web Scan",
      buyer_persona: "Buyer Persona Agent",
      value_library: "Value & ROI Library",
      case_studies: "Case Studies Agent",
      technical_library: "Technical Library",
    };
    const sources = (resp.data_sources || []).map((s) => sourceLabels[s] || s);
    if (sources.length) {
      const badges = sources.map((s) => `<span class="src-badge">${s}</span>`).join(" ");
      let srcHtml = `<p><strong>Data Sources:</strong> ${badges}</p>`;
      if (resp.processing_time_ms) {
        srcHtml += `<p class="timing">Total processing: ${(resp.processing_time_ms / 1000).toFixed(1)}s</p>`;
      }
      sections.push({ heading: "Data Sources", body: srcHtml, cls: "sources" });
    }

    const bodyHtml = sections.map((sec) =>
      `<div class="section ${sec.cls}"><h2>${sec.heading}</h2><div class="section-body">${sec.body}</div></div>`
    ).join("");

    const css = `
@page { margin: .75in .85in; size: letter; }
* { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
body { font-family: "Segoe UI", Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #1e1b4b; font-size: 10.5pt; line-height: 1.65; margin: 0; padding: 0; }

.title-block { border-bottom: 3px solid #7c3aed; padding-bottom: .6rem; margin-bottom: .75rem; }
.title-block h1 { font-size: 20pt; margin: 0 0 .15rem; color: #1e1b4b; font-weight: 800; letter-spacing: -.02em; }
.title-block .subtitle { font-size: 9pt; color: #6b7280; }
.title-block .subtitle span { margin-right: .6rem; }

.section { margin-bottom: 1rem; }
.section h2 { font-size: 11pt; color: #7c3aed; margin: 0 0 .4rem; padding-bottom: .2rem;
  border-bottom: 1.5px solid #ede9fe; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.section-body { font-size: 10.5pt; line-height: 1.65; }

/* Actions */
.actions .section-body { }
.action-row { padding: .5rem 0; border-bottom: 1px solid #e5e7eb; page-break-inside: avoid; }
.action-row:last-child { border-bottom: none; }
.action-hdr { display: flex; align-items: center; gap: .35rem; margin-bottom: .15rem; }
.action-icon { font-size: 11pt; }
.action-cat { font-size: 8pt; color: #6b7280; text-transform: uppercase; font-weight: 700; letter-spacing: .04em; }
.action-text { font-size: 10.5pt; font-weight: 600; margin: .15rem 0; color: #1e1b4b; }
.action-rationale { font-size: 9pt; color: #6b7280; margin: .1rem 0 0; line-height: 1.5; }
.pri-high { background: #fef2f2; color: #991b1b; padding: .05rem .3rem; border-radius: 3px; font-size: 7pt; font-weight: 700; letter-spacing: .03em; }
.pri-med { background: #fffbeb; color: #92400e; padding: .05rem .3rem; border-radius: 3px; font-size: 7pt; font-weight: 700; letter-spacing: .03em; }
.pri-low { background: #f3f4f6; color: #6b7280; padding: .05rem .3rem; border-radius: 3px; font-size: 7pt; font-weight: 700; }

/* Hypothesis body */
.hypothesis-body .section-body { background: #fafafa; border-left: 3px solid #7c3aed;
  padding: .65rem .85rem; border-radius: 0 8px 8px 0; }

h3 { font-size: 11.5pt; color: #1e1b4b; font-weight: 700; margin: .7rem 0 .2rem; }
h4 { font-size: 10.5pt; margin: .5rem 0 .15rem; font-weight: 700; }
p { margin: .25rem 0; }
ul, ol { margin: .25rem 0 .25rem 1.4rem; }
li { margin: .15rem 0; }
strong { font-weight: 600; }
blockquote { border-left: 2px solid #d1d5db; padding: .25rem .6rem; color: #555; margin: .4rem 0; font-size: 10pt; }

/* Tech chips */
.chip-wrap { display: flex; flex-wrap: wrap; gap: .25rem; margin: .25rem 0; }
.chip-obs { background: #eef2ff; color: #4338ca; padding: .1rem .35rem; border-radius: 4px; font-size: 8.5pt; font-weight: 600; }
.chip-cloud { background: #ecfdf5; color: #065f46; padding: .1rem .35rem; border-radius: 4px; font-size: 8.5pt; font-weight: 600; }
.chip-infra { background: #fff7ed; color: #9a3412; padding: .1rem .35rem; border-radius: 4px; font-size: 8.5pt; font-weight: 600; }
.chip-competitor { background: #fef2f2; color: #991b1b; padding: .1rem .35rem; border-radius: 4px; font-size: 8.5pt; font-weight: 700; border: 1px solid #fca5a5; }
.tech-row { margin-bottom: .5rem; }
.tech-row h4 { margin: 0 0 .2rem; font-size: 9pt; color: #6b7280; text-transform: uppercase; letter-spacing: .03em; }
.displace-note { font-size: 8.5pt; color: #991b1b; font-weight: 600; margin-top: .35rem; }

/* Intel */
.intel-sub { font-size: 9pt; color: #6b7280; text-transform: uppercase; letter-spacing: .03em; margin: .6rem 0 .15rem; }
.intel-list { list-style: none; padding: 0; margin: 0; }
.intel-list li { padding: .3rem 0 .3rem .6rem; border-bottom: 1px solid #f3f4f6; font-size: 9.5pt; line-height: 1.45; }
.intel-list li:last-child { border-bottom: none; }
.priorities-list li { border-left: 3px solid #7c3aed; }
.risks-list li { border-left: 3px solid #ef4444; }
.tech-list li { border-left: 3px solid #059669; }

/* Hiring */
table { width: 100%; border-collapse: collapse; margin: .4rem 0; font-size: 9pt; }
th, td { padding: .25rem .5rem; border: 1px solid #d1d5db; text-align: left; }
th { background: #f3f4f6; font-weight: 600; font-size: 8.5pt; text-transform: uppercase; }

/* Sources */
.src-badge { background: #ede9fe; color: #5b21b6; padding: .1rem .4rem; border-radius: 4px;
  font-size: 8.5pt; font-weight: 600; display: inline-block; margin: .1rem .15rem; }
.timing { font-size: 8.5pt; color: #9ca3af; margin-top: .25rem; }

code { background: #f3f4f6; padding: .05rem .2rem; border-radius: 3px; font-size: 9pt; }
pre { background: #1e1b4b; color: #e0e0e0; padding: .35rem .5rem; border-radius: 6px;
  font-size: 8pt; overflow-wrap: break-word; white-space: pre-wrap; }
pre code { background: none; padding: 0; color: inherit; }

.footer { margin-top: 1.25rem; padding-top: .35rem; border-top: 1px solid #e5e7eb;
  font-size: 7.5pt; color: #9ca3af; text-align: center; }
`;

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const metaSpans =
      `<span>${resp.is_public ? "Public" : "Private"} Company</span>` +
      `<span>Confidence: ${(resp.confidence_level || "low").toUpperCase()}</span>` +
      (resp.domain ? `<span>${MD.escapeHtml(resp.domain)}</span>` : "") +
      `<span>${(resp.processing_time_ms / 1000).toFixed(1)}s</span>`;

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
  }

  function generateStrategy() {
    if (!_lastResponse) return;
    const rs = _lastResponse.research_summary || {};
    const company = _lastResponse.company_name || "this company";

    const themes = rs.key_hiring_themes || [];
    const obs = rs.current_observability_tools || [];
    const targets = rs.competitive_displacement_targets || [];
    const entry = rs.recommended_entry_persona || {};

    let query = `What are the key strategic initiatives for ${company}? ` +
      "Highlight all of the areas that Datadog can help them, including the products " +
      "and use cases that would be most relevant for them.";

    if (targets.length) {
      query += ` Their current observability stack includes ${targets.join(", ")} — ` +
        "identify displacement opportunities.";
    }
    if (themes.length) {
      query += ` Key hiring themes: ${themes.join(", ")}.`;
    }

    // Build hypothesis context for injection
    const ctxParts = [];
    if (obs.length) ctxParts.push("Current Observability Tools: " + obs.join(", "));
    if (rs.current_cloud_platforms && rs.current_cloud_platforms.length)
      ctxParts.push("Cloud Platforms: " + rs.current_cloud_platforms.join(", "));
    if (rs.current_infrastructure && rs.current_infrastructure.length)
      ctxParts.push("Infrastructure: " + rs.current_infrastructure.join(", "));
    if (rs.current_databases && rs.current_databases.length)
      ctxParts.push("Databases: " + rs.current_databases.join(", "));
    if (rs.current_message_queues && rs.current_message_queues.length)
      ctxParts.push("Message Queues: " + rs.current_message_queues.join(", "));
    if (rs.current_languages && rs.current_languages.length)
      ctxParts.push("Languages/Frameworks: " + rs.current_languages.join(", "));
    if (rs.current_data_platforms && rs.current_data_platforms.length)
      ctxParts.push("Data Platforms: " + rs.current_data_platforms.join(", "));
    if (rs.current_cicd_tools && rs.current_cicd_tools.length)
      ctxParts.push("CI/CD Tools: " + rs.current_cicd_tools.join(", "));
    if (rs.current_feature_flags && rs.current_feature_flags.length)
      ctxParts.push("Feature Flags: " + rs.current_feature_flags.join(", "));
    if (rs.current_serverless && rs.current_serverless.length)
      ctxParts.push("Serverless: " + rs.current_serverless.join(", "));
    if (rs.current_networking && rs.current_networking.length)
      ctxParts.push("Networking: " + rs.current_networking.join(", "));
    if (targets.length) ctxParts.push("Competitive Displacement Targets: " + targets.join(", "));
    if (rs.hiring_velocity) ctxParts.push("Hiring Velocity: " + rs.hiring_velocity);
    if (themes.length) ctxParts.push("Key Hiring Themes: " + themes.join(", "));
    if (entry.title) ctxParts.push("Recommended Entry Persona: " + entry.title);
    if (rs.relevant_open_roles && rs.relevant_open_roles.length) {
      const roleStrs = rs.relevant_open_roles.slice(0, 5).map(
        (r) => `${r.title || "N/A"} (${r.department || ""})`
      );
      ctxParts.push("Key Open Roles: " + roleStrs.join("; "));
    }

    const prefill = {
      query: query,
      hypothesis_context: ctxParts.join("\n"),
      sec_filing_ticker: _lastResponse.is_public ? (_lastResponse.company_name || "") : "",
    };

    try {
      sessionStorage.setItem("hypothesis_strategy_prefill", JSON.stringify(prefill));
    } catch { /* ignore */ }
    window.navigateTo("research");
  }

  function generateExpansion() {
    if (!_lastResponse) return;
    var data = {
      company_name: _lastResponse.company_name || "",
      domain: _lastResponse.domain || "",
      hypothesis_id: _lastResponse.id || "",
    };
    if (window.expansionPage) window.expansionPage.prefill(data);
    window.navigateTo("expansion");
  }

  function createDemoPlan() {
    if (!_lastResponse) return;
    const rs = _lastResponse.research_summary || {};
    const entry = rs.recommended_entry_persona || {};

    const prefill = {
      company_name: _lastResponse.company_name || "",
      is_public_company: _lastResponse.is_public || false,
      incumbent_tooling: (rs.competitive_displacement_targets || []).join(", "),
      customer_pain_points: (rs.key_hiring_themes || []).join(". "),
    };

    try {
      sessionStorage.setItem("hypothesis_prefill", JSON.stringify(prefill));
    } catch {
      // sessionStorage unavailable
    }
    window.navigateTo("demo-planner");
  }

  function checkPrefill() {
    try {
      const prefill = sessionStorage.getItem("hypothesis_prefill_company");
      if (prefill) {
        sessionStorage.removeItem("hypothesis_prefill_company");
        const input = document.getElementById("hypCompanyName");
        if (input) {
          input.value = prefill;
          onHypCompanyInput(); // trigger match indicator and artifact preview
        }
        showForm();
      }
    } catch { /* ignore */ }
  }

  function injectBreadcrumb() {
    var container = document.getElementById("page-hypothesis");
    var existing = container.querySelector(".company-breadcrumb");
    if (existing) existing.remove();
    var html = window.renderCompanyBreadcrumb ? window.renderCompanyBreadcrumb("Sales Hypothesis") : "";
    if (html) container.insertAdjacentHTML("afterbegin", html);
  }

  return {
    init() {
      if (!initialized) {
        render();
        bindEvents();
        initialized = true;
      }
      injectBreadcrumb();
      loadSavedList();
      loadHypCompanies();
      checkPrefill();
    },
    showForm,
    loadHypothesis,
    deleteHypothesis,
    copyMarkdown,
    exportPDF,
    generateStrategy,
    generateExpansion,
    createDemoPlan,
  };
})();
