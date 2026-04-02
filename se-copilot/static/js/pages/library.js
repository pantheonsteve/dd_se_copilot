/**
 * Library — unified browse/search for saved reports, demo plans, and slide decks.
 */
window.libraryPage = (function () {
  let initialized = false;
  let _allItems = [];

  function render() {
    const el = document.getElementById("page-library");
    el.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="libSearch" placeholder="Search by title or keyword..." style="flex:1;min-width:200px;">
        <select id="libTypeFilter">
          <option value="">All types</option>
          <option value="report">Reports</option>
          <option value="plan">Demo Plans</option>
        </select>
        <span style="font-size:.78rem;color:var(--text-muted);" id="libCount"></span>
      </div>
      <div class="artifact-grid" id="libGrid">
        <span class="empty">Loading...</span>
      </div>
    `;

    document.getElementById("libSearch").addEventListener("input", renderFiltered);
    document.getElementById("libTypeFilter").addEventListener("change", renderFiltered);
  }

  async function loadItems() {
    _allItems = [];
    const grid = document.getElementById("libGrid");

    try {
      const [reports, plans] = await Promise.all([
        API.listReports().catch(() => []),
        API.listDemoPlans().catch(() => []),
      ]);

      (reports || []).forEach((r) => {
        _allItems.push({
          type: "report",
          id: r.id,
          title: r.title || r.query,
          snippet: r.query,
          date: r.saved_at,
          meta: r.route,
          badges: [
            { cls: "type-report", text: "Report" },
            { cls: "route", text: r.route },
          ],
        });
      });

      (plans || []).forEach((p) => {
        const badges = [{ cls: "type-plan", text: "Demo Plan" }];
        if (p.has_slides) badges.push({ cls: "type-slides", text: "Slides" });
        if (p.has_pdf) badges.push({ cls: "time", text: "PDF" });

        _allItems.push({
          type: "plan",
          id: p.id,
          title: p.title,
          snippet: p.demo_mode.replace(/_/g, " ") + " \u2022 " + p.persona.replace(/_/g, " ") + " \u2022 " + p.company_name,
          date: p.created_at,
          meta: p.demo_mode.replace(/_/g, " "),
          badges,
        });
      });

      _allItems.sort((a, b) => new Date(b.date) - new Date(a.date));
      renderFiltered();
    } catch {
      grid.innerHTML = '<span class="empty">Failed to load items.</span>';
    }
  }

  function renderFiltered() {
    const search = (document.getElementById("libSearch")?.value || "").toLowerCase();
    const typeFilter = document.getElementById("libTypeFilter")?.value || "";
    const grid = document.getElementById("libGrid");
    const countEl = document.getElementById("libCount");

    let items = _allItems;
    if (typeFilter) items = items.filter((i) => i.type === typeFilter);
    if (search) items = items.filter((i) =>
      i.title.toLowerCase().includes(search) ||
      i.snippet.toLowerCase().includes(search) ||
      i.meta.toLowerCase().includes(search)
    );

    countEl.textContent = items.length + " item" + (items.length !== 1 ? "s" : "");

    if (!items.length) {
      grid.innerHTML = '<span class="empty">No items match your filters.</span>';
      return;
    }

    grid.innerHTML = items.map((item) => {
      const badgesHtml = item.badges.map((b) => '<span class="badge ' + b.cls + '">' + b.text + "</span>").join("");
      return `
        <div class="artifact-card" onclick="window.libraryPage.open('${item.type}','${item.id}')">
          <div class="ac-header">
            ${badgesHtml}
          </div>
          <div class="ac-title">${MD.escapeHtml(item.title)}</div>
          <div class="ac-snippet">${MD.escapeHtml(item.snippet)}</div>
          <div class="ac-footer">
            <span>${MD.formatDate(item.date)}</span>
            <span class="spacer"></span>
            <button class="ac-delete" onclick="event.stopPropagation();window.libraryPage.deleteItem('${item.type}','${item.id}')" title="Delete">Delete</button>
          </div>
        </div>
      `;
    }).join("");
  }

  return {
    init() {
      if (!initialized) {
        render();
        initialized = true;
      }
      loadItems();
    },

    open(type, id) {
      if (type === "report") {
        navigateTo("research");
        setTimeout(() => { if (window.researchPage) window.researchPage.loadReport(id); }, 100);
      } else {
        navigateTo("demo-planner");
        setTimeout(() => { if (window.demoPlanner) window.demoPlanner.loadSavedPlan(id); }, 100);
      }
    },

    async deleteItem(type, id) {
      try {
        if (type === "report") await API.deleteReport(id);
        else await API.deleteDemoPlan(id);
        _allItems = _allItems.filter((i) => !(i.type === type && i.id === id));
        renderFiltered();
      } catch { /* ignore */ }
    },
  };
})();
