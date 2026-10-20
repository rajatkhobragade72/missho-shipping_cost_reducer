const MEESHO = "https://supplier.meesho.com/";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function allowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "meesho.com" || url.hostname.endsWith(".meesho.com"));
  } catch {
    return false;
  }
}

async function handle(msg) {
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
