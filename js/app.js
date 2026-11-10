import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./js/pdfjs/pdf.worker.min.mjs";

// Procedure videos live in their own cache, outside the service worker's
// versioned ones, so a protocol update doesn't throw away a 12 MB download.
// Video files are versioned by name; stale ones are pruned on load.
const VIDEO_CACHE = "slco-protocols-videos";

const STORAGE_KEYS = {
  favorites: "slco-protocols:favorites",
  theme: "slco-protocols:theme",
  textSize: "slco-protocols:text-size",
};

const state = {
  protocols: null,
  searchIndex: null,
  videos: [],
  savedVideos: new Set(), // ids saved for offline
  view: "home",
  query: "",
  favorites: loadFavorites(),
  pdfDocs: new Map(), // docId -> pdfjs document proxy
  viewer: {
    docId: null,
    title: null,
    page: 1,
    numPages: 1,
    zoom: 1, // multiplier on top of fit-to-width baseline (1 = fit width)
    rendering: false,
  },
};

const el = {
  app: document.getElementById("app"),
  topTitle: document.getElementById("topTitle"),
  backBtn: document.getElementById("backBtn"),
  favBtn: document.getElementById("favBtn"),
  searchWrap: document.getElementById("searchWrap"),
  searchInput: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  tabbar: document.getElementById("tabbar"),
  viewer: document.getElementById("viewer"),
  viewerTitle: document.getElementById("viewerTitle"),
  viewerClose: document.getElementById("viewerClose"),
  pdfCanvas: document.getElementById("pdfCanvas"),
  canvasWrap: document.getElementById("viewerCanvasWrap"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  pageIndicator: document.getElementById("pageIndicator"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
  zoomIndicator: document.getElementById("zoomIndicator"),
  offlineToast: document.getElementById("offlineToast"),
  updateToast: document.getElementById("updateToast"),
  updateReload: document.getElementById("updateReload"),
  viewerVideoBar: document.getElementById("viewerVideoBar"),
  player: document.getElementById("player"),
  playerClose: document.getElementById("playerClose"),
  playerTitle: document.getElementById("playerTitle"),
  playerProtocol: document.getElementById("playerProtocol"),
  playerVideo: document.getElementById("playerVideo"),
  playerOffline: document.getElementById("playerOffline"),
  playerSave: document.getElementById("playerSave"),
};

const CATEGORY_ICONS = {
  "general-patient-care-guidelines": "🩺",
  "cardiac-patient-care-guidelines": "❤️",
  "medical-patient-care-guidelines": "💊",
  "avalanche-patient-care-guidelines": "🏔️",
  "trauma-patient-care-guidelines": "🩹",
  "appendix": "💉",
};

function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.favorites);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify([...state.favorites]));
}

function favKey(docId, page) {
  return `${docId}#${page}`;
}

// ---------- Data loading ----------

async function loadData() {
  const [protocolsRes, searchRes] = await Promise.all([
    fetch("data/protocols.json"),
    fetch("data/search-index.json"),
  ]);
  state.protocols = await protocolsRes.json();
  state.searchIndex = await searchRes.json();
  // Lower-case each page once; search runs on every keystroke.
  for (const pg of state.searchIndex) pg.lower = pg.text.toLowerCase();
  buildPageContext();
  // Videos need the player markup; if this page is an older index.html,
  // leave them out rather than break the app.
  try {
    state.videos = el.player ? (await (await fetch("data/videos.json")).json()).videos || [] : [];
  } catch {
    state.videos = [];
  }
  await refreshSavedVideos();
}

async function refreshSavedVideos() {
  if (!("caches" in window)) return;
  const cache = await caches.open(VIDEO_CACHE);
  const saved = new Set();
  for (const v of state.videos) if (await cache.match(v.file)) saved.add(v.id);
  state.savedVideos = saved;
  // Drop files from older versions of a video (or videos no longer listed).
  const keep = new Set(state.videos.flatMap((v) => [v.file, v.poster]).map((f) => new URL(f, location.href).href));
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
}

function findEntryByKey(key) {
  const [docId, pageStr] = key.split("#");
  const page = Number(pageStr);
  const all = allNavEntries();
  return all.find((e) => e.docId === docId && e.page === page) || {
    docId, page, title: `${docId} p.${page}`,
  };
}

function allNavEntries() {
  const p = state.protocols;
  if (!p) return [];
  const entries = [];
  for (const cat of p.clinicalCategories) entries.push(...cat.protocols);
  entries.push(...p.reference);
  entries.push(...p.administrative);
  entries.push(...(p.departmentVariances || []));
  return entries;
}

// ---------- Rendering: views ----------

