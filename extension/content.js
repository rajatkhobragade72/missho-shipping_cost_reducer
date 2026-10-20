(() => {
  if (window.__shipTester) return;
  window.__shipTester = true;

  const POLL_MS = 500;
  const STABLE_MS = 2000;
  const MAX_WAIT_MS = 45000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = { uploadSelector: "", costSelector: "", waitSec: 8, gapSec: 3, onlyUntested: true };
  let running = false;
  let stopRequested = false;

  // ---------- messaging ----------
  async function bg(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error || "Extension error");
    return res.data;
  }

  // ---------- DOM detection ----------
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

  // ---------- panel UI (shadow DOM, textContent only) ----------
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box{width:320px;font:13px system-ui,sans-serif;background:#fff;color:#222;border:2px solid #9f2089;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.2)}
    .head{background:#9f2089;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
    .body{padding:8px 10px;display:grid;gap:6px;max-height:60vh;overflow:auto}
    button{background:#9f2089;color:#fff;border:0;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:12px}
    button:disabled{opacity:.5}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .muted{color:#666;font-size:12px}
    .err{color:#b00020}
    input[type=number]{width:52px}
    ol{margin:0;padding-left:18px;font-size:12px}
    .hidden{display:none}`;
  const box = document.createElement("div");
  box.className = "box";
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("strong");
  title.textContent = "Shipping Tester";
  const minBtn = document.createElement("span");
  minBtn.textContent = "–";
  head.append(title, minBtn);
  const body = document.createElement("div");
  body.className = "body";

  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const sessionInfo = el("div", "Images load nahi hui", "muted");
  const detectInfo = el("div", "", "muted");
  const status = el("div", "");
  const log = el("ol");

  const btnRefresh = el("button", "Images refresh");
  const btnPickUpload = el("button", "Pick upload box");
  const btnPickCost = el("button", "Pick shipping cost");
  const btnReset = el("button", "Auto-detect");
  const btnStart = el("button", "Test all images");
  const btnStop = el("button", "Stop");
  btnStop.disabled = true;

  const waitInput = Object.assign(el("input"), { type: "number", min: 3, max: 40 });
  const gapInput = Object.assign(el("input"), { type: "number", min: 1, max: 60 });
  const onlyNew = Object.assign(el("input"), { type: "checkbox" });

  const rowSetup = el("div", null, "row");
  rowSetup.append(btnPickUpload, btnPickCost, btnReset);
  const rowTiming = el("div", null, "row");
  rowTiming.append(el("span", "Wait (sec):"), waitInput, el("span", "Gap:"), gapInput);
  const rowOnly = el("label", null, "row");
  rowOnly.append(onlyNew, el("span", "Sirf jinka Meesho cost nahi hai"));
  const rowRun = el("div", null, "row");
  rowRun.append(btnRefresh, btnStart, btnStop);
  const help = el("div", "Pehle catalogue form me category, weight, price bhar do taaki shipping dikhne lage. Phir 'Test all images' dabao.", "muted");

  body.append(help, sessionInfo, detectInfo, rowSetup, rowTiming, rowOnly, rowRun, status, log);
  box.append(head, body);
  root.append(style, box);
  document.documentElement.appendChild(host);

  head.addEventListener("click", () => body.classList.toggle("hidden"));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle") host.style.display = host.style.display === "none" ? "" : "none";
  });

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.className = isError ? "err" : "";
  }

  function addLog(text) {
    const li = el("li", text);
    log.prepend(li);
    while (log.children.length > 40) log.lastChild.remove();
  }

  function refreshDetect() {
    const input = findFileInput();
    const costEl = findCostEl();
    const cost = costEl ? parseCost(costEl.textContent) : null;
    detectInfo.textContent =
      `Upload box: ${input ? "mil gaya" : "NAHI mila"}${cfg.uploadSelector ? " (picked)" : " (auto)"} | ` +
      `Shipping: ${cost !== null ? "₹" + cost : "NAHI mila"}${cfg.costSelector ? " (picked)" : " (auto)"}`;
  }

  async function saveCfg() {
    cfg.waitSec = Math.min(40, Math.max(3, Number(waitInput.value) || 8));
    cfg.gapSec = Math.min(60, Math.max(1, Number(gapInput.value) || 3));
    cfg.onlyUntested = onlyNew.checked;
    await chrome.storage.local.set({ shipTesterCfg: cfg });
  }

  // ---------- picker ----------
  function pick(kind) {
    setStatus(kind === "upload"
      ? "Ab page par front image upload box par click karo (Esc = cancel)"
      : "Ab page par shipping charge (₹) wale hisse par click karo (Esc = cancel)");
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
      cfg[kind === "upload" ? "uploadSelector" : "costSelector"] = cssPath(e.target);
      await saveCfg();
      done();
      setStatus(kind === "upload" ? "Upload box set ho gaya." : "Shipping cost wala hissa set ho gaya.");
    };
    const key = (e) => {
      if (e.key === "Escape") { done(); setStatus("Cancel kiya."); }
    };
    document.addEventListener("mouseover", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  }

  // ---------- run ----------
  let latest = null;

  async function loadLatest() {
    latest = await bg({ type: "latest" });
    const tested = Object.values(latest.costs || {}).filter((c) => c.source === "meesho").length;
    sessionInfo.textContent = `Tool session ${latest.session.slice(0, 6)}…: ${latest.images.length} images, ${tested} ka Meesho cost mil chuka`;
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

  function fileFromB64(b64, name) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: "image/jpeg" });
  }

  async function run() {
    await saveCfg();
    running = true;
    stopRequested = false;
    btnStart.disabled = true;
    btnStop.disabled = false;
    try {
      await loadLatest();
      const costs = latest.costs || {};
      const queue = latest.images.filter((img) => !cfg.onlyUntested || costs[img.name]?.source !== "meesho");
      if (!queue.length) { setStatus("Sab images ka cost pehle se hai."); return; }
      for (let i = 0; i < queue.length && !stopRequested; i++) {
        const img = queue[i];
        setStatus(`${i + 1}/${queue.length}: ${img.label} upload ho rahi hai...`);
        const input = findFileInput();
        if (!input) throw new Error("Upload box nahi mila. 'Pick upload box' se set karo.");
        const prevEl = findCostEl();
        const prevText = prevEl ? prevEl.textContent.trim() : null;
        const { b64 } = await bg({ type: "image", session: latest.session, name: img.name });
        const dt = new DataTransfer();
        dt.items.add(fileFromB64(b64, img.name));
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        const result = await waitForCost(prevText, cfg.waitSec * 1000);
        const cost = result ? parseCost(result.text) : null;
        if (cost === null) {
          addLog(`${img.label}: cost nahi padh paya`);
        } else {
          await bg({ type: "cost", session: latest.session, name: img.name, cost });
          addLog(`${img.label}: ₹${cost}${result.changed ? "" : " (pichhli image jaisa, check karo)"}`);
        }
        refreshDetect();
        if (i < queue.length - 1) await sleep(cfg.gapSec * 1000);
      }
      setStatus(stopRequested ? "Roka gaya." : "Ho gaya! Tool me har image par cost dikh raha hoga.");
      await loadLatest();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      running = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
    }
  }

  btnPickUpload.addEventListener("click", () => pick("upload"));
  btnPickCost.addEventListener("click", () => pick("cost"));
  btnReset.addEventListener("click", async () => {
    cfg.uploadSelector = "";
    cfg.costSelector = "";
    await saveCfg();
    refreshDetect();
    setStatus("Auto-detect par wapas.");
  });
  btnRefresh.addEventListener("click", () => loadLatest().then(() => setStatus("")).catch((e) => setStatus(e.message, true)));
  btnStart.addEventListener("click", () => { if (!running) run(); });
  btnStop.addEventListener("click", () => { stopRequested = true; setStatus("Rok rahe hain..."); });
  [waitInput, gapInput, onlyNew].forEach((n) => n.addEventListener("change", saveCfg));

  chrome.storage.local.get("shipTesterCfg").then(({ shipTesterCfg }) => {
    Object.assign(cfg, shipTesterCfg || {});
    waitInput.value = cfg.waitSec;
    gapInput.value = cfg.gapSec;
    onlyNew.checked = cfg.onlyUntested;
    refreshDetect();
  });
  setInterval(() => { if (!running) refreshDetect(); }, 3000);
  loadLatest().catch((e) => setStatus(e.message, true));
})();
