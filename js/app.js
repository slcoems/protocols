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
  pageTone: "slco-protocols:page-tone",
  zoom: "slco-protocols:zoom",
};

// localStorage throws in some private-browsing modes. Preferences are a
// convenience, never a reason for the app to stop working.
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* not persisted */ }
  },
};

// 100% is "the page's content fits the screen width".
const ZOOM_STEPS = [0.75, 1, 1.5, 2, 2.5, 3];

const state = {
  protocols: null,
  searchIndex: null,
  pageText: new Map(), // "docId#page" -> flattened page text
  videos: [],
  savedVideos: new Set(), // ids saved for offline
  view: "home",
  query: "",
  favorites: loadFavorites(),
  pdfDocs: new Map(), // docId -> pdfjs document proxy
  viewer: {
    docId: null,
    openTitle: null, // the title the viewer was opened with
    openPage: 1,
    page: 1,
    numPages: 1,
    zoom: loadZoom(), // multiplier on top of the content-fit baseline (1 = fit)
    rendering: false,
  },
};

const el = {
  app: document.getElementById("app"),
  topbar: document.getElementById("topbar"),
  topTitle: document.getElementById("topTitle"),
  backBtn: document.getElementById("backBtn"),
  favBtn: document.getElementById("favBtn"),
  searchWrap: document.getElementById("searchWrap"),
  searchInput: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  tabbar: document.getElementById("tabbar"),
  announcer: document.getElementById("announcer"),
  viewer: document.getElementById("viewer"),
  viewerTitle: document.getElementById("viewerTitle"),
  viewerClose: document.getElementById("viewerClose"),
  viewerStatus: document.getElementById("viewerStatus"),
  pdfCanvas: document.getElementById("pdfCanvas"),
  pdfText: document.getElementById("pdfText"),
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

// Spoken to screen readers through the polite live region. Delayed announcements
// (search results while typing) restart on each call so only the last is read.
let announceTimer = null;
function announce(message, delay = 0) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    el.announcer.textContent = "";
    setTimeout(() => { el.announcer.textContent = message; }, 50);
  }, delay);
}

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
    return new Set(JSON.parse(store.get(STORAGE_KEYS.favorites) || "[]"));
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  store.set(STORAGE_KEYS.favorites, JSON.stringify([...state.favorites]));
}

