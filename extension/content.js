(() => {
  if (window.__shipOptimizer) return;
  window.__shipOptimizer = true;

  const POLL_MS = 500;
  const STABLE_MS = 3000;
  const MIN_READ_WAIT_MS = 8000;
  const POST_REFRESH_WAIT_MS = 4000;  // extra settle time after refreshPrice before reading cost
  const CONFIRM_TOP = 3;
  const MAX_CHOICES = 6;
  const MAX_WAIT_MS = 45000;
  const STEP_TIMEOUT_MS = 15000;
  const UPLOAD_CHECK_MS = 6000;
  const MAX_STEPS = 6;
  const MAX_SIDE = 1200;
  const MAX_OTHER_PHOTOS = 8;
  const KEEPALIVE_MS = 20000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = {
    heroSelector: "",
    otherSelector: "",
    costSelector: "",
    priceSelector: "",
    refreshPrice: true,
    useAI: false,
    uploadMethod: "input",
    steps: [],
    waitSec: 6,
    stepWaitSec: 2,
    tries: 30,
    stickers: false,
    look: "nice",
    extrasMode: "make",
    fourth: "size",
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

  // Real Meesho single-catalog page ids (from a user page report). #getFile is "Add Product": never touch it.
  const MEESHO_HERO_INPUT = "#changeFrontImage";
  const MEESHO_OTHER_INPUT = "#addMoreImagesInput";
  const MEESHO_FORBIDDEN_INPUT = "#getFile";

  function imageInputs() {
    return [...document.querySelectorAll("input[type=file]")].filter((i) =>
      !i.matches(MEESHO_FORBIDDEN_INPUT) && (!i.accept || /image|jpe?g|png|webp/i.test(i.accept)));
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

  const visible = (n) => !!n && n.getClientRects().length > 0;
  const ownText = (n) => (n.textContent || "").replace(/\s+/g, " ").trim();

  // Meesho shows "Front Image *" under the thumbnail with a "CHANGE" link (no visible file input).
  function frontTile() {
    const label = [...document.querySelectorAll("body *")].find((n) =>
      !host.contains(n) && n.children.length <= 2 && /^front image\s*\*?$/i.test(ownText(n)) && visible(n));
    if (!label) return null;
    for (let n = label.parentElement, depth = 0; n && n !== document.body && depth < 4; n = n.parentElement, depth++) {
      if (n.querySelector("img") && !/image\s*2/i.test(ownText(n))) return n;
    }
    return label.parentElement;
  }

  function changeLink(tile) {
    const scope = tile?.parentElement || tile;
    return scope ? [...scope.querySelectorAll("button, a, span, div, p, [role=button]")]
      .find((n) => /^(change|edit|replace)$/i.test(ownText(n)) && visible(n)) || null : null;
  }

  function heroInput() {
    const picked = inputFromPicked(cfg.heroSelector);
    if (picked) return picked;
    const known = document.querySelector(MEESHO_HERO_INPUT);
    if (known) return known;
    const tile = frontTile();
    if (tile) return tile.querySelector("input[type=file]") || null;
    return imageInputs().find((i) => !i.multiple) || imageInputs()[0] || null;
  }

  // Clicks the "CHANGE" link and grabs the file input it opens, without showing the OS file dialog.
  async function heroInputViaChange() {
    const link = changeLink(frontTile());
    if (!link) return null;
    let caught = null;
    const onClick = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "file") { caught = e.target; e.preventDefault(); }
    };
    const before = new Set(imageInputs());
    document.addEventListener("click", onClick, true);
    try {
      link.click();
      for (let t = 0; t < 10 && !caught; t++) {
        await sleep(400);
        const fresh = imageInputs().find((i) => !before.has(i));
        if (fresh) return fresh;
      }
    } finally {
      document.removeEventListener("click", onClick, true);
    }
    return caught;
  }

  function otherInputs() {
    const picked = inputFromPicked(cfg.otherSelector);
    if (picked) return [picked];
    const known = document.querySelector(MEESHO_OTHER_INPUT);
    if (known) return [known];
    const hero = heroInput();
    const tile = frontTile();
    return imageInputs().filter((i) => i !== hero && !tile?.contains(i));
  }

  const CONFIRM_RE = /\b(save|done|apply|crop|confirm|ok|okay|upload|update|replace|use|continue|proceed|next|add|ho\s*gaya|theek|lagao|haan|yes|complete|finish|submit photo|upload photo)\b/i;
  const DANGER_RE = /submit(?!\s*photo)|cancel|delete|remove|discard|back|close|reset|skip|exit/i;
  const isConfirm = (b) => { const t = ownText(b); return t.length <= 30 && CONFIRM_RE.test(t) && !DANGER_RE.test(t); };
  const DIALOG_SEL = "[role=dialog], [aria-modal=true], [class*=modal i], [class*=dialog i], [class*=popup i], [class*=drawer i], [class*=sheet i], [class*=overlay i]";

  // After an upload Meesho may open a crop/preview popup. Press its Save/Done (never "Submit").
  // Poll up to ~6 s — the dialog may appear with a delay after file input is set.
  async function autoConfirm() {
    let pressed = 0;
    for (let round = 0; round < 5; round++) {
      await sleep(1200);
      const dialogs = [...document.querySelectorAll(DIALOG_SEL)].filter((d) => visible(d) && !host.contains(d));
      if (!dialogs.length) {
        if (pressed > 0) return;  // we already pressed something, popup closed — done
        continue;                 // popup not opened yet, keep waiting
      }
      const btn = dialogs
        .flatMap((d) => [...d.querySelectorAll("button, [role=button]")])
        .find((b) => visible(b) && !b.disabled && isConfirm(b));
      if (!btn) continue;        // dialog open but no confirm button yet (loading state)
      addLog(`Popup me "${ownText(btn)}" dabaya`);
      btn.click();
      pressed++;
    }
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
    const tileImg = [...(frontTile()?.querySelectorAll("img") || [])].find((i) => i.naturalWidth >= 100);
    if (tileImg) return tileImg.currentSrc || tileImg.src;
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
  const WIDTHS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
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

  // "Sundar" look: soft palettes, thin lines, rounded white card with a soft shadow, square output.
  const PALETTES = [
    { name: "blush", bg: "#fde2e4", accent: "#c9184a" },
    { name: "mint", bg: "#d8f3dc", accent: "#2d6a4f" },
    { name: "sky", bg: "#dbeafe", accent: "#1e40af" },
    { name: "lavender", bg: "#ede9fe", accent: "#6d28d9" },
    { name: "peach", bg: "#ffe5d0", accent: "#c2410c" },
    { name: "cream-gold", bg: "#fdf6e3", accent: "#a67c00" },
    { name: "grey", bg: "#f1f3f5", accent: "#343a40" },
    { name: "teal", bg: "#ccfbf1", accent: "#0f766e" },
    { name: "pink", bg: "#fce7f3", accent: "#9f2089" },
  ];
  const NICE_STYLES = ["b1g1", "pastel-card", "thin-frame", "gradient-card", "corner-accents", "accent-card", "double-line", "dots-card", "band"];
  const NICE_PADS = [0.10, 0.15, 0.20, 0.25];
  // Scales: product should fill most of the card — never use tiny values like 0.20/0.30
  const NICE_SCALES = [0.72, 0.78, 0.84, 0.88, 0.92, 0.96];
  const NICE_STICKERS = ["BESTSELLER", "NEW", "PREMIUM", "TRENDING"];
  const NICE_SIDE = 1100;

  // ---- Product context: title + description se smart layouts ----
  let productCtx = { quantity: 1, isB1G1: false, title: "", features: [] };

  function parseProductContext(title, desc) {
    const text = (title + " " + desc).toLowerCase();
    const b1g1  = /buy\s*(\d+)\s*get\s*(\d+)/i.exec(text);
    const packN  = (/pack\s*of\s*(\d+)/i.exec(text) || /set\s*of\s*(\d+)/i.exec(text) || /combo\s*of\s*(\d+)/i.exec(text));
    const pcs    = /(\d+)\s*(?:pc|pcs|piece|pieces|nos)\b/i.exec(text);
    let quantity = 1;
    let isB1G1   = false;
    if (b1g1)       { quantity = Math.min(4, Number(b1g1[1]) + Number(b1g1[2])); isB1G1 = true; }
    else if (packN) { quantity = Math.min(4, Number(packN[1])); }
    else if (pcs)   { quantity = Math.min(4, Number(pcs[1])); }
    const features = desc
      ? desc.split(/[.\n,;]/).map((s) => s.trim()).filter((s) => s.length > 4 && s.length < 60).slice(0, 5)
      : [];
    productCtx = { quantity, isB1G1, title: title.trim(), features };
    // update UI hint (ctxInfo declared later in UI section — closure is safe)
    const parts = [];
    if (isB1G1)            parts.push(`Buy 1 Get 1 Free → 2 products dikhaega`);
    else if (quantity > 1) parts.push(`Pack of ${quantity} → ${quantity} products dikhaega`);
    if (features.length)   parts.push(`${features.length} features mili`);
    if (typeof ctxInfo !== "undefined")
      ctxInfo.textContent = parts.length ? "Samjha: " + parts.join(" | ") : "Koi khaas pattern nahi mila (normal frames try honge).";
  }

  // Returns ordered style list based on current productCtx.
  function contextStyles() {
    const base = [];
    if (productCtx.isB1G1)        base.push("b1g1");
    if (productCtx.quantity >= 2) base.push("multi-pack");
    if (productCtx.title)         base.push("feature-card");
    for (const s of NICE_STYLES) { if (!base.includes(s)) base.push(s); }
    return base;
  }

  function variantSpec(i, seed, withStickers, look = "nice") {
    const r = rng(seed * 1000 + i);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    if (look === "nice") {
      const styles = contextStyles();
      return {
        mode: "nice",
        style: styles[i % styles.length],
        palette: PALETTES[(Math.floor(i / styles.length) * 4 + Math.floor(r() * PALETTES.length)) % PALETTES.length],
        pad: pick(NICE_PADS),
        scale: pick(NICE_SCALES),
        sticker: withStickers && i % 4 === 3 ? pick(NICE_STICKERS) : null,
        corner: pick(["tl", "tr"]),
      };
    }
    const c1 = pick(COLORS);
    let c2 = pick(COLORS);
    while (c2 === c1) c2 = pick(COLORS);
    return {
      mode: "variety",
      pattern: PATTERNS[i % PATTERNS.length],
      width: WIDTHS[Math.floor(i / PATTERNS.length) % WIDTHS.length],
      c1, c2,
      sticker: withStickers && i % 3 === 2 ? pick(STICKERS) : null,
      corner: pick(CORNERS),
    };
  }

  function specLabel(s) {
    if (s.mode === "nice") {
      if (s.style === "b1g1")          return `Buy 1 Get 1 Free (${s.palette.name})`;
      if (s.style === "multi-pack")    return `Pack of ${productCtx.quantity || 2} grid`;
      if (s.style === "feature-card")  return `Feature card layout`;
      return `${s.style} ${s.palette.name}${s.sticker ? ` + "${s.sticker}"` : ""}`;
    }
    return `${s.pattern} border ${Math.round(s.width * 100)}%${s.sticker ? ` + "${s.sticker}"` : ""}`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function paintNice(ctx, S, s) {
    const { bg, accent } = s.palette;
    const pad = Math.round(S * s.pad);
    const card = { x: pad, y: pad, w: S - 2 * pad, h: S - 2 * pad, r: Math.round(S * 0.04) };
    const shadowCard = () => {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = S * 0.03;
      ctx.shadowOffsetY = S * 0.01;
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, card.x, card.y, card.w, card.h, card.r);
      ctx.fill();
      ctx.restore();
    };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, S, S);
    if (s.style === "pastel-card" || s.style === "dots-card") {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, S, S);
      if (s.style === "dots-card") {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.12;
        const step = S * 0.04;
        for (let y = step / 2; y < S; y += step) for (let x = step / 2; x < S; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, S * 0.005, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      shadowCard();
    } else if (s.style === "gradient-card") {
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, bg);
      g.addColorStop(1, "#ffffff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      shadowCard();
    } else if (s.style === "accent-card") {
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, S, S);
      shadowCard();
      ctx.strokeStyle = bg;
      ctx.lineWidth = S * 0.004;
      roundRect(ctx, card.x + S * 0.015, card.y + S * 0.015, card.w - S * 0.03, card.h - S * 0.03, card.r * 0.7);
      ctx.stroke();
    } else if (s.style === "thin-frame" || s.style === "double-line") {
      ctx.strokeStyle = accent;
      ctx.lineWidth = S * 0.006;
      ctx.strokeRect(pad / 2, pad / 2, S - pad, S - pad);
      if (s.style === "double-line") {
        ctx.strokeStyle = bg;
        ctx.lineWidth = S * 0.012;
        ctx.strokeRect(pad / 2 + S * 0.016, pad / 2 + S * 0.016, S - pad - S * 0.032, S - pad - S * 0.032);
      }
    } else if (s.style === "corner-accents") {
      const len = S * 0.12;
      const o = pad / 2;
      ctx.strokeStyle = accent;
      ctx.lineWidth = S * 0.012;
      ctx.lineCap = "round";
      for (const [x, y, dx, dy] of [[o, o, 1, 1], [S - o, o, -1, 1], [o, S - o, 1, -1], [S - o, S - o, -1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x, y + dy * len);
        ctx.lineTo(x, y);
        ctx.lineTo(x + dx * len, y);
        ctx.stroke();
      }
    } else if (s.style === "band") {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, S, pad * 0.6);
      ctx.fillRect(0, S - pad * 0.6, S, pad * 0.6);
      ctx.fillStyle = accent;
      ctx.fillRect(0, pad * 0.6, S, S * 0.005);
      ctx.fillRect(0, S - pad * 0.6 - S * 0.005, S, S * 0.005);
    }
    return card;
  }

  function paintNiceSticker(ctx, S, s) {
    const h = S * 0.06;
    ctx.font = `bold ${Math.round(S * 0.028)}px Arial, sans-serif`;
    const w = ctx.measureText(s.sticker).width + S * 0.05;
    const m = S * s.pad + S * 0.025;
    const x = s.corner === "tl" ? m : S - m - w;
    ctx.fillStyle = s.palette.accent;
    roundRect(ctx, x, m, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.sticker, x + w / 2, m + h / 2 + 1);
  }

  function renderNice(bitmap, spec, name) {
    if (spec.style === "b1g1")         return renderB1G1(bitmap, spec, name);
    if (spec.style === "multi-pack")   return renderMultiPack(bitmap, spec, name);
    if (spec.style === "feature-card") return renderFeatureCard(bitmap, spec, name);
    const S = NICE_SIDE;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const card = paintNice(ctx, S, spec);
    const inset = S * 0.02;
    const aw = card.w - 2 * inset;
    const ah = card.h - 2 * inset;
    const fit = Math.min(aw / bitmap.width, ah / bitmap.height) * spec.scale;
    const dw = bitmap.width * fit;
    const dh = bitmap.height * fit;
    ctx.save();
    roundRect(ctx, card.x, card.y, card.w, card.h, card.r);
    ctx.clip();
    ctx.drawImage(bitmap, card.x + (card.w - dw) / 2, card.y + (card.h - dh) / 2, dw, dh);
    ctx.restore();
    if (spec.sticker) paintNiceSticker(ctx, S, spec);
    return toJpeg(canvas, name);
  }

  // ---- Buy 1 Get 1 Free promotional canvas (no AI needed) ----
  function renderB1G1(bitmap, spec, name) {
    const S = NICE_SIDE; // 1100
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, S, S);

    // ── Top red banner ──────────────────────────────────
    const bannerH = Math.round(S * 0.22);
    const grad = ctx.createLinearGradient(0, 0, S, 0);
    grad.addColorStop(0, "#b71c1c");
    grad.addColorStop(0.5, "#e53935");
    grad.addColorStop(1, "#b71c1c");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, bannerH);

    // Decorative yellow triangles on banner
    ctx.fillStyle = "#fdd835";
    for (const [bx, flip] of [[S * 0.05, 1], [S * 0.13, -1], [S * 0.87, 1], [S * 0.95, -1]]) {
      const ts = S * 0.06;
      ctx.beginPath();
      ctx.moveTo(bx, 4);
      ctx.lineTo(bx + ts * flip, 4);
      ctx.lineTo(bx + (ts / 2) * flip, ts * 0.9);
      ctx.closePath();
      ctx.fill();
    }

    // Banner text
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = `900 ${Math.round(S * 0.080)}px 'Arial Black', Arial, sans-serif`;
    ctx.fillText("BUY 1", S / 2, Math.round(bannerH * 0.31));
    ctx.fillStyle = "#fdd835";
    ctx.font = `900 ${Math.round(S * 0.098)}px 'Arial Black', Arial, sans-serif`;
    ctx.fillText("GET 1 FREE", S / 2, Math.round(bannerH * 0.73));

    // ── Product images ───────────────────────────────────
    const prodTop = bannerH + Math.round(S * 0.025);
    const labelH  = Math.round(S * 0.11);
    const labelTop = S - labelH;
    const prodAreaH = labelTop - prodTop - Math.round(S * 0.02);
    const halfW = Math.round(S / 2);
    const padX  = Math.round(S * 0.04);

    const maxPW = halfW - padX * 2 - Math.round(S * 0.025); // leave room for "+" circle
    const fit = Math.min(maxPW / bitmap.width, prodAreaH / bitmap.height) * 0.90;
    const dw = Math.round(bitmap.width * fit);
    const dh = Math.round(bitmap.height * fit);

    const lx = padX + Math.round((maxPW - dw) / 2);
    const imgY = prodTop + Math.round((prodAreaH - dh) / 2);
    // Left product (BUY)
    ctx.drawImage(bitmap, lx, imgY, dw, dh);
    // Right product (FREE)
    const rx = halfW + padX + Math.round((maxPW - dw) / 2) + Math.round(S * 0.025);
    ctx.drawImage(bitmap, rx, imgY, dw, dh);

    // ── "+" circle in centre ─────────────────────────────
    const plusR  = Math.round(S * 0.046);
    const plusCX = halfW;
    const plusCY = prodTop + Math.round(prodAreaH / 2);
    ctx.fillStyle = "#e53935";
    ctx.beginPath();
    ctx.arc(plusCX, plusCY, plusR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(S * 0.058)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+", plusCX, plusCY + 2);

    // ── Labels ───────────────────────────────────────────
    const lbW = Math.round(halfW * 0.68);
    const lbH = Math.round(labelH * 0.70);
    const lbR = Math.round(lbH / 2);
    const lbY = labelTop + Math.round((labelH - lbH) / 2);
    const fontSize = Math.round(S * 0.038);

    // Left: "1 PC (BUY)"
    const lb1X = Math.round(halfW / 2 - lbW / 2);
    ctx.fillStyle = "#e53935";
    roundRect(ctx, lb1X, lbY, lbW, lbH, lbR);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("1 PC (BUY)", halfW / 2, lbY + lbH / 2);

    // Right: "1 PC (FREE)"
    const lb2X = halfW + Math.round(halfW / 2 - lbW / 2);
    ctx.fillStyle = "#c62828";
    roundRect(ctx, lb2X, lbY, lbW, lbH, lbR);
    ctx.fill();
    ctx.fillStyle = "#fdd835";
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("1 PC (FREE)", halfW + halfW / 2, lbY + lbH / 2);

    return toJpeg(canvas, name);
  }

  // ---- Pack of N layout (2/3/4 product copies in a grid) ----
  function renderMultiPack(bitmap, spec, name) {
    const S = NICE_SIDE;
    const n = Math.min(4, productCtx.quantity || 2);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const { bg, accent } = spec.palette;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, Math.round(S * 0.06));
    ctx.fillRect(0, Math.round(S * 0.94), S, Math.round(S * 0.06));
    // "PACK OF N" badge
    const bdgW = Math.round(S * 0.36), bdgH = Math.round(S * 0.075);
    const bdgX = Math.round((S - bdgW) / 2), bdgY = Math.round(S * 0.01);
    ctx.fillStyle = accent;
    roundRect(ctx, bdgX, bdgY, bdgW, bdgH, bdgH / 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(S * 0.038)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`PACK OF ${n}`, bdgX + bdgW / 2, bdgY + bdgH / 2);
    // helper to draw one product copy
    const pad = Math.round(S * 0.04);
    const topY = Math.round(S * 0.09);
    const areaH = Math.round(S * 0.84);
    function drawItem(ix, iy, iw, ih) {
      const fit = Math.min(iw / bitmap.width, ih / bitmap.height) * 0.85;
      const dw = bitmap.width * fit, dh = bitmap.height * fit;
      ctx.drawImage(bitmap, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
    }
    if (n === 2) {
      const gap = Math.round(S * 0.03);
      const iw  = Math.round((S - pad * 2 - gap) / 2);
      drawItem(pad, topY, iw, areaH);
      drawItem(pad + iw + gap, topY, iw, areaH);
    } else if (n === 3) {
      const topH = Math.round(areaH * 0.52);
      const botH = areaH - topH - Math.round(S * 0.02);
      const gap  = Math.round(S * 0.025);
      const topW = Math.round(S * 0.52);
      drawItem(Math.round((S - topW) / 2), topY, topW, topH);
      const bw = Math.round((S - pad * 2 - gap) / 2);
      drawItem(pad, topY + topH + Math.round(S * 0.02), bw, botH);
      drawItem(pad + bw + gap, topY + topH + Math.round(S * 0.02), bw, botH);
    } else {
      const gap = Math.round(S * 0.025);
      const cw  = Math.round((S - pad * 2 - gap) / 2);
      const ch  = Math.round((areaH - gap) / 2);
      for (let i = 0; i < Math.min(n, 4); i++) {
        drawItem(pad + (i % 2) * (cw + gap), topY + Math.floor(i / 2) * (ch + gap), cw, ch);
      }
    }
    // bottom title
    if (productCtx.title) {
      ctx.fillStyle = "#444444";
      ctx.font = `${Math.round(S * 0.027)}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(productCtx.title.slice(0, 55), S / 2, Math.round(S * 0.965));
    }
    return toJpeg(canvas, name);
  }

  // ---- Feature card layout (product left, title + bullets right) ----
  function renderFeatureCard(bitmap, spec, name) {
    const S = NICE_SIDE;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const { bg, accent } = spec.palette;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, S, S);
    // right info panel
    const splitX  = Math.round(S * 0.56);
    const panelPad = Math.round(S * 0.033);
    ctx.fillStyle = bg;
    roundRect(ctx, splitX, panelPad, S - splitX - panelPad, S - panelPad * 2, Math.round(S * 0.04));
    ctx.fill();
    // product image left
    const imgW = splitX - panelPad * 2;
    const imgH = S - panelPad * 2;
    const fit  = Math.min(imgW / bitmap.width, imgH / bitmap.height) * 0.91;
    const dw = bitmap.width * fit, dh = bitmap.height * fit;
    ctx.drawImage(bitmap, panelPad + (imgW - dw) / 2, panelPad + (imgH - dh) / 2, dw, dh);
    // right panel content
    const rx = splitX + panelPad * 1.4;
    const rw = S - splitX - panelPad * 3;
    let cy = Math.round(S * 0.09);
    // accent top bar
    ctx.fillStyle = accent;
    roundRect(ctx, rx - 4, cy - Math.round(S * 0.008), rw + 8, Math.round(S * 0.007), 4);
    ctx.fill();
    cy += Math.round(S * 0.038);
    // title word-wrap
    if (productCtx.title) {
      ctx.fillStyle = accent;
      ctx.font = `bold ${Math.round(S * 0.034)}px Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const words = productCtx.title.split(" ");
      let line = "";
      for (const w of words) {
        const test = line ? line + " " + w : w;
        if (ctx.measureText(test).width > rw && line) {
          ctx.fillText(line, rx, cy); cy += Math.round(S * 0.043); line = w;
        } else line = test;
        if (cy > S * 0.38) break;
      }
      if (line) { ctx.fillText(line, rx, cy); cy += Math.round(S * 0.043); }
      cy += Math.round(S * 0.025);
    }
    // divider
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(rx, cy); ctx.lineTo(rx + rw, cy); ctx.stroke();
    ctx.globalAlpha = 1; cy += Math.round(S * 0.038);
    // feature bullets
    const feats = productCtx.features.length > 0
      ? productCtx.features
      : ["Premium Quality", "Durable & Long Lasting", "Easy to Clean", "Multipurpose Use"];
    for (const feat of feats.slice(0, 5)) {
      if (cy > S * 0.83) break;
      const bcy = cy + Math.round(S * 0.016);
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(rx + Math.round(S * 0.019), bcy, Math.round(S * 0.016), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.font = `bold ${Math.round(S * 0.018)}px Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("✓", rx + Math.round(S * 0.019), bcy);
      ctx.fillStyle = "#333333"; ctx.font = `${Math.round(S * 0.026)}px Arial, sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      const ftx = rx + Math.round(S * 0.044);
      const ftw = rw - Math.round(S * 0.044);
      let fl = "", fy = cy;
      for (const fw of feat.split(" ")) {
        const ft = fl ? fl + " " + fw : fw;
        if (ctx.measureText(ft).width > ftw && fl) { ctx.fillText(fl, ftx, fy); fy += Math.round(S * 0.030); fl = fw; } else fl = ft;
      }
      if (fl) ctx.fillText(fl, ftx, fy);
      cy = Math.max(fy + Math.round(S * 0.032), cy + Math.round(S * 0.052));
      cy += Math.round(S * 0.008);
    }
    return toJpeg(canvas, name);
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
    if (spec.mode === "nice") return renderNice(bitmap, spec, name);
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
    button:disabled{opacity:.5;cursor:not-allowed}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    label.row{flex-wrap:nowrap;align-items:flex-start}
    .muted{color:#666;font-size:12px}
    .err{color:#b00020;font-weight:600}
    .result{background:#e8f5e9;border:1px solid #1b8a3a;border-radius:8px;padding:8px;color:#1b5e20;font-weight:700;font-size:14px}
    .body{overflow-x:hidden}
    select{width:100%;max-width:100%;font-size:12px}
    .choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .choice{border:2px solid #eee;border-radius:8px;padding:4px;display:grid;gap:3px;text-align:center;font-size:11px;background:#fff}
    .choice.on{border-color:#1b8a3a;background:#e8f5e9}
    .choice img{width:100%;aspect-ratio:1;object-fit:contain;background:#fafafa;border-radius:4px;cursor:zoom-in}
    .choice .cost{font-size:14px;font-weight:700;color:#1b5e20}
    .choice button{padding:4px 2px;font-size:11px}
    .zoom{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;cursor:zoom-out}
    .zoom img{max-width:90vw;max-height:90vh;background:#fff}
    progress{width:100%}
    input[type=number]{width:52px}
    input[type=file]{font-size:11px;max-width:100%}
    textarea{width:100%;box-sizing:border-box;font:11px monospace}
    details summary{cursor:pointer;color:#9f2089;font-size:12px}
    details .card{margin-top:6px;background:#fafafa}
    ol{margin:0;padding-left:18px;font-size:12px;max-height:160px;overflow:auto}
    .hidden{display:none}
    .ctx-inp{width:100%;box-sizing:border-box;font:11px system-ui,sans-serif;padding:4px 6px;border:1px solid #ddd;border-radius:4px;margin-top:2px;color:#222}
    .ctx-inp:focus{outline:none;border-color:#9f2089}`;
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
  const version = chrome.runtime.getManifest?.().version;
  head.append(el("strong", `Meesho Shipping Optimizer${version ? ` v${version}` : ""}`), el("span", "–"));
  const body = el("div", null, "body");

  const tip = el("div", "Pehle Meesho form me category, weight aur price bhar do, aur front image laga do (taaki Shipping ₹ dikhe).", "muted");

  // ---- Product context card ----
  const productTitleInp = Object.assign(el("input", null, "ctx-inp"), { type: "text", placeholder: "e.g. Microfiber Towel Buy 1 Get 1 Free Orange Green" });
  const productDescInp  = Object.assign(el("textarea", null, "ctx-inp"), { placeholder: "Features (optional): Soft, 300GSM, Machine Washable, Car/Kitchen use...", rows: 2 });
  const ctxInfo = el("div", "Title/description se smart images banegi: pack/combo/B1G1 auto detect hoga.", "muted");
  const ctxCard = card(
    el("div", "📦 Product Title & Features (optional — smarter images banegi):", "muted"),
    productTitleInp, productDescInp, ctxInfo,
  );

  const btnHero = el("button", "1. Hero image ki shipping kam karo", "big");
  const heroFile = Object.assign(el("input"), { type: "file", accept: "image/jpeg,image/png,image/webp" });
  const triesInput = numInput(5, 80);
  const targetInput = numInput(0, 5000);
  const stickersBox = checkbox();
  const lookSelect = el("select");
  [["nice", "Look: Sundar (recommended)"], ["variety", "Look: Rang-birange (zyada variety)"]]
    .forEach(([v, t]) => { const o = el("option", t); o.value = v; lookSelect.append(o); });
  const btnPreview = el("button", "Pehle look dekho (upload nahi hoga)", "ghost");
  let previewSeed = null;

  const btnOthers = el("button", "2. Baaki photos banao / lagao", "big");
  const otherFiles = Object.assign(el("input"), { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true });
  const sameFrameBox = checkbox();
  const extrasModeSelect = el("select");
  [["make", "Meri asli photo se banao: angle, close-up, size/daily use"], ["asis", "Meri chuni photos waise hi lagao"]]
    .forEach(([v, t]) => { const o = el("option", t); o.value = v; extrasModeSelect.append(o); });
  const fourthSelect = el("select");
  [["size", "Chauthi photo: Size chart (bina AI)"], ["daily", "Chauthi photo: Daily use (AI, local tool chahiye)"]]
    .forEach(([v, t]) => { const o = el("option", t); o.value = v; fourthSelect.append(o); });
  const sizeL = numInput(1, 1000);
  const sizeW = numInput(1, 1000);
  const extrasBox = el("div", null, "choices");
  const btnUploadExtras = el("button", "Chuni hui photos Meesho par lagao");
  const extrasWrap = el("div", null, "hidden");
  extrasWrap.append(el("div", "Baaki photos preview (photo par click = badi dikhegi):", "muted"), extrasBox, btnUploadExtras);
  const aiBox = checkbox();
  const refreshPriceBox = checkbox();

  const btnStop = el("button", "Stop", "stop hidden");
  const progress = Object.assign(el("progress"), { max: 1, value: 0 });
  const status = el("div", "");
  const result = el("div", "", "result hidden");
  const choicesTitle = el("div", "Sabse sasti photos: jo pasand ho uspar 'Ye lagao' dabao (photo par click = badi dikhegi)", "muted hidden");
  const choices = el("div", null, "choices hidden");
  let choiceUrls = [];
  const btnDownload = el("button", "Sasti image download karo", "ghost hidden");
  const log = el("ol");

  const detectInfo = el("div", "", "muted");
  const btnPickHero = el("button", "Pick hero upload box", "ghost");
  const btnPickOther = el("button", "Pick other photos box", "ghost");
  const btnPickCost = el("button", "Pick shipping ₹", "ghost");
  const btnPickPrice = el("button", "Pick price box", "ghost");
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
  const btnReport = el("button", "Page report copy karo", "ghost");
  const reportBox = Object.assign(el("textarea", null, "hidden"), { readOnly: true, rows: 6 });

  const setup = el("details");
  setup.append(el("summary", "Setup (sirf agar auto-detect kaam na kare)"), card(
    detectInfo, row(btnPickHero, btnPickOther), row(btnPickCost, btnPickPrice, btnReset), row(methodSelect),
    labelled(refreshPriceBox, "Upload ke baad price dobara bhar ke shipping refresh karo"),
    row(el("span", "Min wait (sec):"), waitInput, el("span", "Step wait:"), stepWaitInput),
    el("div", "Agar image upload ke baad Meesho me Save / Done / Crop dabana padta hai, to '+ step' se wo button pick karo.", "muted"),
    stepsList, row(btnAddStep, btnClearSteps),
    el("div", "Kaam na kare to ye report copy karke developer ko bhejo (isme koi password/login nahi hota):", "muted"),
    btnReport, reportBox,
  ));

  body.append(
    tip, ctxCard,
    card(btnHero,
      el("div", "Page ki front image use hogi. Chaho to yahan alag photo chuno:", "muted"), heroFile,
      row(el("span", "Kul kitni photos try karein (5-80):"), triesInput),
      row(el("span", "Target shipping ₹:"), targetInput),
      el("div", "Itna ya isse kam shipping milte hi ruk jayega. 0 = saari photos try karo.", "muted"),
      lookSelect, btnPreview,
      labelled(stickersBox, "Badge bhi lagao (BESTSELLER / NEW) - Meesho QC kabhi reject kar sakta hai"),
      labelled(aiBox, "AI se alag photos bhi banao (local tool chalu hona chahiye)")),

    card(btnOthers,
      el("div", "Apne product ki ASLI photos chuno (1 ya zyada). 2nd photo = doosra angle, agar ho.", "muted"), otherFiles,
      extrasModeSelect, fourthSelect,
      row(el("span", "Size (cm): Lambaai"), sizeL, el("span", "Chaudaai"), sizeW),
      labelled(sameFrameBox, "Hero jaisa frame lagao (sirf 'waise hi' mode me)"),
      extrasWrap),
    row(btnStop, btnDownload), progress, status, result, choicesTitle, choices, log, setup,
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
      `Hero: ${heroInput() ? "box mil gaya" : changeLink(frontTile()) ? "CHANGE se" : "NAHI mila"} | Other photo box: ${otherInputs().length} | ` +
      `Shipping: ${cost !== null ? "₹" + cost : "nahi dikh raha"} | Price box: ${findPriceInput() ? "mil gaya" : "nahi mila"}`;
  }

  const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(v) || dflt));

  async function saveCfg() {
    cfg.tries = clamp(triesInput.value, 5, 80, 30);
    cfg.target = clamp(targetInput.value, 0, 5000, 0);
    triesInput.value = cfg.tries;
    targetInput.value = cfg.target;
    cfg.stickers = stickersBox.checked;
    cfg.look = lookSelect.value === "variety" ? "variety" : "nice";
    cfg.extrasMode = extrasModeSelect.value === "asis" ? "asis" : "make";
    cfg.fourth = fourthSelect.value === "daily" ? "daily" : "size";
    cfg.sameFrame = sameFrameBox.checked;
    cfg.useAI = aiBox.checked;
    cfg.refreshPrice = refreshPriceBox.checked;
    cfg.waitSec = clamp(waitInput.value, 3, 40, 6);
    cfg.stepWaitSec = clamp(stepWaitInput.value, 1, 20, 2);
    cfg.uploadMethod = methodSelect.value === "drop" ? "drop" : "input";
    await chrome.storage.local.set({ shipOptimizerCfg: cfg });
  }

  function setBusy(busy) {
    running = busy;
    [btnHero, btnOthers, btnPreview, btnUploadExtras, btnAddStep, btnPickHero, btnPickOther, btnPickCost, btnPickPrice].forEach((b) => { b.disabled = busy; });
    btnStop.disabled = false;
    btnStop.textContent = "Stop";
    btnStop.classList.toggle("hidden", !busy);
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
    if (!cfg.steps.length) return autoConfirm();
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

  // Meesho answers asynchronously and an old response can land first, so never take the first change:
  // wait a minimum time and require the value to stay unchanged for STABLE_MS.
  // priceRefreshed = true means refreshPrice() just ran, so we must ignore any reading for an
  // extra POST_REFRESH_WAIT_MS (Meesho's API may still be computing the new value).
  async function waitForCost(priceRefreshed = false) {
    const start = Date.now();
    const minWait = Math.max(MIN_READ_WAIT_MS, cfg.waitSec * 1000) + (priceRefreshed ? POST_REFRESH_WAIT_MS : 0);
    let last;
    let stableSince = start;
    while (Date.now() - start < MAX_WAIT_MS && !stopRequested) {
      await sleep(POLL_MS);
      const costEl = findCostEl();
      const text = costEl ? costEl.textContent.trim() : null;
      if (text !== last) { last = text; stableSince = Date.now(); }
      if (text !== null && Date.now() - start >= minWait && Date.now() - stableSince >= STABLE_MS) return parseCost(text);
    }
    return null;
  }

  const frontSrc = () => {
    const img = frontTile()?.querySelector("img");
    return img ? img.currentSrc || img.src : null;
  };

  const TEXT_INPUTS = "input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=search])";

  // Short label text near an input (MUI puts "Meesho Price" + "*" in sibling <p>s a few levels up).
  function fieldLabel(input) {
    const own = [input.name, input.id, input.placeholder, input.getAttribute("aria-label")].filter(Boolean).join(" ");
    for (let n = input.parentElement, depth = 0; n && n !== document.body && depth < 5; n = n.parentElement, depth++) {
      const text = ownText(n);
      if (text && text.length <= 80 && n.querySelectorAll(TEXT_INPUTS).length === 1) {
        if (/[a-z]/i.test(text)) return `${own} ${text}`.trim();
      } else if (n.querySelectorAll(TEXT_INPUTS).length > 1) break;
    }
    return own;
  }

  // Only the price text box: weight fields on Meesho are dropdowns and must not be cleared.
  const REFRESH_FIELD_RE = /meesho.?price|selling.?price/i;
  const MEESHO_PRICE_INPUT = "#meesho_price";

  function refreshInputs() {
    const picked = safeQuery(cfg.priceSelector) || document.querySelector(MEESHO_PRICE_INPUT);
    if (picked) return [picked.matches("input") ? picked : picked.querySelector("input")].filter((i) => i?.value);
    const found = [...document.querySelectorAll(TEXT_INPUTS)]
      .find((i) => !host.contains(i) && visible(i) && !i.disabled && i.value && REFRESH_FIELD_RE.test(fieldLabel(i)));
    return found ? [found] : [];
  }

  const findPriceInput = () => refreshInputs()[0] || null;

  // Meesho may only recalculate the breakdown when price/weight change: re-enter the same values.
  async function refreshPrice() {
    const inputs = refreshInputs();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const input of inputs) {
      const value = input.value;
      input.focus();
      for (const v of ["", value]) {
        setValue.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(300);
      }
      input.blur();
      input.dispatchEvent(new Event("focusout", { bubbles: true }));
      await sleep(300);
    }
    return inputs.length > 0;
  }

  async function tryHero(file) {
    const beforeSrc = frontSrc();
    // Always get a fresh input — Meesho creates a new file element each time CHANGE is clicked.
    let input = heroInput();
    if (!input && cfg.uploadMethod === "input") {
      input = await heroInputViaChange();
    }
    if (!input && cfg.uploadMethod === "input") throw new Error("Front image ka upload box nahi mila (CHANGE dabane par bhi). Setup me 'Page report copy karo' dabao aur report bhejo.");
    const uploaded = await putFiles(input, cfg.heroSelector, [file]);
    await runSteps();
    // Wait for front thumbnail src to change. Meesho can keep the same CDN URL for a moment,
    // so also accept if the src just changes to a blob: or data: URL (crop preview).
    let frontChanged = beforeSrc === null ? null : false;
    for (let t = 0; t < 16 && frontChanged === false; t++) {
      await sleep(POLL_MS);
      const cur = frontSrc();
      if (cur && cur !== beforeSrc) frontChanged = true;
    }
    const priceRefreshed = cfg.refreshPrice ? await refreshPrice() : false;
    const cost = await waitForCost(priceRefreshed);
    return { cost, uploaded, frontChanged };
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

  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Photo padh nahi paye"));
      reader.readAsDataURL(file);
    });
  }

  async function withKeepAlive(promise) {
    const timer = setInterval(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}), KEEPALIVE_MS);
    try { return await promise; } finally { clearInterval(timer); }
  }

  // Different-looking photos of the same product, made by the local tool's AI (Pollinations, key stays on the server).
  async function aiSources(original, max) {
    setStatus("AI se alag photos ban rahi hain (1-2 minute)...");
    try {
      const mime = /^image\/(jpeg|png|webp)$/.test(original.type) ? original.type : "image/jpeg";
      const { session, images, failed, failedReason } = await withKeepAlive(bg({ type: "aiVariants", b64: await fileToB64(original), mime, max }));
      const photos = [];
      for (const img of images) {
        const { b64 } = await bg({ type: "localImage", session, name: img.name });
        photos.push({ file: b64ToFile(b64, img.name, "image/jpeg"), label: img.label });
      }
      addLog(`AI: ${photos.length} alag photos bani${failed ? `, ${failed} fail${failedReason ? ` (${failedReason})` : ""}` : ""}`);
      return photos;
    } catch (err) {
      addLog(`AI photos nahi bani (${err.message}). Sirf border wali variations try hongi.`);
      return [];
    }
  }

  function showResult(text) {
    result.textContent = text;
    result.classList.remove("hidden");
  }

  function downloadFile(file, name) {
    const a = el("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function zoom(src) {
    const overlay = el("div", null, "zoom");
    overlay.append(Object.assign(el("img"), { src }));
    overlay.addEventListener("click", () => overlay.remove());
    root.append(overlay);
  }

  // Gallery of the cheapest images so the user can choose which one goes on the listing.
  const CHOICES_TITLE = "Sabse sasti photos: jo pasand ho uspar 'Ye lagao' dabao (photo par click = badi dikhegi)";

  function renderChoices(list, appliedFile, baseline, title = CHOICES_TITLE) {
    choicesTitle.textContent = title;
    choiceUrls.forEach((u) => URL.revokeObjectURL(u));
    choiceUrls = [];
    choices.replaceChildren();
    choices.classList.toggle("hidden", !list.length);
    choicesTitle.classList.toggle("hidden", !list.length);
    for (const item of list) {
      const url = URL.createObjectURL(item.file);
      choiceUrls.push(url);
      const shownCost = item.confirmed ?? item.cost;
      const costText = shownCost === undefined ? "Test nahi hua" : `₹${shownCost}`;
      const card = el("div", null, `choice${item.file === appliedFile ? " on" : ""}`);
      const img = Object.assign(el("img"), { src: url, alt: item.label, title: item.label });
      img.addEventListener("click", () => zoom(url));
      const apply = el("button", item.file === appliedFile ? "Laga hua hai" : "Ye lagao");
      const save = el("button", "Download", "ghost");
      apply.addEventListener("click", () => guarded(async () => {
        if (item.ai && !window.confirm("Ye AI ki banai photo hai. Isme product ka texture/size badla ho sakta hai ya ajeeb text aa sakta hai. Photo badi karke check kar li? Phir bhi lagayein?")) return;
        setStatus(`${item.label} laga rahe hain...`);
        const { cost } = await tryHero(item.file);
        if (cost !== null) item.confirmed = cost;
        winner = { ...item, cost: cost ?? shownCost ?? "?" };
        btnDownload.classList.remove("hidden");
        showResult(`Laga di: shipping ₹${winner.cost}${baseline ? `  (original ₹${baseline})` : ""}`);
        setStatus(`Laga di: ${item.label}. Ab form check karke khud Submit karo.`);
        renderChoices(list, item.file, baseline, title);
      }));
      save.addEventListener("click", () => downloadFile(item.file, shownCost === undefined ? `meesho_hero_${item.file.name}` : `meesho_hero_rs${shownCost}.jpg`));
      card.append(img, el("div", costText, "cost"),
        item.ai ? el("div", "AI ⚠ product/text check karo", "err") :
          el("div", item.confirmed !== undefined && item.confirmed !== item.cost ? `(pehli baar ₹${item.cost})` : item.confirmed !== undefined ? "confirm ✓" : " ", "muted"),
        apply, save);
      choices.append(card);
    }
  }

  // Shows how the first few variations will look, without uploading anything.
  async function previewLooks() {
    const source = heroFile.files[0] || await pageHeroFile();
    if (!source) throw new Error("Photo nahi mili. Upar 'Choose file' se hero photo chuno.");
    setStatus("Look bana rahe hain...");
    const bitmap = await createImageBitmap(source);
    previewSeed = Math.floor(Math.random() * 1e6);
    const list = [];
    for (let k = 0; k < MAX_CHOICES; k++) {
      const spec = variantSpec(k, previewSeed, cfg.stickers, cfg.look);
      list.push({ file: await renderVariant(bitmap, spec, `look_${k + 1}.jpg`), spec, label: `#${k + 1} ${specLabel(spec)}` });
    }
    bitmap.close();
    result.classList.add("hidden");
    renderChoices(list, null, null, "Look preview (abhi Meesho par test nahi hui). Photo par click = badi dikhegi. 'Ye lagao' = seedha laga ke shipping dekho.");
    setStatus("Ye pehli 6 photos ka look hai. Pasand aaye to '1. Hero image...' dabao (yahi look try honge), nahi to dobara 'Pehle look dekho' dabao.");
  }

  // ---------- flow 1: optimize hero ----------
  async function optimizeHero() {
    result.classList.add("hidden");
    renderChoices([], null);
    btnDownload.classList.add("hidden");
    log.replaceChildren();
    if (!heroInput() && !changeLink(frontTile()) && cfg.uploadMethod === "input") throw new Error("Front image nahi mili. Meesho ka catalog page kholo (jahan 'Front Image' dikhe), ya Setup me 'Pick hero upload box' karo.");

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
    if (cfg.refreshPrice) {
      const fields = refreshInputs().map((i) => fieldLabel(i).slice(0, 25));
      addLog(fields.length ? `Har upload ke baad ye dobara bharenge: ${fields.join(", ")}` : "Price/weight box nahi mila (Setup me 'Pick price box' karo)");
    }

    // The user's number is the total: AI photos count towards it, border variants fill the rest.
    const total = cfg.tries;
    const aiPhotos = cfg.useAI ? (await aiSources(original, total)).slice(0, total) : [];
    const bitmaps = [await createImageBitmap(original)];
    for (const p of aiPhotos) bitmaps.push(await createImageBitmap(p.file));
    const seed = previewSeed ?? Math.floor(Math.random() * 1e6);
    previewSeed = null;
    let best = { cost: baseline, file: original, spec: null, label: "Original" };
    const results = [];
    let lastFile = original;
    let readFails = 0;
    let notUploaded = 0;
    let notSaved = 0;
    let sameAsOriginal = 0;
    let stuck = false;
    progress.max = total;
    for (let i = 0; i < total && !stopRequested; i++) {
      // AI photos can redraw the product (texture/size) or garble text, so they are only offered in the
      // gallery for the user to judge; auto-apply only uses images built from the untouched original.
      let file, spec = null, label, ai = true;
      if (i < aiPhotos.length) {
        ({ file, label } = aiPhotos[i]);
      } else {
        const k = i - aiPhotos.length;
        const src = k % bitmaps.length;
        ai = src !== 0;
        spec = variantSpec(k, seed, cfg.stickers, cfg.look);
        label = `#${k + 1} ${ai ? `AI photo ${src} + ` : ""}${specLabel(spec)}`;
        file = await renderVariant(bitmaps[src], spec, `hero_${k + 1}.jpg`);
      }
      setStatus(`${i + 1}/${total} try ho rahi hai... (asli photo ka best ₹${best.cost})`);
      const { cost, uploaded, frontChanged } = await tryHero(file);
      lastFile = file;
      progress.value = i + 1;
      if (!uploaded) notUploaded++;
      if (frontChanged === false) notSaved++;
      const savedNote = frontChanged === false ? "  (front image NAHI badli)" : "";
      if (cost === null) {
        readFails++;
        addLog(`${label}: cost nahi padh paya${savedNote}`);
      } else {
        const mark = cost < best.cost ? (ai ? "  ← sasta par AI (khud check karo)" : "  ← naya best") : "";
        addLog(`${label}: ₹${cost}${mark}${savedNote}`);
        if (!ai && cost < best.cost) best = { cost, file, spec, label };
        if (cost < baseline) results.push({ cost, file, spec, label, ai });
        if (cost === baseline) sameAsOriginal++;
      }
      // Stuck: every reading so far matches baseline and price refresh should work
      if (i >= 2 && sameAsOriginal === i + 1 - readFails && findPriceInput() !== null) stuck = true;

      if (i === 2 && notUploaded === 3) throw new Error("Image upload nahi ho rahi (preview nahi badla). Setup me 'Upload: drag-drop' try karo ya 'Pick hero upload box' karo.");
      if (i === 2 && notSaved === 3) {
        addLog("Hint: Upload ke baad koi Save/Crop popup aa raha hoga. Setup me '+ Upload ke baad click step' dabao aur us button ko pick karo.");
        throw new Error("Image upload to hui par Front Image save nahi hui. Popup me jo button dabana padta hai (jaise Save/Crop), use Setup me '+ Upload ke baad click step' se pick karo, phir dobara chalao.");
      }
      if (i === 2 && readFails === 3) throw new Error("Shipping ₹ padh nahi pa rahe. Setup me 'Pick shipping ₹' karo.");
      // Warn early if ALL costs are same (likely not refreshing)
      if (i === 4 && stuck) addLog("Chetavni: Abhi tak sab costs same hain. 'Setup' me 'refreshPrice' on hai to check karo price box mil raha hai. Ya cost selector manually pick karo.");
      if (cfg.target && best.cost <= cfg.target) { addLog(`Target ₹${cfg.target} mil gaya, ruk gaye.`); break; }
    }
    bitmaps.forEach((b) => b.close());

    // Meesho's number for the same image is not always repeatable: re-upload the cheapest few and keep
    // the one that is cheapest on the second reading too.
    const wasStopped = stopRequested;
    stopRequested = false;
    const candidates = results.filter((r) => !r.ai).sort((a, b) => a.cost - b.cost).slice(0, wasStopped ? 1 : CONFIRM_TOP);
    let confirmed = null;
    for (const [n, c] of candidates.entries()) {
      setStatus(`Confirm kar rahe hain ${n + 1}/${candidates.length}: ${c.label} (pehle ₹${c.cost})...`);
      const { cost } = await tryHero(c.file);
      lastFile = c.file;
      addLog(`Confirm: ${c.label}: pehle ₹${c.cost}, ab ₹${cost ?? "?"}`);
      if (cost !== null) c.confirmed = cost;
      if (cost !== null && cost < baseline && (!confirmed || cost < confirmed.cost)) confirmed = { ...c, cost };
    }
    best = confirmed || { cost: baseline, file: original, spec: null, label: "Original" };
    const improved = best.file !== original;
    if (best.file !== lastFile) {
      setStatus(improved ? "Sabse sasti (confirm ki hui) image laga rahe hain..." : "Koi variation pakki sasti nahi nikli, original wapas laga rahe hain...");
      const final = (await tryHero(best.file)).cost;
      if (final !== null && final !== best.cost) {
        addLog(`Dhyan do: aakhri baar lagane par ₹${final} dikha (confirm me ₹${best.cost}).`);
        if (improved) best = { ...best, cost: final };
      }
    }
    winner = improved ? best : null;
    const shown = results.slice().sort((a, b) => (a.confirmed ?? a.cost) - (b.confirmed ?? b.cost)).slice(0, MAX_CHOICES);
    renderChoices(shown, improved ? best.file : null, baseline);
    if (improved) {
      const saved = baseline - best.cost;
      showResult(saved > 0
        ? `Pehle ₹${baseline} → Ab ₹${best.cost}  (₹${saved} bacha, confirm kiya)`
        : `Laga di ${best.label}, par aakhri reading ₹${best.cost} aayi (original ₹${baseline}).`);
      btnDownload.classList.remove("hidden");
      setStatus(saved > 0
        ? `Laga di: ${best.label}. Ab form check karke khud Submit karo.`
        : "Meesho ka shipping number har baar alag aa raha hai. Dobara chalao ya 'Sasti image download karo' se image rakh lo.", saved <= 0);
    } else {
      if (stuck) {
        showResult(`${total} alag images par bhi shipping ₹${baseline} hi raha.`);
        setStatus("Lagta hai Meesho shipping dobara calculate nahi kar raha. Setup me 'Look: Rang-birange (zyada variety)' try karo, ya price box check karo.", true);
      } else {

        showResult(`Original hi sabse sasta hai: ₹${baseline}`);
        setStatus(wasStopped ? "Roka gaya. Original wapas laga di." : "Dobara chalao (har baar naye colours try hote hain) ya 'Kitni try' badhao.");
      }
    }
  }

  // ---------- flow 2: other photos ----------
  // Photo 2 = another angle, photo 3 = close-up of the real texture, photo 4 = size chart or daily use.
  const EXTRA_SIDE = 1100;

  function squareCanvas() {
    const c = document.createElement("canvas");
    c.width = c.height = EXTRA_SIDE;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, EXTRA_SIDE, EXTRA_SIDE);
    return [c, ctx];
  }

  function drawContain(ctx, bitmap, x, y, w, h) {
    const fit = Math.min(w / bitmap.width, h / bitmap.height);
    const dw = bitmap.width * fit;
    const dh = bitmap.height * fit;
    ctx.drawImage(bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
  }

  async function cleanSquare(bitmap, name) {
    const [c, ctx] = squareCanvas();
    const m = EXTRA_SIDE * 0.04;
    drawContain(ctx, bitmap, m, m, EXTRA_SIDE - 2 * m, EXTRA_SIDE - 2 * m);
    return toJpeg(c, name);
  }

  // Real pixels only: a zoomed crop from the middle of the photo shows the actual fabric/finish.
  async function closeUp(bitmap, name, zoomPart = 0.42) {
    const [c, ctx] = squareCanvas();
    const side = Math.min(bitmap.width, bitmap.height) * zoomPart;
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, EXTRA_SIDE, EXTRA_SIDE);
    return toJpeg(c, name);
  }

  function arrow(ctx, x1, y1, x2, y2) {
    const head = EXTRA_SIDE * 0.02;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    for (const [x, y, a] of [[x1, y1, ang], [x2, y2, ang + Math.PI]]) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + head * Math.cos(a + 0.5), y + head * Math.sin(a + 0.5));
      ctx.moveTo(x, y);
      ctx.lineTo(x + head * Math.cos(a - 0.5), y + head * Math.sin(a - 0.5));
    }
    ctx.stroke();
  }

  async function sizeChart(bitmap, lengthCm, widthCm, name) {
    const [c, ctx] = squareCanvas();
    const S = EXTRA_SIDE;
    const box = drawContain(ctx, bitmap, S * 0.1, S * 0.08, S * 0.72, S * 0.72);
    ctx.strokeStyle = "#333333";
    ctx.fillStyle = "#333333";
    ctx.lineWidth = S * 0.004;
    ctx.font = `bold ${Math.round(S * 0.042)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const yLine = box.y + box.h + S * 0.06;
    arrow(ctx, box.x, yLine, box.x + box.w, yLine);
    ctx.fillText(`${lengthCm} cm`, box.x + box.w / 2, yLine + S * 0.05);
    const xLine = box.x + box.w + S * 0.05;
    arrow(ctx, xLine, box.y, xLine, box.y + box.h);
    ctx.save();
    ctx.translate(xLine + S * 0.05, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${widthCm} cm`, 0, 0);
    ctx.restore();
    return toJpeg(c, name);
  }

  const pageNumber = (sel) => {
    const v = Number(document.querySelector(sel)?.value);
    return Number.isFinite(v) && v > 0 ? v : "";
  };

  async function aiExtras(source, presets) {
    if (!presets.length) return {};
    setStatus("AI photo ban rahi hai (1-2 minute)...");
    try {
      const mime = /^image\/(jpeg|png|webp)$/.test(source.type) ? source.type : "image/jpeg";
      const { session, images } = await withKeepAlive(bg({ type: "aiVariants", b64: await fileToB64(source), mime, presets }));
      const out = {};
      for (const img of images) {
        const preset = presets.find((p) => img.name.startsWith(`ai_${p}_`));
        if (!preset || out[preset]) continue;
        const { b64 } = await bg({ type: "localImage", session, name: img.name });
        out[preset] = b64ToFile(b64, img.name, "image/jpeg");
      }
      return out;
    } catch (err) {
      addLog(`AI photo nahi bani: ${err.message}`);
      return {};
    }
  }

  let extras = [];
  let extraUrls = [];

  function renderExtras() {
    extraUrls.forEach((u) => URL.revokeObjectURL(u));
    extraUrls = [];
    extrasBox.replaceChildren();
    extrasWrap.classList.toggle("hidden", !extras.length);
    for (const item of extras) {
      const url = URL.createObjectURL(item.file);
      extraUrls.push(url);
      const img = Object.assign(el("img"), { src: url, alt: item.label, title: item.label });
      img.addEventListener("click", () => zoom(url));
      const use = Object.assign(checkbox(), { checked: item.use });
      use.addEventListener("change", () => { item.use = use.checked; });
      const save = el("button", "Download", "ghost");
      save.addEventListener("click", () => downloadFile(item.file, item.file.name));
      const card = el("div", null, "choice");
      card.append(img, el("div", item.label, "muted"), item.ai ? el("div", "AI ⚠ product check karo", "err") : el("div", "Asli photo se", "muted"),
        labelled(use, "Lagao"), save);
      extrasBox.append(card);
    }
  }

  async function buildExtras() {
    const real = [...otherFiles.files].slice(0, MAX_OTHER_PHOTOS);
    const source = real[0] || heroFile.files[0] || await pageHeroFile();
    if (!source) throw new Error("'2.' ke neeche apne product ki asli photo chuno (jaise table par rakhe towel ki photo).");
    if (/buy|get|free|offer/i.test(source.name)) addLog("Dhyan do: is photo me offer/banner ho sakta hai. Bina text wali asli photo do to close-up aur size chart saaf bananege.");
    const bitmaps = await Promise.all(real.map((f) => createImageBitmap(f)));
    const main = bitmaps[0] || await createImageBitmap(source);
    const needAI = [];
    if (!bitmaps[1] && cfg.useAI) needAI.push("angle-34");
    if (cfg.fourth === "daily" && cfg.useAI) needAI.push("lifestyle");
    const ai = await aiExtras(source, needAI);
    setStatus("Photos bana rahe hain...");
    extras = [];
    if (bitmaps[1]) extras.push({ label: "2. Doosra angle (aapki photo 2)", file: await cleanSquare(bitmaps[1], "photo2_angle.jpg"), use: true });
    else if (ai["angle-34"]) extras.push({ label: "2. Doosra angle (AI)", file: ai["angle-34"], use: false, ai: true });
    else addLog("Doosre angle ke liye product ki ek aur photo (side/peeche se) bhi chuno, ya 'AI se alag photos' tick karo.");
    extras.push({ label: "3. Close-up: asli texture", file: await closeUp(main, "photo3_closeup.jpg"), use: true });
    if (cfg.fourth === "daily" && ai.lifestyle) extras.push({ label: "4. Daily use (AI)", file: ai.lifestyle, use: false, ai: true });
    else {
      if (cfg.fourth === "daily") addLog("Daily use photo AI se nahi bani (local tool + 'AI se alag photos' chahiye), size chart bana diya.");
      const cm = (v) => (Number(v) > 0 ? Math.min(1000, Math.round(Number(v) * 10) / 10) : 0);
      const L = cm(sizeL.value);
      const W = cm(sizeW.value);
      if (L && W) extras.push({ label: "4. Size chart", file: await sizeChart(bitmaps[2] || main, L, W, "photo4_size.jpg"), use: true });
      else addLog("Size chart ke liye lambaai aur chaudaai (cm) bharo.");
    }
    bitmaps.forEach((b) => b.close());
    if (!bitmaps.length) main.close();
    renderExtras();
    setStatus("Neeche photos dekho. Jo chahiye un par 'Lagao' tick rakho, phir 'Chuni hui photos Meesho par lagao' dabao. AI wali photo khud check karke hi tick karna.");
  }

  async function addOtherPhotos() {
    if (cfg.extrasMode === "make") return buildExtras();
    const files = [...otherFiles.files].slice(0, MAX_OTHER_PHOTOS);
    if (!files.length) throw new Error("Pehle '2. Baaki photos' ke neeche photos chuno.");
    const prepared = [];
    for (const [i, f] of files.entries()) {
        // Simple upload for extra photos — does NOT wait for imageSources DOM change
  // (hero detection), just fires events + waits for Meesho to process.
  async function putFilesExtras(input, files) {
    if (!input) return false;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(1800);   // let Meesho react
    return true;
  }

  async function uploadChosenExtras() {
    const chosen = extras.filter((e) => e.use).map((e) => e.file);
    if (!chosen.length) throw new Error("Koi photo tick nahi hai.");
    if (extras.some((e) => e.use && e.ai))
      addLog("Dhyan do: AI wali photo bhi hai \u2014 Meesho par dikhne ke baad khud check karo.");
    await uploadExtras(chosen);
  }

  async function uploadExtras(prepared) {
    progress.max = prepared.length;
    progress.value = 0;
    let failed = 0;

    // Find the best input to use for extra photos.
    const getInput = () => {
      const known = document.querySelector(MEESHO_OTHER_INPUT); // #addMoreImagesInput
      if (known) return known;
      const picked = inputFromPicked(cfg.otherSelector);
      if (picked) return picked;
      const hero = heroInput();
      const tile = frontTile();
      return imageInputs().find((i) => i !== hero && !tile?.contains(i)) || null;
    };

    const first = getInput();
    if (!first && !safeQuery(cfg.otherSelector))
      throw new Error("Baaki photos ka upload box nahi mila. Setup me 'Pick other photos box' karo.");

    // Always upload one-by-one so each crop/save dialog can be handled.
    for (const [i, file] of prepared.entries()) {
      if (stopRequested) break;
      setStatus(`Photo ${i + 1}/${prepared.length} laga rahe hain...`);
      // Re-detect input each iteration (Meesho may recreate it after each upload).
      const inp = getInput() || first;
      const ok = await putFilesExtras(inp, [file]);
      await autoConfirm();    // handle crop/save popup if it appears
      await runSteps();       // run any custom click steps
      if (!ok) failed++;
      addLog(`Photo ${i + 1}: ${ok ? "upload kiya, Meesho par check karo" : "input nahi mila"}`);
      progress.value = i + 1;
      await sleep(800);
    }

    if (failed > 0 && failed === prepared.length) {
      setStatus("Photos upload nahi ho payi. Setup me 'Pick other photos box' se manually box select karo.", true);
    } else if (failed > 0) {
      setStatus(`${prepared.length - failed} photos upload ki, ${failed} fail. Page par check karo.`, true);
    } else {
      setStatus("Photos upload ki. Meesho page par dekho ki sab sahi hain, phir Submit karo.");
    }
  }
 (!ok) failed++;
        addLog(`Photo ${i + 1}: ${ok ? "lag gayi" : "preview nahi dikha, check karo"}`);
        progress.value = i + 1;
        await sleep(1000);
      }
    }
    if (failed) setStatus(`${failed} photo ka preview nahi dikha. Page par check karo, ya Setup me 'Pick other photos box' karo.`, true);
    else setStatus("Photos laga di. Form check karke Submit karo.");
  }

  function pageReport() {
    const short = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const tile = frontTile();
    const lines = [
      `path: ${location.pathname}`,
      `frontTile: ${tile ? short(tile.outerHTML.replace(/src="[^"]*"/g, 'src=".."'), 300) : "none"}`,
      `changeLink: ${changeLink(tile) ? cssPath(changeLink(tile)) : "none"}`,
      `heroInput: ${heroInput() ? cssPath(heroInput()) : "none"}`,
      `cost: ${readCost()} via ${findCostEl() ? cssPath(findCostEl()) : "none"}`,
      `costText: "${short(findCostEl()?.textContent, 200)}"`,
      `costParentText: "${short(findCostEl()?.parentElement?.textContent, 300)}"`,
      `breakdown: "${short([...document.querySelectorAll("body *")].find((n) => !host.contains(n) && n.children.length === 0 && /bank settlement/i.test(n.textContent))?.parentElement?.parentElement?.textContent, 600)}"`,
      `refreshInputs: ${refreshInputs().map((i) => `${cssPath(i)} [${short(fieldLabel(i), 40)}]`).join(" ; ") || "none"}`,
      "textInputs:",
      ...[...document.querySelectorAll(TEXT_INPUTS)].filter((i) => !host.contains(i) && visible(i)).slice(0, 30)
        .map((i) => ` - ${i.id ? `#${i.id}` : i.name || "?"} label="${short(fieldLabel(i), 50)}" value="${short(i.value, 15)}"`),
      "fileInputs:",
      ...[...document.querySelectorAll("input[type=file]")].map((i) =>
        ` - ${cssPath(i)} accept=${i.accept} multiple=${i.multiple} near="${short(i.parentElement?.parentElement?.textContent, 50)}"`),
      "rupeeTexts:",
      ...[...document.querySelectorAll("body *")].filter((n) => !host.contains(n) && n.children.length === 0 && n.textContent.includes("₹"))
        .slice(0, 25).map((n) => ` - "${short(n.parentElement?.parentElement?.textContent, 90)}"`),
      `dialogs: ${[...document.querySelectorAll(DIALOG_SEL)].filter(visible).map((d) => short(d.textContent, 60)).join(" || ") || "none"}`,
      `cfg: steps=${cfg.steps.length} method=${cfg.uploadMethod} picked=${[cfg.heroSelector, cfg.otherSelector, cfg.costSelector, cfg.priceSelector].map(Boolean)} refreshPrice=${cfg.refreshPrice} ai=${cfg.useAI}`,
      `priceInput: ${findPriceInput() ? cssPath(findPriceInput()) : "none"} frontSrc: ${short(frontSrc(), 60)}`,
      `buttons in dialogs: ${[...document.querySelectorAll(DIALOG_SEL)].filter(visible).flatMap((d) => [...d.querySelectorAll("button, [role=button]")]).map((b) => short(ownText(b), 25)).join(" | ") || "none"}`,
      "log:", ...[...log.children].slice(0, 15).map((li) => ` - ${li.textContent}`),
      `status: ${status.textContent}`,
    ];
    return lines.join("\n");
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
  btnPreview.addEventListener("click", () => guarded(previewLooks));
  lookSelect.addEventListener("change", () => { previewSeed = null; });
  btnOthers.addEventListener("click", () => {
    if (!otherFiles.files.length) { otherFiles.click(); return; }
    guarded(addOtherPhotos);
  });
  otherFiles.addEventListener("change", () => { if (otherFiles.files.length) guarded(addOtherPhotos); });
  btnUploadExtras.addEventListener("click", () => guarded(uploadChosenExtras));
  // Prefill the size chart from the product dimensions already typed in the Meesho form.
  const prefillSize = () => {
    if (!sizeL.value) sizeL.value = pageNumber("#product_length");
    if (!sizeW.value) sizeW.value = pageNumber("#product_breadth");
  };
  btnOthers.addEventListener("pointerdown", prefillSize);
  setTimeout(prefillSize, 2000);
  btnStop.addEventListener("click", () => {
    stopRequested = true;
    btnStop.disabled = true;
    btnStop.textContent = "Ruk raha hai...";
    setStatus("Rok rahe hain... (chalu wali image ka kaam khatam hote hi rukega)");
  });
  btnDownload.addEventListener("click", () => {
    if (winner) downloadFile(winner.file, `meesho_hero_rs${winner.cost}.jpg`);
  });
  btnPickHero.addEventListener("click", () => pick("Page par FRONT image upload box par click karo", (t) => {
    cfg.heroSelector = cssPath(t);
    setStatus("Hero upload box set ho gaya.");
  }));
  btnPickOther.addEventListener("click", () => pick("Page par baaki photos wale upload box par click karo", (t) => {
    cfg.otherSelector = cssPath(t);
    setStatus("Other photos box set ho gaya.");
  }));
  btnPickPrice.addEventListener("click", () => pick("Page par Meesho price wale box par click karo", (t) => {
    cfg.priceSelector = cssPath(t);
    setStatus("Price box set ho gaya.");
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
  btnReport.addEventListener("click", async () => {
    reportBox.value = pageReport();
    reportBox.classList.remove("hidden");
    reportBox.select();
    try {
      await navigator.clipboard.writeText(reportBox.value);
      setStatus("Report copy ho gayi. Chat me paste karke bhejo.");
    } catch {
      setStatus("Neeche ki report select karke Ctrl+C karo.");
    }
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
    cfg.priceSelector = "";
    await saveCfg();
    refreshDetect();
    setStatus("Auto-detect par wapas.");
  });
  [triesInput, targetInput, stickersBox, lookSelect, extrasModeSelect, fourthSelect, sameFrameBox, aiBox, refreshPriceBox, waitInput, stepWaitInput, methodSelect]
    .forEach((n) => n.addEventListener("change", saveCfg));
  // Re-parse product context whenever title or desc changes
  const onCtxChange = () => parseProductContext(productTitleInp.value, productDescInp.value);
  productTitleInp.addEventListener("input", onCtxChange);
  productDescInp.addEventListener("input", onCtxChange);

  chrome.storage.local.get("shipOptimizerCfg").then(({ shipOptimizerCfg }) => {
    Object.assign(cfg, shipOptimizerCfg || {});
    if (!Array.isArray(cfg.steps)) cfg.steps = [];
    triesInput.value = cfg.tries;
    targetInput.value = cfg.target;
    stickersBox.checked = cfg.stickers;
    lookSelect.value = cfg.look === "variety" ? "variety" : "nice";
    extrasModeSelect.value = cfg.extrasMode === "asis" ? "asis" : "make";
    fourthSelect.value = cfg.fourth === "daily" ? "daily" : "size";
    sameFrameBox.checked = cfg.sameFrame;
    aiBox.checked = cfg.useAI;
    refreshPriceBox.checked = cfg.refreshPrice;
    waitInput.value = cfg.waitSec;
    stepWaitInput.value = cfg.stepWaitSec;
    methodSelect.value = cfg.uploadMethod;
    renderSteps();
    refreshDetect();
  });
  setInterval(() => { if (!running) refreshDetect(); }, 3000);
})();
