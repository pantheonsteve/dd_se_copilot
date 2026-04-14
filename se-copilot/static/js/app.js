/**
 * App shell: routing, sidebar, health check.
 */
(function () {
  const PAGE_TITLES = {
    home: "Dashboard",
    "release-digest": "Release Notes Digest",
    hypothesis: "Sales Hypothesis",
    research: "Research Hub",
    "demo-planner": "Demo Planner",
    expansion: "Expansion Playbook",
    "next-steps": "Next Steps",
    "precall-brief": "Pre-Call Brief",
    "call-notes": "Call Notes",
    companies: "Companies",
    library: "Library",
    agents: "Agent Console",
  };

  let currentPage = "home";

  function navigateTo(page) {
    // Handle company detail sub-route: companies/detail/{key}
    let companyDetailKey = null;
    if (page.startsWith("companies/detail/")) {
      companyDetailKey = decodeURIComponent(page.substring("companies/detail/".length));
      page = "companies";
    }

    if (!PAGE_TITLES[page]) return;
    currentPage = page;

    document.querySelectorAll(".page").forEach((el) => {
      el.classList.toggle("active", el.id === "page-" + page);
    });
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.page === page);
    });
    document.getElementById("pageTitle").textContent = PAGE_TITLES[page];

    // Hide demo-planner floating elements when not on that page
    const qrFab = document.getElementById("qrFab");
    if (page !== "demo-planner" && qrFab) {
      qrFab.classList.remove("show");
    }

    // Trigger page-specific init
    if (page === "home" && window.homePage) window.homePage.init();
    if (page === "hypothesis" && window.hypothesisPage) window.hypothesisPage.init();
    if (page === "research" && window.researchPage) window.researchPage.init();
    if (page === "demo-planner" && window.demoPlanner) window.demoPlanner.init();
    if (page === "expansion" && window.expansionPage) window.expansionPage.init();
    if (page === "next-steps" && window.nextStepsPage) window.nextStepsPage.init();
    if (page === "precall-brief" && window.preCallPage) window.preCallPage.init();
    if (page === "release-digest" && window.releaseDigestPage) window.releaseDigestPage.init();
    if (page === "call-notes" && window.callNotesPage) window.callNotesPage.init();
    if (page === "companies") {
      if (companyDetailKey && window.companyDetailPage) {
        window.companyDetailPage.init(companyDetailKey);
      } else if (window.companiesPage) {
        window.companiesPage.init();
      }
    }
    if (page === "library" && window.libraryPage) window.libraryPage.init();
    if (page === "agents" && window.agentsPage) window.agentsPage.init();

    const hashValue = companyDetailKey
      ? "companies/detail/" + encodeURIComponent(companyDetailKey)
      : page;
    history.pushState({ page: hashValue }, "", "#" + hashValue);

    if (window.ddRumStartView) window.ddRumStartView(page);
  }

  // Sidebar nav clicks — clear company context so breadcrumbs only show via Quick Actions
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      try {
        sessionStorage.removeItem("company_context_key");
        sessionStorage.removeItem("company_context_name");
      } catch (e) { /* ignore */ }
      navigateTo(btn.dataset.page);
    });
  });

  // Browser back/forward
  window.addEventListener("popstate", (e) => {
    if (e.state && e.state.page) {
      navigateTo(e.state.page);
    }
  });

  // Sidebar collapse
  window.toggleSidebar = function () {
    document.getElementById("sidebar").classList.toggle("collapsed");
  };

  // Health check
  async function checkHealth() {
    try {
      const d = await API.health();
      const dot = document.getElementById("healthDot");
      const txt = document.getElementById("healthText");
      if (d.status === "healthy") {
        dot.className = "dot ok";
        txt.textContent = "All systems operational";
      } else {
        dot.className = "dot warn";
        txt.textContent = "Degraded";
      }
    } catch {
      document.getElementById("healthDot").className = "dot err";
      document.getElementById("healthText").textContent = "Offline";
    }
  }

  // Expose navigate globally for page modules to use
  window.navigateTo = navigateTo;

  // Shared breadcrumb helper for Quick Action pages launched from a company
  window.renderCompanyBreadcrumb = function (toolLabel) {
    try {
      var key = sessionStorage.getItem("company_context_key");
      var name = sessionStorage.getItem("company_context_name");
      if (!key || !name) return "";
      return (
        '<div class="company-breadcrumb">' +
        '<a href="#companies" onclick="event.preventDefault();navigateTo(\'companies\')">Companies</a>' +
        ' <span class="breadcrumb-sep">/</span> ' +
        '<a href="#" onclick="event.preventDefault();navigateTo(\'companies/detail/' +
        encodeURIComponent(key) +
        "')\">" +
        name +
        "</a>" +
        ' <span class="breadcrumb-sep">/</span> ' +
        "<span>" +
        toolLabel +
        "</span>" +
        "</div>"
      );
    } catch (e) {
      return "";
    }
  };

  // Init: check hash, health, boot first page
  const hash = location.hash.replace("#", "") || "companies";
  checkHealth();
  navigateTo(hash);
  setInterval(checkHealth, 60000);
})();
