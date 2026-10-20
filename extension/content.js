(() => {
  if (window.__shipOptimizer) return;
  window.__shipOptimizer = true;

  const POLL_MS = 500;
  const STABLE_MS = 2000;
  const MAX_WAIT_MS = 45000;
  const STEP_TIMEOUT_MS = 15000;
  const UPLOAD_CHECK_MS = 6000;
  const MAX_STEPS = 6;
  const MAX_SIDE = 1200;
  const MAX_OTHER_PHOTOS = 8;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = {
    heroSelector: "",
    otherSelector: "",
    costSelector: "",
    uploadMethod: "input",
    steps: [],
    waitSec: 6,
    stepWaitSec: 2,
    tries: 30,
    stickers: true,
    target: 0,
    sameFrame: true,
  };
  let running = false;
  let stopRequested = false;
  let winner = null;

  // ---------- messaging ----------
  async function bg(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error || "Extension error");
    return res.data;
  }

  // ---------- DOM helpers ----------
  function cssPath(node) {
    const parts = [];
    let rootedAtId = false;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        rootedAtId = true;
        break;
      }
      let i = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) i++;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${i})`);
      node = node.parentElement;
    }
    return (rootedAtId ? "" : "body > ") + parts.join(" > ");
  }

  function safeQuery(selector) {
    try { return selector ? document.querySelector(selector) : null; } catch { return null; }
  }

  function describe(node) {
    const text = (node.innerText || node.value || node.getAttribute("aria-label") || node.tagName).trim().replace(/\s+/g, " ");
    return text.slice(0, 30) || node.tagName.toLowerCase();
  }

  function imageInputs() {
    return [...document.querySelectorAll("input[type=file]")].filter((i) => !i.accept || /image|jpe?g|png|webp/i.test(i.accept));
  }

  function inputFromPicked(selector) {
    const picked = safeQuery(selector);
    if (!picked) return null;
    if (picked.matches("input[type=file]")) return picked;
    for (let n = picked; n && n !== document.body; n = n.parentElement) {
      const inner = n.querySelector("input[type=file]");
      if (inner) return inner;
    }
    return null;
  }

  const heroInput = () => inputFromPicked(cfg.heroSelector) || imageInputs()[0] || null;

  function otherInputs() {
    const picked = inputFromPicked(cfg.otherSelector);
    if (picked) return [picked];
    const hero = heroInput();
    return imageInputs().filter((i) => i !== hero);
  }

  function dropTarget(input, selector) {
    return safeQuery(selector) || input?.closest("label") || input?.parentElement || null;
  }

  const PRICE_RE = /₹\s*([\d,]+(?:\.\d+)?)/;

  function findCostEl() {
    const picked = safeQuery(cfg.costSelector);
    if (picked) return picked;
    let best = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.includes("₹") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (host.contains(node.parentElement)) continue;
      for (let n = node.parentElement, depth = 0; n && depth < 5; n = n.parentElement, depth++) {
        const text = n.textContent || "";
        if (text.length > 200) break;
        if (/shipping|delivery/i.test(text) && PRICE_RE.test(text)) {
          if (!best || text.length < best.textContent.length) best = n;
          break;
        }
      }
    }
    return best;
  }

  function parseCost(text) {
    const m = text.match(PRICE_RE) || text.match(/(\d[\d,]*(?:\.\d+)?)/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }

  function readCost() {
    const costEl = findCostEl();
    return costEl ? parseCost(costEl.textContent) : null;
  }

  function imageSources() {
    return new Set([...document.images].map((i) => i.currentSrc || i.src).filter(Boolean));
  }

  function heroPreviewSrc() {
    const input = heroInput();
    for (let n = input?.parentElement, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
      const img = [...n.querySelectorAll("img")].find((i) => i.naturalWidth >= 150 && i.naturalHeight >= 150);
      if (img) return img.currentSrc || img.src;
    }
    return null;
  }

  // ---------- image variations (canvas, all local) ----------
  const COLORS = ["#ffffff", "#000000", "#e53935", "#fdd835", "#1e88e5", "#43a047", "#ec407a", "#fb8c00",
    "#8e24aa", "#9e9e9e", "#6d4c41", "#1a237e", "#00acc1", "#f5f5dc", "#ff80ab", "#004d40"];
  const PATTERNS = ["solid", "double", "stripes", "dots", "checker", "gradient", "dashed"];
  const WIDTHS = [0.03, 0.06, 0.1, 0.15];
  const STICKERS = ["NEW", "BEST", "HOT", "★", "❤", "TOP"];
  const CORNERS = ["tr", "tl", "br", "bl"];

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function variantSpec(i, seed, withStickers) {
    const r = rng(seed * 1000 + i);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const c1 = pick(COLORS);
    let c2 = pick(COLORS);
    while (c2 === c1) c2 = pick(COLORS);
    return {
      pattern: PATTERNS[i % PATTERNS.length],
      width: WIDTHS[Math.floor(i / PATTERNS.length) % WIDTHS.length],
      c1, c2,
      sticker: withStickers && i % 3 === 2 ? pick(STICKERS) : null,
      corner: pick(CORNERS),
    };
  }

  function specLabel(s) {
    return `${s.pattern} border ${Math.round(s.width * 100)}%${s.sticker ? ` + "${s.sticker}"` : ""}`;
  }

  function tile(size, draw) {
    const t = document.createElement("canvas");
    t.width = t.height = size;
    draw(t.getContext("2d"), size);
    return t;
  }

  function paintBorder(ctx, w, h, b, s) {
    ctx.fillStyle = s.c1;
    ctx.fillRect(0, 0, w, h);
    const unit = Math.max(6, Math.round(b / 2));
    if (s.pattern === "gradient") {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, s.c1);
      g.addColorStop(1, s.c2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    } else if (s.pattern === "double" || s.pattern === "dashed") {
      ctx.strokeStyle = s.c2;
      ctx.lineWidth = Math.max(2, b / 4);
      if (s.pattern === "dashed") ctx.setLineDash([unit, unit / 2]);
      ctx.strokeRect(b / 2, b / 2, w - b, h - b);
      ctx.setLineDash([]);
    } else if (s.pattern !== "solid") {
      const t = tile(unit * 2, (c, n) => {
        c.fillStyle = s.c1;
        c.fillRect(0, 0, n, n);
        c.fillStyle = s.c2;
        if (s.pattern === "checker") { c.fillRect(0, 0, n / 2, n / 2); c.fillRect(n / 2, n / 2, n / 2, n / 2); }
        if (s.pattern === "dots") { c.beginPath(); c.arc(n / 2, n / 2, n / 5, 0, Math.PI * 2); c.fill(); }
        if (s.pattern === "stripes") {
          c.strokeStyle = s.c2;
          c.lineWidth = n / 4;
          c.beginPath();
          for (let k = -n; k <= 2 * n; k += n / 2) { c.moveTo(k, 0); c.lineTo(k - n, n); }
          c.stroke();
        }
      });
      ctx.fillStyle = ctx.createPattern(t, "repeat");
      ctx.fillRect(0, 0, w, h);
    }
  }

  function paintSticker(ctx, w, h, s) {
    const d = Math.round(Math.min(w, h) * 0.16);
    const m = Math.round(Math.min(w, h) * 0.04);
    const x = s.corner.includes("l") ? m + d / 2 : w - m - d / 2;
    const y = s.corner.includes("t") ? m + d / 2 : h - m - d / 2;
    ctx.fillStyle = s.c1 === "#ffffff" ? "#e53935" : s.c1;
    ctx.beginPath();
    ctx.arc(x, y, d / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(d / (s.sticker.length > 2 ? 3.2 : 1.8))}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.sticker, x, y + 1);
  }

  function canvasSize(bitmap) {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    return [Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)];
  }

  function toJpeg(canvas, name) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], name, { type: "image/jpeg" })) : reject(new Error("Image ban nahi payi"))),
      "image/jpeg", 0.9,
    ));
  }

  function renderVariant(bitmap, spec, name) {
    const [w, h] = canvasSize(bitmap);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const b = Math.round(Math.min(w, h) * spec.width);
    paintBorder(ctx, w, h, b, spec);
    const iw = w - 2 * b;
    const ih = h - 2 * b;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b, b, iw, ih);
    const fit = Math.min(iw / bitmap.width, ih / bitmap.height);
    const dw = bitmap.width * fit;
    const dh = bitmap.height * fit;
    ctx.drawImage(bitmap, b + (iw - dw) / 2, b + (ih - dh) / 2, dw, dh);
    if (spec.sticker) paintSticker(ctx, w, h, spec);
    return toJpeg(canvas, name);
  }

  // ---------- panel UI (shadow DOM, textContent only) ----------
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box{width:330px;font:13px system-ui,sans-serif;background:#fff;color:#222;border:2px solid #9f2089;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.25);overflow:hidden}
    .head{background:#9f2089;color:#fff;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-size:14px}
    .body{padding:10px 12px;display:grid;gap:8px;max-height:75vh;overflow:auto}
    .card{border:1px solid #eee;border-radius:10px;padding:8px;display:grid;gap:6px;background:#fdf7fc}
    .big{font-size:15px;font-weight:700;padding:12px;border-radius:8px}
    button{background:#9f2089;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
    button.ghost{background:#eee;color:#333}
    button.stop{background:#b00020}
    button:disabled{opacity:.5;cursor:wait}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .muted{color:#666;font-size:12px}
    .err{color:#b00020;font-weight:600}
    .result{background:#e8f5e9;border:1px solid #1b8a3a;border-radius:8px;padding:8px;color:#1b5e20;font-weight:700;font-size:14px}
    progress{width:100%}
    input[type=number]{width:52px}
    input[type=file]{font-size:11px;max-width:100%}
    details summary{cursor:pointer;color:#9f2089;font-size:12px}
    details .card{margin-top:6px;background:#fafafa}
    ol{margin:0;padding-left:18px;font-size:12px;max-height:160px;overflow:auto}
    .hidden{display:none}`;
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const row = (...children) => { const r = el("div", null, "row"); r.append(...children); return r; };
  const card = (...children) => { const c = el("div", null, "card"); c.append(...children); return c; };
  const labelled = (input, text) => { const l = el("label", null, "row"); l.append(input, el("span", text)); return l; };
  const numInput = (min, max) => Object.assign(el("input"), { type: "number", min, max });
  const checkbox = () => Object.assign(el("input"), { type: "checkbox" });

  const box = el("div", null, "box");
  const head = el("div", null, "head");
  head.append(el("strong", "Meesho Shipping Optimizer"), el("span", "–"));
  const body = el("div", null, "body");

  const tip = el("div", "Pehle Meesho form me category, weight aur price bhar do, aur front image laga do (taaki Shipping ₹ dikhe).", "muted");

  const btnHero = el("button", "1. Hero image ki shipping kam karo", "big");
  const heroFile = Object.assign(el("input"), { type: "file", accept: "image/jpeg,image/png,image/webp" });
  const triesInput = numInput(5, 80);
  const targetInput = numInput(0, 5000);
  const stickersBox = checkbox();

  const btnOthers = el("button", "2. Baaki photos lagao", "big");
  const otherFiles = Object.assign(el("input"), { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true });
  const sameFrameBox = checkbox();

  const btnStop = el("button", "Stop", "stop");
  btnStop.disabled = true;
  const progress = Object.assign(el("progress"), { max: 1, value: 0 });
  const status = el("div", "");
  const result = el("div", "", "result hidden");
  const btnDownload = el("button", "Sasti image download karo", "ghost hidden");
  const log = el("ol");

  const detectInfo = el("div", "", "muted");
  const btnPickHero = el("button", "Pick hero upload box", "ghost");
  const btnPickOther = el("button", "Pick other photos box", "ghost");
  const btnPickCost = el("button", "Pick shipping ₹", "ghost");
  const btnReset = el("button", "Auto-detect", "ghost");
  const methodSelect = el("select");
  [["input", "Upload: file input"], ["drop", "Upload: drag-drop"]].forEach(([v, t]) => {
    const o = el("option", t);
    o.value = v;
    methodSelect.append(o);
  });
  const waitInput = numInput(3, 40);
  const stepWaitInput = numInput(1, 20);
  const stepsList = el("ol");
  const btnAddStep = el("button", "+ Upload ke baad click step", "ghost");
  const btnClearSteps = el("button", "Steps clear", "ghost");

  const setup = el("details");
  setup.append(el("summary", "Setup (sirf agar auto-detect kaam na kare)"), card(
    detectInfo, row(btnPickHero, btnPickOther), row(btnPickCost, btnReset), row(methodSelect),
    row(el("span", "Min wait (sec):"), waitInput, el("span", "Step wait:"), stepWaitInput),
    el("div", "Agar image upload ke baad Meesho me Save / Done / Crop dabana padta hai, to '+ step' se wo button pick karo.", "muted"),
    stepsList, row(btnAddStep, btnClearSteps),
  ));

  body.append(
    tip,
    card(btnHero,
      el("div", "Page ki front image use hogi. Chaho to yahan alag photo chuno:", "muted"), heroFile,
      row(el("span", "Kitni try karein:"), triesInput, el("span", "Target ₹:"), targetInput),
      labelled(stickersBox, "Stickers / badges bhi try karo")),
    card(btnOthers, otherFiles, labelled(sameFrameBox, "Hero jaisa frame lagao")),
    row(btnStop, btnDownload), progress, status, result, log, setup,
  );
  box.append(head, body);
  root.append(style, box);
  document.documentElement.appendChild(host);

  head.addEventListener("click", () => body.classList.toggle("hidden"));
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "toggle") return false;
    host.style.display = host.style.display === "none" ? "" : "none";
    sendResponse({ ok: true });
    return false;
  });

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.className = isError ? "err" : "";
  }

  function addLog(text) {
    log.prepend(el("li", text));
    while (log.children.length > 80) log.lastChild.remove();
  }

  function renderSteps() {
    stepsList.replaceChildren(...cfg.steps.map((s) => el("li", `Click: ${s.label}`)));
    if (!cfg.steps.length) stepsList.append(el("li", "Koi step nahi (sirf upload)"));
  }

  function refreshDetect() {
    const cost = readCost();
    detectInfo.textContent =
      `Hero box: ${heroInput() ? "mil gaya" : "NAHI mila"} | Other photo box: ${otherInputs().length} | ` +
      `Shipping: ${cost !== null ? "₹" + cost : "nahi dikh raha"}`;
  }

  const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(v) || dflt));

  async function saveCfg() {
    cfg.tries = clamp(triesInput.value, 5, 80, 30);
    cfg.target = clamp(targetInput.value, 0, 5000, 0);
    cfg.stickers = stickersBox.checked;
    cfg.sameFrame = sameFrameBox.checked;
    cfg.waitSec = clamp(waitInput.value, 3, 40, 6);
    cfg.stepWaitSec = clamp(stepWaitInput.value, 1, 20, 2);
    cfg.uploadMethod = methodSelect.value === "drop" ? "drop" : "input";
    await chrome.storage.local.set({ shipOptimizerCfg: cfg });
  }

  function setBusy(busy) {
    running = busy;
    [btnHero, btnOthers, btnAddStep, btnPickHero, btnPickOther, btnPickCost].forEach((b) => { b.disabled = busy; });
    btnStop.disabled = !busy;
  }

  // ---------- picker ----------
  function pick(message, onPicked) {
    setStatus(`${message} (Esc = cancel)`);
    const outline = document.createElement("div");
    outline.style.cssText = "position:fixed;pointer-events:none;border:3px solid #9f2089;background:rgba(159,32,137,.12);z-index:2147483646;";
    document.documentElement.appendChild(outline);
    const move = (e) => {
      const r = e.target.getBoundingClientRect();
      Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const done = () => {
      document.removeEventListener("mouseover", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      outline.remove();
      refreshDetect();
    };
    const click = async (e) => {
      if (e.composedPath().includes(host)) return;
      e.preventDefault();
      e.stopPropagation();
      done();
      await onPicked(e.target);
      await saveCfg();
    };
    const key = (e) => {
      if (e.key === "Escape") { done(); setStatus("Cancel kiya."); }
    };
    document.addEventListener("mouseover", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  }

  // ---------- upload + read ----------
  async function putFiles(input, selector, files, method = cfg.uploadMethod) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    const before = imageSources();
    if (method === "drop") {
      const target = dropTarget(input, selector);
      if (!target) throw new Error("Upload box nahi mila. Setup me 'Pick ... box' se set karo.");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    } else {
      if (!input) throw new Error("Upload box nahi mila. Setup me 'Pick ... box' se set karo.");
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const start = Date.now();
    while (Date.now() - start < UPLOAD_CHECK_MS) {
      await sleep(POLL_MS);
      for (const src of imageSources()) if (!before.has(src)) return true;
    }
    return false;
  }

  async function runSteps() {
    for (const step of cfg.steps) {
      if (stopRequested) return;
      const start = Date.now();
      let target = safeQuery(step.selector);
      while (!target && Date.now() - start < STEP_TIMEOUT_MS) {
        await sleep(POLL_MS);
        target = safeQuery(step.selector);
      }
      if (!target) throw new Error(`Step "${step.label}" ka button nahi mila. Steps clear karke dobara pick karo.`);
      target.click();
      await sleep(cfg.stepWaitSec * 1000);
    }
  }

  async function waitForCost(prevText) {
    const start = Date.now();
    let last;
    let stableSince = start;
    while (Date.now() - start < MAX_WAIT_MS && !stopRequested) {
      await sleep(POLL_MS);
      const costEl = findCostEl();
      const text = costEl ? costEl.textContent.trim() : null;
      if (text !== last) { last = text; stableSince = Date.now(); }
      const changed = text !== null && text !== prevText;
      if (text !== null && Date.now() - stableSince >= STABLE_MS && (changed || Date.now() - start >= cfg.waitSec * 1000)) {
        return parseCost(text);
      }
    }
    return null;
  }

  async function tryHero(file) {
    const prevEl = findCostEl();
    const prevText = prevEl ? prevEl.textContent.trim() : null;
    const uploaded = await putFiles(heroInput(), cfg.heroSelector, [file]);
    await runSteps();
    const cost = await waitForCost(prevText);
    return { cost, uploaded };
  }

  function b64ToFile(b64, name, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  async function pageHeroFile() {
    const src = heroPreviewSrc();
    if (!src) return null;
    try {
      const blob = await (await fetch(src)).blob();
      if (blob.type.startsWith("image/")) return new File([blob], "original.jpg", { type: blob.type });
    } catch { /* cross-origin: fall back to the service worker */ }
    if (!/^https:/.test(src)) return null;
    try {
      const { b64, type } = await bg({ type: "fetchImage", url: src });
      return b64ToFile(b64, "original.jpg", type);
    } catch { return null; }
  }

  function showResult(text) {
    result.textContent = text;
    result.classList.remove("hidden");
  }

  // ---------- flow 1: optimize hero ----------
  async function optimizeHero() {
    result.classList.add("hidden");
    btnDownload.classList.add("hidden");
    log.replaceChildren();
    if (!heroInput() && cfg.uploadMethod === "input") throw new Error("Front image ka upload box nahi mila. Meesho ka image upload wala page kholo, ya Setup me 'Pick hero upload box' karo.");

    let original = heroFile.files[0] || null;
    let baseline = null;
    if (original) {
      setStatus("Aapki photo laga ke asli shipping padh rahe hain...");
      baseline = (await tryHero(original)).cost;
    } else {
      original = await pageHeroFile();
      baseline = readCost();
      if (!original) throw new Error("Page par front image nahi mili. Upar 'Choose file' se hero photo chuno.");
    }
    if (baseline === null) throw new Error("Shipping ₹ nahi dikh raha. Pehle category/weight/price bharo, ya Setup me 'Pick shipping ₹' karo.");
    addLog(`Original: ₹${baseline}`);

    const bitmap = await createImageBitmap(original);
    const seed = Math.floor(Math.random() * 1e6);
    let best = { cost: baseline, file: original, spec: null, label: "Original" };
    let lastFile = original;
    let readFails = 0;
    let notUploaded = 0;
    progress.max = cfg.tries;
    for (let i = 0; i < cfg.tries && !stopRequested; i++) {
      const spec = variantSpec(i, seed, cfg.stickers);
      const label = `#${i + 1} ${specLabel(spec)}`;
      setStatus(`${i + 1}/${cfg.tries} try ho rahi hai... (abhi tak best ₹${best.cost})`);
      const file = await renderVariant(bitmap, spec, `hero_${i + 1}.jpg`);
      const { cost, uploaded } = await tryHero(file);
      lastFile = file;
      progress.value = i + 1;
      if (!uploaded) notUploaded++;
      if (cost === null) {
        readFails++;
        addLog(`${label}: cost nahi padh paya`);
      } else {
        addLog(`${label}: ₹${cost}${cost < best.cost ? "  ← naya best" : ""}`);
        if (cost < best.cost) best = { cost, file, spec, label };
      }
      if (i === 2 && notUploaded === 3) throw new Error("Image upload nahi ho rahi (preview nahi badla). Setup me 'Upload: drag-drop' try karo ya 'Pick hero upload box' karo.");
      if (i === 2 && readFails === 3) throw new Error("Shipping ₹ padh nahi pa rahe. Setup me 'Pick shipping ₹' karo.");
      if (cfg.target && best.cost <= cfg.target) { addLog(`Target ₹${cfg.target} mil gaya, ruk gaye.`); break; }
    }
    bitmap.close();

    if (best.file !== lastFile) {
      setStatus(best.spec ? "Sabse sasti image wapas laga rahe hain..." : "Koi variation sasti nahi mili, original wapas laga rahe hain...");
      const confirm = (await tryHero(best.file)).cost;
      if (confirm !== null && confirm !== best.cost) addLog(`Dhyan do: wapas lagane par ₹${confirm} dikha (pehle ₹${best.cost}).`);
    }
    winner = best.spec ? best : null;
    if (best.spec) {
      showResult(`Pehle ₹${baseline} → Ab ₹${best.cost}  (₹${baseline - best.cost} bacha)`);
      btnDownload.classList.remove("hidden");
      setStatus(`Laga di: ${best.label}. Ab form check karke khud Submit karo.`);
    } else {
      showResult(`Original hi sabse sasta hai: ₹${baseline}`);
      setStatus(stopRequested ? "Roka gaya. Original wapas laga di." : "Dobara chalao (har baar naye colours try hote hain) ya 'Kitni try' badhao.");
    }
  }

  // ---------- flow 2: other photos ----------
  async function addOtherPhotos() {
    const files = [...otherFiles.files].slice(0, MAX_OTHER_PHOTOS);
    if (!files.length) throw new Error("Pehle '2. Baaki photos' ke neeche photos chuno.");
    const prepared = [];
    for (const [i, f] of files.entries()) {
      if (cfg.sameFrame && winner?.spec) {
        const bitmap = await createImageBitmap(f);
        prepared.push(await renderVariant(bitmap, winner.spec, `photo_${i + 1}.jpg`));
        bitmap.close();
      } else prepared.push(f);
    }
    if (cfg.sameFrame && !winner?.spec) addLog("Hero ka frame abhi nahi hai, photos waise hi lag rahi hain.");
    progress.max = prepared.length;
    progress.value = 0;
    const first = otherInputs()[0];
    let failed = 0;
    if (!first && !safeQuery(cfg.otherSelector)) throw new Error("Baaki photos ka upload box nahi mila. Setup me 'Pick other photos box' karo.");
    if (!first || first.multiple) {
      setStatus(`${prepared.length} photos ek saath laga rahe hain...`);
      if (!(await putFiles(first, cfg.otherSelector, prepared, first ? "input" : "drop"))) failed = prepared.length;
      await runSteps();
      progress.value = prepared.length;
    } else {
      for (const [i, file] of prepared.entries()) {
        if (stopRequested) break;
        const inputs = otherInputs();
        setStatus(`Photo ${i + 1}/${prepared.length} laga rahe hain...`);
        const ok = await putFiles(inputs[Math.min(i, inputs.length - 1)], cfg.otherSelector, [file], "input");
        await runSteps();
        if (!ok) failed++;
        addLog(`Photo ${i + 1}: ${ok ? "lag gayi" : "preview nahi dikha, check karo"}`);
        progress.value = i + 1;
        await sleep(1000);
      }
    }
    if (failed) setStatus(`${failed} photo ka preview nahi dikha. Page par check karo, ya Setup me 'Pick other photos box' karo.`, true);
    else setStatus("Photos laga di. Form check karke Submit karo.");
  }

  async function guarded(fn) {
    if (running) return;
    await saveCfg();
    stopRequested = false;
    progress.value = 0;
    setBusy(true);
    try { await fn(); } catch (err) { setStatus(err.message, true); } finally { setBusy(false); refreshDetect(); }
  }

  // ---------- events ----------
  btnHero.addEventListener("click", () => guarded(optimizeHero));
  btnOthers.addEventListener("click", () => guarded(addOtherPhotos));
  btnStop.addEventListener("click", () => { stopRequested = true; setStatus("Rok rahe hain..."); });
  btnDownload.addEventListener("click", () => {
    if (!winner) return;
    const a = el("a");
    a.href = URL.createObjectURL(winner.file);
    a.download = `meesho_hero_rs${winner.cost}.jpg`;
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  btnPickHero.addEventListener("click", () => pick("Page par FRONT image upload box par click karo", (t) => {
    cfg.heroSelector = cssPath(t);
    setStatus("Hero upload box set ho gaya.");
  }));
  btnPickOther.addEventListener("click", () => pick("Page par baaki photos wale upload box par click karo", (t) => {
    cfg.otherSelector = cssPath(t);
    setStatus("Other photos box set ho gaya.");
  }));
  btnPickCost.addEventListener("click", () => pick("Page par 'Shipping ₹...' wale hisse par click karo", (t) => {
    cfg.costSelector = cssPath(t);
    setStatus("Shipping ₹ wala hissa set ho gaya.");
  }));
  btnAddStep.addEventListener("click", () => {
    if (cfg.steps.length >= MAX_STEPS) { setStatus(`Max ${MAX_STEPS} steps.`, true); return; }
    pick("Jo button upload ke baad dabana hota hai (Done / Save / Crop) us par click karo", (t) => {
      const button = t.closest("button, a, [role=button], input[type=submit]") || t;
      cfg.steps.push({ selector: cssPath(button), label: describe(button) });
      renderSteps();
      setStatus(`Step add hua: ${describe(button)}`);
    });
  });
  btnClearSteps.addEventListener("click", async () => {
    cfg.steps = [];
    renderSteps();
    await saveCfg();
  });
  btnReset.addEventListener("click", async () => {
    cfg.heroSelector = "";
    cfg.otherSelector = "";
    cfg.costSelector = "";
    await saveCfg();
    refreshDetect();
    setStatus("Auto-detect par wapas.");
  });
  [triesInput, targetInput, stickersBox, sameFrameBox, waitInput, stepWaitInput, methodSelect]
    .forEach((n) => n.addEventListener("change", saveCfg));

  chrome.storage.local.get("shipOptimizerCfg").then(({ shipOptimizerCfg }) => {
    Object.assign(cfg, shipOptimizerCfg || {});
    if (!Array.isArray(cfg.steps)) cfg.steps = [];
    triesInput.value = cfg.tries;
    targetInput.value = cfg.target;
    stickersBox.checked = cfg.stickers;
    sameFrameBox.checked = cfg.sameFrame;
    waitInput.value = cfg.waitSec;
    stepWaitInput.value = cfg.stepWaitSec;
    methodSelect.value = cfg.uploadMethod;
    renderSteps();
    refreshDetect();
  });
  setInterval(() => { if (!running) refreshDetect(); }, 3000);
})();
