const $ = (id) => document.getElementById(id);
const state = {
  session: null, variants: [], costs: {}, chosen: null, extras: [], defaultExtraStyle: null,
};

async function postForm(url, formData) {
  const res = await fetch(url, { method: "POST", body: formData });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Request failed");
  return body;
}

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function target() { return Number($("target").value) || 40; }

function costOf(name) { return state.costs[name]?.cost; }

async function refreshCosts() {
  if (!state.session) return;
  const session = state.session;
  const res = await fetch(`/api/costs/${session}`).catch(() => null);
  if (!res || !res.ok || session !== state.session) return;
  const costs = await res.json();
  if (JSON.stringify(costs) === JSON.stringify(state.costs)) return;
  state.costs = costs;
  if (!document.activeElement?.classList.contains("cost")) renderGrid();
}

async function setManualCost(name, value) {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || n < 0) {
    await fetch(`/api/costs/${state.session}/${encodeURIComponent(name)}`, { method: "DELETE" });
  } else {
    await fetch("/api/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: state.session, name, cost: n, source: "manual" }),
    });
  }
  await refreshCosts();
}

setInterval(refreshCosts, 4000);

function sortedVariants() {
  return state.variants
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const ca = costOf(a.v.name), cb = costOf(b.v.name);
      const ha = ca !== undefined, hb = cb !== undefined;
      if (ha !== hb) return ha ? -1 : 1;
      if (ha && ca !== cb) return ca - cb;
      return a.i - b.i;
    })
    .map(({ v }) => v);
}

function renderGrid() {
  const grid = $("grid");
  const tpl = $("card-template");
  const sorted = sortedVariants();
  const bestName = costOf(sorted[0]?.name) !== undefined ? sorted[0].name : null;
  grid.replaceChildren();
  sorted.forEach((v, i) => {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const cost = costOf(v.name);
    const isBest = v.name === bestName;
    card.querySelector(".rank").textContent = isBest ? `#${i + 1} USE THIS` : `#${i + 1}`;
    card.querySelector("img").src = v.url;
    card.querySelector(".label").textContent = v.label;
    let verdict = "Not tested yet";
    if (cost !== undefined) {
      const source = state.costs[v.name].source === "meesho" ? " (Meesho se)" : " (manual)";
      verdict = `${isBest ? "USE THIS: " : ""}Shipping ₹${cost}${source}`;
      if (cost > target()) verdict += " (target se zyada)";
      card.classList.add(cost <= target() ? "ok" : "over");
    }
    card.querySelector(".verdict").textContent = verdict;
    if (isBest) card.classList.add("best");
    if (v.ai) {
      const tag = document.createElement("div");
      tag.className = "ai-tag";
      tag.textContent = "AI";
      card.appendChild(tag);
    }
    const warnings = card.querySelector(".warnings");
    v.warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      warnings.appendChild(li);
    });
    const input = card.querySelector(".cost");
    if (cost !== undefined) input.value = cost;
    input.addEventListener("change", () => setManualCost(v.name, input.value));
    const link = card.querySelector(".download");
    link.href = v.url;
    link.download = v.name;
    if (state.chosen && state.chosen.name === v.name) card.classList.add("chosen");
    card.querySelector(".choose").addEventListener("click", () => chooseHero(v));
    grid.appendChild(card);
  });
}

function extraStyleKey() { return state.chosen.style_key || state.defaultExtraStyle; }

function chooseHero(v) {
  state.chosen = v;
  $("chosen-style").textContent = v.style_key
    ? v.label
    : `${v.label} (baaki images default style me: 1:1, product 80%, white bg)`;
  $("extras-panel").classList.remove("hidden");
  $("download-all").classList.remove("hidden");
  renderGrid();
  $("extras-panel").scrollIntoView({ behavior: "smooth" });
}

function renderExtras() {
  const grid = $("extras-grid");
  grid.replaceChildren();
  state.extras.forEach((img) => {
    const card = document.createElement("article");
    card.className = "card";
    const el = document.createElement("img");
    el.src = img.url;
    el.alt = img.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    const link = document.createElement("a");
    link.className = "download";
    link.href = img.url;
    link.download = img.name;
    link.textContent = "Download";
    meta.appendChild(link);
    card.append(el, meta);
    grid.appendChild(card);
  });
}

