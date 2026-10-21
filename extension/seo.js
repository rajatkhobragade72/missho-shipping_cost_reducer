// Meesho ranking + SEO analysis.
// Ye module background service worker me chalta hai (manifest: "type": "module").
// Do kaam:
//  1) Asli Meesho search page (real browser tab) se ranked products nikalna.
//  2) Un numbers se SEO ki suggestions banana (sirf data se, koi guess nahi).

const PRODUCT_URL_RE = /^https?:\/\/[^/]*meesho\.com\//i;
const BADGE_WORDS = [
  "meesho's choice", "meesho choice", "meesho assured", "sponsored", "bestseller", "best seller",
  "free shipping", "trending", "top pick", "limited deal", "sale", "discount", "deal", "offer",
  "exclusive", "new arrival", "assured", "premium",
];
const NOISE_WORDS = new Set([
  "the", "and", "for", "with", "you", "your", "are", "was", "this", "that", "from", "not",
  "buy", "get", "free", "shipping", "com", "in", "on", "at", "of", "to", "by", "or", "as", "it",
  "its", "all", "new", "sale", "offer", "offers", "deal", "discount", "price", "mrp", "rating",
  "reviews", "review", "sold", "stock", "product", "products", "online", "india", "best", "more",
  "pack", "set", "piece", "pieces", "pcs", "qty", "quantity", "size", "sizes", "color", "colour",
  "colors", "colours", "black", "white", "blue", "red", "green", "yellow", "pink", "grey", "gray",
  "multicolor", "multiclor", "beige", "navy", "brown", "home", "use", "used",
]);
// Dhyan: category words (microfiber, cloth, towel ...) NOISE me nahi hain - wo hi search
// keywords hote hain aur "missing words" analysis me batane zaroori hain.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page extractors
// Ye functions page ke andar chalti hain (chrome.scripting se inject), isliye
// inke andar bahar ka koi variable use nahi hona chahiye.

/* eslint-disable no-undef */
function extractSearchResults(limit) {
  const BADGE = ["meesho's choice", "meesho choice", "meesho assured", "sponsored", "bestseller",
    "best seller", "free shipping", "trending", "top pick", "exclusive", "new arrival", "premium"];
  const links = [...document.querySelectorAll("a[href]")];
  const candidates = [];
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#") || href.includes("/search") || href.includes("javascript:")) continue;
    const text = (a.innerText || a.textContent || "").trim();
    if (!text || text.length > 1200) continue;
    if (!/₹\s*\d/.test(text)) continue;                       // price chahiye
    if (!a.querySelector("img")) continue;                     // product card chahiye
    let id = "";
    try {
      const path = new URL(href, location.origin).pathname.replace(/\/+$/, "");
      id = path.split("/").pop() || "";
    } catch { id = ""; }
    if (!id || !/^[a-z0-9_-]{6,}$/i.test(id)) continue;
    candidates.push({ a, href: new URL(href, location.origin).href, id });
  }
  // Sabse bada cluster (results grid) chuno, taaki header/footer ke links na aayein.
  const counts = new Map();
  for (const c of candidates) {
    let p = c.a;
    for (let i = 0; i < 4 && p.parentElement; i++) {
      p = p.parentElement;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [el, n] of counts) if (n > bestN) { bestN = n; best = el; }
  const inGrid = best ? candidates.filter((c) => best.contains(c.a)) : candidates;

  const seen = new Set();
  const products = [];
  for (const c of inGrid) {
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    const text = (c.a.innerText || c.a.textContent || "").trim();
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const priceText = (text.match(/₹\s*([\d,]+)/) || [])[1] || "";
    const price = priceText ? Number(priceText.replace(/,/g, "")) : null;
    const ratingText = (text.match(/([0-5](?:[.,]\d)?)\s*(?:★|⭐|\bout of 5\b)/i) || [])[1] || "";
    const rating = ratingText ? Number(ratingText.replace(",", ".")) : null;
    const reviewsText = (text.match(/\(?\s*([\d][\d.,]*\s*[kK]?)\s*\)?\s*(?:reviews?|ratings?|votes?)/i)
      || text.match(/\(\s*([\d][\d.,]*\s*[kK]?)\s*\)/) || [])[1] || "";
    const reviews = reviewsText ? Number(reviewsText.replace(/[,\s]/g, "").replace(/[kK]$/, "000")) : null;
    const badges = lines.filter((l) => l.length < 40 && BADGE.some((b) => l.toLowerCase().includes(b)));
    const title = lines
      .filter((l) => l.length > 12 && !/^₹/.test(l) && !/^[0-9]/.test(l) && !badges.includes(l))
      .sort((x, y) => y.length - x.length)[0] || lines[0] || "";
    const img = c.a.querySelector("img");
    products.push({
      id: c.id,
      href: c.href,
      title: title.slice(0, 220),
      price,
      rating,
      reviews,
      badges: [...new Set(badges)].slice(0, 4),
      image: img ? (img.currentSrc || img.src || "") : "",
    });
    if (products.length >= (limit || 40)) break;
  }
  return { url: location.href, title: document.title, count: products.length, products };
}

