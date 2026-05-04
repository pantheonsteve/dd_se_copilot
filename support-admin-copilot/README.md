# Support Admin Copilot

A read-only Chrome extension that acts as an AI copilot for Datadog Sales Engineers
exploring customer environments via Support Admin.

## ⚠ Scope and policy

**This tool is read-only by design.** It:

- Observes the page the SE has navigated to (DOM + screenshot)
- Sends that context to Claude via a local FastAPI backend
- Returns analysis, observations, and recommendations in a side panel
- **Never** clicks, submits, navigates, or performs any action in the customer environment

**Demo-only until manager approval.** The side panel is hard-gated to only
activate on the staging/demo domain (`datad0g.com`) by default. Capture and
analysis buttons are disabled on any other domain. Before using this on a real
customer account via Support Admin:

1. Review data flow with your manager
2. Confirm InfoSec / AI-policy posture for customer-data-to-Claude calls
3. For GovCloud / regulated accounts, treat as a separate approval
4. Update the `DEMO_ORG_PATTERNS` guard in `extension/sidepanel.js` only after approval

## Data flow

```
Browser (side panel + content script)
        │
        │  screenshot (base64 PNG) + DOM context + prompt
        ▼
background.js  ────────────────────►  localhost:5060 (se-copilot-addon)
                                              │
                                              │  (optional) account/product grounding
                                              ├──► localhost:5055 (Company Research)
                                              ├──► localhost:5050 (Librarian)
                                              │
                                              ▼
                                        Anthropic API (vision)
                                              │
                                              ▼
                                        audit log (./sac_audit.jsonl)
```

Every request logs:
- Session ID (ephemeral)
- Page type (e.g. `service_catalog`, `monitor_detail`)
- Whether an image was included
- Prompt length

Screenshots are **not persisted**. They live in memory for the duration of the
API call and are discarded.

## Repo layout

```
support-admin-copilot/
├── extension/               Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js        service worker, screenshot capture, backend routing
│   ├── content.js           DOM scraping, overlay annotations
│   ├── overlay.css
│   ├── sidepanel.html
│   ├── sidepanel.css
│   ├── sidepanel.js         chat UI, session state, demo-env gate
│   └── icons/               (add 16/48/128 pngs)
└── se-copilot-addon/
    ├── support_admin_extension.py   FastAPI router
    └── requirements.txt
```

## Setup

### 1. Backend

```bash
cd se-copilot-addon
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python support_admin_extension.py      # runs on :5060
```

Optional — integrate with existing SE Copilot agents:

```bash
export LIBRARIAN_URL=http://localhost:5050
export COMPANY_RESEARCH_URL=http://localhost:5055
```

### 2. Extension

1. Open `chrome://extensions`
2. Enable Developer mode (top right)
3. Click "Load unpacked" and select the `extension/` directory
4. Pin the extension icon to your toolbar
5. (First time only) Add placeholder PNGs to `extension/icons/` at 16/48/128 px

### 3. Use

1. Navigate to the demo org in Chrome
2. Click the extension icon → side panel opens
3. Verify the env badge reads `demo` (green dot, no warning)
4. Click `⎙ Full` or `⎙ View` to capture, or type a question directly
5. Click "Generate report" at end of session for a customer-facing writeup

## v1 capabilities

- [x] DOM-aware page context (type, filters, visible entities)
- [x] Full-page screenshot via debugger API with scroll-stitch fallback
- [x] Viewport-only quick capture
- [x] Vision analysis with page-type-aware prompting
- [x] STEAM framework baked into every analysis and report
- [x] Session observation accumulation with STEAM tagging
- [x] Live STEAM coverage indicator in the side panel
- [x] Report generation grouped by STEAM step
- [x] Demo-org hard gate
- [x] Audit logging of every request

## The STEAM framework

Every observation the copilot surfaces is tagged with a STEAM step so a session
accumulates into a coherent discovery story rather than a pile of bullets:

| Step | Name | What the copilot looks for |
|------|------|----------------------------|
| **S** | Surface | Total monitors, muted %, ownership concentration, tier distribution — the baseline. Captured in the first 3-5 observations, then considered "established." |
| **T** | Tension | Contradictions: Watchdog vs threshold, P4 on prod critical path, static thresholds on dynamic workloads, stale P1s. |
| **E** | Evaluate | Blast radius: high-dependency services without monitors, unmonitored chokepoints, SLOs missing burn-rate alerts. |
| **A** | Anchor | One specific named thing — one monitor, one conflict, one gap — that makes the value tangible in a conversation. |
| **M** | Map | Sequenced monitor recommendations by tier: Faster → Smarter → Previously Impossible. |

The side panel shows live STEAM coverage pips so you can see at a glance which
steps the session has touched. The generated report is structured around the
same five steps, with any gaps called out explicitly so you can navigate to
cover them in follow-up.

## Not in v1 (intentional)

- Any action-taking (clicks, form submissions, navigation)
- Persistent storage of screenshots
- Multi-user / shared session support
- Auto-annotation of page elements (plumbed but not wired; reserved for v2)
- Customer-environment use (pending approval)

## Approval conversation notes

When discussing with your manager, the concrete data-flow points are:

1. **What leaves the browser:** base64 PNG of current tab + scraped DOM text + SE-typed prompt
2. **Where it goes:** local backend on `localhost:5060` → Anthropic API (commercial tier, no training on API calls per Anthropic policy)
3. **What's persisted:** audit log of metadata only (no screenshots, no DOM content). Path is `sac_audit.jsonl`
4. **Who can see it:** only the SE running the backend on their own machine
5. **GovCloud posture:** extension matches `datad0g.com` and `datadoghq.com` broadly; needs a narrower host pattern or separate deployment decision before touching gov tenancy

## License

Internal tool. Do not distribute outside Datadog.
