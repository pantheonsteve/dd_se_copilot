# Dev quickstart

## Start the backend

```bash
cd se-copilot-addon
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python support_admin_extension.py
```

You should see: `Uvicorn running on http://127.0.0.1:5060`

Test it:
```bash
curl http://localhost:5060/health
# {"ok":true,"model":"claude-opus-4-7"}
```

## Load the extension

1. Chrome → `chrome://extensions`
2. Developer mode ON
3. "Load unpacked" → pick `extension/`
4. Pin the extension

You'll need placeholder icons. Quick option:
```bash
cd extension/icons
# any 16/48/128 png will do for dev
convert -size 16x16 xc:'#7c5cff' icon16.png
convert -size 48x48 xc:'#7c5cff' icon48.png
convert -size 128x128 xc:'#7c5cff' icon128.png
```

If you don't have ImageMagick, any PNGs at those sizes work.

## First run

1. Go to `https://app.datad0g.com/...` (Datadog staging)
2. Click the extension icon → side panel opens
3. Env badge should read `demo` (green)
4. Navigate to any page (Service Catalog is a good first test)
5. Click `⎙ Full` to capture the page
6. Ask: "What's the observability posture here? Where should I look next?"

## Iteration loop

When you change extension code:
- Go to `chrome://extensions`
- Click the reload icon on the Support Admin Copilot card
- Close and reopen the side panel

When you change backend code:
- Just restart the uvicorn process (no Chrome reload needed)

## Debugging

- **Side panel blank / errors:** right-click the side panel → Inspect
- **Background script errors:** `chrome://extensions` → "service worker" link under the extension
- **Content script errors:** regular DevTools console on the Datadog tab
- **Backend errors:** stdout of the uvicorn process

## Test harness ideas (not built yet)

- Feed a known Service Catalog screenshot into `/analyze` directly via curl to iterate on prompts without the browser loop
- Save a few "golden" observation sets to replay `/report` against for prompt tuning