function render() {
  el.searchWrap.hidden = state.view === "settings";
  el.tabbar.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });

  if (state.query.trim()) {
    renderSearchResults();
    el.topTitle.textContent = "Search";
    el.backBtn.hidden = true;
    return;
  }

  switch (state.view) {
    case "home":
      renderHome();
      el.topTitle.textContent = "SLCo EMS Protocols";
      break;
    case "favorites":
      renderFavorites();
      el.topTitle.textContent = "Favorites";
      break;
    case "admin":
      renderAdmin();
      el.topTitle.textContent = "Administrative";
      break;
    case "settings":
      renderSettings();
      el.topTitle.textContent = "Settings";
      break;
  }
  el.backBtn.hidden = true;
}

function rowHTML(entry, opts = {}) {
  const key = favKey(entry.docId, entry.page);
  const isFav = state.favorites.has(key);
  return `
    <button class="row-btn" data-doc="${entry.docId}" data-page="${entry.page}" data-title="${escapeAttr(entry.title)}">
      ${opts.icon ? `<span class="category-icon">${opts.icon}</span>` : ""}
      <span class="row-title">${escapeHtml(entry.title)}${opts.showSub ? `<div class="row-sub">${escapeHtml(opts.showSub)}</div>` : ""}</span>
      ${isFav ? favStarHTML() : ""}
      <span class="row-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

function formatDuration(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

function videoRowHTML(v) {
  const saved = state.savedVideos.has(v.id) ? " · Saved offline" : "";
  return `
    <button class="row-btn" data-video="${escapeAttr(v.id)}">
      <span class="category-icon"><svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>
      <span class="row-title">${escapeHtml(v.title)}<div class="row-sub">${formatDuration(v.durationSec)} · ${escapeHtml(v.scope)}${saved}</div></span>
      <span class="row-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

function favStarHTML() {
  return `<span class="row-fav-star"><svg viewBox="0 0 24 24"><path d="M12 4.5c1.7-2 5.7-2.3 7.8.5 2 2.7 1 6-1 8-2 2-4.8 4.3-6.8 6-2-1.7-4.8-4-6.8-6-2-2-3-5.3-1-8 2.1-2.8 6.1-2.5 7.8-.5z" fill="currentColor"/></svg></span>`;
}

function formatUpdatedDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function renderHome() {
  const p = state.protocols;
  const updated = formatUpdatedDate(p.sourceCheckedAt || p.generatedAt);
  let html = updated ? `<div class="updated-line">Updated ${updated}</div>` : "";
  html += `<div class="section-title">Clinical Protocols</div><div class="card-list">`;
  html += p.clinicalCategories.map((cat) => `
    <button class="row-btn" data-nav="category" data-cat="${cat.id}">
      <span class="category-icon">${CATEGORY_ICONS[cat.id] || "📋"}</span>
      <span class="row-title">${escapeHtml(cat.title)}<div class="row-sub">${cat.protocols.length} ${cat.noun || "protocol"}${cat.protocols.length === 1 ? "" : "s"}</div></span>
      <span class="row-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`).join("");
  html += `</div>`;

  if (state.videos.length) {
    html += `<div class="section-title">Procedure Videos</div><div class="card-list">`;
    html += state.videos.map((v) => videoRowHTML(v)).join("");
    html += `</div>`;
  }

  html += `<div class="section-title">Reference</div><div class="card-list">`;
  html += p.reference.map((r) => rowHTML(r, { icon: "📄" })).join("");
  html += `</div>`;

  el.app.innerHTML = html;
}

function renderCategory(catId) {
  const cat = state.protocols.clinicalCategories.find((c) => c.id === catId);
  if (!cat) return renderHome();
  el.app.innerHTML = `<div class="section-title">${escapeHtml(cat.title)}</div><div class="card-list">${
    cat.protocols.map((pr) => rowHTML(pr)).join("")
  }</div>`;
  el.topTitle.textContent = cat.title;
  el.backBtn.hidden = false;
  el.backBtn.onclick = () => { navBack(); };
}

function renderFavorites() {
  const all = allNavEntries();
  const favs = all.filter((e) => state.favorites.has(favKey(e.docId, e.page)));
  if (!favs.length) {
    el.app.innerHTML = `<div class="empty-state">No favorites yet.<br>Tap the star inside a protocol to pin it here for quick access.</div>`;
    return;
  }
  el.app.innerHTML = `<div class="card-list">${favs.map((f) => rowHTML(f)).join("")}</div>`;
}

function renderAdmin() {
  const p = state.protocols;
  let html = `<div class="section-title">Administrative & Operational</div><div class="card-list">${
    p.administrative.map((a) => rowHTML(a, { icon: "📋" })).join("")
  }</div>`;
  if (p.departmentVariances && p.departmentVariances.length) {
    html += `<div class="section-title">Department Variances</div><div class="card-list">${
      p.departmentVariances.map((v) => rowHTML(v, { icon: "🚑" })).join("")
    }</div>`;
  }
  el.app.innerHTML = html;
}

function renderSettings() {
  const theme = localStorage.getItem(STORAGE_KEYS.theme) || "system";
  const textSize = localStorage.getItem(STORAGE_KEYS.textSize) || "normal";
  el.app.innerHTML = `
    <div class="section-title">Appearance</div>
    <div class="card-list">
      <div class="settings-row">
        <span class="settings-label">Theme</span>
        <div class="segmented" id="themeSeg">
          <button data-val="light" class="${theme === "light" ? "active" : ""}">Light</button>
          <button data-val="system" class="${theme === "system" ? "active" : ""}">Auto</button>
          <button data-val="dark" class="${theme === "dark" ? "active" : ""}">Dark</button>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-label">Text size</span>
        <div class="segmented" id="textSeg">
          <button data-val="normal" class="${textSize === "normal" ? "active" : ""}">A</button>
          <button data-val="large" class="${textSize === "large" ? "active" : ""}">A+</button>
        </div>
      </div>
    </div>

    <div class="section-title">Offline Access</div>
    <div class="card-list">
      <div class="settings-row">
        <span>
          <div class="settings-label">Download all protocols</div>
          <div class="settings-sub">Caches every PDF${state.videos.length ? " and procedure video" : ""} for use with no signal</div>
        </span>
        <button class="icon-btn" id="downloadAllBtn" style="width:auto;height:auto;color:var(--accent);font-weight:700;font-size:14px;padding:6px 10px;">Download</button>
      </div>
      <div class="download-status" id="downloadStatus"></div>
      <div class="progress-bar" id="downloadProgressBar" hidden><div class="progress-bar-fill" id="downloadProgressFill"></div></div>
    </div>

    <div class="section-title">About</div>
    <div class="card-list">
      <div class="settings-row">
        <span class="settings-label">Source</span>
        <span class="settings-sub">2bprotocols.com — Salt Lake County EMS</span>
      </div>
    </div>
  `;

  document.getElementById("themeSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    setTheme(btn.dataset.val);
    renderSettings();
  });
  document.getElementById("textSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    setTextSize(btn.dataset.val);
    renderSettings();
  });
  document.getElementById("downloadAllBtn").addEventListener("click", downloadAllForOffline);
}

