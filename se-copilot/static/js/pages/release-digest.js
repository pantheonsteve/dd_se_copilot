/**
 * Release Notes Digest — weekly customer-facing newsletter with SE view toggle.
 */
window.releaseDigestPage = (function () {
  let _initialized = false;
  let _current = null;
  let _savedId = null;
  let _companies = [];
  let _customerView = true; // default: customer-facing mode

  const CATEGORY_COLORS = {
    APM:                    '#7c3aed',
    Infrastructure:         '#2563eb',
    Logs:                   '#0891b2',
    RUM:                    '#059669',
    Security:               '#dc2626',
    Synthetics:             '#d97706',
    Databases:              '#7c2d12',
    'Network Monitoring':   '#4338ca',
    'CI Visibility':        '#0d9488',
    'Cloud Cost':           '#16a34a',
    'Platform/Admin':       '#64748b',
    'AI/ML Observability':  '#9333ea',
    Integrations:           '#ea580c',
    Other:                  '#94a3b8',
  };

  // -------------------------------------------------------------------------
  // Render shell
  // -------------------------------------------------------------------------

  function render() {
    const el = document.getElementById('page-release-digest');
    el.innerHTML =
      '<div class="demo-layout" id="rdLayout" style="align-items:flex-start;">' +

        // Sidebar
        '<div class="plans-sidebar">' +
          '<div class="card">' +
            '<p class="section-title">Saved Digests</p>' +
            '<div id="rdSavedList"><span class="empty">Loading…</span></div>' +
          '</div>' +
        '</div>' +

        // Main
        '<div style="flex:1;min-width:0;">' +

          // Form
          '<div class="card" id="rdFormCard">' +
            '<h2 style="font-size:1.1rem;font-weight:700;margin-bottom:.2rem;">Weekly Release Digest</h2>' +
            '<p style="font-size:.85rem;color:var(--text-muted);margin-bottom:1.25rem;">Generate a customer-facing product update newsletter. Claude scores every recent Datadog release against your account intelligence and writes a personalized digest ready to send.</p>' +

            '<div class="form-row">' +
              '<div class="field grow">' +
                '<label for="rdCompany">Company <span style="color:var(--red)">*</span></label>' +
                '<input type="text" id="rdCompany" placeholder="e.g. Athenahealth" autocomplete="off" list="rdCompanyList">' +
                '<datalist id="rdCompanyList"></datalist>' +
              '</div>' +
              '<div class="field" style="min-width:165px;">' +
                '<label for="rdMinScore">Relevance threshold</label>' +
                '<select id="rdMinScore">' +
                  '<option value="5">5 — Include tangential</option>' +
                  '<option value="6" selected>6 — Balanced (default)</option>' +
                  '<option value="7">7 — High signal only</option>' +
                  '<option value="8">8 — Confirmed pains only</option>' +
                '</select>' +
              '</div>' +
              '<div class="field" style="min-width:140px;">' +
                '<label for="rdMaxReleases">Releases to scan</label>' +
                '<select id="rdMaxReleases">' +
                  '<option value="10">10 — Last week</option>' +
                  '<option value="20" selected>20 — Default</option>' +
                  '<option value="30">30 — Broader scan</option>' +
                '</select>' +
              '</div>' +
            '</div>' +

            '<div class="form-row" style="margin-top:.75rem;">' +
              '<div class="field grow">' +
                '<label for="rdContext">SE context <span style="font-weight:400;font-size:.72rem;color:var(--text-muted);">(optional — high signal, e.g. "mid-POC on APM, evaluating vs Dynatrace, compliance blocker Oct call")</span></label>' +
                '<textarea id="rdContext" rows="2" placeholder="Anything Claude should prioritize that isn\'t in the saved artifacts…"></textarea>' +
              '</div>' +
            '</div>' +

            '<div style="margin-top:1.25rem;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;">' +
              '<button class="btn-primary" id="rdGenerateBtn" onclick="window.releaseDigestPage.generate()">Generate Digest</button>' +
              '<span id="rdStatus" style="font-size:.82rem;color:var(--text-muted);"></span>' +
            '</div>' +
          '</div>' +

          // Result
          '<div id="rdResultCard" style="display:none;margin-top:1.25rem;"></div>' +

        '</div>' +
      '</div>';
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async function init() {
    if (!_initialized) {
      render();
      _initialized = true;
    }
    loadSavedList();
    loadCompanies();
  }

  async function loadCompanies() {
    try {
      const data = await API.listCompanies();
      _companies = (data.companies || []).map(c => c.name);
      const dl = document.getElementById('rdCompanyList');
      if (dl) dl.innerHTML = _companies.map(n => `<option value="${esc(n)}">`).join('');
    } catch (_) {}
  }

  async function loadSavedList() {
    const el = document.getElementById('rdSavedList');
    if (!el) return;
    try {
      const list = await API.listReleaseDigests();
      if (!list || !list.length) {
        el.innerHTML = '<span class="empty">No digests yet.</span>';
        return;
      }
      el.innerHTML = list.map(d =>
        `<div class="plan-item" onclick="window.releaseDigestPage.loadSaved('${d.id}')" style="cursor:pointer;">
          <div style="font-weight:600;font-size:.82rem;">${esc(d.company_name)}</div>
          <div style="font-size:.74rem;color:var(--text-muted);margin-top:.1rem;line-height:1.4;">${esc(d.headline || '—')}</div>
          <div style="font-size:.7rem;color:var(--text-muted);margin-top:.2rem;">${fmtDate(d.created_at)} · ${d.featured_count} featured · ${d.total_releases_reviewed} scanned</div>
          <button onclick="event.stopPropagation();window.releaseDigestPage.deleteSaved('${d.id}')" class="btn-ghost" style="font-size:.7rem;margin-top:.35rem;padding:.15rem .4rem;">Delete</button>
        </div>`
      ).join('');
    } catch (_) {
      el.innerHTML = '<span class="empty">Failed to load.</span>';
    }
  }

  // -------------------------------------------------------------------------
  // Generate
  // -------------------------------------------------------------------------

  async function generate() {
    const company = document.getElementById('rdCompany').value.trim();
    if (!company) { alert('Please enter a company name.'); return; }

    const btn = document.getElementById('rdGenerateBtn');
    const status = document.getElementById('rdStatus');
    btn.disabled = true;
    status.textContent = 'Fetching release notes and scoring against account context…';

    try {
      const result = await API.generateReleaseDigest({
        company_name: company,
        min_relevance_score: parseInt(document.getElementById('rdMinScore').value, 10),
        max_releases: parseInt(document.getElementById('rdMaxReleases').value, 10),
        additional_context: document.getElementById('rdContext').value.trim() || '',
      });
      _current = result;
      _savedId = result.id || null;
      renderDigest(result);
      const secs = ((result.processing_time_ms || 0) / 1000).toFixed(1);
      status.textContent = `${result.total_releases_reviewed} releases scanned · ${result.releases_above_threshold} relevant · ${secs}s`;
      loadSavedList();
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Load / delete
  // -------------------------------------------------------------------------

  async function loadSaved(id) {
    try {
      const result = await API.getReleaseDigest(id);
      _current = result;
      _savedId = id;
      const inp = document.getElementById('rdCompany');
      if (inp) inp.value = result.company_name || '';
      renderDigest(result);
    } catch (e) { alert('Failed to load: ' + e.message); }
  }

  async function deleteSaved(id) {
    if (!confirm('Delete this digest?')) return;
    try {
      await API.deleteReleaseDigest(id);
      loadSavedList();
      if (_savedId === id) {
        _current = null; _savedId = null;
        const rc = document.getElementById('rdResultCard');
        if (rc) rc.style.display = 'none';
      }
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  // -------------------------------------------------------------------------
  // Toggle view mode
  // -------------------------------------------------------------------------

  function toggleView() {
    _customerView = !_customerView;
    if (_current) renderDigest(_current);
    const btn = document.getElementById('rdViewToggle');
    if (btn) {
      btn.textContent = _customerView ? '🔧 SE View' : '👤 Customer View';
      btn.title = _customerView ? 'Switch to SE view (shows scores & talk tracks)' : 'Switch to customer view (clean, sendable)';
    }
  }

  // -------------------------------------------------------------------------
  // Render digest
  // -------------------------------------------------------------------------

  function renderDigest(d) {
    const rc = document.getElementById('rdResultCard');
    if (!rc) return;

    const featured = d.featured_releases || [];
    const others = d.other_relevant_releases || [];
    const additional = d.additional_releases || [];
    const ctaLine = d.cta_line || 'Interested in a closer look? Happy to set up a quick demo.';
    const hasContent = featured.length > 0 || others.length > 0;

    // Get current week string for newsletter dateline
    const now = new Date();
    const weekOf = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    rc.innerHTML =

      // Toolbar
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;gap:.5rem;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:.5rem;">
          <span style="font-size:.75rem;color:var(--text-muted);">${d.total_releases_reviewed} releases scanned · ${d.releases_above_threshold} relevant</span>
          ${!_customerView ? `<span style="font-size:.7rem;padding:.15rem .5rem;border-radius:4px;background:#f59e0b22;color:#b45309;font-weight:600;">SE View — scores & talk tracks visible</span>` : ''}
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          <button id="rdViewToggle" class="btn-ghost" onclick="window.releaseDigestPage.toggleView()" style="font-size:.78rem;" title="Switch to SE view (shows scores & talk tracks)">
            🔧 SE View
          </button>
          <button class="btn-ghost" onclick="window.releaseDigestPage.copyPlainText()" style="font-size:.78rem;" id="rdCopyText">📋 Copy as text</button>
          <button class="btn-ghost" onclick="window.releaseDigestPage.copyHtml()" style="font-size:.78rem;" id="rdCopyHtml">📄 Copy as HTML</button>
          <button class="btn-ghost" onclick="window.releaseDigestPage.exportPdf()" style="font-size:.78rem;" id="rdExportPdf">⬇ Export PDF</button>
        </div>
      </div>` +

      // Newsletter card
      `<div id="rdNewsletterCard" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;max-width:720px;">` +

        // Header band
        `<div style="padding:1.5rem 1.75rem 1.25rem;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin-bottom:.6rem;">
            <div>
              <div style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);">Datadog Weekly · ${esc(d.company_name)}</div>
              <div style="font-size:.65rem;color:var(--text-muted);margin-top:.1rem;">Week of ${weekOf}</div>
            </div>
            <div style="width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,#632CA6,#7c3aed);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
          </div>
          <h1 style="font-size:1.3rem;font-weight:800;line-height:1.25;margin:0 0 1rem;color:var(--text);">${esc(d.headline)}</h1>
          <p style="font-size:.9rem;line-height:1.7;color:var(--text);margin:0;">${esc(d.intro_paragraph)}</p>
        </div>` +

        // Body
        `<div style="padding:1.25rem 1.75rem;">` +

          // Featured
          (featured.length ? `
            <div style="margin-bottom:${others.length ? '1.5rem' : '.5rem'};">
              <div style="font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.85rem;">⭐ Featured — Must Reads</div>
              ${featured.map(r => renderRelease(r, true, ctaLine)).join('')}
            </div>` : '') +

          // Others
          (others.length ? `
            <div style="margin-bottom:.5rem;">
              <div style="font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.85rem;">Also Relevant This Week</div>
              ${others.map(r => renderRelease(r, false, ctaLine)).join('')}
            </div>` : '') +

          // Empty
          (!hasContent ? `
            <div style="text-align:center;padding:2.5rem;color:var(--text-muted);font-size:.88rem;">
              No releases met the relevance threshold for this account. Try lowering the threshold or adding more SE context.
            </div>` : '') +

        `</div>` +

        // Additional releases — compact awareness list
        (additional.length ? `
          <div style="padding:0 1.75rem 1.25rem;">
            <div style="font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.75rem;padding-top:1.25rem;border-top:1px solid var(--border);">Also Released This Period</div>
            <div style="display:flex;flex-direction:column;gap:.4rem;">
              ${additional.map(r => {
                const color = CATEGORY_COLORS[r.category] || CATEGORY_COLORS['Other'];
                const links = [];
                if (r.link) links.push(`<a href="${esc(r.link)}" target="_blank" rel="noopener" style="color:var(--text-muted);font-size:.72rem;text-decoration:none;font-weight:600;">Release notes &#x2197;</a>`);
                if (r.docs_link) links.push(`<a href="${esc(r.docs_link)}" target="_blank" rel="noopener" style="color:${color};font-size:.72rem;text-decoration:none;font-weight:600;">Docs &#x2197;</a>`);
                (r.feed_links || []).forEach(lnk => {
                  if (lnk.url === r.link || lnk.url === r.docs_link) return;
                  const lbl = lnk.url.includes('datadoghq.com/blog') ? 'Blog' : lnk.url.includes('github.com') ? 'SDK' : (lnk.text || 'Link');
                  links.push(`<a href="${esc(lnk.url)}" target="_blank" rel="noopener" style="color:var(--text-muted);font-size:.72rem;text-decoration:none;font-weight:600;">${esc(lbl)} &#x2197;</a>`);
                });
                return `<div style="padding:.5rem 0;border-bottom:1px solid var(--border);">
                  <div style="display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin-bottom:${r.why_it_matters ? '.2rem' : '0'};">
                    <span style="font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.15rem .4rem;border-radius:3pt;background:${color}14;color:${color};flex-shrink:0;">${esc(r.category)}</span>
                    <span style="font-size:.82rem;font-weight:600;color:var(--text);flex:1;min-width:0;">${esc(r.title)}</span>
                    ${r.published ? `<span style="font-size:.7rem;color:var(--text-muted);flex-shrink:0;">${fmtDate(r.published)}</span>` : ''}
                    ${links.length ? `<span style="display:flex;gap:.5rem;flex-shrink:0;">${links.join('')}</span>` : ''}
                  </div>
                  ${r.why_it_matters ? `<p style="margin:0;font-size:.79rem;line-height:1.55;color:var(--text-muted);padding-left:.05rem;">${esc(r.why_it_matters)}</p>` : ''}
                </div>`;
              }).join('')}
            </div>
          </div>` : '') +

        // Footer / closing
        `<div style="padding:1.1rem 1.75rem 1.5rem;border-top:1px solid var(--border);background:var(--bg-alt,var(--surface-raised,rgba(0,0,0,.02)));">` +
        `<p style="font-size:.88rem;line-height:1.7;color:var(--text);margin:0;">${esc(d.closing_paragraph)}</p>` +
        `</div>` +

      `</div>`;

    rc.style.display = 'block';
  }

  // -------------------------------------------------------------------------
  // Render a single release card
  // -------------------------------------------------------------------------

  function renderRelease(r, featured, ctaLine) {
    const color = CATEGORY_COLORS[r.category] || CATEGORY_COLORS['Other'];
    const score = r.relevance_score || 0;

    // Score dots (SE view only)
    const scoreDots = Array.from({length: 10}, (_, i) =>
      `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${i < score ? color : 'var(--border)'};margin-right:2px;vertical-align:middle;"></span>`
    ).join('');

    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:1rem 1.1rem;margin-bottom:.75rem;${featured ? 'border-left:3px solid ' + color + ';' : ''}">

        <!-- Category + score row -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.55rem;flex-wrap:wrap;gap:.4rem;">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
            <span style="font-size:.65rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:.2rem .55rem;border-radius:4px;background:${color}18;color:${color};border:1px solid ${color}33;">${esc(r.category)}</span>
            ${!_customerView ? `<div style="display:flex;align-items:center;">${scoreDots}<span style="font-size:.68rem;color:var(--text-muted);margin-left:4px;">${score}/10</span></div>` : ''}
          </div>
          ${r.published ? `<span style="font-size:.7rem;color:var(--text-muted);">${fmtDate(r.published)}</span>` : ''}
        </div>

        <!-- Title -->
        <div style="font-weight:700;font-size:.93rem;line-height:1.35;margin-bottom:.55rem;">
          ${r.link
            ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;">${esc(r.title)}<span style="font-size:.72rem;color:var(--text-muted);margin-left:.3rem;">↗</span></a>`
            : esc(r.title)
          }
        </div>

        <!-- Why it matters -->
        <p style="margin:0 0 .7rem;font-size:.86rem;line-height:1.65;color:var(--text);">${esc(r.why_it_matters)}</p>

        <!-- Links from feed + docs -->
        ${(() => {
          const allLinks = [];
          // Docs link first
          if (r.docs_link) allLinks.push({ url: r.docs_link, label: 'View documentation', isDocs: true });
          // Other feed links (blog, SDK changelogs) — exclude any already shown as docs
          (r.feed_links || []).forEach(lnk => {
            if (lnk.url === r.docs_link) return; // already shown
            if (lnk.url === r.link) return; // already shown as title link
            const isBlog = lnk.url.includes('datadoghq.com/blog');
            const isSDK = lnk.url.includes('github.com');
            const label = isBlog ? 'Read blog post' : isSDK ? (lnk.text || 'SDK changelog') : (lnk.text || 'Learn more');
            allLinks.push({ url: lnk.url, label, isDocs: false });
          });
          if (!allLinks.length) return '';
          return `<div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.7rem;">${
            allLinks.map(lnk =>
              `<a href="${esc(lnk.url)}" target="_blank" rel="noopener"
                style="font-size:.75rem;color:${lnk.isDocs ? color : '#64748b'};text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:.25rem;padding:.2rem .5rem;border-radius:4px;border:1px solid ${lnk.isDocs ? color + '44' : '#e2e8f0'};background:${lnk.isDocs ? color + '08' : '#f8fafc'};">
                ${lnk.isDocs
                  ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
                  : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
                }
                ${esc(lnk.label)}
              </a>`
            ).join('')
          }</div>`;
        })()}

        <!-- Talk track (SE view only) -->
        ${!_customerView && r.talk_track ? `
          <div style="padding:.5rem .75rem;background:var(--bg-alt,rgba(0,0,0,.03));border-radius:5px;border-left:2px solid ${color}66;margin-bottom:.7rem;">
            <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${color};margin-right:.4rem;">Talk track</span>
            <span style="font-size:.82rem;line-height:1.55;color:var(--text);">${esc(r.talk_track)}</span>
          </div>` : ''}

        <!-- Interactive CTA (customer view only) -->
        ${_customerView ? `
          <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;">
            <button onclick="window.releaseDigestPage.handleCta('${esc(r.title).replace(/'/g,'\\\'')}')"
              style="font-size:.78rem;padding:.35rem .8rem;border-radius:5px;border:1px solid ${color}44;background:${color}10;color:${color};cursor:pointer;font-weight:600;transition:background .15s;"
              onmouseover="this.style.background='${color}20'" onmouseout="this.style.background='${color}10'">
              👋 Request a demo
            </button>
            <span style="font-size:.78rem;color:var(--text-muted);">${esc(ctaLine)}</span>
          </div>` : ''}
      </div>`;
  }

  // -------------------------------------------------------------------------
  // CTA handler — copies a mailto with the feature name pre-filled
  // -------------------------------------------------------------------------

  function handleCta(featureTitle) {
    const company = (_current && _current.company_name) ? _current.company_name : 'your team';
    const subject = encodeURIComponent(`Datadog demo request: ${featureTitle}`);
    const body = encodeURIComponent(
      `Hi,\n\nI saw the update about "${featureTitle}" in this week's digest and would love to see a demo of how this would work for ${company}.\n\nThanks`
    );
    // Open mailto — SE gets the reply, customer sends to SE
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  // -------------------------------------------------------------------------
  // Export PDF
  // -------------------------------------------------------------------------

  function exportPdf() {
    if (!_savedId) {
      alert('Please generate or load a digest first.');
      return;
    }
    const btn = document.getElementById('rdExportPdf');
    if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }
    // Trigger download — server renders WeasyPrint PDF
    API.openReleaseDigestPdf(_savedId);
    // Restore button after a moment (download is async by nature)
    setTimeout(() => {
      if (btn) { btn.textContent = '⬇ Export PDF'; btn.disabled = false; }
    }, 3000);
  }

  // -------------------------------------------------------------------------
  // Copy as plain text
  // -------------------------------------------------------------------------

  function copyPlainText() {
    if (!_current) return;
    const d = _current;
    const featured = d.featured_releases || [];
    const others = d.other_relevant_releases || [];

    let out = `${d.headline}\nFor ${d.company_name} · Week of ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}\n\n${d.intro_paragraph}\n\n`;

    if (featured.length) {
      out += '⭐ FEATURED — MUST READS\n\n';
      featured.forEach(r => {
        out += `[${r.category}] ${r.title}\n`;
        out += `${r.why_it_matters}\n`;
        if (!_customerView && r.talk_track) out += `Talk track: ${r.talk_track}\n`;
        if (r.link) out += `Release notes: ${r.link}\n`;
        if (r.docs_link) out += `Documentation: ${r.docs_link}\n`;
        (r.feed_links || []).forEach(lnk => {
          if (lnk.url === r.link || lnk.url === r.docs_link) return;
          out += `${lnk.text || lnk.url}: ${lnk.url}\n`;
        });
        out += '\n';
      });
    }
    if (others.length) {
      out += 'ALSO RELEVANT THIS WEEK\n\n';
      others.forEach(r => {
        out += `[${r.category}] ${r.title}\n`;
        out += `${r.why_it_matters}\n`;
        if (!_customerView && r.talk_track) out += `Talk track: ${r.talk_track}\n`;
        if (r.link) out += `Release notes: ${r.link}\n`;
        if (r.docs_link) out += `Documentation: ${r.docs_link}\n`;
        (r.feed_links || []).forEach(lnk => {
          if (lnk.url === r.link || lnk.url === r.docs_link) return;
          out += `${lnk.text || lnk.url}: ${lnk.url}\n`;
        });
        out += '\n';
      });
    }
    const additional = d.additional_releases || [];
    if (additional.length) {
      out += '\nADDITIONAL RELEASES THIS PERIOD\n\n';
      additional.forEach(r => {
        out += `[${r.category}] ${r.title}`;
        if (r.published) out += ` (${fmtDate(r.published)})`;
        out += '\n';
        if (r.why_it_matters) out += `  ${r.why_it_matters}\n`;
        if (r.link) out += `  Release notes: ${r.link}\n`;
        if (r.docs_link) out += `  Docs: ${r.docs_link}\n`;
        (r.feed_links || []).forEach(lnk => {
          if (lnk.url === r.link || lnk.url === r.docs_link) return;
          const lbl = lnk.url.includes('datadoghq.com/blog') ? 'Blog' : lnk.url.includes('github.com') ? 'SDK' : (lnk.text || lnk.url);
          out += `  ${lbl}: ${lnk.url}\n`;
        });
      });
      out += '\n';
    }
    out += d.closing_paragraph;

    navigator.clipboard.writeText(out).then(() => {
      const btn = document.getElementById('rdCopyText');
      if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = orig, 1800); }
    });
  }

  // -------------------------------------------------------------------------
  // Copy as HTML (clean, email-ready, no scores or talk tracks)
  // -------------------------------------------------------------------------

  function copyHtml() {
    if (!_current) return;
    const d = _current;
    const featured = d.featured_releases || [];
    const others = d.other_relevant_releases || [];
    const weekOf = new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'});
    const ctaLine = d.cta_line || 'Interested in a closer look? Happy to set up a quick demo.';

    const releaseHtml = (r) => {
      const color = CATEGORY_COLORS[r.category] || '#64748b';
      return `
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:12px;${r.relevance_score >= 7 ? 'border-left:3px solid ' + color + ';' : ''}">
  <div style="margin-bottom:8px;">
    <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:2px 8px;border-radius:4px;background:${color}22;color:${color};">${esc(r.category)}</span>
    ${r.published ? `<span style="font-size:11px;color:#9ca3af;margin-left:8px;">${fmtDate(r.published)}</span>` : ''}
  </div>
  <div style="font-weight:700;font-size:15px;margin-bottom:8px;line-height:1.35;">${r.link ? `<a href="${esc(r.link)}" style="color:#111827;text-decoration:none;">${esc(r.title)} ↗</a>` : esc(r.title)}</div>
  <p style="margin:0 0 10px;font-size:14px;line-height:1.65;color:#374151;">${esc(r.why_it_matters)}</p>
  ${(() => {
    const linkBtns = [];
    if (r.docs_link) linkBtns.push(`<a href="${esc(r.docs_link)}" style="font-size:12px;color:${color};text-decoration:none;font-weight:600;padding:4px 10px;border-radius:4px;border:1px solid ${color}44;background:${color}0d;display:inline-block;margin-right:6px;margin-bottom:6px;">&#x1F4C4; View documentation</a>`);
    (r.feed_links || []).forEach(lnk => {
      if (lnk.url === r.docs_link || lnk.url === r.link) return;
      const lbl = lnk.url.includes('datadoghq.com/blog') ? '&#x1F4DD; Read blog post'
                : lnk.url.includes('github.com') ? '&#x1F527; SDK changelog'
                : esc(lnk.text || 'Learn more');
      linkBtns.push(`<a href="${esc(lnk.url)}" style="font-size:12px;color:#374151;text-decoration:none;font-weight:600;padding:4px 10px;border-radius:4px;border:1px solid #e5e7eb;background:#f9fafb;display:inline-block;margin-right:6px;margin-bottom:6px;">${lbl}</a>`);
    });
    return linkBtns.length ? `<div style="margin-bottom:10px;">${linkBtns.join('')}</div>` : '';
  })()}
  <div style="display:inline-block;font-size:13px;padding:6px 14px;border-radius:5px;background:${color}12;color:${color};border:1px solid ${color}33;font-weight:600;cursor:pointer;">&#x1F44B; Request a demo</div>
  <span style="font-size:12px;color:#6b7280;margin-left:10px;">${esc(ctaLine)}</span>
