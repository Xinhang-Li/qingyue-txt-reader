(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.hidden = true, ms);
}
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function fmtChars(n) {
  return n >= 1e4 ? (n / 1e4).toFixed(1) + " 万字" : n + " 字";
}
function debounce(fn, ms) {
  let id;
  return (...a) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...a), ms);
  };
}
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve, reject) => {
      const req = indexedDB.open("qingyue-reader", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  store(mode = "readonly") {
    return this.open().then((d) => d.transaction("books", mode).objectStore("books"));
  },
  async put(book) {
    const s = await this.store("readwrite");
    return new Promise((res, rej) => {
      const r = s.put(book);
      r.onsuccess = res;
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    const s = await this.store();
    return new Promise((res, rej) => {
      const r = s.get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async all() {
    const s = await this.store();
    return new Promise((res, rej) => {
      const r = s.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async del(key) {
    const s = await this.store("readwrite");
    return new Promise((res, rej) => {
      const r = s.delete(key);
      r.onsuccess = res;
      r.onerror = () => rej(r.error);
    });
  }
};
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}
const CHAPTER_RE = /^[ \t　]*(?:第[0-9〇零一二三四五六七八九十百千万两０-９]+[章节回卷部篇集][^\n]{0,40}|楔子|序章|序言|序|前言|引子|尾声|后记|番外[^\n]{0,30}|Chapter\s+[0-9０-９]+[^\n]{0,40}|卷\s*[0-9〇零一二三四五六七八九十]+[^\n]{0,30})[ \t　]*$/gm;
function parseChapters(text) {
  const matches = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(text)) !== null) {
    matches.push({ title: m[0].trim(), start: m.index });
  }
  const chapters = [];
  if (matches.length === 0) {
    const CHUNK = 3e4;
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + CHUNK, text.length);
      if (end < text.length) {
        const nl = text.indexOf("\n", i + CHUNK);
        if (nl !== -1 && nl - i < CHUNK + 4e3) end = nl + 1;
      }
      chapters.push({ title: `第 ${chapters.length + 1} 节`, start: i, end });
      i = end;
    }
    if (chapters.length === 0) chapters.push({ title: "全文", start: 0, end: text.length });
    return chapters;
  }
  if (matches[0].start > 0) {
    const head = text.slice(0, matches[0].start);
    if (head.trim()) chapters.push({ title: "正文之前", start: 0, end: matches[0].start });
  }
  matches.forEach((mm, i) => {
    chapters.push({
      title: mm.title,
      start: mm.start,
      end: i + 1 < matches.length ? matches[i + 1].start : text.length
    });
  });
  return chapters;
}
const state = {
  book: null,
  // { key, name, size, text }
  chapters: [],
  // { title, start, end, el? }
  renderedUpTo: -1,
  // 已渲染到的章节下标
  currentChapter: 0,
  search: { query: "", matches: [], idx: -1 }
};
const settings = Object.assign(
  { fontSize: 19, lineHeight: 19, theme: "light", autoMode: "scroll", autoSpeed: 4, autoPageSec: 25 },
  JSON.parse(localStorage.getItem("qy-settings") || "{}")
);
function applySettings() {
  document.documentElement.style.setProperty("--fs", settings.fontSize + "px");
  document.documentElement.style.setProperty("--lh", settings.lineHeight / 10);
  document.body.dataset.theme = settings.theme;
  $("#fontSizeRange").value = settings.fontSize;
  $("#fontSizeVal").textContent = settings.fontSize;
  $("#lineHeightRange").value = settings.lineHeight;
  $("#lineHeightVal").textContent = (settings.lineHeight / 10).toFixed(1);
  $$(".theme-dot").forEach((d) => d.classList.toggle("active", d.dataset.theme === settings.theme));
  $("#modeScroll").classList.toggle("active", settings.autoMode === "scroll");
  $("#modePage").classList.toggle("active", settings.autoMode === "page");
  $("#speedRow").hidden = settings.autoMode !== "scroll";
  $("#pageRow").hidden = settings.autoMode !== "page";
  $("#speedRange").value = settings.autoSpeed;
  $("#speedVal").textContent = settings.autoSpeed + " 档";
  $("#pageSecRange").value = settings.autoPageSec;
  $("#pageSecVal").textContent = settings.autoPageSec + " 秒";
  localStorage.setItem("qy-settings", JSON.stringify(settings));
}
const contentEl = $("#content");
const scrollBox = $("#scrollBox");
function renderChapter(i) {
  const ch = state.chapters[i];
  if (!ch || ch.el) return;
  const sec = document.createElement("section");
  sec.dataset.idx = i;
  const h = document.createElement("h2");
  h.className = "chapter-title";
  h.textContent = ch.title;
  h.id = "ch-" + i;
  sec.appendChild(h);
  const body = state.book.text.slice(ch.start, ch.end);
  const frag = document.createDocumentFragment();
  ch.paraSpans = [];
  const LINE_RE = /[^\n]*\S[^\n]*/g;
  let lm;
  while ((lm = LINE_RE.exec(body)) !== null) {
    const t = lm[0].trim();
    const p = document.createElement("p");
    p.textContent = t;
    frag.appendChild(p);
    ch.paraSpans.push({ start: ch.start + lm.index + (lm[0].length - lm[0].trimStart().length), el: p, len: t.length });
  }
  sec.appendChild(frag);
  contentEl.appendChild(sec);
  ch.el = sec;
}
function renderUntil(i) {
  while (state.renderedUpTo < i && state.renderedUpTo < state.chapters.length - 1) {
    state.renderedUpTo++;
    renderChapter(state.renderedUpTo);
  }
}
const sentinelObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.book && state.renderedUpTo < state.chapters.length - 1) {
    renderUntil(state.renderedUpTo + 3);
    updateProgress();
  }
}, { root: scrollBox, rootMargin: "1200px" });
sentinelObserver.observe($("#sentinel"));
async function openFile(file) {
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) {
    toast("文件超过 80MB，可能超出浏览器处理能力");
    return;
  }
  toast("正在打开…");
  try {
    const text = (await readTextFile(file)).replace(/\r\n?/g, "\n");
    const book = {
      key: file.name + "|" + file.size,
      name: file.name.replace(/\.txt$/i, ""),
      size: file.size,
      text
    };
    const old = await db.get(book.key);
    book.progress = (old == null ? void 0 : old.progress) || null;
    await db.put({ key: book.key, name: book.name, size: book.size, text, progress: book.progress, updatedAt: Date.now() });
    enterReader(book);
  } catch (e) {
    console.error(e);
    toast("打开失败：" + (e.message || e));
  }
}
function enterReader(book) {
  state.book = book;
  state.chapters = parseChapters(book.text);
  state.renderedUpTo = -1;
  state.search = { query: "", matches: [], idx: -1 };
  contentEl.innerHTML = "";
  $("#home").hidden = true;
  $("#reader").hidden = false;
  $("#bookTitle").textContent = book.name;
  $("#bookMeta").textContent = `${fmtChars(book.text.length)} · 约 ${Math.max(1, Math.round(book.text.length / 400))} 分钟`;
  buildToc();
  renderUntil(2);
  scrollBox.scrollTop = 0;
  const p = book.progress;
  if (p && p.chapter > 0 && state.chapters[p.chapter]) {
    renderUntil(Math.min(p.chapter + 1, state.chapters.length - 1));
    requestAnimationFrame(() => {
      const el = state.chapters[p.chapter].el;
      if (el) scrollBox.scrollTop = Math.max(0, el.offsetTop + (p.offset || 0) - 70);
      updateProgress();
    });
    toast(`已从 ${Math.round((p.fraction || 0) * 100)}% 处继续阅读`);
  } else {
    updateProgress();
  }
}
function leaveReader() {
  stopAuto();
  saveProgressNow();
  state.book = null;
  state.chapters = [];
  $("#reader").hidden = true;
  $("#home").hidden = false;
  $("#sidebar").hidden = true;
  $("#autoPanel").hidden = true;
  refreshRecent();
}
function buildToc() {
  const ul = $("#tocList");
  ul.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement("li");
    li.textContent = ch.title;
    li.dataset.idx = i;
    li.addEventListener("click", () => {
      jumpToChapter(i);
      if (innerWidth < 760) $("#sidebar").hidden = true;
    });
    frag.appendChild(li);
  });
  ul.appendChild(frag);
}
function jumpToChapter(i) {
  if (!state.chapters[i]) return;
  renderUntil(Math.min(i + 1, state.chapters.length - 1));
  requestAnimationFrame(() => {
    const el = state.chapters[i].el;
    if (el) scrollBox.scrollTop = Math.max(0, el.offsetTop - 70);
    state.currentChapter = i;
    updateProgress();
  });
}
function locateCurrentChapter() {
  const top = scrollBox.scrollTop + 90;
  let cur = 0;
  for (let i = 0; i <= state.renderedUpTo; i++) {
    const el = state.chapters[i].el;
    if (el && el.offsetTop <= top) cur = i;
    else break;
  }
  return cur;
}
function updateProgress() {
  var _a;
  if (!state.book) return;
  const max = scrollBox.scrollHeight - scrollBox.clientHeight;
  const frac = max > 0 ? Math.min(1, scrollBox.scrollTop / max) : 0;
  $("#progressFill").style.width = (frac * 100).toFixed(1) + "%";
  $("#progressText").textContent = (frac * 100).toFixed(1) + "%";
  const cur = locateCurrentChapter();
  state.currentChapter = cur;
  $("#chapterName").textContent = ((_a = state.chapters[cur]) == null ? void 0 : _a.title) || "";
  $$("#tocList li").forEach((li) => li.classList.toggle("current", +li.dataset.idx === cur));
}
const saveProgressNow = () => {
  var _a;
  if (!state.book) return;
  const max = scrollBox.scrollHeight - scrollBox.clientHeight;
  const frac = max > 0 ? Math.min(1, scrollBox.scrollTop / max) : 0;
  const cur = locateCurrentChapter();
  const el = (_a = state.chapters[cur]) == null ? void 0 : _a.el;
  const progress = { chapter: cur, offset: el ? scrollBox.scrollTop - el.offsetTop : 0, fraction: frac };
  state.book.progress = progress;
  db.put({ key: state.book.key, name: state.book.name, size: state.book.size, text: state.book.text, progress, updatedAt: Date.now() }).catch(() => {
  });
};
const saveProgressDebounced = debounce(saveProgressNow, 800);
let scrollTicking = false;
scrollBox.addEventListener("scroll", () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    updateProgress();
    saveProgressDebounced();
    scrollTicking = false;
  });
});
const AUTO_SPEEDS = [0, 30, 50, 75, 105, 140, 180, 230, 300, 400, 520];
const auto = { active: false, rafId: null, timerId: null, last: 0 };
function atRealEnd() {
  return state.renderedUpTo >= state.chapters.length - 1 && scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 4;
}
function startAuto() {
  if (!state.book || auto.active) return;
  auto.active = true;
  $("#autoBtn").textContent = "⏸ 暂停";
  $("#autoBtn").classList.add("playing");
  if (settings.autoMode === "scroll") {
    auto.last = performance.now();
    auto.rafId = requestAnimationFrame(tickAuto);
  } else {
    pageFlip();
    auto.timerId = setInterval(pageFlip, settings.autoPageSec * 1e3);
  }
  toast(settings.autoMode === "scroll" ? `自动滚动 · ${settings.autoSpeed} 档` : `自动翻页 · 每 ${settings.autoPageSec} 秒`);
}
function stopAuto(msg) {
  if (!auto.active) return;
  auto.active = false;
  cancelAnimationFrame(auto.rafId);
  clearInterval(auto.timerId);
  $("#autoBtn").textContent = "▶ 自动";
  $("#autoBtn").classList.remove("playing");
  if (msg) toast(msg);
}
function toggleAuto() {
  if (auto.active) stopAuto("已暂停自动阅读");
  else startAuto();
}
function tickAuto(t) {
  if (!auto.active) return;
  const dt = Math.min(64, t - auto.last);
  auto.last = t;
  scrollBox.scrollTop += AUTO_SPEEDS[settings.autoSpeed] * dt / 1e3;
  if (atRealEnd()) {
    stopAuto("已读完全书 🎉");
    return;
  }
  auto.rafId = requestAnimationFrame(tickAuto);
}
function pageFlip() {
  if (!auto.active) return;
  if (atRealEnd()) {
    stopAuto("已读完全书 🎉");
    return;
  }
  scrollBox.scrollTop += scrollBox.clientHeight - 80;
}
scrollBox.addEventListener("wheel", () => stopAuto("已暂停自动阅读"), { passive: true });
scrollBox.addEventListener("touchstart", () => stopAuto("已暂停自动阅读"), { passive: true });
function runSearch(q) {
  state.search = { query: q, matches: [], idx: -1 };
  const ul = $("#searchResults");
  ul.innerHTML = "";
  if (!q || !state.book) {
    $("#searchInfo").textContent = "";
    return;
  }
  const text = state.book.text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const MAX = 500;
  let i = 0;
  while (state.search.matches.length < MAX) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) break;
    state.search.matches.push(idx);
    i = idx + needle.length;
  }
  const total = state.search.matches.length;
  $("#searchInfo").textContent = total === 0 ? "无结果" : total >= MAX ? `前 ${MAX} 处` : `共 ${total} 处`;
  if (total === 0) return;
  const frag = document.createDocumentFragment();
  state.search.matches.forEach((pos, n) => {
    const li = document.createElement("li");
    const ctx = text.slice(Math.max(0, pos - 18), pos + q.length + 22).replace(/\n/g, " ");
    const at = ctx.toLowerCase().indexOf(needle);
    li.innerHTML = escapeHtml(ctx.slice(0, at)) + "<b>" + escapeHtml(ctx.slice(at, at + q.length)) + "</b>" + escapeHtml(ctx.slice(at + q.length));
    li.addEventListener("click", () => gotoMatch(n));
    frag.appendChild(li);
  });
  ul.appendChild(frag);
  gotoMatch(0);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function chapterOf(pos) {
  let lo = 0, hi = state.chapters.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (state.chapters[mid].start <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
function clearMarks() {
  $$("#content mark").forEach((mk) => mk.replaceWith(document.createTextNode(mk.textContent)));
  contentEl.normalize();
}
function gotoMatch(n) {
  const { matches, query } = state.search;
  if (!matches.length) return;
  state.search.idx = (n % matches.length + matches.length) % matches.length;
  const pos = matches[state.search.idx];
  $("#searchInfo").textContent = `${state.search.idx + 1} / ${matches.length}`;
  $$("#searchResults li").forEach((li, i) => li.classList.toggle("active", i === state.search.idx));
  const chIdx = chapterOf(pos);
  renderUntil(Math.min(chIdx + 1, state.chapters.length - 1));
  requestAnimationFrame(() => {
    clearMarks();
    const ch = state.chapters[chIdx];
    const span = (ch.paraSpans || []).find((s) => pos >= s.start && pos < s.start + s.len);
    if (span && span.el.firstChild) {
      const local = pos - span.start;
      const node = span.el.firstChild;
      try {
        const range = document.createRange();
        range.setStart(node, Math.min(local, node.length));
        range.setEnd(node, Math.min(local + query.length, node.length));
        const mark = document.createElement("mark");
        mark.className = "cur";
        range.surroundContents(mark);
        mark.scrollIntoView({ block: "center" });
      } catch {
      }
    } else if (ch.el) {
      scrollBox.scrollTop = Math.max(0, ch.el.offsetTop - 70);
    }
    updateProgress();
  });
}
async function refreshRecent() {
  const books = (await db.all()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const wrap = $("#recentWrap");
  const ul = $("#recentList");
  ul.innerHTML = "";
  wrap.hidden = books.length === 0;
  for (const b of books) {
    const li = document.createElement("li");
    const pct = b.progress ? Math.round((b.progress.fraction || 0) * 100) : 0;
    li.innerHTML = `<span class="recent-name"></span><span class="recent-info">${fmtSize(b.size)} · ${pct}%</span><button class="recent-del" title="删除">✕</button>`;
    li.querySelector(".recent-name").textContent = b.name;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".recent-del")) return;
      enterReader(b);
    });
    li.querySelector(".recent-del").addEventListener("click", async () => {
      await db.del(b.key);
      refreshRecent();
      toast("已删除");
    });
    ul.appendChild(li);
  }
}
const fileInput = $("#fileInput");
$("#pickBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});
$("#dropzone").addEventListener("click", () => fileInput.click());
$("#dropzone").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  openFile(fileInput.files[0]);
  fileInput.value = "";
});
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  $("#dropOverlay").hidden = false;
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#dropOverlay").hidden = true;
  }
});
addEventListener("drop", (e) => {
  var _a, _b, _c;
  e.preventDefault();
  dragDepth = 0;
  $("#dropOverlay").hidden = true;
  const f = [...((_a = e.dataTransfer) == null ? void 0 : _a.files) || []].find((x) => /\.txt$/i.test(x.name) || x.type === "text/plain") || ((_c = (_b = e.dataTransfer) == null ? void 0 : _b.files) == null ? void 0 : _c[0]);
  if (f) openFile(f);
});
$("#backBtn").addEventListener("click", leaveReader);
$("#tocBtn").addEventListener("click", () => {
  const sb = $("#sidebar");
  sb.hidden = !sb.hidden;
  if (!sb.hidden) {
    switchTab("toc");
    scrollActiveTocIntoView();
  }
});
$("#settingsBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#autoPanel").hidden = true;
  $("#settingsPanel").hidden = !$("#settingsPanel").hidden;
});
document.addEventListener("click", (e) => {
  if (!$("#settingsPanel").hidden && !e.target.closest("#settingsPanel")) $("#settingsPanel").hidden = true;
  if (!$("#autoPanel").hidden && !e.target.closest("#autoPanel") && !e.target.closest("#autoCaret")) $("#autoPanel").hidden = true;
});
$("#autoBtn").addEventListener("click", toggleAuto);
$("#autoCaret").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#settingsPanel").hidden = true;
  $("#autoPanel").hidden = !$("#autoPanel").hidden;
});
$("#modeScroll").addEventListener("click", () => {
  settings.autoMode = "scroll";
  applySettings();
  if (auto.active) {
    stopAuto();
    startAuto();
  }
});
$("#modePage").addEventListener("click", () => {
  settings.autoMode = "page";
  applySettings();
  if (auto.active) {
    stopAuto();
    startAuto();
  }
});
$("#speedRange").addEventListener("input", (e) => {
  settings.autoSpeed = +e.target.value;
  applySettings();
});
$("#pageSecRange").addEventListener("input", (e) => {
  settings.autoPageSec = +e.target.value;
  applySettings();
  if (auto.active && settings.autoMode === "page") {
    clearInterval(auto.timerId);
    auto.timerId = setInterval(pageFlip, settings.autoPageSec * 1e3);
  }
});
function scrollActiveTocIntoView() {
  var _a;
  (_a = $("#tocList li.current")) == null ? void 0 : _a.scrollIntoView({ block: "center" });
}
$("#fontUp").addEventListener("click", () => {
  settings.fontSize = Math.min(28, settings.fontSize + 1);
  applySettings();
});
$("#fontDown").addEventListener("click", () => {
  settings.fontSize = Math.max(14, settings.fontSize - 1);
  applySettings();
});
function switchTab(name) {
  const isToc = name === "toc";
  $("#tabToc").classList.toggle("active", isToc);
  $("#tabSearch").classList.toggle("active", !isToc);
  $("#tocPanel").hidden = !isToc;
  $("#searchPanel").hidden = isToc;
  if (!isToc) $("#searchInput").focus();
}
$("#tabToc").addEventListener("click", () => switchTab("toc"));
$("#tabSearch").addEventListener("click", () => switchTab("search"));
$("#sideClose").addEventListener("click", () => $("#sidebar").hidden = true);
$("#searchInput").addEventListener("input", debounce((e) => runSearch(e.target.value.trim()), 250));
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gotoMatch(state.search.idx + (e.shiftKey ? -1 : 1));
  }
});
$("#nextMatch").addEventListener("click", () => gotoMatch(state.search.idx + 1));
$("#prevMatch").addEventListener("click", () => gotoMatch(state.search.idx - 1));
$("#fontSizeRange").addEventListener("input", (e) => {
  settings.fontSize = +e.target.value;
  applySettings();
});
$("#lineHeightRange").addEventListener("input", (e) => {
  settings.lineHeight = +e.target.value;
  applySettings();
});
$$(".theme-dot").forEach((d) => d.addEventListener("click", () => {
  settings.theme = d.dataset.theme;
  applySettings();
}));
addEventListener("keydown", (e) => {
  var _a;
  if ($("#reader").hidden) return;
  const typing = /INPUT|TEXTAREA/.test(((_a = document.activeElement) == null ? void 0 : _a.tagName) || "");
  if (e.key === "Escape") {
    if (!$("#sidebar").hidden) {
      $("#sidebar").hidden = true;
      return;
    }
    if (!$("#settingsPanel").hidden) {
      $("#settingsPanel").hidden = true;
      return;
    }
    if (!$("#autoPanel").hidden) {
      $("#autoPanel").hidden = true;
      return;
    }
    if (!typing) leaveReader();
    return;
  }
  if (typing) return;
  if (e.key === " ") {
    e.preventDefault();
    toggleAuto();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    $("#sidebar").hidden = false;
    switchTab("search");
  }
  if (e.key === "ArrowRight") {
    stopAuto();
    jumpToChapter(Math.min(state.currentChapter + 1, state.chapters.length - 1));
  }
  if (e.key === "ArrowLeft") {
    stopAuto();
    jumpToChapter(Math.max(state.currentChapter - 1, 0));
  }
});
addEventListener("beforeunload", saveProgressNow);
applySettings();
refreshRecent();