function loadZoom() {
  const z = Number(store.get(STORAGE_KEYS.zoom));
  return ZOOM_STEPS.includes(z) ? z : 1;
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
  state.pageText = new Map(state.searchIndex.map((pg) => [`${pg.docId}#${pg.page}`, pg.text]));
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
    const on = b.dataset.view === state.view;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
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
      ${opts.icon ? `<span class="category-icon" aria-hidden="true">${opts.icon}</span>` : ""}
      <span class="row-title">${escapeHtml(entry.title)}${opts.showSub ? `<div class="row-sub">${escapeHtml(opts.showSub)}</div>` : ""}</span>
      ${isFav ? favStarHTML() : ""}
      <span class="row-chevron"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

function formatDuration(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

function videoRowHTML(v) {
  const saved = state.savedVideos.has(v.id) ? " · Saved offline" : "";
  return `
    <button class="row-btn" data-video="${escapeAttr(v.id)}">
      <span class="category-icon" aria-hidden="true"><svg class="play-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>
      <span class="row-title">${escapeHtml(v.title)}<div class="row-sub">${formatDuration(v.durationSec)} · ${escapeHtml(v.scope)}${saved}</div></span>
      <span class="row-chevron"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

function favStarHTML() {
  return `<span class="row-fav-star"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4.5c1.7-2 5.7-2.3 7.8.5 2 2.7 1 6-1 8-2 2-4.8 4.3-6.8 6-2-1.7-4.8-4-6.8-6-2-2-3-5.3-1-8 2.1-2.8 6.1-2.5 7.8-.5z" fill="currentColor"/></svg></span>`;
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
  html += `<h2 class="section-title">Clinical Protocols</h2><div class="card-list">`;
  html += p.clinicalCategories.map((cat) => `
    <button class="row-btn" data-nav="category" data-cat="${cat.id}">
      <span class="category-icon" aria-hidden="true">${CATEGORY_ICONS[cat.id] || "📋"}</span>
      <span class="row-title">${escapeHtml(cat.title)}<div class="row-sub">${cat.protocols.length} ${cat.noun || "protocol"}${cat.protocols.length === 1 ? "" : "s"}</div></span>
      <span class="row-chevron"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`).join("");
  html += `</div>`;

  if (state.videos.length) {
    html += `<h2 class="section-title">Procedure Videos</h2><div class="card-list">`;
    html += state.videos.map((v) => videoRowHTML(v)).join("");
    html += `</div>`;
  }

  html += `<h2 class="section-title">Reference</h2><div class="card-list">`;
  html += p.reference.map((r) => rowHTML(r, { icon: "📄" })).join("");
  html += `</div>`;

  el.app.innerHTML = html;
}

function renderCategory(catId) {
  const cat = state.protocols.clinicalCategories.find((c) => c.id === catId);
  if (!cat) return renderHome();
  el.app.innerHTML = `<h2 class="section-title">${escapeHtml(cat.title)}</h2><div class="card-list">${
    cat.protocols.map((pr) => rowHTML(pr)).join("")
  }</div>`;
  el.topTitle.textContent = cat.title;
  el.backBtn.hidden = false;
  el.backBtn.onclick = () => { navBack(); };
}

// Favorites are stored as "doc#page", so any page can be saved, not just the
// ones a bookmark starts on. Titles come from the same page -> protocol lookup
// search uses.
function renderFavorites() {
  const keys = [...state.favorites].reverse().filter((k) => state.protocols.documents[k.split("#")[0]]); // newest first
  if (!keys.length) {
    el.app.innerHTML = `<div class="empty-state">No favorites yet.<br>Tap the heart inside a protocol to pin that page here.</div>`;
    return;
  }
  el.app.innerHTML = `<div class="card-list">${keys.map(favoriteRowHTML).join("")}</div>`;
}

function favoriteRowHTML(key) {
  const [docId, pageStr] = key.split("#");
  const page = Number(pageStr);
  const { title } = contextForPage(docId, page);
  return `
    <button class="row-btn" data-doc="${escapeAttr(docId)}" data-page="${page}" data-title="${escapeAttr(title)}">
      <span class="row-title">${escapeHtml(title)}</span>
      ${page > 1 ? `<span class="search-result-page">p.${page}</span>` : ""}
      <span class="row-chevron"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

function renderAdmin() {
  const p = state.protocols;
  let html = `<h2 class="section-title">Administrative & Operational</h2><div class="card-list">${
    p.administrative.map((a) => rowHTML(a, { icon: "📋" })).join("")
  }</div>`;
  if (p.departmentVariances && p.departmentVariances.length) {
    html += `<h2 class="section-title">Department Variances</h2><div class="card-list">${
      p.departmentVariances.map((v) => rowHTML(v, { icon: "🚑" })).join("")
    }</div>`;
  }
  el.app.innerHTML = html;
}

function segmentedHTML(id, labelId, options, current) {
  const buttons = options.map((o) =>
    `<button data-val="${o.val}" aria-pressed="${o.val === current}"${o.label ? ` aria-label="${o.label}"` : ""}>${o.text}</button>`
  ).join("");
  return `<div class="segmented" id="${id}" role="group" aria-labelledby="${labelId}">${buttons}</div>`;
}

function renderSettings() {
  const theme = store.get(STORAGE_KEYS.theme) || "system";
  const textSize = store.get(STORAGE_KEYS.textSize) || "normal";
  const tone = store.get(STORAGE_KEYS.pageTone) || "dim";
  el.app.innerHTML = `
    <h2 class="section-title">Appearance</h2>
    <div class="card-list">
      <div class="settings-row">
        <span class="settings-label" id="lblTheme">Theme</span>
        ${segmentedHTML("themeSeg", "lblTheme", [
          { val: "light", text: "Light" }, { val: "system", text: "Auto" }, { val: "dark", text: "Dark" },
        ], theme)}
      </div>
      <div class="settings-row">
        <span class="settings-label" id="lblText">Text size</span>
        ${segmentedHTML("textSeg", "lblText", [
          { val: "normal", text: "A", label: "Normal" }, { val: "large", text: "A+", label: "Large" }, { val: "xlarge", text: "A++", label: "Largest" },
        ], textSize)}
      </div>
      <div class="settings-row">
        <span>
          <div class="settings-label" id="lblTone">Pages at night</div>
          <div class="settings-sub">Dims or inverts PDF pages while the theme is dark</div>
        </span>
        ${segmentedHTML("toneSeg", "lblTone", [
          { val: "off", text: "Normal" }, { val: "dim", text: "Dim" }, { val: "invert", text: "Invert" },
        ], tone)}
      </div>
    </div>

    <h2 class="section-title">Offline Access</h2>
    <div class="card-list">
      <div class="settings-row">
        <span>
          <div class="settings-label">Download all protocols</div>
          <div class="settings-sub">Caches every PDF${state.videos.length ? " and procedure video" : ""} for use with no signal</div>
        </span>
        <button class="action-btn" id="downloadAllBtn">Download</button>
      </div>
      <div class="download-status" id="downloadStatus" role="status"></div>
      <div class="progress-bar" id="downloadProgressBar" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div class="progress-bar-fill" id="downloadProgressFill"></div></div>
    </div>

    <h2 class="section-title">About</h2>
    <div class="card-list">
      <div class="settings-row">
        <span class="settings-label">Source</span>
        <span class="settings-sub">2bprotocols.com — Salt Lake County EMS</span>
      </div>
    </div>
  `;

  // Update the pressed state in place so keyboard focus stays on the control.
  const bindSegmented = (id, apply) => {
    const group = document.getElementById(id);
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      apply(btn.dataset.val);
      group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    });
  };
  bindSegmented("themeSeg", setTheme);
  bindSegmented("textSeg", setTextSize);
  bindSegmented("toneSeg", setPageTone);
  document.getElementById("downloadAllBtn").addEventListener("click", downloadAllForOffline);
  refreshOfflineStatus();
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
  const byName = videoMatches.length + titleMatches.length;
  announce(
    `${byName} ${byName === 1 ? "match" : "matches"} by name, ${textMatches.length} more ${textMatches.length === 1 ? "page mentions" : "pages mention"} ${raw}`,
    700
  );

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
    html += `<h2 class="section-title">${top ? "Also mentioned" : "Mentioned"} on ${n} page${n === 1 ? "" : "s"}</h2>`;
    html += `<div class="card-list">${textMatches.slice(0, MAX_TEXT_RESULTS).map((m) => textHitRowHTML(m, groups)).join("")}</div>`;
    if (n > MAX_TEXT_RESULTS) {
      html += `<div class="search-note">Showing the ${MAX_TEXT_RESULTS} best matches of ${n}. Add a word to narrow it down.</div>`;
    }
  }
  el.app.innerHTML = html;
}

function renderNoResults(raw) {
  const fix = suggestCorrection(raw);
  announce(fix ? `No results for ${raw}. Did you mean ${fix}?` : `No results for ${raw}`, 700);
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
    announce(el.topTitle.textContent);
    return;
  }
  const videoBtn = e.target.closest(".row-btn[data-video]");
  if (videoBtn) {
    openPlayer(videoBtn.dataset.video, videoBtn);
    return;
  }
  const rowBtn = e.target.closest(".row-btn[data-doc]");
  if (rowBtn) {
    openViewer(rowBtn.dataset.doc, Number(rowBtn.dataset.page), rowBtn.dataset.title, rowBtn);
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
  announce(el.topTitle.textContent);
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

// ---------- Dialogs (PDF viewer, video player) ----------

// While a dialog is open everything behind it is inert: not focusable, not
// readable by a screen reader, not tappable. The video player opens over the
// viewer, so then the viewer is what goes inert.
function selectorFor(node) {
  if (!node || node === document.body) return null;
  const d = node.dataset || {};
  if (d.doc) return `.row-btn[data-doc="${CSS.escape(d.doc)}"][data-page="${CSS.escape(d.page)}"]`;
  if (d.video) return `[data-video="${CSS.escape(d.video)}"]`;
  if (d.nav) return `[data-cat="${CSS.escape(d.cat)}"]`;
  return node.id ? `#${CSS.escape(node.id)}` : null;
}

function openDialog(dialog, initialFocus, trigger) {
  const layer = dialog === el.player && !el.viewer.hidden ? [el.viewer] : [el.topbar, el.searchWrap, el.app, el.tabbar];
  layer.forEach((n) => n.setAttribute("inert", ""));
  dialog._layer = layer;
  dialog._returnTo = selectorFor(trigger);
  dialog.hidden = false;
  initialFocus?.focus({ preventScroll: true });
}

function closeDialog(dialog) {
  dialog.hidden = true;
  (dialog._layer || []).forEach((n) => n.removeAttribute("inert"));
  dialog._layer = null;
  return dialog._returnTo;
}

// Put focus back where the user was, after the list behind has re-rendered.
function restoreFocus(selector) {
  const target = (selector && document.querySelector(selector)) || el.app;
  target.focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "Escape") {
    if (!el.player.hidden) closePlayer();
    else if (!el.viewer.hidden) closeViewer();
    return;
  }
  if (el.viewer.hidden || !el.player.hidden) return;
  if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || "")) return;
  if (e.key === "ArrowRight") el.nextPage.click();
  else if (e.key === "ArrowLeft") el.prevPage.click();
  else if (e.key === "+" || e.key === "=") el.zoomIn.click();
  else if (e.key === "-") el.zoomOut.click();
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

