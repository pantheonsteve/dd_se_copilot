/**
 * Datadog RUM / Product Analytics initialization.
 *
 * Fetches applicationId and clientToken from /api/rum-config (backed by .env)
 * so credentials are never committed to source.
 */
(function () {
  var PAGE_NAMES = {
    home: "/dashboard",
    "release-digest": "/release-digest",
    hypothesis: "/hypothesis",
    research: "/research",
    "demo-planner": "/demo-planner",
    expansion: "/expansion",
    "next-steps": "/next-steps",
    "precall-brief": "/precall-brief",
    "call-notes": "/call-notes",
    companies: "/companies",
    library: "/library",
    agents: "/agents",
  };

  fetch("/api/rum-config")
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (!cfg.enabled || typeof window.DD_RUM === "undefined") return;
      window.DD_RUM.init({
        applicationId: cfg.applicationId,
        clientToken: cfg.clientToken,
        site: "datadoghq.com",
        service: "se-copilot",
        env: "production",
        version: "1.0.0",
        sessionSampleRate: 100,
        sessionReplaySampleRate: 20,
        trackResources: true,
        trackUserInteractions: true,
        trackLongTasks: true,
        allowedTracingUrls: [window.location.origin],
        defaultPrivacyLevel: "mask-user-input",
      });
    })
    .catch(function (err) {
      console.warn("[RUM] Config fetch failed:", err);
    });

  /**
   * Called by the app shell's navigateTo() to record SPA view changes.
   */
  window.ddRumStartView = function (page) {
    if (typeof window.DD_RUM === "undefined" || !window.DD_RUM.getInternalContext) return;
    var name = PAGE_NAMES[page] || "/" + page;
    window.DD_RUM.startView({ name: name });
  };

  /**
   * Record a custom action for Product Analytics funnels / heatmaps.
   * Example: ddRumAction("generate_hypothesis", { company: "Acme" })
   */
  window.ddRumAction = function (name, context) {
    if (typeof window.DD_RUM === "undefined") return;
    window.DD_RUM.addAction(name, context || {});
  };

  /**
   * Attach the current user so sessions are identifiable in Product Analytics.
   */
  window.ddRumSetUser = function (user) {
    if (typeof window.DD_RUM === "undefined") return;
    window.DD_RUM.setUser(user);
  };
})();