// ---------- Search ----------

// Names medics say on the radio that the protocol book doesn't print. Each maps
// to the generic name the book's medication appendix uses.
const SYNONYMS = {
  adrenaline: ["epinephrine"],
  narcan: ["naloxone"],
  versed: ["midazolam"],
  ntg: ["nitroglycerin"],
  toradol: ["ketorolac"],
  zofran: ["ondansetron"],
  ativan: ["lorazepam"],
  valium: ["diazepam"],
  benadryl: ["diphenhydramine"],
  haldol: ["haloperidol"],
  tylenol: ["acetaminophen"],
  motrin: ["ibuprofen"],
  advil: ["ibuprofen"],
  ketalar: ["ketamine"],
  cordarone: ["amiodarone"],
  pacerone: ["amiodarone"],
  adenocard: ["adenosine"],
  phenergan: ["promethazine"],
};

const MAX_TEXT_RESULTS = 40;

// A number followed by a dose unit: "1 mg", "0.01 mg/kg", "300 mL", "50 joules".
const DOSE_RE = /\d(?:\.\d+)?\s?(?:mg|mcg|µg|ug|g|ml|l|units?|iu|meq|joules?|j|%)(?![a-z])/;

// One group per typed word; a text matches a group when any alternative (the
// word or a synonym) starts a word in it. "epi" finds epinephrine but not "recipe".
function parseQuery(raw) {
  return raw.toLowerCase().split(/\s+/).filter(Boolean).map((word) => {
    const alts = [word, ...(SYNONYMS[word] || [])];
    return { word, alts, re: new RegExp(`(?:^|[^a-z0-9])(?:${alts.map(escapeRegex).join("|")})`, "g") };
  });
}

// The book's bookmarks only mark where a protocol starts, so a search hit on
// page 26 would otherwise be labelled with the whole book's name. Build a page
// -> protocol lookup from the same data the category lists use.
function buildPageContext() {
  const p = state.protocols;
  const byDoc = new Map();
  const add = (docId, item) => {
    if (!byDoc.has(docId)) byDoc.set(docId, []);
    byDoc.get(docId).push(item);
  };
  const entryGroup = new Map(); // entry id -> section name shown under title matches
  for (const cat of p.clinicalCategories) {
    const docId = cat.protocols[0]?.docId;
    if (!docId) continue;
    if (cat.page) add(docId, { page: cat.page, kind: 1, title: cat.title, category: cat.title, noun: cat.noun });
    for (const pr of cat.protocols) {
      add(docId, { page: pr.page, kind: 2, title: pr.title, category: cat.title, noun: cat.noun });
      entryGroup.set(pr.id, cat.title);
    }
  }
  for (const r of p.reference) {
    add(r.docId, { page: r.page, kind: 0, title: r.title, category: "Reference" });
    entryGroup.set(r.id, "Reference");
  }
  for (const a of p.administrative) entryGroup.set(a.id, "Administrative");
  for (const v of p.departmentVariances || []) entryGroup.set(v.id, "Department variance");
  for (const list of byDoc.values()) list.sort((a, b) => a.page - b.page || a.kind - b.kind);
  state.pageContext = byDoc;
  state.entryGroup = entryGroup;
}