// Where a page's ink actually is. County PDFs carry wide blank margins, so
// "100%" fits the content, not the paper: the same screen shows larger type.
// Measured from a small render, so images and colour bars count as content too.
const cropCache = new Map();
async function contentRange(docId, page, pageNum) {
  const key = `${docId}#${pageNum}`;
  if (cropCache.has(key)) return cropCache.get(key);
  let range = { x0: 0, x1: 1 };
  try {
    const vp = page.getViewport({ scale: 0.35 });
    const probe = document.createElement("canvas");
    probe.width = Math.ceil(vp.width);
    probe.height = Math.ceil(vp.height);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, probe.width, probe.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data, width, height } = ctx.getImageData(0, 0, probe.width, probe.height);
    let min = width;
    let max = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          if (x < min) min = x;
          if (x > max) max = x;
        }
      }
    }
    if (max >= 0) {
      const pad = 0.03;
      range = { x0: Math.max(0, min / width - pad), x1: Math.min(1, (max + 1) / width + pad) };
    }
    if (range.x1 - range.x0 < 0.5) range = { x0: 0, x1: 1 }; // a mostly blank page: show it whole
  } catch (err) {
    console.warn("Couldn't measure page content", err);
  }
  cropCache.set(key, range);
  return range;
}

function setViewerStatus(message, retry) {
  el.viewerStatus.replaceChildren();
  el.viewerStatus.hidden = !message;
  el.canvasWrap.setAttribute("aria-busy", String(Boolean(message) && !retry));
  if (!message) return;
  el.viewerStatus.append(message);
  if (retry) {
    const btn = document.createElement("button");
    btn.textContent = "Try again";
    btn.onclick = retry;
    el.viewerStatus.append(btn);
  }
}

