/**
 * Dashboard Home — quick actions, recent activity feed, system status.
 */
window.homePage = (function () {
  let initialized = false;

  function render() {
    const el = document.getElementById("page-home");
    el.innerHTML = `
      <!-- Quick Actions -->
      <div class="quick-actions">
        <div class="quick-action" onclick="navigateTo('research')">
          <div class="qa-icon" style="background:#eff6ff;color:#3b82f6;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <div>
            <div class="qa-title">Ask a question</div>
            <div class="qa-desc">Research technical and value topics across all agents</div>
          </div>
        </div>
        <div class="quick-action" onclick="navigateTo('demo-planner')">
          <div class="qa-icon" style="background:var(--brand-light);color:var(--brand);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div>
            <div class="qa-title">Plan a demo</div>
            <div class="qa-desc">Generate a structured demo plan with talk tracks and slides</div>
          </div>
        </div>
      </div>

      <!-- Grid: Activity + Status -->
      <div class="home-grid">
        <div class="card">
          <p class="section-title">Recent Activity</p>
          <div id="activityFeed"><span class="empty">Loading...</span></div>
        </div>
        <div class="card">
          <p class="section-title">System Status</p>
          <div id="statusPanel"><span class="empty">Loading...</span></div>
        </div>
      </div>
    `;
  }

  async function loadActivity() {
    const feed = document.getElementById("activityFeed");
    if (!feed) return;

    try {
      const [reports, plans] = await Promise.all([
        API.listReports().catch(() => []),
        API.listDemoPlans().catch(() => []),
      ]);

      const items = [];

      (reports || []).forEach((r) => {
        items.push({
          type: "report",
          title: r.title || r.query,
          date: r.saved_at,
          meta: r.route,
          id: r.id,
        });
      });

      (plans || []).forEach((p) => {
        items.push({
          type: "plan",
          title: p.title,
          date: p.created_at,
          meta: p.demo_mode.replace(/_/g, " ") + " \u2022 " + p.persona.replace(/_/g, " "),
          id: p.id,
        });
      });

      items.sort((a, b) => new Date(b.date) - new Date(a.date));

      if (!items.length) {
        feed.innerHTML = '<span class="empty">No activity yet. Ask a question or plan a demo to get started.</span>';
        return;
      }

      feed.innerHTML = items
        .slice(0, 15)
        .map((item) => {
          const iconCls = item.type === "report" ? "report" : "plan";
          const iconSvg =
            item.type === "report"
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
          const typeBadge =
            item.type === "report"
              ? '<span class="badge type-report">Report</span>'
              : '<span class="badge type-plan">Demo Plan</span>';

          return `
            <div class="activity-item" onclick="homePageOpen('${item.type}','${item.id}')">
              <div class="activity-icon ${iconCls}">${iconSvg}</div>
              <div class="activity-body">
                <div class="activity-title">${MD.escapeHtml(item.title)}</div>
                <div class="activity-meta">
                  ${typeBadge}
                  <span>${MD.escapeHtml(item.meta || "")}</span>
                  <span>${MD.timeAgo(item.date)}</span>
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    } catch {
      feed.innerHTML = '<span class="empty">Failed to load activity.</span>';
    }
  }

  async function loadStatus() {
    const panel = document.getElementById("statusPanel");
    if (!panel) return;

    try {
      const inv = await API.inventory();
      if (!inv.agents || !inv.agents.length) {
        panel.innerHTML = '<span class="empty">No agents found.</span>';
        return;
      }

      panel.innerHTML = inv.agents
        .map((a) => {
          const dot = a.status === "ok" ? "ok" : "err";
          const stats = a.total_chunks
            ? a.total_chunks + " chunks, " + a.unique_sources + " sources"
            : "";
          return `
          <div class="agent-mini">
            <span class="dot ${dot}"></span>
            <span class="agent-name">${MD.escapeHtml(a.agent.replace(/_/g, " "))}</span>
            <span class="agent-stat">${stats}</span>
          </div>
        `;
        })
        .join("");

      panel.innerHTML += `
        <div style="margin-top:.75rem;text-align:right;">
          <button class="btn btn-sm btn-secondary" onclick="navigateTo('agents')">View details</button>
        </div>
      `;
    } catch {
      panel.innerHTML = '<span class="empty">Failed to load status.</span>';
    }
  }

  // Navigate from activity items
  window.homePageOpen = function (type, id) {
    if (type === "report") {
      navigateTo("research");
      setTimeout(() => {
        if (window.researchPage) window.researchPage.loadReport(id);
      }, 100);
    } else {
      navigateTo("demo-planner");
      setTimeout(() => {
        if (window.demoPlanner) window.demoPlanner.loadSavedPlan(id);
      }, 100);
    }
  };

  return {
    init() {
      if (!initialized) {
        render();
        initialized = true;
      }
      loadActivity();
      loadStatus();
    },
  };
})();