// { title, category } for the protocol a page belongs to.
function contextForPage(docId, page) {
  const list = state.pageContext?.get(docId);
  let last = -1;
  if (list) for (let i = 0; i < list.length && list[i].page <= page; i++) last = i;
  if (last < 0) return { title: docTitle(docId), category: null };
  const startsHere = list.filter((x) => x.page === list[last].page);
  const protocols = startsHere.filter((x) => x.kind === 2);
  if (protocols.length === 1) return { title: protocols[0].title, category: protocols[0].category };
  if (protocols.length > 1) {
    // Several items share the page (the medication appendix): name the list.
    const { category, noun } = protocols[0];
    return { title: noun ? `${category} · ${noun}s` : category, category: null };
  }
  return { title: startsHere[0].title, category: startsHere[0].category };
}

function runSearch(raw) {
  const groups = parseQuery(raw);
  const matches = (text) => groups.every((g) => text.search(g.re) !== -1);
  const q = raw.toLowerCase();

  const rankTitle = (e) => {
    const t = e.title.toLowerCase();
    return t === q ? 0 : t.startsWith(q) ? 1 : 2;
  };
  const titleMatches = allNavEntries().filter((e) => matches(e.title.toLowerCase())).sort((a, b) => rankTitle(a) - rankTitle(b));
  const titleKeys = new Set(titleMatches.map((e) => `${e.docId}#${e.page}`));

  const textMatches = [];
  for (const pg of state.searchIndex) {
    if (!matches(pg.lower) || titleKeys.has(`${pg.docId}#${pg.page}`)) continue;
    const ctx = contextForPage(pg.docId, pg.page);
    let score = 0;
    let first = Infinity;
    for (const g of groups) {
      score += Math.min(pg.lower.match(g.re).length, 5); // how much the page is about it
      first = Math.min(first, pg.lower.search(g.re));
    }
    if (matches(ctx.title.toLowerCase())) score += 4; // the page sits in a protocol named for the query
    if (first < 160) score += 2; // the match is in the page's header
    if (DOSE_RE.test(pg.lower.slice(Math.max(0, first - 80), first + 120))) score += 3; // it sits beside a dose
    textMatches.push({ pg, ctx, score });
  }
  textMatches.sort((a, b) => b.score - a.score || a.pg.page - b.pg.page);

  const videoMatches = state.videos.filter((v) =>
    matches([v.title, v.summary, ...(v.keywords || [])].join(" ").toLowerCase()));

  return { groups, videoMatches, titleMatches, textMatches };
}

function textHitRowHTML({ pg, ctx }, groups) {
  return `
    <button class="row-btn" data-doc="${pg.docId}" data-page="${pg.page}" data-title="${escapeAttr(ctx.title)}">
      <span class="row-title">${escapeHtml(ctx.title)}<div class="search-snippet">${buildSnippet(pg.text, groups)}</div></span>
      <span class="search-result-page">p.${pg.page}</span>
    </button>`;
}

function renderSearchResults() {
  const raw = state.query.trim();
  if (raw.length < 2) {
    el.app.innerHTML = `<div class="empty-state">Keep typing to search…</div>`;
    return;
  }
  const { groups, videoMatches, titleMatches, textMatches } = runSearch(raw);
  if (!videoMatches.length && !titleMatches.length && !textMatches.length) {
    renderNoResults(raw);
    return;
  }

  let html = "";
  const top = videoMatches.length + titleMatches.length;
  if (top) {
    html += `<div class="card-list">`;
    html += videoMatches.map((v) => videoRowHTML(v)).join("");
    html += titleMatches.map((e) => rowHTML(e, { showSub: state.entryGroup?.get(e.id) })).join("");
    html += `</div>`;
  }
  if (textMatches.length) {
    const n = textMatches.length;
    html += `<div class="section-title">${top ? "Also mentioned" : "Mentioned"} on ${n} page${n === 1 ? "" : "s"}</div>`;
    html += `<div class="card-list">${textMatches.slice(0, MAX_TEXT_RESULTS).map((m) => textHitRowHTML(m, groups)).join("")}</div>`;
    if (n > MAX_TEXT_RESULTS) {
      html += `<div class="search-note">Showing the ${MAX_TEXT_RESULTS} best matches of ${n}. Add a word to narrow it down.</div>`;
    }
  }
  el.app.innerHTML = html;
}

