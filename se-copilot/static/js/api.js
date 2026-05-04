/**
 * Centralized API client for all SE Copilot endpoints.
 */
const API = {
  async _fetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      let detail = "HTTP " + resp.status;
      try {
        const body = await resp.json();
        if (body && typeof body.detail === "string") detail = body.detail;
        else if (body && Array.isArray(body.detail)) detail = body.detail.map((d) => d.msg || d).join("; ");
      } catch (_) { /* ignore */ }
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  },

  _post(url, body) {
    return this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  // Health & inventory
  health() { return this._fetch("/api/health"); },
  inventory() { return this._fetch("/api/inventory"); },
  gaps() { return this._fetch("/api/gaps"); },

  // Query pipeline
  query(payload) { return this._post("/api/query", payload); },

  // Reports
  listReports() { return this._fetch("/api/reports"); },
  getReport(id) { return this._fetch("/api/reports/" + id); },
  saveReport(response, title) { return this._post("/api/reports", { response, title }); },
  deleteReport(id) { return this._fetch("/api/reports/" + id, { method: "DELETE" }); },

  // Demo plans
  generateDemoPlan(payload) { return this._post("/api/demo-plan", payload); },
  generateDemoPlanFromReport(payload) { return this._post("/api/demo-plan/from-report", payload); },
  listDemoPlans() { return this._fetch("/api/demo-plans"); },
  getDemoPlan(id) { return this._fetch("/api/demo-plans/" + id); },
  deleteDemoPlan(id) { return this._fetch("/api/demo-plans/" + id, { method: "DELETE" }); },
  getDemoPlanPdf(id) { window.open("/api/demo-plans/" + id + "/pdf", "_blank"); },

  // Personas
  personas() { return this._fetch("/api/demo-plan/personas"); },

  // Slides
  generateSlides(planId) {
    return this._fetch("/api/demo-plans/" + planId + "/slides", { method: "POST" });
  },
  getSlides(planId) { return this._fetch("/api/demo-plans/" + planId + "/slides"); },

  // SEC EDGAR 10-K management
  edgarSearch(q) { return this._fetch("/api/edgar/search?q=" + encodeURIComponent(q)); },
  edgarIngest(ticker, cik, companyName) {
    return this._post("/api/edgar/ingest", { ticker, cik, company_name: companyName });
  },

  // Hypothesis
  generateHypothesis(payload) { return this._post("/api/hypothesis", payload); },
  listHypotheses() { return this._fetch("/api/hypotheses"); },
  getHypothesis(id) { return this._fetch("/api/hypotheses/" + id); },
  deleteHypothesis(id) { return this._fetch("/api/hypotheses/" + id, { method: "DELETE" }); },
  refreshHypothesis(id) {
    return this._fetch("/api/hypotheses/" + id + "/refresh", { method: "POST" });
  },

  // Expansion Playbook
  generateExpansionPlaybook(payload) { return this._post("/api/expansion-playbook", payload); },
  listExpansionPlaybooks() { return this._fetch("/api/expansion-playbooks"); },
  getExpansionPlaybook(id) { return this._fetch("/api/expansion-playbooks/" + id); },
  deleteExpansionPlaybook(id) { return this._fetch("/api/expansion-playbooks/" + id, { method: "DELETE" }); },
  getLibrarianProducts() { return this._fetch("/api/librarian/products"); },

  // Call Notes
  submitCallNote(payload) { return this._post("/api/call-notes", payload); },
  listCallNotes() { return this._fetch("/api/call-notes"); },
  getCallNote(id) { return this._fetch("/api/call-notes/" + id); },
  deleteCallNote(id) { return this._fetch("/api/call-notes/" + id, { method: "DELETE" }); },

  // Next Steps
  generateNextSteps(payload) { return this._post('/api/next-steps', payload); },
  listNextSteps() { return this._fetch('/api/next-steps'); },
  getNextSteps(id) { return this._fetch('/api/next-steps/' + id); },
  deleteNextSteps(id) { return this._fetch('/api/next-steps/' + id, { method: 'DELETE' }); },
  refreshNextSteps(id) { return this._fetch('/api/next-steps/' + id + '/refresh', { method: 'POST' }); },
  getNextStepsByCompany(name) { return this._fetch('/api/next-steps/by-company/' + encodeURIComponent(name)); },

  // Pre-Call Brief — generate
  generatePreCallBrief(payload) { return this._post('/api/precall-brief', payload); },
  getCallTypes() { return this._fetch('/api/precall-brief/call-types'); },

  // Pre-Call Brief — saved artifacts
  savePreCallBrief(brief) { return this._post('/api/precall-briefs', brief); },
  listPreCallBriefs() { return this._fetch('/api/precall-briefs'); },
  getPreCallBrief(id) { return this._fetch('/api/precall-briefs/' + id); },
  deletePreCallBrief(id) { return this._fetch('/api/precall-briefs/' + id, { method: 'DELETE' }); },
  getPreCallBriefsByCompany(name) { return this._fetch('/api/precall-briefs/by-company/' + encodeURIComponent(name)); },
  openPreCallBriefPdf(id) {
    var a = document.createElement('a');
    a.href = '/api/precall-briefs/' + id + '/pdf';
    a.download = 'precall-brief-' + id + '.pdf';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 100);
  },

  // Release Notes Digest
  generateReleaseDigest(payload) { return this._post('/api/release-digest', payload); },
  listReleaseDigests() { return this._fetch('/api/release-digests'); },
  getReleaseDigest(id) { return this._fetch('/api/release-digests/' + id); },
  deleteReleaseDigest(id) { return this._fetch('/api/release-digests/' + id, { method: 'DELETE' }); },
  getReleaseDigestsByCompany(name) { return this._fetch('/api/release-digests/by-company/' + encodeURIComponent(name)); },
  openReleaseDigestPdf(id) {
    var a = document.createElement('a');
    a.href = '/api/release-digests/' + id + '/pdf';
    a.download = 'datadog_update_' + id + '.pdf';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 100);
  },

  // Slack Summaries
  saveSlackSummary(companyName, summaryText, channelName) {
    return this._post('/api/slack-summaries', {
      company_name: companyName,
      summary_text: summaryText,
      channel_name: channelName || '',
    });
  },
  getSlackSummariesByCompany(name) {
    return this._fetch('/api/slack-summaries/by-company/' + encodeURIComponent(name));
  },
  updateSlackSummary(id, summaryText, channelName) {
    return this._fetch('/api/slack-summaries/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary_text: summaryText, channel_name: channelName || null }),
    });
  },
  deleteSlackSummary(id) {
    return this._fetch('/api/slack-summaries/' + id, { method: 'DELETE' });
  },

  // Deal Snapshot
  generateDealSnapshot(companyName, additionalContext) {
    return this._post('/api/deal-snapshot', {
      company_name: companyName,
      additional_context: additionalContext || null,
    });
  },

  // Debrief
  generateDebrief(callNoteId, precallBriefId) {
    return this._post('/api/debrief', { call_note_id: callNoteId, precall_brief_id: precallBriefId });
  },

  // Linked artifacts
  linkedArtifacts(companyName) {
    return this._fetch("/api/linked-artifacts/" + encodeURIComponent(companyName));
  },

  // Companies
  listCompanies() { return this._fetch("/api/companies"); },
  getCompanyProfile(key) { return this._fetch("/api/companies/" + encodeURIComponent(key) + "/profile"); },
  createCompany(payload) { return this._post("/api/companies", payload); },
  updateCompany(id, payload) {
    return this._fetch("/api/companies/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  deleteCompany(id) { return this._fetch("/api/companies/" + id, { method: "DELETE" }); },
  getCompany(id) { return this._fetch("/api/companies/defined/" + id); },
  linkResource(companyId, resourceType, resourceId) {
    return this._post("/api/companies/" + companyId + "/resources", {
      resource_type: resourceType, resource_id: resourceId,
    });
  },
  unlinkResource(companyId, resourceType, resourceId) {
    return this._fetch(
      "/api/companies/" + companyId + "/resources/" + encodeURIComponent(resourceType) + "/" + encodeURIComponent(resourceId),
      { method: "DELETE" },
    );
  },

  searchHomerunOpportunities(query, limit) {
    var q = "/api/homerun/opportunities/search?query=" + encodeURIComponent(query || "");
    if (limit != null) q += "&limit=" + encodeURIComponent(String(limit));
    return this._fetch(q);
  },

  homerunFillPreview(opportunityUuid) {
    return this._fetch("/api/homerun/opportunities/" + encodeURIComponent(opportunityUuid) + "/fill-preview");
  },

  generateHomerunFieldDraft(companyKey, opportunityUuid, prompt) {
    return this._post("/api/companies/" + encodeURIComponent(companyKey) + "/homerun-field-draft", {
      opportunity_uuid: opportunityUuid,
      prompt: prompt || "",
    });
  },

  getSalesforceSnowflakeContext(companyKey, opportunityUuid) {
    var q =
      "/api/companies/" +
      encodeURIComponent(companyKey) +
      "/snowflake/salesforce-context?opportunity_uuid=" +
      encodeURIComponent(opportunityUuid || "");
    return this._fetch(q);
  },

  summarizeSalesforceSnowflakeContext(companyKey, opportunityUuid) {
    return this._post("/api/companies/" + encodeURIComponent(companyKey) + "/snowflake/salesforce-summary", {
      opportunity_uuid: opportunityUuid,
    });
  },

  // Company Notes
  createCompanyNote(companyId, title, content, noteDate) {
    var body = { title: title, content: content };
    if (noteDate) body.note_date = noteDate;
    return this._post("/api/companies/" + companyId + "/notes", body);
  },
  listCompanyNotes(companyId) {
    return this._fetch("/api/companies/" + companyId + "/notes");
  },
  updateCompanyNoteDate(companyId, noteId, noteDate) {
    return this._fetch("/api/companies/" + companyId + "/notes/" + noteId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_date: noteDate }),
    });
  },
  deleteCompanyNote(companyId, noteId) {
    return this._fetch("/api/companies/" + companyId + "/notes/" + noteId, { method: "DELETE" });
  },

  // Company Chat
  companyChatSend(companyName, message, conversationId) {
    var body = { company_name: companyName, message: message };
    if (conversationId) body.conversation_id = conversationId;
    return this._post("/api/company-chat", body);
  },
  companyChatConversations(companyName) {
    return this._fetch("/api/company-chat/conversations?company_name=" + encodeURIComponent(companyName));
  },
  companyChatGet(conversationId) {
    return this._fetch("/api/company-chat/conversations/" + encodeURIComponent(conversationId));
  },
  companyChatDelete(conversationId) {
    return this._fetch("/api/company-chat/conversations/" + encodeURIComponent(conversationId), { method: "DELETE" });
  },
};