</div>`;
    };

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.headline)}</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:680px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">

  <!-- Header -->
  <div style="padding:24px 28px 20px;border-bottom:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9ca3af;margin-bottom:4px;">Datadog Weekly · ${esc(d.company_name)}</div>
    <div style="font-size:11px;color:#9ca3af;margin-bottom:12px;">Week of ${weekOf}</div>
    <h1 style="font-size:22px;font-weight:800;line-height:1.25;margin:0 0 16px;color:#111827;">${esc(d.headline)}</h1>
    <p style="font-size:15px;line-height:1.7;color:#374151;margin:0;">${esc(d.intro_paragraph)}</p>
  </div>

  <!-- Body -->
  <div style="padding:20px 28px;">
    ${featured.length ? `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:14px;">⭐ Featured — Must Reads</div>${featured.map(releaseHtml).join('')}` : ''}
    ${others.length ? `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin:20px 0 14px;">Also Relevant This Week</div>${others.map(releaseHtml).join('')}` : ''}
  </div>

  <!-- Footer -->
  <div style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;">
    <p style="font-size:14px;line-height:1.7;color:#374151;margin:0;">${esc(d.closing_paragraph)}</p>
  </div>

  ${(d.additional_releases || []).length ? `
  <!-- Additional releases -->
  <div style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:12px;">Also Released This Period</div>
    ${(d.additional_releases || []).map(r => {
      const c = CATEGORY_COLORS[r.category] || '#64748b';
      const linkParts = [];
      if (r.link) linkParts.push(`<a href="${esc(r.link)}" style="font-size:11px;color:#6b7280;text-decoration:none;">Release notes &#x2197;</a>`);
      if (r.docs_link) linkParts.push(`<a href="${esc(r.docs_link)}" style="font-size:11px;color:${c};text-decoration:none;font-weight:600;">Docs &#x2197;</a>`);
      (r.feed_links || []).forEach(lnk => {
        if (lnk.url === r.link || lnk.url === r.docs_link) return;
        const lbl = lnk.url.includes('datadoghq.com/blog') ? 'Blog' : lnk.url.includes('github.com') ? 'SDK' : (lnk.text || 'Link');
        linkParts.push(`<a href="${esc(lnk.url)}" style="font-size:11px;color:#6b7280;text-decoration:none;">${esc(lbl)} &#x2197;</a>`);
      });
      return `<div style="padding:8px 0;border-bottom:1px solid #f3f4f6;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:${r.why_it_matters ? '4px' : '0'};""><span style="font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:3px;background:${c}18;color:${c};flex-shrink:0;">${esc(r.category)}</span><span style="font-size:13px;font-weight:600;color:#111827;flex:1;">${r.link ? `<a href="${esc(r.link)}" style="color:#111827;text-decoration:none;">${esc(r.title)}</a>` : esc(r.title)}</span>${r.published ? `<span style="font-size:11px;color:#9ca3af;">${fmtDate(r.published)}</span>` : ''}${linkParts.length ? `<span style="display:flex;gap:8px;">${linkParts.join('')}</span>` : ''}</div>${r.why_it_matters ? `<p style="margin:0;font-size:12px;line-height:1.55;color:#6b7280;">${esc(r.why_it_matters)}</p>` : ''}</div>`;
    }).join('')}
  </div>` : ''}

</div>
</body></html>`;

    navigator.clipboard.writeText(html).then(() => {
      const btn = document.getElementById('rdCopyHtml');
      if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = orig, 1800); }
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}); }
    catch (_) { return String(iso).slice(0,10); }
  }

  return { init, generate, loadSaved, deleteSaved, toggleView, copyPlainText, copyHtml, handleCta, exportPdf };
})();