function renderNoResults(raw) {
  const fix = suggestCorrection(raw);
  let html = `<div class="empty-state${fix ? " tight" : ""}">No results for “${escapeHtml(raw)}”</div>`;
  if (fix) {
    html += `<div class="card-list"><button class="row-btn" data-suggest="${escapeAttr(fix)}">
      <span class="row-title">Did you mean <strong>${escapeHtml(fix)}</strong>?</span>
    </button></div>`;
  }
  el.app.innerHTML = html;
}

// Every word the book uses, with how often, for spelling suggestions.
function vocabulary() {
  if (state.vocab) return state.vocab;
  const counts = new Map();
  const tally = (text) => {
    for (const w of text.match(/[a-z][a-z-]{3,}/g) || []) counts.set(w, (counts.get(w) || 0) + 1);
  };
  for (const pg of state.searchIndex) tally(pg.lower);
  for (const e of allNavEntries()) tally(e.title.toLowerCase());
  state.vocab = counts;
  return counts;
}

// Optimal-string-alignment distance (one swap of neighbours counts as one edit),
// giving up once it must exceed `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// "epinefrine" -> "epinephrine". Only ever offered, never applied silently: a
// misread dose search is worse than an honest "no results".
function suggestCorrection(raw) {
  const vocab = vocabulary();
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  let changed = false;
  const fixed = words.map((w) => {
    if (w.length < 4 || SYNONYMS[w]) return w;
    for (const known of vocab.keys()) if (known.startsWith(w)) return w; // already a real word-start
    const max = w.length <= 5 ? 1 : 2;
    let best = null;
    let bestD = Infinity;
    let bestN = 0;
    for (const [cand, n] of vocab) {
      const d = editDistance(w, cand, max);
      if (d <= max && (d < bestD || (d === bestD && n > bestN))) {
        best = cand;
        bestD = d;
        bestN = n;
      }
    }
    if (!best) return w;
    changed = true;
    return best;
  });
  if (!changed) return null;
  const suggestion = fixed.join(" ");
  const r = runSearch(suggestion);
  return r.videoMatches.length || r.titleMatches.length || r.textMatches.length ? suggestion : null;
}

function docTitle(docId) {
  return state.protocols?.documents?.[docId]?.title || docId;
}

// A window of the page text around the first hit, with every hit marked. Text is
// escaped piece by piece so a marked term can never split an HTML entity.
function buildSnippet(text, groups) {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const g of groups) {
    const i = lower.search(g.re);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 120);
  const raw = text.slice(start, end);
  const terms = groups.flatMap((g) => g.alts).map(escapeRegex).join("|");
  const re = new RegExp(`(^|[^A-Za-z0-9])(${terms})`, "gi");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    const at = m.index + m[1].length;
    out += escapeHtml(raw.slice(last, at)) + `<mark>${escapeHtml(m[2])}</mark>`;
    last = at + m[2].length;
  }
  out += escapeHtml(raw.slice(last));
  return (start > 0 ? "…" : "") + out + (end < text.length ? "…" : "");
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Navigation ----------

let navStack = [];

function navBack() {
  navStack.pop();
  const prev = navStack.pop();
  if (prev) {
    navStack.push(prev);
    applyNav(prev, false);
  } else {
    state.view = "home";
    render();
  }
}

function applyNav(target, push = true) {
  if (push) navStack.push(target);
  if (target.type === "category") {
    renderCategory(target.catId);
  }
}

el.app.addEventListener("click", (e) => {
  const suggestBtn = e.target.closest("[data-suggest]");
  if (suggestBtn) {
    el.searchInput.value = suggestBtn.dataset.suggest;
    el.searchInput.dispatchEvent(new Event("input"));
    return;
  }
  const navBtn = e.target.closest("[data-nav='category']");
  if (navBtn) {
    applyNav({ type: "category", catId: navBtn.dataset.cat });
    return;
  }
  const videoBtn = e.target.closest(".row-btn[data-video]");
  if (videoBtn) {
    openPlayer(videoBtn.dataset.video);
    return;
  }
  const rowBtn = e.target.closest(".row-btn[data-doc]");
  if (rowBtn) {
    openViewer(rowBtn.dataset.doc, Number(rowBtn.dataset.page), rowBtn.dataset.title);
  }
});

el.tabbar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  navStack = [];
  state.view = btn.dataset.view;
  state.query = "";
  el.searchInput.value = "";
  el.clearSearch.hidden = true;
  render();
});

el.searchInput.addEventListener("input", () => {
  state.query = el.searchInput.value;
  el.clearSearch.hidden = !state.query;
  render();
});
el.clearSearch.addEventListener("click", () => {
  state.query = "";
  el.searchInput.value = "";
  el.clearSearch.hidden = true;
  render();
  el.searchInput.blur();
});

