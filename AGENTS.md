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
Standalone (does NOT need the local server), modelled on SnapSeller "Least Price Image" /
Ecomdost / RapidSKU: the product photo is untouched, only a frame is added. Content script on
`https://supplier.meesho.com/*` injects a "Meesho Shipping Optimizer" panel (closed shadow DOM,
textContent only) with two buttons:
1. Hero: takes the page's current front image (or a chosen file), reads the baseline cost, then
   renders N canvas variations (7 border patterns x 4 widths x random palette, optional corner
   sticker; seeded per run so re-runs try new colours), uploads each via DataTransfer on the
   front `input[type=file]`, waits for text near "Shipping/Delivery ... ₹" to change/stabilise,
   keeps the cheapest and re-applies it (original if nothing is cheaper). Optional target ₹ stops early.
2. Other photos: uploads chosen files into the remaining image inputs (optionally with the winning frame).
Real panel (user screenshot): "Uploaded Images" block, front tile = thumbnail + "Front Image*" +
"CHANGE" link (no visible file input), Image 2..n tiles, "Bank Settlement Breakdown" below. So the
hero input is found via the "Front Image" tile; if none, the extension clicks CHANGE and grabs the
file input it opens (capture-phase click listener + preventDefault, or a newly added input). With no
custom steps, `autoConfirm` presses Save/Done/Crop/... inside visible dialogs (never "Submit").
User reported the charge did not change after upload, so after each upload the extension checks the
front thumbnail src really changed (logs "front image NAHI badli", stops after 3 with a hint to add a
click step) and, if "refreshPrice" is on (default), re-enters the Meesho price field ("" then the old
value, via the native value setter + input/change/blur) so the breakdown recalculates.
Optional "AI se alag photos" checkbox: background posts the original to the local tool
(`/api/hero` + `/api/ai-variants`, key stays server-side; needs host permission 127.0.0.1:8000),
tests each AI photo raw first, then border variants cycle over [original, ...AI photos].
Real page report (path `/panel/v3/new/cataloging/<id>/catalogs/single/add`, MUI): file inputs
`#changeFrontImage` (front), `#addMoreImagesInput` (others, multiple), `#getFile` ("Add Product",
excluded everywhere). Front thumbnails come from `upload.meeshosupplyassets.com` (allowed in
background fetch). Labels are split `<p>Meesho Price</p><p>*</p>`, so refresh fields are found via
`fieldLabel` (name/id/placeholder + nearest short ancestor text with a single input) matching
meesho price / selling price; only `#meesho_price` is re-entered (weight fields such as
`#product_weight`/`#product_weight_unit` are MUI dropdowns and must not be cleared).
Shipping text on the real page: "Shipping (added separately) ₹579" in Customer Price Breakdown.
Real run: the charge does change per image (₹267–₹4998 for the same product) but is noisy / can lag
(an old response lands first), so `waitForCost` waits >= 8 s and needs 3 s stability, and after the
loop the top 3 cheaper images are re-uploaded and the cheapest confirmed reading wins.
After a run, `renderChoices` shows up to 6 cheapest images (thumbnail, ₹, confirm mark, click =
zoom) with "Ye lagao" (re-uploads that image and reads the charge) and "Download" per card.
Setup has "Page report copy karo" (inputs, ₹ texts, dialogs, log) for remote debugging.
Background worker only fetches the front image from `https://*.meesho.com` (CORS) and toggles the panel.
Selectors auto-detect; Setup has pickers (hero box, other box, shipping ₹, post-upload click steps)
stored in chrome.storage (`shipOptimizerCfg`).
Never tested against the real panel (needs login). `tests/extension_harness.html` is a fake panel:
copy it plus `extension/content.js` into a temp dir, `python -m http.server`, then run headless Edge
with `--dump-dom --virtual-time-budget=400000` on `/extension_harness.html` (and `?method=drop`);
the title shows `DONE hero=... | others=...`.

## Verify
```
.venv/Scripts/python -m pytest -q
.venv/Scripts/pip-audit -r requirements.txt
```

## Conventions
- Dependencies pinned exactly in `requirements.txt`; prefer versions released 7+ days ago.
- Styles are an allowlist in `app/imaging.py` (`HERO_STYLES`); API looks them up by key.
- Frontend builds DOM with `textContent` only (no innerHTML).
