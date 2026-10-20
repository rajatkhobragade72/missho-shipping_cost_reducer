const MEESHO = "https://supplier.meesho.com/";
const LOCAL_TOOL = "http://127.0.0.1:8000";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const SESSION_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,80}\.jpg$/;

async function local(path, options) {
  let res;
  try {
    res = await fetch(`${LOCAL_TOOL}${path}`, options);
  } catch {
    throw new Error("Local tool (127.0.0.1:8000) chalu nahi hai");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Local tool error ${res.status}`);
  }
  return res;
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function aiVariants(msg) {
  if (typeof msg.b64 !== "string" || msg.b64.length > MAX_UPLOAD_B64) throw new Error("Photo 15 MB se badi hai");
  if (!/^image\/(jpeg|png|webp)$/.test(msg.mime)) throw new Error("Sirf JPG/PNG/WEBP photo chalegi");
  const config = await (await local("/api/config")).json();
  if (!config.ai_configured) throw new Error("Local tool me POLLINATIONS_API_KEY set nahi hai (.env)");
  const upload = new FormData();
  upload.append("file", new Blob([fromBase64(msg.b64)], { type: msg.mime }), "product");
  const { session } = await (await local("/api/hero", { method: "POST", body: upload })).json();
  const form = new FormData();
  form.append("session", session);
  const max = Number.isInteger(msg.max) && msg.max > 0 ? msg.max : config.ai_presets.length;
  config.ai_presets.slice(0, max).forEach((p) => form.append("presets", p.key));
  const result = await (await local("/api/ai-variants", { method: "POST", body: form })).json();
  return {
    session,
    images: result.variants.filter((v) => NAME_RE.test(v.name)).map((v) => ({ name: v.name, label: v.label })),
    failed: result.failed.length,
  };
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function allowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && ["meesho.com", "meeshosupplyassets.com"]
      .some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function handle(msg) {
  if (msg?.type === "ping") return { ok: true };
  if (msg?.type === "aiVariants") return aiVariants(msg);
  if (msg?.type === "localImage") {
    if (!SESSION_RE.test(msg.session) || !NAME_RE.test(msg.name)) throw new Error("Invalid image reference");
    const res = await local(`/api/image/${msg.session}/${msg.name}`);
    return { b64: toBase64(new Uint8Array(await res.arrayBuffer())) };
  }
  if (msg?.type === "fetchImage") {
    if (typeof msg.url !== "string" || !allowedImageUrl(msg.url)) throw new Error("Image URL allowed nahi hai");
    const res = await fetch(msg.url, { credentials: "omit" });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) throw new Error("Front image download nahi hui");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image bahut badi hai");
    return { b64: toBase64(bytes), type: type.split(";")[0] };
  }
  throw new Error("Unknown message");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith(MEESHO)) {
    chrome.tabs.create({ url: MEESHO });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    // Tab was open before the extension was installed/reloaded: inject the panel now.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
});
