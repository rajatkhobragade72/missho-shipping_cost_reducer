const API = "http://127.0.0.1:8000";
const SESSION_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,80}\.jpg$/;

async function call(path, options) {
  let res;
  try {
    res = await fetch(`${API}${path}`, options);
  } catch {
    throw new Error("Local tool (127.0.0.1:8000) chalu nahi hai. Pehle server start karo.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Local tool error ${res.status}`);
  }
  return res;
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function handle(msg) {
  if (msg.type === "latest") return (await call("/api/sessions/latest")).json();
  if (!SESSION_RE.test(msg.session) || !NAME_RE.test(msg.name)) throw new Error("Invalid image reference");
  if (msg.type === "image") {
    const res = await call(`/api/image/${msg.session}/${msg.name}`);
    return { b64: toBase64(new Uint8Array(await res.arrayBuffer())) };
  }
  if (msg.type === "cost") {
    if (!Number.isFinite(msg.cost) || msg.cost < 0 || msg.cost > 100000) throw new Error("Invalid cost");
    await call("/api/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: msg.session, name: msg.name, cost: msg.cost, source: "meesho" }),
    });
    return { ok: true };
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

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});
