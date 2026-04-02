/**
 * Agent Console — health grid from /api/inventory, content gaps from /api/gaps.
 */
window.agentsPage = (function () {
  let initialized = false;

  function render() {
    const el = document.getElementById("page-agents");
    el.innerHTML = `
      <p class="section-title">Agent Health &amp; Inventory</p>
      <div class="agent-grid" id="agentGrid">
        <span class="empty">Loading...</span>
      </div>

      <p class="section-title" style="margin-top:1.5rem;">Content Gaps</p>
      <div class="card" id="gapsSection">
        <span class="empty">Loading...</span>
      </div>
    `;
  }

  async function loadInventory() {
    const grid = document.getElementById("agentGrid");
    if (!grid) return;

    try {
      const data = await API.inventory();
      if (!data.agents || !data.agents.length) {
        grid.innerHTML = '<span class="empty">No agents registered.</span>';
        return;
      }

      grid.innerHTML = data.agents.map((a) => {
        const dotCls = a.status === "ok" ? "ok" : "err";
        const statusText = a.status === "ok" ? "Healthy" : a.status;
        const name = a.agent.replace(/_/g, " ");
        const url = a.url || "";
        const isRagAgent = a.total_chunks > 0 || a.unique_sources > 0;

        // Stats — show chunk/source counts for RAG agents, type label for standalone
        let statsHtml = "";
        if (isRagAgent) {
          statsHtml = `
            <div class="agent-stats">
              <div class="agent-stat-item">
                <div class="stat-value">${a.total_chunks.toLocaleString()}</div>
                <div class="stat-label">Chunks</div>
              </div>
              <div class="agent-stat-item">
                <div class="stat-value">${a.unique_sources.toLocaleString()}</div>
                <div class="stat-label">Sources</div>
              </div>
            </div>
          `;
        } else {
          statsHtml = `
            <div class="agent-stats">
              <div class="agent-stat-item">
                <div class="stat-value" style="font-size:.85rem;">Service</div>
                <div class="stat-label">Type</div>
              </div>
            </div>
          `;
        }

        // Categories
        let catHtml = "";
        if (a.categories && Object.keys(a.categories).length) {
          const cats = Object.entries(a.categories).sort((x, y) => y[1] - x[1]);
          catHtml = `
            <details class="agent-categories">
              <summary>${cats.length} categories</summary>
              <div class="cat-list">
                ${cats.map(([cat, count]) => '<span class="cat-chip">' + cat + " (" + count + ")</span>").join("")}
              </div>
            </details>
          `;
        }

        // Companies (SEC EDGAR)
        let companiesHtml = "";
        if (a.companies && a.companies.length) {
          companiesHtml = `
            <details class="agent-categories" style="margin-top:.5rem;">
              <summary>${a.companies.length} ingested companies</summary>
              <div class="cat-list">
                ${a.companies.map((c) => '<span class="cat-chip">' + c.ticker + " \u2014 " + c.company + "</span>").join("")}
              </div>
            </details>
          `;
        }

        return `
          <div class="agent-card">
            <div class="agent-card-header">
              <span class="dot ${dotCls}"></span>
              <span class="agent-card-name">${MD.escapeHtml(name)}</span>
              <span style="font-size:.72rem;color:var(--text-muted);">${statusText}</span>
            </div>
            <div class="agent-card-url">${MD.escapeHtml(url)}</div>
            ${statsHtml}
            ${catHtml}
            ${companiesHtml}
          </div>
        `;
      }).join("");
    } catch {
      grid.innerHTML = '<span class="empty">Failed to load inventory.</span>';
    }
  }

  async function loadGaps() {
    const section = document.getElementById("gapsSection");
    if (!section) return;

    try {
      const data = await API.gaps();
      if (!data || (!data.entries && !data.length)) {
        section.innerHTML = '<span class="empty">No content gaps logged.</span>';
        return;
      }

      const entries = data.entries || data;
      if (!entries.length) {
        section.innerHTML = '<span class="empty">No content gaps logged yet.</span>';
        return;
      }

      // Aggregate gaps by frequency
      const gapCounts = {};
      entries.forEach((entry) => {
        (entry.gaps || []).forEach((g) => {
          gapCounts[g] = (gapCounts[g] || 0) + 1;
        });
      });

      const sorted = Object.entries(gapCounts).sort((a, b) => b[1] - a[1]);

      let html = '<table style="width:100%;border-collapse:collapse;font-size:.85rem;">';
      html += '<thead><tr><th style="text-align:left;padding:.4rem .6rem;border-bottom:2px solid var(--border);font-weight:600;font-size:.78rem;text-transform:uppercase;color:var(--text-muted);">Gap</th>';
      html += '<th style="text-align:right;padding:.4rem .6rem;border-bottom:2px solid var(--border);font-weight:600;font-size:.78rem;text-transform:uppercase;color:var(--text-muted);width:60px;">Count</th></tr></thead>';
      html += "<tbody>";
      sorted.forEach(([gap, count]) => {
        html += '<tr><td style="padding:.4rem .6rem;border-bottom:1px solid var(--border);color:var(--red);">' + MD.escapeHtml(gap) + "</td>";
        html += '<td style="padding:.4rem .6rem;border-bottom:1px solid var(--border);text-align:right;font-weight:600;">' + count + "</td></tr>";
      });
      html += "</tbody></table>";

      html += '<p style="margin-top:.75rem;font-size:.75rem;color:var(--text-muted);">From ' + entries.length + " logged queries</p>";
      section.innerHTML = html;
    } catch {
      section.innerHTML = '<span class="empty">Failed to load content gaps.</span>';
    }
  }

  return {
    init() {
      if (!initialized) {
        render();
        initialized = true;
      }
      loadInventory();
      loadGaps();
    },
  };
})();