// ---------- PDF Viewer ----------

async function getPdfDoc(docId) {
  if (state.pdfDocs.has(docId)) return state.pdfDocs.get(docId);
  const meta = state.protocols.documents[docId];
  const loadingTask = pdfjsLib.getDocument({ url: `pdfs/${meta.file}` });
  const doc = await loadingTask.promise;
  state.pdfDocs.set(docId, doc);
  return doc;
}

async function openViewer(docId, page, title) {
  state.viewer.docId = docId;
  state.viewer.title = title || docTitle(docId);
  state.viewer.page = page || 1;
  state.viewer.zoom = 1; // reset to fit-width whenever a fresh document/protocol is opened
  el.viewer.hidden = false;
  el.viewerTitle.textContent = state.viewer.title;
  updateFavButton();

  try {
    const doc = await getPdfDoc(docId);
    state.viewer.numPages = doc.numPages;
    await renderPage("open");
  } catch (err) {
    console.error("Failed to open PDF", err);
    el.canvasWrap.innerHTML = `<div class="empty-state" style="color:var(--text)">Couldn't load this document. If you're offline, download it first from Settings.</div>`;
  }
}

// What the viewer was asked to do decides where the page should sit afterwards:
//   open: a new document starts at its top-left
//   page: a new page starts at its top, keeping the zoomed-in column position
//   zoom: the same spot stays in the middle of the screen (also used on rotate)
// A request that arrives mid-render is remembered, not dropped, and runs with
// the latest page and zoom as soon as the current one finishes.
const RENDER_RANK = { zoom: 0, page: 1, open: 2 };
let queuedRender = null;

function captureAnchor() {
  const w = el.canvasWrap.getBoundingClientRect();
  const c = el.pdfCanvas.getBoundingClientRect();
  if (!c.width || !c.height) return null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return {
    fx: clamp((w.left + el.canvasWrap.clientWidth / 2 - c.left) / c.width),
    fy: clamp((w.top + el.canvasWrap.clientHeight / 2 - c.top) / c.height),
  };
}

function restoreScroll(mode, anchor) {
  const wrap = el.canvasWrap;
  if (mode === "open") {
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  } else if (mode === "page") {
    wrap.scrollTop = 0;
  } else if (anchor) {
    const w = wrap.getBoundingClientRect();
    const c = el.pdfCanvas.getBoundingClientRect();
    wrap.scrollLeft += c.left - w.left - (wrap.clientWidth / 2 - anchor.fx * c.width);
    wrap.scrollTop += c.top - w.top - (wrap.clientHeight / 2 - anchor.fy * c.height);
  }
}

// iOS Safari silently drops canvases above ~16.7 million pixels, which a large
// zoom on a high-density tablet would otherwise reach.
const MAX_CANVAS_PIXELS = 16e6;

async function renderPage(mode = "page") {
  if (state.viewer.rendering) {
    if (!queuedRender || RENDER_RANK[mode] > RENDER_RANK[queuedRender]) queuedRender = mode;
    return;
  }
  state.viewer.rendering = true;
  try {
    const doc = await getPdfDoc(state.viewer.docId);
    const pageNum = Math.min(Math.max(1, state.viewer.page), doc.numPages);
    state.viewer.page = pageNum;
    const page = await doc.getPage(pageNum);

    // Fit-to-width baseline: the unscaled page width maps to the available
    // canvas-wrap width, then the user's zoom multiplier is applied on top.
    const unscaledViewport = page.getViewport({ scale: 1 });
    const wrapStyle = getComputedStyle(el.canvasWrap);
    const availableWidth = el.canvasWrap.clientWidth
      - parseFloat(wrapStyle.paddingLeft) - parseFloat(wrapStyle.paddingRight);
    const baseScale = availableWidth / unscaledViewport.width;
    const cssScale = baseScale * state.viewer.zoom;
    const dpr = window.devicePixelRatio || 1;

    let renderScale = cssScale * dpr;
    const pixels = unscaledViewport.width * unscaledViewport.height * renderScale * renderScale;
    if (pixels > MAX_CANVAS_PIXELS) renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const renderViewport = page.getViewport({ scale: renderScale });
    const canvas = el.pdfCanvas;
    const ctx = canvas.getContext("2d");
    const anchor = mode === "zoom" ? captureAnchor() : null; // measured before the canvas changes size
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = `${cssScale * unscaledViewport.width}px`;
    canvas.style.height = `${cssScale * unscaledViewport.height}px`;
    restoreScroll(mode, anchor);
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    el.pageIndicator.textContent = `${pageNum} / ${doc.numPages}`;
    el.zoomIndicator.textContent = `${Math.round(state.viewer.zoom * 100)}%`;
    updateFavButton();
    updateVideoBar();
  } finally {
    state.viewer.rendering = false;
    if (queuedRender) {
      const next = queuedRender;
      queuedRender = null;
      renderPage(next).catch((err) => console.error("PDF render failed", err));
    }
  }
}