function showViewerError(err) {
  console.error("PDF viewer error", err);
  const v = state.viewer;
  setViewerStatus(
    navigator.onLine
      ? "Couldn't load this page."
      : "Couldn't load this page. You're offline. Download protocols from Settings while you have signal.",
    () => openViewer(v.docId, v.page, v.openTitle)
  );
}

async function openViewer(docId, page, title, trigger) {
  const v = state.viewer;
  v.docId = docId;
  v.page = page || 1;
  v.openPage = v.page;
  v.openTitle = title || docTitle(docId);
  v.zoom = loadZoom(); // the zoom the reader last chose, not a reset
  el.viewerTitle.textContent = v.openTitle;
  el.pageIndicator.textContent = "…";
  el.pdfText.textContent = "";
  setViewerStatus("Loading…");
  updateFavButton();
  updateDock();
  if (el.viewer.hidden) openDialog(el.viewer, el.viewerClose, trigger);

  try {
    const doc = await getPdfDoc(docId);
    v.numPages = doc.numPages;
    await renderPage("open");
  } catch (err) {
    showViewerError(err);
  }
}

// What the viewer was asked to do decides where the page should sit afterwards:
//   open: a new document starts at its top-left
//   page: a new page starts at its top, keeping the zoomed-in column position
//   zoom: the same spot stays where it was on screen (also used on rotate)
// A request that arrives mid-render is remembered, not dropped, and runs with
// the latest page and zoom as soon as the current one finishes.
const RENDER_RANK = { zoom: 0, page: 1, open: 2 };
let queuedRender = null;
let pendingAnchorPoint = null; // a screen point to hold still while zooming (double-tap)

