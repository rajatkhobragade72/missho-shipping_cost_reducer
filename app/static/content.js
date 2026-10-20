(() => {
  if (window.__shipTester) return;
  window.__shipTester = true;

  const POLL_MS = 500;
  const STABLE_MS = 2000;
  const MAX_WAIT_MS = 45000;
  const STEP_TIMEOUT_MS = 15000;
  const UPLOAD_CHECK_MS = 6000;
  const KEEPALIVE_MS = 20000;
  const MAX_STEPS = 6;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = {
    uploadSelector: "",
    costSelector: "",
    uploadMethod: "input",
    steps: [],
    waitSec: 8,
    gapSec: 3,
    stepWaitSec: 2,
    onlyUntested: true,
    applyBest: true,
  };
  let running = false;
  let stopRequested = false;
  let latest = null;

  // ---------- messaging ----------
  async function bg(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error || "Extension error");
    return res.data;
  }

  async function withKeepAlive(promise) {
    const timer = setInterval(() => chrome.runtime.sendMessage({ type: "ping" }).catch(() => {}), KEEPALIVE_MS);
    try { return await promise; } finally { clearInterval(timer); }
  }

  // ---------- DOM helpers ----------
  function cssPath(el) {
    const parts = [];
    let rootedAtId = false;
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
        parts.unshift(`#${el.id}`);
        rootedAtId = true;
        break;
      }
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${i})`);
      el = el.parentElement;
    }
    return (rootedAtId ? "" : "body > ") + parts.join(" > ");
  }

  function safeQuery(selector) {
    try { return selector ? document.querySelector(selector) : null; } catch { return null; }
  }

  function describe(el) {
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.tagName).trim().replace(/\s+/g, " ");
    return text.slice(0, 30) || el.tagName.toLowerCase();
  }

  function findFileInput() {
    const picked = safeQuery(cfg.uploadSelector);
    if (picked) {
      if (picked.matches("input[type=file]")) return picked;
      for (let el = picked; el && el !== document.body; el = el.parentElement) {
        const inner = el.querySelector("input[type=file]");
        if (inner) return inner;
      }
    }
    const inputs = [...document.querySelectorAll("input[type=file]")];
    return inputs.find((i) => /image|jpe?g|png/i.test(i.accept || "")) || inputs[0] || null;
  }

  function findDropTarget() {
    const picked = safeQuery(cfg.uploadSelector);
    if (picked) return picked;
    const input = findFileInput();
    return input?.closest("label") || input?.parentElement || null;
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
      for (let el = node.parentElement, depth = 0; el && depth < 5; el = el.parentElement, depth++) {
        const text = el.textContent || "";
        if (text.length > 200) break;
        if (/shipping/i.test(text) && PRICE_RE.test(text)) {
          if (!best || text.length < best.textContent.length) best = el;
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

  function imageSources() {
    return new Set([...document.images].map((i) => i.currentSrc || i.src).filter(Boolean));
  }

  // ---------- panel UI (shadow DOM, textContent only) ----------
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box{width:340px;font:13px system-ui,sans-serif;background:#fff;color:#222;border:2px solid #9f2089;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.2)}
    .head{background:#9f2089;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
    .body{padding:8px 10px;display:grid;gap:6px;max-height:70vh;overflow:auto}
    .sec{border-top:1px solid #eee;padding-top:6px;display:grid;gap:5px}
    .sec h4{margin:0;font-size:12px;color:#9f2089}
    button{background:#9f2089;color:#fff;border:0;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:12px}
    button.ghost{background:#eee;color:#333}
    button:disabled{opacity:.5;cursor:wait}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .muted{color:#666;font-size:12px}
    .err{color:#b00020}
    .ok{color:#1b8a3a;font-weight:600}
    input[type=number]{width:46px}
    ol{margin:0;padding-left:18px;font-size:12px}
    .hidden{display:none}`;
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const row = (...children) => { const r = el("div", null, "row"); r.append(...children); return r; };
  const section = (title, ...children) => { const s = el("div", null, "sec"); s.append(el("h4", title), ...children); return s; };

  const box = el("div", null, "box");
  const head = el("div", null, "head");
  head.append(el("strong", "Shipping Tester"), el("span", "–"));
  const body = el("div", null, "body");

  // section 1: new photo
  const photoInput = Object.assign(el("input"), { type: "file", accept: "image/jpeg,image/png,image/webp" });
  const btnGenerate = el("button", "Variations banao + test karo");

  // section 2: setup
  const detectInfo = el("div", "", "muted");
  const btnPickUpload = el("button", "Pick upload box", "ghost");
  const btnPickCost = el("button", "Pick shipping cost", "ghost");
  const btnReset = el("button", "Auto-detect", "ghost");
  const methodSelect = el("select");
  [["input", "Upload: file input"], ["drop", "Upload: drag-drop"]].forEach(([v, t]) => {
    const o = el("option", t);
    o.value = v;
    methodSelect.append(o);
  });
  const stepsList = el("ol");
  const btnAddStep = el("button", "+ Upload ke baad click step", "ghost");
  const btnClearSteps = el("button", "Steps clear", "ghost");
  const btnTestOne = el("button", "1 image try karo", "ghost");

  // section 3: run
  const sessionInfo = el("div", "Images load nahi hui", "muted");
  const waitInput = Object.assign(el("input"), { type: "number", min: 3, max: 40 });
  const gapInput = Object.assign(el("input"), { type: "number", min: 1, max: 60 });
  const stepWaitInput = Object.assign(el("input"), { type: "number", min: 1, max: 20 });
  const onlyNew = Object.assign(el("input"), { type: "checkbox" });
  const applyBest = Object.assign(el("input"), { type: "checkbox" });
  const btnRefresh = el("button", "Refresh", "ghost");
  const btnStart = el("button", "Test all images");
  const btnStop = el("button", "Stop", "ghost");
  btnStop.disabled = true;
  const bestInfo = el("div", "", "ok");
  const btnApplyBest = el("button", "Sabse sasti image lagao");
  btnApplyBest.disabled = true;
  const status = el("div", "");
  const log = el("ol");

  const onlyLabel = el("label", null, "row");
  onlyLabel.append(onlyNew, el("span", "Sirf jinka Meesho cost nahi hai"));
  const applyLabel = el("label", null, "row");
  applyLabel.append(applyBest, el("span", "End me sabse sasti image form me laga do"));

  body.append(
    section("1. Nayi product photo", el("div", "Photo chuno: tool variations banayega, phir sab Meesho par test hongi.", "muted"),
      photoInput, btnGenerate),
    section("2. Setup (pehli baar)", el("div", "Pehle form me category, weight, price bhar do taaki shipping dikhe. Agar Meesho upload ke baad Save / Done / Price breakdown dabana padta hai, to '+ step' se un buttons ko order me pick karo.", "muted"),
      detectInfo, row(btnPickUpload, btnPickCost, btnReset), row(methodSelect),
      stepsList, row(btnAddStep, btnClearSteps, btnTestOne)),
    section("3. Test", sessionInfo,
      row(el("span", "Wait:"), waitInput, el("span", "Gap:"), gapInput, el("span", "Step wait:"), stepWaitInput),
      onlyLabel, applyLabel, row(btnRefresh, btnStart, btnStop), bestInfo, btnApplyBest),
    status, log,
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
    while (log.children.length > 50) log.lastChild.remove();
  }

  function renderSteps() {
    stepsList.replaceChildren(...cfg.steps.map((s) => el("li", `Click: ${s.label}`)));
    if (!cfg.steps.length) stepsList.append(el("li", "Koi step nahi (sirf upload)"));
  }

  function refreshDetect() {
    const input = findFileInput();
    const costEl = findCostEl();
    const cost = costEl ? parseCost(costEl.textContent) : null;
    detectInfo.textContent =
      `Upload box: ${input ? "mil gaya" : "NAHI mila"}${cfg.uploadSelector ? " (picked)" : " (auto)"} | ` +
      `Shipping: ${cost !== null ? "₹" + cost : "abhi nahi dikh raha"}${cfg.costSelector ? " (picked)" : " (auto)"}`;
  }

  async function saveCfg() {
    cfg.waitSec = Math.min(40, Math.max(3, Number(waitInput.value) || 8));
    cfg.gapSec = Math.min(60, Math.max(1, Number(gapInput.value) || 3));
    cfg.stepWaitSec = Math.min(20, Math.max(1, Number(stepWaitInput.value) || 2));
    cfg.onlyUntested = onlyNew.checked;
    cfg.applyBest = applyBest.checked;
    cfg.uploadMethod = methodSelect.value === "drop" ? "drop" : "input";
    await chrome.storage.local.set({ shipTesterCfg: cfg });
  }

  function setBusy(busy) {
    running = busy;
    [btnStart, btnGenerate, btnTestOne, btnApplyBest, btnAddStep].forEach((b) => { b.disabled = busy; });
    btnStop.disabled = !busy;
    if (!busy) updateBest();
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
      if (host.contains(e.target)) return;
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
  function fileFromB64(b64, name) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: "image/jpeg" });
  }

  async function putImage(img) {
    const { b64 } = await bg({ type: "image", session: latest.session, name: img.name });
    const file = fileFromB64(b64, img.name);
    const dt = new DataTransfer();
    dt.items.add(file);
    const before = imageSources();
    if (cfg.uploadMethod === "drop") {
      const target = findDropTarget();
      if (!target) throw new Error("Upload box nahi mila. 'Pick upload box' se set karo.");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    } else {
      const input = findFileInput();
      if (!input) throw new Error("Upload box nahi mila. 'Pick upload box' se set karo.");
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

  async function waitForCost(prevText, minWaitMs) {
    const start = Date.now();
    let last;
    let stableSince = start;
    while (Date.now() - start < MAX_WAIT_MS && !stopRequested) {
      await sleep(POLL_MS);
      const costEl = findCostEl();
      const text = costEl ? costEl.textContent.trim() : null;
      if (text !== last) { last = text; stableSince = Date.now(); }
      const elapsed = Date.now() - start;
      const changed = text !== null && text !== prevText;
      if (text !== null && Date.now() - stableSince >= STABLE_MS && (changed || elapsed >= minWaitMs)) {
        return { text, changed };
      }
    }
    return null;
  }

  async function testImage(img) {
    const prevEl = findCostEl();
    const prevText = prevEl ? prevEl.textContent.trim() : null;
    const uploaded = await putImage(img);
    await runSteps();
    const result = await waitForCost(prevText, cfg.waitSec * 1000);
    const cost = result ? parseCost(result.text) : null;
    const note = uploaded ? "" : " [preview nahi badla: upload hua? method badal ke dekho]";
    if (cost === null) {
      addLog(`${img.label}: cost nahi padh paya${note}`);
      return null;
    }
    await bg({ type: "cost", session: latest.session, name: img.name, cost });
    addLog(`${img.label}: ₹${cost}${result.changed ? "" : " (pichhli jaisa)"}${note}`);
    return { cost, uploaded, changed: result.changed };
  }

  // ---------- flows ----------
  async function loadLatest() {
    latest = await bg({ type: "latest" });
    const tested = Object.values(latest.costs || {}).filter((c) => c.source === "meesho").length;
    sessionInfo.textContent = `Tool session ${latest.session.slice(0, 6)}…: ${latest.images.length} images, ${tested} ka Meesho cost mil chuka`;
    updateBest();
  }

  function bestImage() {
    if (!latest) return null;
    let best = null;
    for (const img of latest.images) {
      const c = latest.costs?.[img.name];
      if (c?.source === "meesho" && (!best || c.cost < best.cost)) best = { ...img, cost: c.cost };
    }
    return best;
  }

  function updateBest() {
    const best = bestImage();
    bestInfo.textContent = best ? `Sabse sasti: ${best.label} → ₹${best.cost}` : "";
    btnApplyBest.disabled = running || !best;
  }

  async function applyBestImage() {
    const best = bestImage();
    if (!best) return;
    setStatus(`Sabse sasti image (₹${best.cost}) form me laga rahe hain...`);
    await putImage(best);
    await runSteps();
    setStatus(`Laga di: ${best.label} (₹${best.cost}). Ab form check karke khud Submit karo.`);
  }

  async function testAll() {
    await loadLatest();
    const costs = latest.costs || {};
    const queue = latest.images.filter((img) => !cfg.onlyUntested || costs[img.name]?.source !== "meesho");
    if (!queue.length) { setStatus("Sab images ka cost pehle se hai."); return; }
    let unchanged = 0;
    let notUploaded = 0;
    for (let i = 0; i < queue.length && !stopRequested; i++) {
      setStatus(`${i + 1}/${queue.length}: ${queue[i].label} test ho rahi hai...`);
      const r = await testImage(queue[i]);
      if (r && !r.changed) unchanged++;
      if (r && !r.uploaded && !r.changed) notUploaded++;
      if (i < queue.length - 1) await sleep(cfg.gapSec * 1000);
    }
    await loadLatest();
    if (stopRequested) { setStatus("Roka gaya."); return; }
    if (notUploaded >= 2) {
      setStatus("Kai images ka preview nahi badla: upload nahi ho rahi. 'Upload: drag-drop' try karo ya upload box dobara pick karo.", true);
      return;
    }
    if (unchanged >= 2 && unchanged === queue.length - 1) {
      setStatus("Har image par cost same aaya. Ya to Meesho ko Save/Update chahiye ('+ step' add karo), ya cost image se nahi, weight/size se aa raha hai.", true);
      return;
    }
    if (cfg.applyBest) await applyBestImage();
    else setStatus("Ho gaya! Tool me har image par cost dikh raha hoga.");
  }

  async function guarded(fn) {
    if (running) return;
    await saveCfg();
    stopRequested = false;
    setBusy(true);
    try { await fn(); } catch (err) { setStatus(err.message, true); } finally { setBusy(false); }
  }

  function readFileB64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Photo padh nahi paye"));
      reader.readAsDataURL(file);
    });
  }

  // ---------- events ----------
  btnGenerate.addEventListener("click", () => guarded(async () => {
    const file = photoInput.files[0];
    if (!file) throw new Error("Pehle photo chuno.");
    setStatus("Photo tool me bhej rahe hain...");
    const hero = await bg({ type: "hero", b64: await readFileB64(file), mime: file.type });
    setStatus(`${hero.variants.length} variations bani. AI images ban rahi hain (1-2 minute)...`);
    const aiResult = await withKeepAlive(bg({ type: "ai", session: hero.session }));
    addLog(aiResult.skipped ? "AI band hai (.env me key nahi), sirf basic variations" : `AI: ${aiResult.variants.length} images bani`);
    await testAll();
  }));
  btnPickUpload.addEventListener("click", () => pick("Page par front image upload box par click karo", (t) => {
    cfg.uploadSelector = cssPath(t);
    setStatus("Upload box set ho gaya.");
  }));
  btnPickCost.addEventListener("click", () => pick("Page par 'Shipping ₹...' wale hisse par click karo", (t) => {
    cfg.costSelector = cssPath(t);
    setStatus("Shipping cost wala hissa set ho gaya.");
  }));
  btnAddStep.addEventListener("click", () => {
    if (cfg.steps.length >= MAX_STEPS) { setStatus(`Max ${MAX_STEPS} steps.`, true); return; }
    pick("Jo button upload ke baad dabana hota hai (Done / Save / Price breakdown) us par click karo", (t) => {
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
    cfg.uploadSelector = "";
    cfg.costSelector = "";
    await saveCfg();
    refreshDetect();
    setStatus("Auto-detect par wapas.");
  });
  btnTestOne.addEventListener("click", () => guarded(async () => {
    await loadLatest();
    const img = latest.images[0];
    if (!img) throw new Error("Tool me koi image nahi hai.");
    setStatus(`Try: ${img.label}`);
    const r = await testImage(img);
    setStatus(r ? `Try ho gaya: ₹${r.cost}. Upload ${r.uploaded ? "dikha" : "NAHI dikha"}.` : "Cost nahi padh paya.", !r || !r.uploaded);
  }));
  btnRefresh.addEventListener("click", () => loadLatest().then(() => setStatus("")).catch((e) => setStatus(e.message, true)));
  btnStart.addEventListener("click", () => guarded(testAll));
  btnApplyBest.addEventListener("click", () => guarded(applyBestImage));
  btnStop.addEventListener("click", () => { stopRequested = true; setStatus("Rok rahe hain..."); });
  [waitInput, gapInput, stepWaitInput, onlyNew, applyBest, methodSelect].forEach((n) => n.addEventListener("change", saveCfg));

  chrome.storage.local.get("shipTesterCfg").then(({ shipTesterCfg }) => {
    Object.assign(cfg, shipTesterCfg || {});
    if (!Array.isArray(cfg.steps)) cfg.steps = [];
    waitInput.value = cfg.waitSec;
    gapInput.value = cfg.gapSec;
    stepWaitInput.value = cfg.stepWaitSec;
    onlyNew.checked = cfg.onlyUntested;
    applyBest.checked = cfg.applyBest;
    methodSelect.value = cfg.uploadMethod;
    renderSteps();
    refreshDetect();
  });
  setInterval(() => { if (!running) refreshDetect(); }, 3000);
  loadLatest().catch((e) => setStatus(e.message, true));
})();