async function loadConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) return;
  const cfg = await res.json();
  $("ai-setup").classList.toggle("hidden", cfg.ai_configured);
  $("ai-controls").classList.toggle("hidden", !cfg.ai_configured);
  const box = $("ai-presets");
  box.replaceChildren();
  cfg.ai_presets.forEach((p, i) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p.key;
    cb.checked = true;
    label.append(cb, ` ${p.label}`);
    box.appendChild(label);
  });
}

$("hero-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("hero-file").files[0];
  if (!file) return;
  const btn = e.submitter;
  btn.disabled = true;
  setStatus($("hero-status"), "Processing... (background hata rahe hain, variations bana rahe hain)");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const data = await postForm("/api/hero", fd);
    Object.assign(state, {
      session: data.session,
      variants: data.variants,
      defaultExtraStyle: data.default_extra_style,
      chosen: null,
      extras: [],
      costs: {},
    });
    $("results-panel").classList.remove("hidden");
    $("extras-panel").classList.add("hidden");
    $("download-all").classList.add("hidden");
    $("extras-grid").replaceChildren();
    setStatus($("ai-status"), "");
    renderGrid();
    setStatus($("hero-status"), `${data.variants.length} variations ready.`);
    if (data.ai_configured) runAI();
  } catch (err) {
    setStatus($("hero-status"), err.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function runAI() {
  const presets = [...$("ai-presets").querySelectorAll("input:checked")].map((cb) => cb.value);
  if (!presets.length || !state.session) return;
  const session = state.session;
  const btn = $("ai-btn");
  btn.disabled = true;
  setStatus($("ai-status"), `AI ${presets.length} images bana raha hai... (1-3 minute lag sakte hain)`);
  try {
    const fd = new FormData();
    fd.append("session", session);
    presets.forEach((p) => fd.append("presets", p));
    const data = await postForm("/api/ai-variants", fd);
    if (session !== state.session) return;
    const names = new Set(data.variants.map((v) => v.name));
    state.variants = [...data.variants, ...state.variants.filter((v) => !names.has(v.name))];
    renderGrid();
    refreshCosts();
    const failed = data.failed.length ? ` Fail hue: ${data.failed.join(", ")}.` : "";
    setStatus($("ai-status"), `${data.variants.length} AI images add hui. Total ${state.variants.length}.${failed}`, data.variants.length === 0);
  } catch (err) {
    setStatus($("ai-status"), err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$("ai-btn").addEventListener("click", runAI);

$("sheet-btn").addEventListener("click", async () => {
  if (!state.session) return;
  const items = sortedVariants().map((v) => ({ name: v.name, cost: costOf(v.name) ?? null }));
  const res = await fetch("/api/sheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: state.session, target: target(), items: items.slice(0, 40) }),
  });
  if (!res.ok) {
    setStatus($("hero-status"), "Comparison sheet nahi ban payi", true);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "comparison_sheet.jpg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$("target").addEventListener("change", renderGrid);

$("extras-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = $("extras-files").files;
  if (!files.length || !state.chosen) return;
  const btn = e.submitter;
  btn.disabled = true;
  setStatus($("extras-status"), "Processing...");
  try {
    const fd = new FormData();
    fd.append("session", state.session);
    fd.append("style_key", extraStyleKey());
    [...files].forEach((f) => fd.append("files", f));
    const data = await postForm("/api/extras", fd);
    state.extras.push(...data.images);
    renderExtras();
    setStatus($("extras-status"), `${data.images.length} images ready.`);
  } catch (err) {
    setStatus($("extras-status"), err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("download-all").addEventListener("click", () => {
  const params = new URLSearchParams();
  [state.chosen, ...state.extras].forEach((img) => params.append("names", img.name));
  window.location.href = `/api/download/${state.session}?${params}`;
});

loadConfig();