function captureAnchor() {
  const wrap = el.canvasWrap;
  const w = wrap.getBoundingClientRect();
  const c = el.pdfCanvas.getBoundingClientRect();
  if (!c.width || !c.height) return null;
  const sx = pendingAnchorPoint ? pendingAnchorPoint.x - w.left : wrap.clientWidth / 2;
  const sy = pendingAnchorPoint ? pendingAnchorPoint.y - w.top : wrap.clientHeight / 2;
  pendingAnchorPoint = null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return { sx, sy, fx: clamp((w.left + sx - c.left) / c.width), fy: clamp((w.top + sy - c.top) / c.height) };
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
    wrap.scrollLeft += c.left - w.left - (anchor.sx - anchor.fx * c.width);
    wrap.scrollTop += c.top - w.top - (anchor.sy - anchor.fy * c.height);
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
    const v = state.viewer;
    const doc = await getPdfDoc(v.docId);
    const pageNum = Math.min(Math.max(1, v.page), doc.numPages);
    v.page = pageNum;
    const page = await doc.getPage(pageNum);
    if (mode !== "zoom") pendingAnchorPoint = null;

    // Fit the page's content (not its blank margins) to the available width,
    // then apply the reader's zoom on top.
    const unscaled = page.getViewport({ scale: 1 });
    const crop = await contentRange(v.docId, page, pageNum);
    const cropW = unscaled.width * (crop.x1 - crop.x0);
    const wrapStyle = getComputedStyle(el.canvasWrap);
    const availableWidth = el.canvasWrap.clientWidth - parseFloat(wrapStyle.paddingLeft) - parseFloat(wrapStyle.paddingRight);
    const cssScale = (availableWidth / cropW) * v.zoom;
    const dpr = window.devicePixelRatio || 1;

    let renderScale = cssScale * dpr;
    const pixels = cropW * unscaled.height * renderScale * renderScale;
    if (pixels > MAX_CANVAS_PIXELS) renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const renderViewport = page.getViewport({ scale: renderScale, offsetX: -crop.x0 * unscaled.width * renderScale });
    const canvas = el.pdfCanvas;
    const ctx = canvas.getContext("2d");
    const anchor = mode === "zoom" ? captureAnchor() : null; // measured before the canvas changes size
    canvas.width = Math.ceil(cropW * renderScale);
    canvas.height = Math.ceil(renderViewport.height);
    canvas.style.width = `${cssScale * cropW}px`;
    canvas.style.height = `${cssScale * unscaled.height}px`;
    restoreScroll(mode, anchor);
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    setViewerStatus("");
    el.viewerTitle.textContent = pageNum === v.openPage ? v.openTitle : contextForPage(v.docId, pageNum).title;
    // The canvas is a picture of text; this is the same page's text for assistive tech.
    el.pdfText.textContent = state.pageText.get(`${v.docId}#${pageNum}`) || "No text is available for this page.";
    el.pageIndicator.textContent = `${pageNum} / ${doc.numPages}`;
    el.zoomIndicator.textContent = `${Math.round(v.zoom * 100)}%`;
    updateFavButton();
    updateDock();
    updateVideoBar();
  } catch (err) {
    showViewerError(err);
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
  const on = state.favorites.has(favKey(state.viewer.docId, state.viewer.page));
  el.favBtn.setAttribute("aria-pressed", String(on));
}