function updateFavButton() {
  const key = favKey(state.viewer.docId, state.viewer.page);
  el.favBtn.classList.toggle("active", state.favorites.has(key));
}

el.favBtn.addEventListener("click", () => {
  const key = favKey(state.viewer.docId, state.viewer.page);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  saveFavorites();
  updateFavButton();
});

el.viewerClose.addEventListener("click", closeViewer);
function closeViewer() {
  el.viewer.hidden = true;
  const top = navStack[navStack.length - 1];
  if (top && top.type === "category") applyNav(top, false);
  else render();
}

el.prevPage.addEventListener("click", () => {
  state.viewer.page = Math.max(1, state.viewer.page - 1);
  renderPage("page");
});
el.nextPage.addEventListener("click", () => {
  state.viewer.page = Math.min(state.viewer.numPages, state.viewer.page + 1);
  renderPage("page");
});
el.zoomIn.addEventListener("click", () => {
  state.viewer.zoom = Math.min(3, state.viewer.zoom + 0.25);
  renderPage("zoom");
});
el.zoomOut.addEventListener("click", () => {
  state.viewer.zoom = Math.max(0.5, state.viewer.zoom - 0.25);
  renderPage("zoom");
});

// Swipe left/right to change page on the canvas area
(function setupSwipe() {
  let startX = null, startY = null, moved = false;
  el.canvasWrap.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
  }, { passive: true });
  el.canvasWrap.addEventListener("touchmove", () => { moved = true; }, { passive: true });
  el.canvasWrap.addEventListener("touchend", (e) => {
    if (startX === null) return;
    const endX = (e.changedTouches[0] || {}).clientX ?? startX;
    const endY = (e.changedTouches[0] || {}).clientY ?? startY;
    const dx = endX - startX;
    const dy = endY - startY;
    if (moved && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5 && el.canvasWrap.scrollWidth <= el.canvasWrap.clientWidth + 4) {
      if (dx < 0) el.nextPage.click();
      else el.prevPage.click();
    }
    startX = null;
  });
})();

// ---------- Procedure videos ----------

// A protocol page links to a video when its text mentions the procedure, so
// the link survives the county renumbering pages in a new PDF. One page can
// mention several procedures (General Trauma Management covers both needle
// thoracostomy and pelvic binders), so it gets a link for each.
function videosForPage(docId, page) {
  const entry = state.searchIndex?.find((p) => p.docId === docId && p.page === page);
  if (!entry) return [];
  const text = entry.text.toLowerCase();
  return state.videos.filter((v) => (v.pageText || []).some((t) => text.includes(t)));
}

function updateVideoBar() {
  if (!el.viewerVideoBar) return;
  const vs = videosForPage(state.viewer.docId, state.viewer.page);
  el.viewerVideoBar.hidden = !vs.length;
  el.viewerVideoBar.innerHTML = vs
    .map(
      (v) => `<button class="viewer-video-link" data-video="${escapeAttr(v.id)}">
        <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
        <span>Watch: ${escapeHtml(v.title)} (${formatDuration(v.durationSec)})</span>
      </button>`
    )
    .join("");
  el.viewerVideoBar.querySelectorAll("button").forEach((b) => (b.onclick = () => openPlayer(b.dataset.video)));
}

function protocolEntryFor(v) {
  const byId = allNavEntries().find((e) => e.id === v.protocolId);
  if (byId) return byId;
  const page = state.searchIndex?.find((p) => (v.pageText || []).some((t) => p.text.toLowerCase().includes(t)));
  return page ? { docId: page.docId, page: page.page, title: docTitle(page.docId) } : null;
}

function openPlayer(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  const video = el.playerVideo;
  el.playerTitle.textContent = v.title;
  video.poster = v.poster;
  video.src = v.file;
  el.player.hidden = false;
  el.player.dataset.video = v.id;
  const entry = protocolEntryFor(v);
  el.playerProtocol.hidden = !entry || !el.viewer.hidden;
  el.playerProtocol.onclick = () => {
    closePlayer();
    if (entry) openViewer(entry.docId, entry.page, entry.title);
  };
  el.playerSave.onclick = () => saveVideo(v);
  updatePlayerOffline(v);
  video.play().catch(() => {}); // autoplay may be blocked; the controls are there
}

function updatePlayerOffline(v, message) {
  const saved = state.savedVideos.has(v.id);
  el.playerOffline.textContent = message || (saved ? "Saved on this device" : `Not saved offline (${Math.round(v.bytes / 1e6)} MB)`);
  el.playerSave.hidden = saved;
}

