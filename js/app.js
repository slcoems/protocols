import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./js/pdfjs/pdf.worker.min.mjs";

const STORAGE_KEYS = {
  favorites: "slco-protocols:favorites",
  theme: "slco-protocols:theme",
  textSize: "slco-protocols:text-size",
};

const state = {
  protocols: null,
  searchIndex: null,
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
      <span class="row-title">${escapeHtml(cat.title)}<div class="row-sub">${cat.protocols.length} protocol${cat.protocols.length === 1 ? "" : "s"}</div></span>
      <span class="row-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`).join("");
  html += `</div>`;

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
          <div class="settings-sub">Caches every PDF for use with no signal</div>
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

function renderSearchResults() {
  const q = state.query.trim().toLowerCase();
  if (q.length < 2) {
    el.app.innerHTML = `<div class="empty-state">Keep typing to search…</div>`;
    return;
  }
  const words = q.split(/\s+/).filter(Boolean);
  const navByKey = new Map(allNavEntries().map((e) => [`${e.docId}#${e.page}`, e]));

  const titleMatches = [];
  const textMatches = [];

  for (const entry of allNavEntries()) {
    if (entry.title.toLowerCase().includes(q)) titleMatches.push(entry);
  }

  for (const page of state.searchIndex) {
    const lower = page.text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const key = `${page.docId}#${page.page}`;
    if (titleMatches.some((t) => `${t.docId}#${t.page}` === key)) continue;
    textMatches.push(page);
  }

  const total = titleMatches.length + textMatches.length;
  if (!total) {
    el.app.innerHTML = `<div class="empty-state">No results for "${escapeHtml(state.query)}"</div>`;
    return;
  }

  let html = `<div class="card-list">`;
  html += titleMatches.map((entry) => rowHTML(entry)).join("");
  html += textMatches.slice(0, 40).map((page) => {
    const entry = navByKey.get(`${page.docId}#${page.page}`) || {
      docId: page.docId, page: page.page, title: docTitle(page.docId),
    };
    const snippet = buildSnippet(page.text, words);
    return `
      <button class="row-btn" data-doc="${entry.docId}" data-page="${entry.page}" data-title="${escapeAttr(entry.title)}">
        <span class="row-title">${escapeHtml(entry.title)}<div class="search-snippet">${snippet}</div></span>
        <span class="search-result-page">p.${entry.page}</span>
      </button>`;
  }).join("");
  html += `</div>`;
  el.app.innerHTML = html;
}

function docTitle(docId) {
  return state.protocols?.documents?.[docId]?.title || docId;
}

function buildSnippet(text, words) {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const w of words) {
    idx = lower.indexOf(w);
    if (idx !== -1) break;
  }
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 120);
  let snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  snippet = escapeHtml(snippet);
  for (const w of words) {
    const re = new RegExp(`(${escapeRegex(w)})`, "ig");
    snippet = snippet.replace(re, "<mark>$1</mark>");
  }
  return snippet;
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
  const navBtn = e.target.closest("[data-nav='category']");
  if (navBtn) {
    applyNav({ type: "category", catId: navBtn.dataset.cat });
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
    await renderPage();
  } catch (err) {
    console.error("Failed to open PDF", err);
    el.canvasWrap.innerHTML = `<div class="empty-state" style="color:var(--text)">Couldn't load this document. If you're offline, download it first from Settings.</div>`;
  }
}

async function renderPage() {
  if (state.viewer.rendering) return;
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

    const renderViewport = page.getViewport({ scale: cssScale * dpr });
    const canvas = el.pdfCanvas;
    const ctx = canvas.getContext("2d");
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = `${cssScale * unscaledViewport.width}px`;
    canvas.style.height = `${cssScale * unscaledViewport.height}px`;
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    el.pageIndicator.textContent = `${pageNum} / ${doc.numPages}`;
    el.zoomIndicator.textContent = `${Math.round(state.viewer.zoom * 100)}%`;
    updateFavButton();
  } finally {
    state.viewer.rendering = false;
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
  renderPage();
});
el.nextPage.addEventListener("click", () => {
  state.viewer.page = Math.min(state.viewer.numPages, state.viewer.page + 1);
  renderPage();
});
el.zoomIn.addEventListener("click", () => {
  state.viewer.zoom = Math.min(3, state.viewer.zoom + 0.25);
  renderPage();
});
el.zoomOut.addEventListener("click", () => {
  state.viewer.zoom = Math.max(0.5, state.viewer.zoom - 0.25);
  renderPage();
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
  statusEl.textContent = saved === files.length
    ? `All ${files.length} documents available offline.`
    : `${saved} of ${files.length} documents saved. Check your connection and try again.`;
}

window.addEventListener("resize", () => {
  if (!el.viewer.hidden) renderPage();
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