function updateDock() {
  const v = state.viewer;
  el.prevPage.disabled = v.page <= 1;
  el.nextPage.disabled = v.page >= v.numPages;
  el.zoomOut.disabled = v.zoom <= ZOOM_STEPS[0];
  el.zoomIn.disabled = v.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

el.favBtn.addEventListener("click", () => {
  const key = favKey(state.viewer.docId, state.viewer.page);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  saveFavorites();
  updateFavButton();
  announce(state.favorites.has(key) ? "Added to favorites" : "Removed from favorites");
});

el.viewerClose.addEventListener("click", closeViewer);
function closeViewer() {
  const back = closeDialog(el.viewer);
  const top = navStack[navStack.length - 1];
  if (top && top.type === "category") applyNav(top, false);
  else render();
  restoreFocus(back);
}

el.prevPage.addEventListener("click", () => {
  state.viewer.page = Math.max(1, state.viewer.page - 1);
  updateDock();
  renderPage("page");
});
el.nextPage.addEventListener("click", () => {
  state.viewer.page = Math.min(state.viewer.numPages, state.viewer.page + 1);
  updateDock();
  renderPage("page");
});

function nextZoom(dir) {
  const z = state.viewer.zoom;
  const steps = dir > 0 ? ZOOM_STEPS.filter((s) => s > z + 1e-9) : ZOOM_STEPS.filter((s) => s < z - 1e-9).reverse();
  return steps[0] ?? z;
}
function setZoom(zoom, anchorPoint) {
  if (zoom === state.viewer.zoom) return;
  state.viewer.zoom = zoom;
  store.set(STORAGE_KEYS.zoom, String(zoom));
  pendingAnchorPoint = anchorPoint || null;
  el.zoomIndicator.textContent = `${Math.round(zoom * 100)}%`;
  updateDock();
  renderPage("zoom");
}
el.zoomIn.addEventListener("click", () => setZoom(nextZoom(1)));
el.zoomOut.addEventListener("click", () => setZoom(nextZoom(-1)));

// Double-tap toggles between fit and a readable zoom around the tapped spot.
function toggleZoomAt(x, y) {
  setZoom(state.viewer.zoom < 1.5 ? 2 : 1, { x, y });
}

// Gestures on the page: a horizontal swipe turns the page (unless the page is
// zoomed past the screen, when it pans), and a double-tap zooms.
(function setupGestures() {
  const wrap = el.canvasWrap;
  let start = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let lastDoubleTap = 0;
  wrap.addEventListener("touchstart", (e) => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  wrap.addEventListener("touchend", (e) => {
    if (!start || e.changedTouches.length !== 1) { start = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    start = null;
    if (Math.hypot(dx, dy) < 10) {
      const now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
        lastTap.t = 0;
        lastDoubleTap = now;
        toggleZoomAt(t.clientX, t.clientY);
      } else {
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
      return;
    }
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5 && wrap.scrollWidth <= wrap.clientWidth + 4) {
      (dx < 0 ? el.nextPage : el.prevPage).click();
    }
  });
  // Mouse users (and some browsers after a touch double-tap): don't toggle twice.
  wrap.addEventListener("dblclick", (e) => {
    if (Date.now() - lastDoubleTap > 600) toggleZoomAt(e.clientX, e.clientY);
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
  const bar = el.viewerVideoBar;
  if (!bar) return;
  const vs = videosForPage(state.viewer.docId, state.viewer.page);
  bar.hidden = vs.length === 0;
  if (!vs.length) {
    bar.innerHTML = "";
    return;
  }
  const play = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>`;
  const link = (v, label) => `<button class="viewer-video-link" data-video="${escapeAttr(v.id)}">${play}<span>${label}<span class="video-len"> (${formatDuration(v.durationSec)})</span></span></button>`;
  if (vs.length === 1) {
    bar.innerHTML = link(vs[0], `Watch: ${escapeHtml(vs[0].title)}`);
  } else {
    // Several procedures on one page: one row, expanded on demand.
    bar.innerHTML = `
      <button class="viewer-video-toggle" aria-expanded="false" aria-controls="viewerVideoList">${play}<span>Procedure videos on this page (${vs.length})</span><svg class="chev" aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="viewer-video-list" id="viewerVideoList" hidden>${vs.map((v) => link(v, escapeHtml(v.title))).join("")}</div>`;
    const toggle = bar.querySelector(".viewer-video-toggle");
    const list = bar.querySelector(".viewer-video-list");
    toggle.onclick = () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    };
  }
  bar.querySelectorAll(".viewer-video-link").forEach((b) => (b.onclick = () => openPlayer(b.dataset.video, b)));
}

function protocolEntryFor(v) {
  const byId = allNavEntries().find((e) => e.id === v.protocolId);
  if (byId) return byId;
  const page = state.searchIndex?.find((p) => (v.pageText || []).some((t) => p.text.toLowerCase().includes(t)));
  return page ? { docId: page.docId, page: page.page, title: docTitle(page.docId) } : null;
}

function openPlayer(id, trigger) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  const video = el.playerVideo;
  el.playerTitle.textContent = v.title;
  video.poster = v.poster;
  video.src = v.file;
  el.player.dataset.video = v.id;
  openDialog(el.player, el.playerClose, trigger);
  const entry = protocolEntryFor(v);
  el.playerProtocol.hidden = !entry || !el.viewer.hidden;
  el.playerProtocol.onclick = () => {
    closePlayer();
    if (entry) openViewer(entry.docId, entry.page, entry.title);
  };
  el.playerSave.onclick = () => saveVideo(v);
  updatePlayerOffline(v);
  // A reader who asked for reduced motion gets a video that waits for Play.
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) video.play().catch(() => {}); // autoplay may be blocked; the controls are there
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
  const back = closeDialog(el.player);
  if (el.viewer.hidden) render();
  restoreFocus(back);
}

el.playerClose?.addEventListener("click", closePlayer);
el.playerVideo?.addEventListener("error", () => {
  if (!el.playerVideo.getAttribute("src")) return;
  const v = state.videos.find((x) => x.id === el.player.dataset.video);
  if (v && !navigator.onLine && !state.savedVideos.has(v.id)) {
    updatePlayerOffline(v, "Not saved on this device. Save it next time you have signal.");
  }
});

// ---------- Theme / text size / page tone ----------

// "Auto" is resolved here (and in index.html before first paint) to light or
// dark, so the stylesheet only ever has one dark palette.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const CHROME_COLORS = { light: "#1d4ed8", dark: "#14213d" }; // the status-bar tint matches the top bar
const TEXT_SCALES = { normal: "100%", large: "125%", xlarge: "150%" };

function setTheme(val) {
  store.set(STORAGE_KEYS.theme, val);
  applyTheme();
}
function applyTheme() {
  const pref = store.get(STORAGE_KEYS.theme) || "system";
  const theme = pref === "dark" || (pref !== "light" && darkQuery.matches) ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeColor")?.setAttribute("content", CHROME_COLORS[theme]);
}
darkQuery.addEventListener?.("change", () => {
  if ((store.get(STORAGE_KEYS.theme) || "system") === "system") applyTheme();
});

function setTextSize(val) {
  store.set(STORAGE_KEYS.textSize, val);
  applyTextSize();
}
function applyTextSize() {
  document.documentElement.style.fontSize = TEXT_SCALES[store.get(STORAGE_KEYS.textSize) || "normal"] || "100%";
}

function setPageTone(val) {
  store.set(STORAGE_KEYS.pageTone, val);
  applyPageTone();
}
function applyPageTone() {
  document.documentElement.setAttribute("data-page-tone", store.get(STORAGE_KEYS.pageTone) || "dim");
}

// The bars are sized by their text, so measure them instead of guessing: the
// sticky search box and the bottom padding follow the real heights.
function observeChromeHeights() {
  if (!("ResizeObserver" in window)) return;
  const set = () => {
    const root = document.documentElement.style;
    root.setProperty("--topbar-h", `${el.topbar.offsetHeight}px`);
    root.setProperty("--tabbar-h", `${el.tabbar.offsetHeight}px`);
  };
  const ro = new ResizeObserver(set);
  ro.observe(el.topbar);
  ro.observe(el.tabbar);
  set();
}

// ---------- Offline download ----------

// What's on this device right now, so Settings answers "will this work with no
// signal?" every time it's opened, not just right after a download.
async function refreshOfflineStatus() {
  const statusEl = document.getElementById("downloadStatus");
  if (!statusEl || !("caches" in window)) return;
  const files = Object.values(state.protocols.documents).map((d) => `pdfs/${d.file}`);
  const saved = (await Promise.all(files.map((f) => caches.match(f)))).filter(Boolean).length;
  if (statusEl.dataset.busy || !statusEl.isConnected) return; // a download is reporting its own progress, or the view changed
  statusEl.textContent = saved === files.length
    ? `All ${files.length} documents are saved on this device.`
    : saved
      ? `${saved} of ${files.length} documents are saved on this device.`
      : "Nothing saved yet (about 7 MB).";
}

// PDFs are fetched through the service worker, which stores them in its own
// versioned runtime cache. Writing to a cache from here instead would use a
// name the service worker doesn't know about, and it deletes unknown caches
// every time it updates.
async function downloadAllForOffline() {
  const btn = document.getElementById("downloadAllBtn");
  const statusEl = document.getElementById("downloadStatus");
  const barEl = document.getElementById("downloadProgressBar");
  const fillEl = document.getElementById("downloadProgressFill");
  if (!navigator.serviceWorker?.controller) {
    statusEl.textContent = "Offline storage isn't ready yet. Reload the app, then try again.";
    return;
  }
  btn.disabled = true; // no second download while one is running
  statusEl.dataset.busy = "1";
  const files = Object.values(state.protocols.documents).map((d) => `pdfs/${d.file}`);
  barEl.hidden = false;
  const progress = (done) => {
    const pct = Math.round((done / files.length) * 100);
    fillEl.style.width = `${pct}%`;
    barEl.setAttribute("aria-valuenow", String(pct));
    statusEl.textContent = `Downloading ${done}/${files.length}…`;
  };
  try {
    progress(0);
    for (let i = 0; i < files.length; i++) {
      try {
        const res = await fetch(files[i]);
        await res.arrayBuffer();
      } catch (err) {
        console.warn("Failed to download", files[i], err);
      }
      progress(i + 1);
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
      ? `All ${files.length} documents are saved on this device.`
      : `${saved} of ${files.length} documents saved. Check your connection and try again.`) + videoNote;
  } finally {
    delete statusEl.dataset.busy;
    btn.disabled = false;
  }
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
  applyPageTone();
  observeChromeHeights();
  updateOnlineStatus();
  await loadData();
  render();
  // ?nosw skips the service worker, so development edits aren't served stale.
  if (!location.search.includes("nosw")) setupServiceWorker();
}

init();