function extractProductPage() {
  const text = document.body ? (document.body.innerText || "") : "";
  const priceText = (text.match(/₹\s*([\d,]+)/) || [])[1] || "";
  const ratingText = (text.match(/([0-5](?:[.,]\d)?)\s*(?:★|⭐|\bout of 5\b)/i) || [])[1] || "";
  const reviewsText = (text.match(/([\d][\d.,]*\s*[kK]?)\s*(?:reviews?|ratings?)/i) || [])[1] || "";
  const h1 = document.querySelector("h1");
  const og = document.querySelector('meta[property="og:title"]');
  const title = (h1 && h1.innerText.trim()) || (og && og.getAttribute("content")) || document.title || "";
  const path = location.pathname.replace(/\/+$/, "");
  return {
    url: location.href,
    id: path.split("/").pop() || "",
    title: title.slice(0, 220),
    price: priceText ? Number(priceText.replace(/,/g, "")) : null,
    rating: ratingText ? Number(ratingText.replace(",", ".")) : null,
    reviews: reviewsText ? Number(reviewsText.replace(/[,\s]/g, "").replace(/[kK]$/, "000")) : null,
  };
}
/* eslint-enable no-undef */

// ---------------------------------------------------------------- tab helpers

function waitForLoad(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); };
    const onUpdate = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// Asli browser tab me page kholte hain (Akamai plain fetch ko block karta hai).
async function openAndExtract(url, kind, arg) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { error: `Tab nahi khul paya: ${err.message}` };
  }
  try {
    await waitForLoad(tab.id);
    let data = null;
    for (let i = 0; i < 28; i++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: kind === "product" ? extractProductPage : extractSearchResults,
        args: kind === "product" ? [] : [arg || 40],
      }).catch(() => null);
      data = res && res[0] ? res[0].result : null;
      const ready = data && (kind === "product" ? data.title : (data.products && data.products.length));
      if (ready) break;
      await sleep(800);
    }
    if (!data) return { error: "Page ka data nahi mila" };
    return data;
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  } finally {
    if (tab && tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function searchMeesho(keyword, limit = 40) {
  const url = `https://www.meesho.com/search?q=${encodeURIComponent(keyword)}`;
  const data = await openAndExtract(url, "search", limit);
  return { keyword, url, ...data };
}

export async function fetchProductPage(url) {
  if (!PRODUCT_URL_RE.test(url)) return { error: "Yeh Meesho ka product URL nahi lagta" };
  return openAndExtract(url, "product");
}

// ---------------------------------------------------------------- pure analysis

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !NOISE_WORDS.has(t) && !/^\d+$/.test(t));
}

export function productIdFromUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path.split("/").pop() || "";
  } catch { return ""; }
}

// Meesho ka asli product link hai ya nahi (gaalti se dusra link paste kiya ho).
export function isMeeshoProductUrl(url) {
  const s = String(url || "");
  if (!PRODUCT_URL_RE.test(s)) return false;
  return /^[a-z0-9_-]{6,}$/i.test(productIdFromUrl(s));
}

