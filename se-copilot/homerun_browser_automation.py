"""
Homerun + Chrome DevTools MCP workflow helpers.

Snowflake DIM rows and se-copilot context produce string values; applying them in
the browser requires fresh uids from take_snapshot or resolution via the script
below (Vuetify textarea ids are not stable).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# JavaScript: returns { [ui_heading]: textareaElementId } for SE Details textareas.
HOMERUN_RESOLVE_TEXTAREA_IDS_BY_HEADING = """
() => {
  const headings = [
    'Technical Plan/Status',
    'Current Status',
    'SE Leader Next Steps',
    'SE Next Steps',
    'Current Environment/Tools',
    'SE Outstanding Risks',
    'Link to Opportunity Documents'
  ];
  const set = new Set(headings);
  const out = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
  const textareas = new Set([...document.querySelectorAll('textarea')]);
  let lastHeading = null;
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (textareas.has(el)) {
      if (lastHeading && set.has(lastHeading)) {
        out[lastHeading] = el.id || null;
      }
      continue;
    }
    if (!el.children || el.children.length === 0) continue;
    const t = el.innerText;
    if (!t) continue;
    const line = t.trim().split(/\\s+/).join(' ');
    if (line.length > 2 && line.length < 80 && !line.includes('\\n')) {
      if (/^[A-Z]/.test(line) || line.includes('SE ') || line.includes('Technical')
          || line.includes('Current Status') || line.includes('Current Environment')
          || line.includes('Link to Opportunity')) {
        lastHeading = line;
      }
    }
  }
  return out;
}
"""

_HEADING_TO_SNOWFLAKE: dict[str, str] = {
    "Technical Plan/Status": "TECHNICAL_PLAN_STATUS",
    "Current Status": "OPPORTUNITY_CURRENT_STATUS",
    "SE Leader Next Steps": "SE_LEADER_NEXT_STEPS",
    "SE Next Steps": "SE_NEXT_STEPS",
    "Current Environment/Tools": "CURRENT_ENVIRONMENT_TOOLS",
    "SE Outstanding Risks": "SE_OUTSTANDING_RISKS",
    "Link to Opportunity Documents": "LINK_TO_OPPORTUNITY_DOCUMENTS",
}

# Stable order for UI, Snowflake snapshot text, and browser automation (matches company-detail tab).
HOMERUN_TEMPLATE_FIELD_ORDER: tuple[str, ...] = tuple(_HEADING_TO_SNOWFLAKE.keys())

# SE Leader Next Steps is owned in Homerun; SE Copilot only displays values loaded from Snowflake.
HOMERUN_READ_ONLY_FROM_HOMERUN_HEADINGS: tuple[str, ...] = ("SE Leader Next Steps",)

# JSON keys the LLM must return (excludes read-only Homerun fields).
HOMERUN_TEMPLATE_GENERATED_HEADINGS: tuple[str, ...] = tuple(
    h for h in HOMERUN_TEMPLATE_FIELD_ORDER if h not in set(HOMERUN_READ_ONLY_FROM_HOMERUN_HEADINGS)
)

# All workspace headings (Snowflake DIM text fields + snapshot display).
HOMERUN_WORKSPACE_TEXTAREA_HEADINGS: tuple[str, ...] = HOMERUN_TEMPLATE_FIELD_ORDER


def workspace_url(opportunity_uuid: str, base: str | None = None) -> str:
    b = (base or "https://datadog.cloud.homerunpresales.com").rstrip("/")
    return f"{b}/#/evaluation/{opportunity_uuid.strip()}/workspace"


def dim_row_to_fill_strings(dim_row: dict[str, Any]) -> dict[str, str]:
    """Map Homerun UI headings to string values from a Snowflake DIM row."""
    out: dict[str, str] = {}
    for heading, col in _HEADING_TO_SNOWFLAKE.items():
        raw = dim_row.get(col)
        if raw is None or raw == "":
            continue
        if isinstance(raw, (list, dict)):
            text = json.dumps(raw, default=str)
        else:
            text = str(raw).strip()
        if text:
            out[heading] = text
    return out


def load_ui_inventory() -> dict[str, Any]:
    path = Path(__file__).resolve().parent / "homerun_ui_field_inventory.json"
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_fill_form_elements_from_snapshot_uids(
    heading_to_uid: dict[str, str | None],
    heading_to_value: dict[str, str],
) -> list[dict[str, str]]:
    """
    Produce the `elements` array for Chrome DevTools MCP fill_form.

    heading_to_uid: output keyed by same headings as dim_row_to_fill_strings (uids from snapshot).
    """
    elements: list[dict[str, str]] = []
    for heading, value in heading_to_value.items():
        uid = heading_to_uid.get(heading)
        if uid:
            elements.append({"uid": uid, "value": value})
    return elements


def automation_runbook_markdown(
    opportunity_uuid: str,
    heading_to_value: dict[str, str],
) -> str:
    """Human/agent checklist for MCP (navigate → evaluate_script → fill_form → verify)."""
    url = workspace_url(opportunity_uuid)
    lines = [
        "## Homerun MCP fill runbook",
        f"1. **navigate_page** url=`{url}`",
        "2. **evaluate_script** function body: see `HOMERUN_RESOLVE_TEXTAREA_IDS_BY_HEADING` "
        "in homerun_browser_automation.py (returns heading → textarea id).",
        "3. **take_snapshot** and map textarea nodes to **uid** for fill_form (preferred if ids empty).",
        "4. **fill_form** with elements [{uid, value}, ...] — only for reviewed values (dry-run: skip fill_form).",
        "5. **take_snapshot** again to verify.",
        "",
        "### Payload (headings → values)",
    ]
    for h, v in heading_to_value.items():
        preview = v[:200] + ("…" if len(v) > 200 else "")
        lines.append(f"- **{h}:** {preview}")
    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    from homerun_snowflake import fetch_homerun_dim_dict_sync

    p = argparse.ArgumentParser(description="Print MCP runbook + heading values from Snowflake DIM")
    p.add_argument("--opportunity-uuid", required=True, help="Homerun OPPORTUNITY_UUID")
    p.add_argument("--salesforce-opportunity-id", default=None, help="Optional SF id for disambiguation")
    args = p.parse_args()
    row = fetch_homerun_dim_dict_sync(
        args.opportunity_uuid.strip(),
        (args.salesforce_opportunity_id or "").strip() or None,
    )
    if not row:
        raise SystemExit("No DIM row (check Snowflake config and id).")
    vals = dim_row_to_fill_strings(row)
    ouid = str(row.get("OPPORTUNITY_UUID") or args.opportunity_uuid)
    print(automation_runbook_markdown(ouid, vals))
