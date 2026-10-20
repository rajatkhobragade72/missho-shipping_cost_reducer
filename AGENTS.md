# Meesho Shipping Optimizer

Local FastAPI + Pillow + rembg web app. Generates hero-image variations (local framing + optional
Pollinations AI edits). No cost prediction: variants are ranked only by real costs the user reads
from the Meesho Supplier Panel (a heuristic "smaller in frame = cheaper" score was removed after a
real test gave Rs 1,613). A comparison sheet JPEG shows rank/cost/"USE THIS" per variant.
Extra catalogue photos are rendered in the chosen hero style.

AI: set `POLLINATIONS_API_KEY` in `.env` (see `.env.example`); uses `POST /v1/images/edits`
on gen.pollinations.ai. Presets are an allowlist in `app/ai.py`; the key never reaches the browser.

## Setup
```
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
```

## Run
```
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
Open http://127.0.0.1:8000. Generated images go to `data/sessions/` (auto-deleted after 24h).

TLS: `truststore.inject_into_ssl()` in `app/main.py` makes Python use the Windows cert store, so the
corporate TLS-intercepting proxy is trusted (never disable verification instead).

rembg was removed (its 170 MB model cannot be downloaded through the corporate proxy). Background
cleanup is done by the Pollinations "clean-white" preset; `imaging.trim_background` then crops the
plain background (colour sampled from corners) and 8 framed CLEAN_STYLES are composed from it.
Flow: /api/hero gives 4 original framed variants; the UI then auto-calls /api/ai-variants with all
12 presets (about 20 images, ~80 s).

Pollinations default model is `black-forest-labs/flux.2-klein-4b` (not paid_only); paid_only models
such as gemini-2.5-flash-image return HTTP 402 on free keys.

## Chrome extension (`extension/`, MV3)
Reads the real shipping charge from the user's logged-in Meesho Supplier Panel. Content script on
`https://supplier.meesho.com/*` injects a floating "Shipping Tester" panel (closed shadow DOM,
textContent only). It gets the latest session from `GET /api/sessions/latest` (via the background
service worker, which has host permission for 127.0.0.1:8000), sets each image on the page's
`input[type=file]` via DataTransfer, waits for the text near "Shipping ... ₹" to change/stabilise,
and posts it to `POST /api/costs` (stored in `data/sessions/<id>/costs.json`, source meesho|manual).
Selectors auto-detect; "Pick upload box"/"Pick shipping cost" store a CSS path in chrome.storage.
Never tested against the real panel (needs login); `tests/extension_harness.html` is a fake panel:
copy it as `app/static/_harness.html` plus `extension/content.js` into `app/static/`, open
`/_harness.html` (headless Edge works), then delete both copies.

## Verify
```
.venv/Scripts/python -m pytest -q
.venv/Scripts/pip-audit -r requirements.txt
```

## Conventions
- Dependencies pinned exactly in `requirements.txt`; prefer versions released 7+ days ago.
- Styles are an allowlist in `app/imaging.py` (`HERO_STYLES`); API looks them up by key.
- Frontend builds DOM with `textContent` only (no innerHTML).