// Top products ke titles se related keywords nikalta hai (data se, guess nahi).
export function buildRelatedKeywords(keyword, products, limit = 5) {
  const counts = new Map();
  const bigrams = new Map();
  for (const p of products) {
    const words = tokenize(p.title);
    const seenHere = new Set();
    for (const w of words) {
      if (seenHere.has(w)) continue;
      seenHere.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`;
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
  }
  const topWords = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const topBigrams = [...bigrams.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const kw = String(keyword || "").trim().toLowerCase();
  const out = [kw];
  const push = (k) => {
    const key = k.trim().toLowerCase();
    if (!key || out.some((o) => o === key)) return;
    out.push(key);
  };
  for (const w of topWords.slice(0, 4)) push(w);
  for (const w of topWords.slice(0, 3)) push(`${kw} ${w}`);
  for (const bg of topBigrams.slice(0, 2)) push(bg);
  return out.slice(0, limit + 1);
}

const median = (nums) => {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// Tumhari photo vs top-20: kya farak hai aur kya karna chahiye.
export function analyzeSeo(user, products, keyword) {
  const top = products.slice(0, 20);
  const stats = {
    priceMedian: median(top.map((p) => p.price).filter((v) => typeof v === "number" && v > 0)),
    priceMin: Math.min(...top.map((p) => p.price).filter((v) => typeof v === "number" && v > 0).concat([Infinity])),
    priceMax: Math.max(...top.map((p) => p.price).filter((v) => typeof v === "number" && v > 0).concat([0])),
    ratingAvg: null,
    reviewsMedian: median(top.map((p) => p.reviews).filter((v) => typeof v === "number" && v > 0)),
    titleLenAvg: Math.round(top.reduce((s, p) => s + (p.title || "").length, 0) / (top.length || 1)),
    badgeShare: 0,
  };
  const ratings = top.map((p) => p.rating).filter((v) => typeof v === "number" && v > 0);
  stats.ratingAvg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  stats.badgeShare = top.length ? top.filter((p) => p.badges && p.badges.length).length / top.length : 0;
  if (!Number.isFinite(stats.priceMin)) stats.priceMin = null;
  if (!Number.isFinite(stats.priceMax)) stats.priceMax = null;

  const userWords = new Set(tokenize(user.title));
  const common = new Map();
  for (const p of top.slice(0, 10)) {
    for (const w of new Set(tokenize(p.title))) common.set(w, (common.get(w) || 0) + 1);
  }
  const missing = [...common.entries()]
    .filter(([w, n]) => n >= 3 && !userWords.has(w))
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  const suggestions = [];
  const add = (title, detail, priority = "normal") => suggestions.push({ title, detail, priority });

  if (missing.length) {
    add("Title me ye words add karo",
      `Top 10 me ${missing.slice(0, 6).map((w) => `"${w}"`).join(", ")} lagatar aa rahe hain, tumhare title me nahi. Title me 2-3 natural jagah daal do (spam mat karo).`,
      "high");
  }
  const packWord = top.slice(0, 10).find((p) => /pack of|set of|\b\d+\s*(pcs|pieces|pack)/i.test(p.title || ""));
  if (packWord && !/pack of|set of|\d+\s*(pcs|pieces|pack)/i.test(user.title || "")) {
    add("Pack / count batao",
      `Top me "${(packWord.title.match(/[^|]*(pack of|set of|\d+\s*(?:pcs|pieces|pack))[^|]*/i) || [packWord.title])[0].trim().slice(0, 60)}" likha hai. Apne title me bhi "Pack of N" ya count likho - search me ye filter lagta hai.`,
      "high");
  }
  if (typeof user.price === "number" && stats.priceMedian) {
    if (user.price > stats.priceMedian * 1.15) {
      add("Price thoda zyada hai",
        `Tumhari price ₹${user.price}, top 10 ka median ₹${stats.priceMedian} (range ₹${stats.priceMin}-₹${stats.priceMax}). Same product ke liye ₹${Math.round(stats.priceMedian)} tak jaana ranking karega.`,
        "high");
    } else if (user.price < stats.priceMedian * 0.85) {
      add("Price competitive hai",
        `Tumhari price ₹${user.price}, top 10 ka median ₹${stats.priceMedian}. Price accha hai - quality photos aur reviews pe focus karo.`,
        "good");
    } else {
      add("Price theek hai", `Tumhari price ₹${user.price}, top 10 ka median ₹${stats.priceMedian}. Price ka koi bada issue nahi.`, "good");
    }
  } else if (typeof user.price !== "number") {
    add("Price nahi mili", "Apni product page se price check karo - price galat ya missing hui to ranking suffer karti hai.", "normal");
  }
  if (typeof user.rating !== "number" && stats.ratingAvg) {
    add("Rating/reviews kam hain",
      `Tumhare listing pe rating nahi dikh rahi, top 10 ka average ${stats.ratingAvg}★ hai${stats.reviewsMedian ? ` (median ${stats.reviewsMedian} reviews)` : ""}. 3-5 genuine buyers ke reviews le lo - ranking me sabse bada fark yahi laata hai.`,
      "high");
  } else if (typeof user.rating === "number" && stats.ratingAvg && user.rating < stats.ratingAvg - 0.2) {
    add("Rating neeche hai",
      `Tumhari rating ${user.rating}★, top 10 ka average ${stats.ratingAvg}★. Product quality/expectation match nahi ho rahi - description aur photos me size/color clearly batao.`,
      "high");
  }
  if (stats.badgeShare >= 0.4) {
    add("Quality badge (Meesho's Choice) chahiye",
      `Top 20 me ${Math.round(stats.badgeShare * 100)}% products par quality badge hai. Packaging, product quality aur image quality theek karo - badge milega to rank jump karta hai.`,
      "normal");
  }
  if ((user.title || "").length < stats.titleLenAvg * 0.7) {
    add("Title chhota hai",
      `Tumhara title ${(user.title || "").length} characters, top 10 ka average ${stats.titleLenAvg}. Size, count, material, colour, use-case likh ke title bada karo (spam mat karo).`,
      "normal");
  }
  if (top.some((p) => p.badges.some((b) => /sponsored/i.test(b)))) {
    add("Top me sponsored hai", "Pehle 3 me sponsored slot hai - unka organic rank alag hota hai. Apni position organic results se compare karo.", "normal");
  }
  const topOne = top[0];
  if (topOne) {
    add("Rank #1 ka reference",
      `#1 "${(topOne.title || "").slice(0, 110)}" - price ${topOne.price ?? "?"}${topOne.rating ? `, ${topOne.rating}★` : ""}${topOne.reviews ? `, ${topOne.reviews} reviews` : ""}. Apne title ko isi tarah ke attributes (material/size/count/use) se compare karo.`,
      "info");
  }
  if (!suggestions.length) add("Koi badi kami nahi mili", "Top 20 ke saath comparison me koi bada difference nahi mila. Photos aur reviews pe focus karo.", "good");

  return { keyword, stats, top, suggestions, missingWords: missing.slice(0, 10) };
}

// Sab keywords ka rank + analysis ek saath.
export function buildReport(user, searches, related) {
  const rows = searches.map((s) => {
    const idx = s.products ? s.products.findIndex((p) => p.id && user.id && p.id.toLowerCase() === user.id.toLowerCase()) : -1;
    const best = s.products && s.products[0];
    return {
      keyword: s.keyword,
      found: idx >= 0,
      rank: idx >= 0 ? idx + 1 : null,
      total: s.products ? s.products.length : 0,
      topTitle: best ? best.title : "",
      topPrice: best ? best.price : null,
      topRating: best ? best.rating : null,
      error: s.error || null,
    };
  });
  const ranked = rows.filter((r) => r.found).sort((a, b) => a.rank - b.rank);
  const main = ranked[0] || rows[0];
  let analysis = null;
  if (main) {
    const search = searches.find((s) => s.keyword === main.keyword);
    if (search && search.products) analysis = analyzeSeo(user, search.products, main.keyword);
  }
  return { user, rows, related: !!related, analysis };
}