async function saveVideo(v) {
  updatePlayerOffline(v, "Saving…");
  el.playerSave.hidden = true;
  try {
    const cache = await caches.open(VIDEO_CACHE);
    await cache.addAll([v.file, v.poster]);
    state.savedVideos.add(v.id);
    updatePlayerOffline(v);
  } catch (err) {
    console.warn("Failed to save video", err);
    updatePlayerOffline(v, "Couldn't save. Check your connection.");
    el.playerSave.hidden = false;
  }
}

function closePlayer() {
  const video = el.playerVideo;
  video.pause();
  video.removeAttribute("src");
  video.load(); // stop any download in progress
  el.player.hidden = true;
  if (el.viewer.hidden) render();
}

el.playerClose?.addEventListener("click", closePlayer);
el.playerVideo?.addEventListener("error", () => {
  if (!el.playerVideo.getAttribute("src")) return;
  const v = state.videos.find((x) => x.id === el.player.dataset.video);
  if (v && !navigator.onLine && !state.savedVideos.has(v.id)) {
    updatePlayerOffline(v, "Not saved on this device. Save it next time you have signal.");
  }
});

// ---------- Theme / text size ----------

function setTheme(val) {
  localStorage.setItem(STORAGE_KEYS.theme, val);
  applyTheme();
}
function applyTheme() {
  const val = localStorage.getItem(STORAGE_KEYS.theme) || "system";
  if (val === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", val);
}
function setTextSize(val) {
  localStorage.setItem(STORAGE_KEYS.textSize, val);
  applyTextSize();
}
function applyTextSize() {
  const val = localStorage.getItem(STORAGE_KEYS.textSize) || "normal";
  document.documentElement.style.fontSize = val === "large" ? "112.5%" : "100%";
}

// ---------- Offline download ----------

// PDFs are fetched through the service worker, which stores them in its own
// versioned runtime cache. Writing to a cache from here instead would use a
// name the service worker doesn't know about, and it deletes unknown caches
// every time it updates.
async function downloadAllForOffline() {
  const statusEl = document.getElementById("downloadStatus");
  const barEl = document.getElementById("downloadProgressBar");
  const fillEl = document.getElementById("downloadProgressFill");
  if (!navigator.serviceWorker?.controller) {
    statusEl.textContent = "Offline storage isn't ready yet. Reload the app, then try again.";
    return;
  }
  const files = Object.values(state.protocols.documents).map((d) => `pdfs/${d.file}`);
  barEl.hidden = false;
  let done = 0;
  statusEl.textContent = `Downloading ${done}/${files.length}…`;
  for (const f of files) {
    try {
      const res = await fetch(f);
      await res.arrayBuffer();
    } catch (err) {
      console.warn("Failed to download", f, err);
    }
    done += 1;
    fillEl.style.width = `${Math.round((done / files.length) * 100)}%`;
    statusEl.textContent = `Downloading ${done}/${files.length}…`;
  }
  // The service worker finishes writing each file just after handing it back.
  let saved = 0;
  for (let tries = 0; tries < 10; tries++) {
    saved = (await Promise.all(files.map((f) => caches.match(f)))).filter(Boolean).length;
    if (saved === files.length) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  let videoNote = "";
  if (state.videos.length) {
    statusEl.textContent = "Downloading procedure videos…";
    const cache = await caches.open(VIDEO_CACHE);
    for (const v of state.videos) {
      try {
        if (!(await cache.match(v.file))) await cache.addAll([v.file, v.poster]);
        state.savedVideos.add(v.id);
      } catch (err) {
        console.warn("Failed to save video", v.file, err);
      }
    }
    const n = state.videos.filter((v) => state.savedVideos.has(v.id)).length;
    videoNote = ` ${n} of ${state.videos.length} video${state.videos.length === 1 ? "" : "s"} saved.`;
  }
  statusEl.textContent = (saved === files.length
    ? `All ${files.length} documents available offline.`
    : `${saved} of ${files.length} documents saved. Check your connection and try again.`) + videoNote;
}

window.addEventListener("resize", () => {
  if (!el.viewer.hidden) renderPage("zoom");
});

// ---------- Network status ----------

function updateOnlineStatus() {
  el.offlineToast.hidden = navigator.onLine;
}
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

// ---------- Service worker ----------

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          el.updateToast.hidden = false;
        }
      });
    });
  }).catch((err) => console.warn("SW registration failed", err));

  el.updateReload.addEventListener("click", () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg && reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    });
    window.location.reload();
  });
}

// ---------- Init ----------

async function init() {
  applyTheme();
  applyTextSize();
  updateOnlineStatus();
  await loadData();
  render();
  if (!window.__DISABLE_SW_FOR_DEV__) setupServiceWorker();
}

init();
