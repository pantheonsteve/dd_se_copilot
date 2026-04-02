/**
 * Playbook Timeline — reusable renderer for expansion playbook results.
 * Usage: PlaybookTimeline.render("containerId", playbookData)
 */
window.PlaybookTimeline = (function () {
  function _esc(s) { return (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function _badgeClass(type) {
    const map = {
      product_expansion: "exp-badge-product_expansion",
      new_team: "exp-badge-new_team",
      new_bu: "exp-badge-new_bu",
      net_new_use_case: "exp-badge-net_new_use_case",
    };
    return map[type] || "exp-badge-product_expansion";
  }

  function _badgeLabel(type) {
    const map = {
      product_expansion: "Product Expansion",
      new_team: "New Team",
      new_bu: "New BU",
      net_new_use_case: "Net-New Use Case",
    };
    return map[type] || type;
  }

  function _urgencyClass(u) {
    const level = (u || "medium").toLowerCase();
    if (level.startsWith("high")) return "exp-urgency-high";
    if (level.startsWith("low")) return "exp-urgency-low";
    return "exp-urgency-medium";
  }

  function _urgencyLabel(u) {
    const level = (u || "medium").toLowerCase();
    if (level.startsWith("high")) return "High";
    if (level.startsWith("low")) return "Low";
    return "Medium";
  }

  function _renderProducts(products) {
    if (!products || !products.length) return "";
    return '<div class="exp-products-list">' +
      products.map(function (p) {
        var label = _esc(p.product_name);
        if (p.sku_or_tier) label += " (" + _esc(p.sku_or_tier) + ")";
        return '<span class="exp-product-pill" title="' + _esc(p.why_this_product) + '">' + label + '</span>';
      }).join("") +
    '</div>';
  }

  function _renderDisplaces(opp) {
    if (!opp.displaces || !opp.displaces.length) return "";
    var conf = opp.displacement_confidence || "unverified";
    return '<div class="exp-displaces">Displaces: <strong>' +
      opp.displaces.map(_esc).join(", ") +
      '</strong> <span style="opacity:.7">(' + conf + ')</span></div>';
  }

  function _renderExpandable(opp, idx) {
    var sections = [];

    if (opp.business_case) {
      sections.push('<h4>Business Case</h4><p>' + _esc(opp.business_case) + '</p>');
    }

    if (opp.conversation_opener) {
      sections.push('<h4>Conversation Opener</h4><p>' + _esc(opp.conversation_opener) + '</p>');
    }

    if (opp.discovery_questions && opp.discovery_questions.length) {
      sections.push(
        '<h4>Discovery Questions</h4><ul>' +
        opp.discovery_questions.map(function (q) { return '<li>' + _esc(q) + '</li>'; }).join("") +
        '</ul>'
      );
    }

    if (opp.success_metrics && opp.success_metrics.length) {
      sections.push(
        '<h4>Success Metrics</h4><ul>' +
        opp.success_metrics.map(function (m) { return '<li>' + _esc(m) + '</li>'; }).join("") +
        '</ul>'
      );
    }

    if (opp.products && opp.products.length) {
      var details = opp.products.map(function (p) {
        var parts = ['<strong>' + _esc(p.product_name) + '</strong>'];
        if (p.key_capabilities && p.key_capabilities.length) {
          parts.push('Capabilities: ' + p.key_capabilities.map(_esc).join(", "));
        }
        if (p.replaces && p.replaces.length) {
          parts.push('Replaces: ' + p.replaces.map(_esc).join(", "));
        }
        if (p.why_this_product) {
          parts.push(_esc(p.why_this_product));
        }
        return '<li>' + parts.join('<br>') + '</li>';
      }).join("");
      sections.push('<h4>Product Details</h4><ul>' + details + '</ul>');
    }

    if (opp.case_study_reference) {
      sections.push('<h4>Case Study</h4><p>' + _esc(opp.case_study_reference) + '</p>');
    }
    if (opp.roi_evidence) {
      sections.push('<h4>ROI Evidence</h4><p>' + _esc(opp.roi_evidence) + '</p>');
    }
    if (opp.estimated_timeline) {
      sections.push('<h4>Estimated Timeline</h4><p>' + _esc(opp.estimated_timeline) + '</p>');
    }

    if (!sections.length) return "";

    var id = "exp-expand-" + idx;
    return '<div class="exp-expandable">' +
      '<button class="exp-expand-btn" onclick="PlaybookTimeline.toggle(\'' + id + '\', this)">' +
        '<span>&#9654;</span> Details' +
      '</button>' +
      '<div class="exp-expand-content" id="' + id + '">' + sections.join("") + '</div>' +
    '</div>';
  }

  function _renderCard(opp, idx) {
    var persona = opp.target_persona || {};
    var personaStr = _esc(persona.title || "");
    if (persona.name) personaStr = _esc(persona.name) + " — " + personaStr;

    return '<div class="exp-card">' +
      '<div class="exp-phase-circle">' + opp.phase + '</div>' +
      '<div class="exp-card-header">' +
        '<span class="exp-card-title">' + _esc(opp.opportunity_name) + '</span>' +
        '<span class="exp-badge ' + _badgeClass(opp.opportunity_type) + '">' + _badgeLabel(opp.opportunity_type) + '</span>' +
        '<span class="exp-urgency ' + _urgencyClass(opp.urgency) + '">' + _urgencyLabel(opp.urgency) + '</span>' +
      '</div>' +
      '<div class="exp-card-meta">' +
        '<span><strong>Team:</strong> ' + _esc(opp.target_team_or_bu) + '</span>' +
        '<span><strong>Persona:</strong> ' + personaStr + '</span>' +
      '</div>' +
      _renderProducts(opp.products) +
      _renderDisplaces(opp) +
      _renderExpandable(opp, idx) +
    '</div>';
  }

  function _renderConnector(opp) {
    if (!opp.trigger_from_previous) return "";
    return '<div class="exp-connector">' + _esc(opp.trigger_from_previous) + '</div>';
  }

  function _renderSummaryBar(pb) {
    var types = pb.opportunity_types || {};
    var badges = Object.keys(types).map(function (k) {
      return '<span class="exp-badge ' + _badgeClass(k) + '">' + types[k] + ' ' + _badgeLabel(k) + '</span>';
    }).join("");

    return '<div class="exp-summary-bar">' +
      '<span class="exp-summary-count">' + (pb.total_opportunities || 0) + '</span>' +
      '<span>opportunities identified</span>' +
      '<div class="exp-summary-badges">' + badges + '</div>' +
    '</div>';
  }

  function _renderContentGaps(pb) {
    if (!pb.content_gaps || !pb.content_gaps.length) return "";
    return '<div class="exp-content-gaps">' +
      '<h4>Content Gaps</h4>' +
      '<ul>' + pb.content_gaps.map(function (g) { return '<li>' + _esc(g) + '</li>'; }).join("") + '</ul>' +
    '</div>';
  }

  function _renderNextAction(pb) {
    if (!pb.recommended_next_action) return "";
    return '<div class="exp-next-action">' +
      '<strong>Recommended Next Action:</strong> ' + _esc(pb.recommended_next_action) +
    '</div>';
  }

  function render(containerId, playbook) {
    var el = document.getElementById(containerId);
    if (!el) return;

    var opps = playbook.opportunities || [];
    if (!opps.length) {
      el.innerHTML = '<div class="exp-empty"><h3>No opportunities identified</h3>' +
        '<p>The analysis did not produce expansion opportunities. Check content gaps below.</p></div>' +
        _renderContentGaps(playbook) + _renderNextAction(playbook);
      return;
    }

    var html = _renderSummaryBar(playbook);

    if (playbook.current_footprint_summary) {
      html += '<div style="font-size:.85rem;color:var(--text-muted);margin-bottom:.75rem;">' +
        '<strong>Current Footprint:</strong> ' + _esc(playbook.current_footprint_summary) + '</div>';
    }

    html += '<div class="exp-timeline">';
    opps.forEach(function (opp, i) {
      if (i > 0) html += _renderConnector(opp);
      html += _renderCard(opp, i);
    });
    html += '</div>';

    html += _renderContentGaps(playbook);
    html += _renderNextAction(playbook);

    if (playbook.key_assumptions && playbook.key_assumptions.length) {
      html += '<div style="margin-top:.75rem;font-size:.82rem;color:var(--text-muted);">' +
        '<strong>Key Assumptions:</strong> ' +
        playbook.key_assumptions.map(_esc).join("; ") + '</div>';
    }

    el.innerHTML = html;
  }

  function toggle(id, btn) {
    var el = document.getElementById(id);
    if (!el) return;
    var open = el.classList.toggle("open");
    var arrow = btn.querySelector("span");
    if (arrow) arrow.innerHTML = open ? "&#9660;" : "&#9654;";
  }

  function toMarkdown(playbook) {
    var lines = [
      "# Account Expansion Playbook: " + (playbook.company_name || ""),
      "",
    ];

    if (playbook.current_footprint_summary) {
      lines.push("**Current Footprint:** " + playbook.current_footprint_summary, "");
    }

    var opps = playbook.opportunities || [];
    opps.forEach(function (opp) {
      lines.push("## Phase " + opp.phase + ": " + opp.opportunity_name);
      lines.push("**Type:** " + _badgeLabel(opp.opportunity_type) + " | **Urgency:** " + (opp.urgency || "medium"));
      lines.push("**Team:** " + (opp.target_team_or_bu || ""));
      var persona = opp.target_persona || {};
      lines.push("**Persona:** " + (persona.name ? persona.name + " — " : "") + (persona.title || ""));
      lines.push("");

      if (opp.products && opp.products.length) {
        lines.push("### Products");
        opp.products.forEach(function (p) {
          lines.push("- **" + p.product_name + "**" + (p.sku_or_tier ? " (" + p.sku_or_tier + ")" : ""));
          if (p.key_capabilities && p.key_capabilities.length) {
            lines.push("  - Capabilities: " + p.key_capabilities.join(", "));
          }
          if (p.replaces && p.replaces.length) {
            lines.push("  - Replaces: " + p.replaces.join(", "));
          }
        });
        lines.push("");
      }

      if (opp.business_case) lines.push("### Business Case", opp.business_case, "");
      if (opp.conversation_opener) lines.push("### Conversation Opener", opp.conversation_opener, "");

      if (opp.discovery_questions && opp.discovery_questions.length) {
        lines.push("### Discovery Questions");
        opp.discovery_questions.forEach(function (q) { lines.push("- " + q); });
        lines.push("");
      }

      if (opp.success_metrics && opp.success_metrics.length) {
        lines.push("### Success Metrics");
        opp.success_metrics.forEach(function (m) { lines.push("- " + m); });
        lines.push("");
      }

      if (opp.case_study_reference) lines.push("### Case Study", opp.case_study_reference, "");
      if (opp.roi_evidence) lines.push("### ROI Evidence", opp.roi_evidence, "");
      if (opp.estimated_timeline) lines.push("**Timeline:** " + opp.estimated_timeline, "");
      if (opp.trigger_from_previous) lines.push("**Trigger:** " + opp.trigger_from_previous, "");
      lines.push("---", "");
    });

    if (playbook.recommended_next_action) {
      lines.push("## Recommended Next Action", playbook.recommended_next_action, "");
    }

    if (playbook.content_gaps && playbook.content_gaps.length) {
      lines.push("## Content Gaps");
      playbook.content_gaps.forEach(function (g) { lines.push("- " + g); });
      lines.push("");
    }

    if (playbook.key_assumptions && playbook.key_assumptions.length) {
      lines.push("## Key Assumptions");
      playbook.key_assumptions.forEach(function (a) { lines.push("- " + a); });
    }

    return lines.join("\n");
  }

  return { render: render, toggle: toggle, toMarkdown: toMarkdown };
})();
