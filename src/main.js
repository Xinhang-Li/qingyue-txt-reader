import './style.css';

/* ================= 工具 ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtChars(n) {
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';
}

function debounce(fn, ms) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}

/* ================= IndexedDB（书库 + 进度） ================= */
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve, reject) => {
      const req = indexedDB.open('qingyue-reader', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('books', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  store(mode = 'readonly') {
    return this.open().then((d) => d.transaction('books', mode).objectStore('books'));
  },
  async put(book) {
    const s = await this.store('readwrite');
    return new Promise((res, rej) => { const r = s.put(book); r.onsuccess = res; r.onerror = () => rej(r.error); });
  },
  async get(key) {
    const s = await this.store();
    return new Promise((res, rej) => { const r = s.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async all() {
    const s = await this.store();
    return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
  },
  async del(key) {
    const s = await this.store('readwrite');
    return new Promise((res, rej) => { const r = s.delete(key); r.onsuccess = res; r.onerror = () => rej(r.error); });
  },
};

/* ================= 文件读取与编码识别 ================= */
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  // 优先按 UTF-8 严格解码，失败则回退 GBK（覆盖绝大多数中文 txt）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/* ================= 章节解析 ================= */
const CHAPTER_RE =
  /^[ \t　]*(?:第[0-9〇零一二三四五六七八九十百千万两０-９]+[章节回卷部篇集][^\n]{0,40}|楔子|序章|序言|序|前言|引子|尾声|后记|番外[^\n]{0,30}|Chapter\s+[0-9０-９]+[^\n]{0,40}|卷\s*[0-9〇零一二三四五六七八九十]+[^\n]{0,30})[ \t　]*$/gm;

function parseChapters(text) {
  const matches = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(text)) !== null) {
    matches.push({ title: m[0].trim(), start: m.index });
  }
  const chapters = [];
  if (matches.length === 0) {
    // 无章节标记：按约 3 万字切段，保证大文件也能分块渲染
    const CHUNK = 30000;
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + CHUNK, text.length);
      if (end < text.length) {
        const nl = text.indexOf('\n', i + CHUNK);
        if (nl !== -1 && nl - i < CHUNK + 4000) end = nl + 1;
      }
      chapters.push({ title: `第 ${chapters.length + 1} 节`, start: i, end });
      i = end;
    }
    if (chapters.length === 0) chapters.push({ title: '全文', start: 0, end: text.length });
    return chapters;
  }
  // 正文前的内容（简介等）
  if (matches[0].start > 0) {
    const head = text.slice(0, matches[0].start);
    if (head.trim()) chapters.push({ title: '正文之前', start: 0, end: matches[0].start });
  }
  matches.forEach((mm, i) => {
    chapters.push({
      title: mm.title,
      start: mm.start,
      end: i + 1 < matches.length ? matches[i + 1].start : text.length,
    });
  });
  return chapters;
}

/* ================= 阅读器状态 ================= */
const state = {
  book: null,        // { key, name, size, text }
  chapters: [],      // { title, start, end, el? }
  renderedUpTo: -1,  // 已渲染到的章节下标
  currentChapter: 0,
  search: { query: '', matches: [], idx: -1 },
};

const settings = Object.assign(
  { fontSize: 19, lineHeight: 19, theme: 'light', autoMode: 'scroll', autoSpeed: 4, autoPageSec: 25, readWidth: 44, ttsRate: 10, ttsVoice: '' },
  JSON.parse(localStorage.getItem('qy-settings') || '{}')
);

function applySettings() {
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--lh', settings.lineHeight / 10);
  document.documentElement.style.setProperty('--read-width', settings.readWidth + 'rem');
  document.body.dataset.theme = settings.theme;
  $('#fontSizeRange').value = settings.fontSize;
  $('#fontSizeVal').textContent = settings.fontSize;
  $('#lineHeightRange').value = settings.lineHeight;
  $('#lineHeightVal').textContent = (settings.lineHeight / 10).toFixed(1);
  $('#readWidthRange').value = settings.readWidth;
  $('#readWidthVal').textContent = settings.readWidth;
  $$('.theme-dot').forEach((d) => d.classList.toggle('active', d.dataset.theme === settings.theme));
  // 自动阅读面板
  $('#modeScroll').classList.toggle('active', settings.autoMode === 'scroll');
  $('#modePage').classList.toggle('active', settings.autoMode === 'page');
  $('#speedRow').hidden = settings.autoMode !== 'scroll';
  $('#pageRow').hidden = settings.autoMode !== 'page';
  $('#speedRange').value = settings.autoSpeed;
  $('#speedVal').textContent = settings.autoSpeed + ' 档';
  $('#pageSecRange').value = settings.autoPageSec;
  $('#pageSecVal').textContent = settings.autoPageSec + ' 秒';
  // 语音朗读面板
  $('#ttsRateRange').value = settings.ttsRate;
  $('#ttsRateVal').textContent = (settings.ttsRate / 10).toFixed(1) + 'x';
  localStorage.setItem('qy-settings', JSON.stringify(settings));
}

/* ================= 渲染（分章 + 懒加载） ================= */
const contentEl = $('#content');
const scrollBox = $('#scrollBox');

function renderChapter(i) {
  const ch = state.chapters[i];
  if (!ch || ch.el) return;
  const sec = document.createElement('section');
  sec.dataset.idx = i;
  const h = document.createElement('h2');
  h.className = 'chapter-title';
  h.textContent = ch.title;
  h.id = 'ch-' + i;
  sec.appendChild(h);

  const body = state.book.text.slice(ch.start, ch.end);
  const frag = document.createDocumentFragment();
  ch.paraSpans = [];
  const LINE_RE = /[^\n]*\S[^\n]*/g;
  let lm;
  while ((lm = LINE_RE.exec(body)) !== null) {
    const t = lm[0].trim();
    const p = document.createElement('p');
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

// 哨兵：滚到底部附近时继续渲染后续章节
const sentinelObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.book && state.renderedUpTo < state.chapters.length - 1) {
    renderUntil(state.renderedUpTo + 3);
    updateProgress();
  }
}, { root: scrollBox, rootMargin: '1200px' });
sentinelObserver.observe($('#sentinel'));

/* ================= 打开书籍 ================= */
async function openFile(file) {
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) { toast('文件超过 80MB，可能超出浏览器处理能力'); return; }
  toast('正在打开…');
  try {
    const text = (await readTextFile(file)).replace(/\r\n?/g, '\n');
    const book = {
      key: file.name + '|' + file.size,
      name: file.name.replace(/\.txt$/i, ''),
      size: file.size,
      text,
    };
    const old = await db.get(book.key);
    book.progress = old?.progress || null;
    book.bookmarks = old?.bookmarks || [];
    await db.put({ key: book.key, name: book.name, size: book.size, text, progress: book.progress, bookmarks: book.bookmarks, updatedAt: Date.now() });
    enterReader(book);
  } catch (e) {
    console.error(e);
    toast('打开失败：' + (e.message || e));
  }
}

function enterReader(book) {
  state.book = book;
  state.chapters = parseChapters(book.text);
  state.renderedUpTo = -1;
  state.search = { query: '', matches: [], idx: -1 };
  contentEl.innerHTML = '';
  $('#aiPanel').hidden = true;
  $('#ttsPanel').hidden = true;
  hideSelToolbar();

  $('#home').hidden = true;
  $('#reader').hidden = false;
  $('#bookTitle').textContent = book.name;
  $('#bookMeta').textContent = `${fmtChars(book.text.length)} · 约 ${Math.max(1, Math.round(book.text.length / 400))} 分钟`;

  buildToc();
  renderUntil(2);
  scrollBox.scrollTop = 0;

  // 恢复进度
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
  stopTts();
  saveProgressNow();
  state.book = null;
  state.chapters = [];
  $('#reader').hidden = true;
  $('#home').hidden = false;
  $('#sidebar').hidden = true;
  $('#autoPanel').hidden = true;
  $('#ttsPanel').hidden = true;
  $('#aiPanel').hidden = true;
  hideSelToolbar();
  refreshRecent();
}

/* ================= 目录 ================= */
function buildToc() {
  const ul = $('#tocList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.textContent = ch.title;
    li.dataset.idx = i;
    li.addEventListener('click', () => { jumpToChapter(i); if (innerWidth < 760) $('#sidebar').hidden = true; });
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

/* ================= 进度 ================= */
function locateCurrentChapter() {
  const top = scrollBox.scrollTop + 90;
  let cur = 0;
  for (let i = 0; i <= state.renderedUpTo; i++) {
    const el = state.chapters[i].el;
    if (el && el.offsetTop <= top) cur = i; else break;
  }
  return cur;
}

function updateProgress() {
  if (!state.book) return;
  const max = scrollBox.scrollHeight - scrollBox.clientHeight;
  const frac = max > 0 ? Math.min(1, scrollBox.scrollTop / max) : 0;
  $('#progressFill').style.width = (frac * 100).toFixed(1) + '%';
  $('#progressText').textContent = (frac * 100).toFixed(1) + '%';

  const cur = locateCurrentChapter();
  state.currentChapter = cur;
  $('#chapterName').textContent = state.chapters[cur]?.title || '';
  $$('#tocList li').forEach((li) => li.classList.toggle('current', +li.dataset.idx === cur));
}

const saveProgressNow = () => {
  if (!state.book) return;
  const max = scrollBox.scrollHeight - scrollBox.clientHeight;
  const frac = max > 0 ? Math.min(1, scrollBox.scrollTop / max) : 0;
  const cur = locateCurrentChapter();
  const el = state.chapters[cur]?.el;
  const progress = { chapter: cur, offset: el ? scrollBox.scrollTop - el.offsetTop : 0, fraction: frac };
  state.book.progress = progress;
  db.put({ key: state.book.key, name: state.book.name, size: state.book.size, text: state.book.text, progress, bookmarks: state.book.bookmarks || [], updatedAt: Date.now() }).catch(() => {});
};
const saveProgressDebounced = debounce(saveProgressNow, 800);

let scrollTicking = false;
scrollBox.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => { updateProgress(); saveProgressDebounced(); scrollTicking = false; });
});

/* ================= 自动阅读（连续滚动 / 整屏翻页） ================= */
// 连续滚动各档速度（px/s）
const AUTO_SPEEDS = [0, 30, 50, 75, 105, 140, 180, 230, 300, 400, 520];

const auto = { active: false, rafId: null, timerId: null, last: 0 };

function atRealEnd() {
  return state.renderedUpTo >= state.chapters.length - 1 &&
    scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 4;
}

function startAuto() {
  if (!state.book || auto.active) return;
  stopTts(); // 朗读与自动阅读互斥
  auto.active = true;
  $('#autoBtn').textContent = '⏸ 暂停';
  $('#autoBtn').classList.add('playing');
  if (settings.autoMode === 'scroll') {
    auto.last = performance.now();
    auto.rafId = requestAnimationFrame(tickAuto);
  } else {
    pageFlip(); // 立即翻第一屏，避免干等
    auto.timerId = setInterval(pageFlip, settings.autoPageSec * 1000);
  }
  toast(settings.autoMode === 'scroll' ? `自动滚动 · ${settings.autoSpeed} 档` : `自动翻页 · 每 ${settings.autoPageSec} 秒`);
}

function stopAuto(msg) {
  if (!auto.active) return;
  auto.active = false;
  cancelAnimationFrame(auto.rafId);
  clearInterval(auto.timerId);
  $('#autoBtn').textContent = '▶ 自动';
  $('#autoBtn').classList.remove('playing');
  if (msg) toast(msg);
}

function toggleAuto() {
  if (auto.active) stopAuto('已暂停自动阅读');
  else startAuto();
}

function tickAuto(t) {
  if (!auto.active) return;
  const dt = Math.min(64, t - auto.last);
  auto.last = t;
  scrollBox.scrollTop += AUTO_SPEEDS[settings.autoSpeed] * dt / 1000;
  if (atRealEnd()) { stopAuto('已读完全书 🎉'); return; }
  auto.rafId = requestAnimationFrame(tickAuto);
}

function pageFlip() {
  if (!auto.active) return;
  if (atRealEnd()) { stopAuto('已读完全书 🎉'); return; }
  scrollBox.scrollTop += scrollBox.clientHeight - 80;
}

// 手动滚动 / 触摸即暂停
scrollBox.addEventListener('wheel', () => stopAuto('已暂停自动阅读'), { passive: true });
scrollBox.addEventListener('touchstart', () => stopAuto('已暂停自动阅读'), { passive: true });

/* ================= 搜索 ================= */
function runSearch(q) {
  state.search = { query: q, matches: [], idx: -1 };
  const ul = $('#searchResults');
  ul.innerHTML = '';
  if (!q || !state.book) { $('#searchInfo').textContent = ''; return; }

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
  $('#searchInfo').textContent = total === 0 ? '无结果' : (total >= MAX ? `前 ${MAX} 处` : `共 ${total} 处`);
  if (total === 0) return;

  const frag = document.createDocumentFragment();
  state.search.matches.forEach((pos, n) => {
    const li = document.createElement('li');
    const ctx = text.slice(Math.max(0, pos - 18), pos + q.length + 22).replace(/\n/g, ' ');
    const at = ctx.toLowerCase().indexOf(needle);
    li.innerHTML = escapeHtml(ctx.slice(0, at)) + '<b>' + escapeHtml(ctx.slice(at, at + q.length)) + '</b>' + escapeHtml(ctx.slice(at + q.length));
    li.addEventListener('click', () => gotoMatch(n));
    frag.appendChild(li);
  });
  ul.appendChild(frag);
  gotoMatch(0);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chapterOf(pos) {
  let lo = 0, hi = state.chapters.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.chapters[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function clearMarks() {
  $$('#content mark').forEach((mk) => mk.replaceWith(document.createTextNode(mk.textContent)));
  contentEl.normalize();
  // normalize 会合并文本节点，段落 span 缓存中的 el 仍有效（元素未被移除）
}

function gotoMatch(n) {
  const { matches, query } = state.search;
  if (!matches.length) return;
  state.search.idx = ((n % matches.length) + matches.length) % matches.length;
  const pos = matches[state.search.idx];
  $('#searchInfo').textContent = `${state.search.idx + 1} / ${matches.length}`;
  $$('#searchResults li').forEach((li, i) => li.classList.toggle('active', i === state.search.idx));

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
        const mark = document.createElement('mark');
        mark.className = 'cur';
        range.surroundContents(mark);
        mark.scrollIntoView({ block: 'center' });
      } catch { /* 忽略边界异常 */ }
    } else if (ch.el) {
      scrollBox.scrollTop = Math.max(0, ch.el.offsetTop - 70);
    }
    updateProgress();
  });
}

/* ================= 书库列表 ================= */
async function refreshRecent() {
  const books = (await db.all()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const wrap = $('#recentWrap');
  const ul = $('#recentList');
  ul.innerHTML = '';
  wrap.hidden = books.length === 0;
  for (const b of books) {
    const li = document.createElement('li');
    const pct = b.progress ? Math.round((b.progress.fraction || 0) * 100) : 0;
    li.innerHTML = `<span class="recent-name"></span><span class="recent-info">${fmtSize(b.size)} · ${pct}%</span><button class="recent-del" title="删除">✕</button>`;
    li.querySelector('.recent-name').textContent = b.name;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.recent-del')) return;
      enterReader(b);
    });
    li.querySelector('.recent-del').addEventListener('click', async () => {
      await db.del(b.key);
      refreshRecent();
      toast('已删除');
    });
    ul.appendChild(li);
  }
}

/* ================= 事件绑定 ================= */
const fileInput = $('#fileInput');
$('#pickBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
$('#dropzone').addEventListener('click', () => fileInput.click());
$('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { openFile(fileInput.files[0]); fileInput.value = ''; });

// 全局拖放
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  const f = [...(e.dataTransfer?.files || [])].find((x) => /\.txt$/i.test(x.name) || x.type === 'text/plain') || e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// 顶栏
$('#backBtn').addEventListener('click', leaveReader);
$('#tocBtn').addEventListener('click', () => {
  const sb = $('#sidebar');
  sb.hidden = !sb.hidden;
  if (!sb.hidden) { switchTab('toc'); scrollActiveTocIntoView(); }
});
$('#settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#autoPanel').hidden = true; $('#ttsPanel').hidden = true; $('#settingsPanel').hidden = !$('#settingsPanel').hidden; });
document.addEventListener('click', (e) => {
  if (!$('#settingsPanel').hidden && !e.target.closest('#settingsPanel') && !e.target.closest('#settingsBtn')) $('#settingsPanel').hidden = true;
  if (!$('#autoPanel').hidden && !e.target.closest('#autoPanel') && !e.target.closest('#autoCaret') && !e.target.closest('#autoBtn')) $('#autoPanel').hidden = true;
  if (!$('#ttsPanel').hidden && !e.target.closest('#ttsPanel') && !e.target.closest('#ttsCaret') && !e.target.closest('#ttsBtn')) $('#ttsPanel').hidden = true;
  if (!$('#selToolbar').hidden && !e.target.closest('#selToolbar')) hideSelToolbar();
});

// 自动阅读
$('#autoBtn').addEventListener('click', toggleAuto);
$('#autoCaret').addEventListener('click', (e) => { e.stopPropagation(); $('#settingsPanel').hidden = true; $('#ttsPanel').hidden = true; $('#autoPanel').hidden = !$('#autoPanel').hidden; });
$('#modeScroll').addEventListener('click', () => { settings.autoMode = 'scroll'; applySettings(); if (auto.active) { stopAuto(); startAuto(); } });
$('#modePage').addEventListener('click', () => { settings.autoMode = 'page'; applySettings(); if (auto.active) { stopAuto(); startAuto(); } });
$('#speedRange').addEventListener('input', (e) => { settings.autoSpeed = +e.target.value; applySettings(); });
$('#pageSecRange').addEventListener('input', (e) => {
  settings.autoPageSec = +e.target.value;
  applySettings();
  if (auto.active && settings.autoMode === 'page') { clearInterval(auto.timerId); auto.timerId = setInterval(pageFlip, settings.autoPageSec * 1000); }
});

function scrollActiveTocIntoView() {
  $('#tocList li.current')?.scrollIntoView({ block: 'center' });
}

// 字号快捷按钮
$('#fontUp').addEventListener('click', () => { settings.fontSize = Math.min(28, settings.fontSize + 1); applySettings(); });
$('#fontDown').addEventListener('click', () => { settings.fontSize = Math.max(14, settings.fontSize - 1); applySettings(); });

// 侧栏 tab
function switchTab(name) {
  $('#tabToc').classList.toggle('active', name === 'toc');
  $('#tabSearch').classList.toggle('active', name === 'search');
  $('#tabMark').classList.toggle('active', name === 'mark');
  $('#tocPanel').hidden = name !== 'toc';
  $('#searchPanel').hidden = name !== 'search';
  $('#markPanel').hidden = name !== 'mark';
  if (name === 'search') $('#searchInput').focus();
  if (name === 'mark') renderBookmarks();
}
$('#tabToc').addEventListener('click', () => switchTab('toc'));
$('#tabSearch').addEventListener('click', () => switchTab('search'));
$('#tabMark').addEventListener('click', () => switchTab('mark'));
$('#sideClose').addEventListener('click', () => ($('#sidebar').hidden = true));

// 搜索
$('#searchInput').addEventListener('input', debounce((e) => runSearch(e.target.value.trim()), 250));
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(state.search.idx + (e.shiftKey ? -1 : 1)); }
});
$('#nextMatch').addEventListener('click', () => gotoMatch(state.search.idx + 1));
$('#prevMatch').addEventListener('click', () => gotoMatch(state.search.idx - 1));

// 设置面板
$('#fontSizeRange').addEventListener('input', (e) => { settings.fontSize = +e.target.value; applySettings(); });
$('#lineHeightRange').addEventListener('input', (e) => { settings.lineHeight = +e.target.value; applySettings(); });
$('#readWidthRange').addEventListener('input', (e) => { settings.readWidth = +e.target.value; applySettings(); });
$$('.theme-dot').forEach((d) => d.addEventListener('click', () => { settings.theme = d.dataset.theme; applySettings(); }));

// 键盘快捷键
addEventListener('keydown', (e) => {
  if ($('#reader').hidden) return;
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') {
    if (!$('#sidebar').hidden) { $('#sidebar').hidden = true; return; }
    if (!$('#settingsPanel').hidden) { $('#settingsPanel').hidden = true; return; }
    if (!$('#autoPanel').hidden) { $('#autoPanel').hidden = true; return; }
    if (!$('#ttsPanel').hidden) { $('#ttsPanel').hidden = true; return; }
    if (!$('#aiPanel').hidden) { $('#aiPanel').hidden = true; return; }
    hideSelToolbar();
    if (!typing) leaveReader();
    return;
  }
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); toggleAuto(); return; }
  if (e.key === 'r' || e.key === 'R') { toggleTts(); return; }
  if (e.key === 'b' || e.key === 'B') { addBookmark(); return; }
  if (e.key === '/') { e.preventDefault(); $('#sidebar').hidden = false; switchTab('search'); }
  if (e.key === 'ArrowRight') { stopAuto(); jumpToChapter(Math.min(state.currentChapter + 1, state.chapters.length - 1)); }
  if (e.key === 'ArrowLeft') { stopAuto(); jumpToChapter(Math.max(state.currentChapter - 1, 0)); }
});

// 离开页面前保存进度
addEventListener('beforeunload', saveProgressNow);

/* ================= 语音朗读（Web Speech API） ================= */
const tts = { active: false, paused: false, queue: [], idx: 0, readingEl: null, token: 0, retries: 0 };
let ttsVoices = [];

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const list = speechSynthesis.getVoices();
  ttsVoices = list.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('zh'));
  if (!ttsVoices.length) ttsVoices = list; // 无中文语音时列出全部
  const sel = $('#voiceSelect');
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = '系统默认';
  sel.appendChild(o0);
  ttsVoices.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = v.name + (v.localService ? '' : '（在线）');
    sel.appendChild(o);
  });
  sel.value = settings.ttsVoice || '';
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

// 把长段落按标点切成 ≤120 字的小段，避免语音引擎截断或卡死
function chunkForSpeech(text, max = 120) {
  const parts = text.split(/(?<=[。！？；…])|(?<=[，、：,.!?;:])/);
  const out = [];
  let buf = '';
  for (const part of parts) {
    if (buf && (buf + part).length > max) { out.push(buf); buf = ''; }
    buf += part;
    while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim());
}

// 当前视口顶部附近的绝对文本位置
function currentTextPos() {
  const cur = locateCurrentChapter();
  const ch = state.chapters[cur];
  if (!ch) return 0;
  const top = scrollBox.scrollTop + 90;
  for (const s of ch.paraSpans || []) {
    if (s.el.offsetTop + s.el.offsetHeight > top) return s.start;
  }
  return ch.start;
}

function buildTtsQueue(fromPos) {
  const q = [];
  for (let ci = chapterOf(fromPos); ci < state.chapters.length; ci++) {
    const c = state.chapters[ci];
    const body = state.book.text.slice(c.start, c.end);
    const LINE_RE2 = /[^\n]*\S[^\n]*/g;
    let lm;
    while ((lm = LINE_RE2.exec(body)) !== null) {
      const t = lm[0].trim();
      const start = c.start + lm.index + (lm[0].length - lm[0].trimStart().length);
      if (start + t.length <= fromPos) continue;
      for (const piece of chunkForSpeech(t)) q.push({ ci, paraStart: start, text: piece });
    }
  }
  return q;
}

function ttsHighlight(item) {
  if (tts.readingEl) { tts.readingEl.classList.remove('reading'); tts.readingEl = null; }
  renderUntil(Math.min(item.ci + 1, state.chapters.length - 1));
  const ch = state.chapters[item.ci];
  const span = ch && (ch.paraSpans || []).find((s) => s.start === item.paraStart);
  if (span) {
    span.el.classList.add('reading');
    tts.readingEl = span.el;
    span.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateProgress();
  }
}

function speakCurrent() {
  if (!tts.active || tts.paused) return;
  const item = tts.queue[tts.idx];
  if (!item) { stopTts('已朗读完全书 🎉'); return; }
  ttsHighlight(item);
  const tk = ++tts.token; // 令牌：cancel 后迟到的 onend/onerror 不再推进队列
  const u = new SpeechSynthesisUtterance(item.text);
  u.rate = settings.ttsRate / 10;
  const v = ttsVoices.find((x) => x.voiceURI === settings.ttsVoice);
  if (v) u.voice = v;
  u.onend = () => { if (tk !== tts.token || !tts.active || tts.paused) return; tts.retries = 0; tts.idx++; speakCurrent(); };
  u.onerror = (e) => {
    if (tk !== tts.token) return;
    if (e.error === 'canceled' || e.error === 'interrupted') {
      // cancel 余波误伤新 utterance：稍候重读当前段，避免队列停摆
      if (tts.active && !tts.paused && tts.retries < 3) {
        tts.retries++;
        setTimeout(() => { if (tk === tts.token && tts.active && !tts.paused) speakCurrent(); }, 150);
      }
      return;
    }
    if (tts.active) { tts.idx++; speakCurrent(); } // 跳过读不了的片段
  };
  speechSynthesis.speak(u);
  // 看门狗：个别平台 cancel+speak 后 utterance 被静默丢弃（无任何回调），2.5 秒后若无声则重读
  setTimeout(() => {
    if (tk === tts.token && tts.active && !tts.paused && !speechSynthesis.speaking && !speechSynthesis.pending) speakCurrent();
  }, 2500);
}

// 朗读中直接重读当前段（换音色/语速立即生效，无需暂停）
function restartTtsCurrent() {
  if (!tts.active || tts.paused) return;
  const tk = ++tts.token; // 先作废旧 utterance 的回调，再 cancel
  speechSynthesis.cancel();
  // Chrome 对紧贴 cancel 的 speak 可能静默丢弃/误打断，延迟一拍再播报；
  // 连续拖动语速条时只有最后一次延迟生效（令牌比对）
  setTimeout(() => { if (tk === tts.token && tts.active && !tts.paused) speakCurrent(); }, 80);
}

function startTts() {
  startTtsFrom(currentTextPos());
}

// 从任意文本位置开始朗读（停止先前朗读）
function startTtsFrom(pos) {
  if (!state.book) return;
  if (!('speechSynthesis' in window)) { toast('当前环境不支持语音朗读'); return; }
  stopAuto(); // 与自动阅读互斥
  speechSynthesis.cancel();
  tts.queue = buildTtsQueue(pos);
  if (!tts.queue.length) { toast('后面没有可朗读的内容了'); return; }
  tts.idx = 0;
  tts.retries = 0;
  tts.active = true;
  tts.paused = false;
  $('#ttsBtn').textContent = '⏸ 朗读中';
  $('#ttsBtn').classList.add('playing');
  speakCurrent();
  toast('开始朗读');
}

function pauseTts() {
  tts.paused = true;
  speechSynthesis.pause();
  $('#ttsBtn').textContent = '▶ 继续';
}

function resumeTts() {
  tts.paused = false;
  $('#ttsBtn').textContent = '⏸ 朗读中';
  speechSynthesis.resume();
  // 个别平台 resume 无效：若 2 秒后仍无声音，重新播报当前段
  setTimeout(() => {
    if (tts.active && !tts.paused && !speechSynthesis.speaking && !speechSynthesis.pending) speakCurrent();
  }, 2000);
}

function stopTts(msg) {
  if (!tts.active) return;
  tts.active = false;
  tts.paused = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (tts.readingEl) { tts.readingEl.classList.remove('reading'); tts.readingEl = null; }
  $('#ttsBtn').textContent = '🔊 朗读';
  $('#ttsBtn').classList.remove('playing');
  if (msg) toast(msg);
}

function toggleTts() {
  if (!tts.active) startTts();
  else if (tts.paused) resumeTts();
  else pauseTts();
}

$('#ttsBtn').addEventListener('click', toggleTts);
$('#ttsCaret').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#settingsPanel').hidden = true;
  $('#autoPanel').hidden = true;
  $('#ttsPanel').hidden = !$('#ttsPanel').hidden;
});
$('#ttsStopBtn').addEventListener('click', () => stopTts('已停止朗读'));
$('#voiceSelect').addEventListener('change', (e) => { settings.ttsVoice = e.target.value; applySettings(); restartTtsCurrent(); });
$('#ttsRateRange').addEventListener('input', (e) => { settings.ttsRate = +e.target.value; applySettings(); restartTtsCurrent(); });

/* ================= 书签 ================= */
function bookMarks() {
  if (!state.book.bookmarks) state.book.bookmarks = [];
  return state.book.bookmarks;
}

function persistBook() {
  const b = state.book;
  return db.put({ key: b.key, name: b.name, size: b.size, text: b.text, progress: b.progress || null, bookmarks: bookMarks(), updatedAt: Date.now() }).catch(() => {});
}

function addBookmark() {
  if (!state.book) return;
  const cur = locateCurrentChapter();
  const ch = state.chapters[cur];
  const pos = currentTextPos();
  const snippet = state.book.text.slice(pos, pos + 24).replace(/\n/g, ' ').trim();
  const marks = bookMarks();
  if (marks.some((m) => m.pos === pos)) { toast('此处已有书签'); return; }
  marks.push({
    pos,
    chapter: cur,
    offset: ch.el ? scrollBox.scrollTop - ch.el.offsetTop : 0,
    snippet,
    chapterTitle: ch.title,
    time: Date.now(),
  });
  marks.sort((a, b) => a.pos - b.pos);
  persistBook();
  renderBookmarks();
  toast('已添加书签 🔖');
}

function renderBookmarks() {
  const ul = $('#markList');
  ul.innerHTML = '';
  const marks = state.book ? bookMarks() : [];
  if (!marks.length) {
    const li = document.createElement('li');
    li.className = 'mark-empty';
    li.textContent = '暂无书签 · 读到喜欢的地方按 B 或点顶栏 🔖';
    ul.appendChild(li);
    return;
  }
  for (const m of marks) {
    const li = document.createElement('li');
    const d = new Date(m.time);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    li.innerHTML = '<div class="mark-text"><span class="mark-name"></span><span class="mark-info"></span></div><button class="recent-del" title="删除">✕</button>';
    li.querySelector('.mark-name').textContent = m.snippet || '（空白处）';
    li.querySelector('.mark-info').textContent = `${m.chapterTitle || ''} · ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.recent-del')) return;
      jumpToBookmark(m);
      if (innerWidth < 760) $('#sidebar').hidden = true;
    });
    li.querySelector('.recent-del').addEventListener('click', () => {
      const arr = bookMarks();
      const i = arr.indexOf(m);
      if (i >= 0) arr.splice(i, 1);
      persistBook();
      renderBookmarks();
      toast('已删除书签');
    });
    ul.appendChild(li);
  }
}

function jumpToBookmark(m) {
  const ci = Math.min(m.chapter, state.chapters.length - 1);
  renderUntil(Math.min(ci + 1, state.chapters.length - 1));
  requestAnimationFrame(() => {
    const el = state.chapters[ci].el;
    if (el) scrollBox.scrollTop = Math.max(0, el.offsetTop + (m.offset || 0) - 70);
    state.currentChapter = ci;
    updateProgress();
  });
}

$('#bookmarkBtn').addEventListener('click', addBookmark);

/* ================= AI 划线辅助阅读 ================= */
const aiCfg = Object.assign(
  { base: 'https://api.moonshot.cn/v1', key: '', model: 'kimi-k2-0905-preview' },
  JSON.parse(localStorage.getItem('qy-ai') || '{}')
);
function saveAiCfg() { localStorage.setItem('qy-ai', JSON.stringify(aiCfg)); }

let selCtx = null; // { text, pos, chapterTitle }
let aiConv = [];   // 当前划线内容的对话记录

function hideSelToolbar() { const tb = $('#selToolbar'); if (tb) tb.hidden = true; }

function showSelToolbar(rect) {
  const tb = $('#selToolbar');
  tb.hidden = false;
  const w = tb.offsetWidth, h = tb.offsetHeight;
  let x = rect.left + rect.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  let y = rect.top - h - 8;
  if (y < 56) y = rect.bottom + 8;
  tb.style.left = x + 'px';
  tb.style.top = y + 'px';
}

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('#selToolbar') || e.target.closest('#aiPanel') || e.target.closest('#sidebar')) return;
  setTimeout(() => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !state.book || $('#reader').hidden) { hideSelToolbar(); return; }
    const range = sel.getRangeAt(0);
    const text = range.toString().trim();
    if (!text) { hideSelToolbar(); return; }
    if (!contentEl.contains(range.commonAncestorContainer)) { hideSelToolbar(); return; }
    const sec = range.startContainer.parentElement && range.startContainer.parentElement.closest('section');
    const ci = sec ? +sec.dataset.idx : locateCurrentChapter();
    const ch = state.chapters[ci];
    const span = ch && (ch.paraSpans || []).find((s) => s.el.contains(range.startContainer));
    selCtx = {
      text: text.slice(0, 500),
      pos: span ? span.start : (ch ? ch.start : 0),
      chapterTitle: ch ? ch.title : '',
    };
    showSelToolbar(range.getBoundingClientRect());
  }, 10);
});
scrollBox.addEventListener('scroll', hideSelToolbar, { passive: true });

function pushMsg(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  $('#aiAnswer').appendChild(div);
  $('#aiAnswer').scrollTop = 1e9;
  return div;
}

function openAiPanel(mode) {
  hideSelToolbar();
  if (!selCtx || !state.book) return;
  aiConv = [];
  $('#aiPanel').hidden = false;
  const s = selCtx;
  $('#aiSelected').textContent = '「' + (s.text.length > 60 ? s.text.slice(0, 60) + '…' : s.text) + '」';
  $('#aiAnswer').innerHTML = '';
  if (!aiCfg.key) {
    pushMsg('ai-err', '还没有配置 AI 接口。点顶栏 ⚙ 填入 API Key 后再试（支持 Kimi / DeepSeek / OpenAI 等兼容接口，Key 仅保存在本机）。');
    return;
  }
  const before = state.book.text.slice(Math.max(0, s.pos - 350), s.pos);
  const after = state.book.text.slice(s.pos + s.text.length, s.pos + s.text.length + 350);
  const ctxStr = `【上下文】\n…${before}〖${s.text}〗${after}…`;
  let user;
  if (mode === 'who') {
    user = `我正在读《${state.book.name}》（${s.chapterTitle}），对划线内容不太了解：「${s.text}」。\n请介绍这个人/事物：身份、背景、与故事情节的关系。若从上下文无法确定，请基于文本合理推测并说明不确定之处，不要编造。回答控制在 200 字以内。\n\n${ctxStr}`;
    pushMsg('ai-q', '✦ 介绍一下这段内容');
  } else if (mode === 'summary') {
    user = `我正在读《${state.book.name}》（${s.chapterTitle}），划了一段内容：「${s.text}」。\n请用 3~5 句话概述这段内容的情节要点，语言简洁，不要剧透上下文之外的内容。\n\n${ctxStr}`;
    pushMsg('ai-q', '≡ 概述这段内容');
  } else {
    $('#aiFollowInput').focus();
    return; // 提问模式：等用户输入问题
  }
  aiConv = [{ role: 'user', content: user }];
  callAi();
}

async function callAi() {
  const loading = pushMsg('ai-loading', 'AI 思考中…');
  try {
    const res = await fetch(aiCfg.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiCfg.key },
      body: JSON.stringify({
        model: aiCfg.model,
        messages: [{ role: 'system', content: '你是「轻阅」TXT 阅读器内置的阅读助手，用简洁、准确的中文回答读者关于划线内容的问题。' }, ...aiConv],
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    const ans = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || '（没有返回内容）';
    aiConv.push({ role: 'assistant', content: ans });
    loading.remove();
    pushMsg('ai-a', ans);
  } catch (e2) {
    loading.remove();
    pushMsg('ai-err', '请求失败：' + (e2.message || e2));
  }
}

function sendFollowUp() {
  const q = $('#aiFollowInput').value.trim();
  if (!q || !state.book) return;
  if (!aiCfg.key) { pushMsg('ai-err', '请先在 ⚙ 设置中填写 API Key。'); return; }
  if (!aiConv.length) {
    const s = selCtx;
    if (!s) return;
    aiConv = [{
      role: 'user',
      content: `我正在读《${state.book.name}》（${s.chapterTitle}），划了一段内容：「${s.text}」。\n我的问题：${q}\n请结合上下文回答，简洁准确。`,
    }];
  } else {
    aiConv.push({ role: 'user', content: q });
  }
  $('#aiFollowInput').value = '';
  pushMsg('ai-q', q);
  callAi();
}

// 划线工具条：从选中文本处开始朗读（停止先前朗读）
$('#readSelBtn').addEventListener('click', () => {
  if (!selCtx || !state.book) return;
  const pos = selCtx.pos;
  hideSelToolbar();
  stopTts();
  startTtsFrom(pos);
});
$('#askWhoBtn').addEventListener('click', () => openAiPanel('who'));
$('#askSummaryBtn').addEventListener('click', () => openAiPanel('summary'));
$('#askCustomBtn').addEventListener('click', () => openAiPanel('custom'));
$('#aiClose').addEventListener('click', () => { $('#aiPanel').hidden = true; });
$('#aiSendBtn').addEventListener('click', sendFollowUp);
$('#aiFollowInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendFollowUp(); }
  e.stopPropagation();
});

// AI 接口配置（仅存本机 localStorage）
$('#aiBase').value = aiCfg.base;
$('#aiKey').value = aiCfg.key;
$('#aiModel').value = aiCfg.model;
$('#aiBase').addEventListener('change', (e) => { aiCfg.base = e.target.value.trim(); saveAiCfg(); });
$('#aiKey').addEventListener('change', (e) => { aiCfg.key = e.target.value.trim(); saveAiCfg(); });
$('#aiModel').addEventListener('change', (e) => { aiCfg.model = e.target.value.trim(); saveAiCfg(); });

// 测试钩子（供自动化测试用）
window.__qy = { state, settings, tts, aiCfg, addBookmark, jumpToBookmark, buildTtsQueue, chunkForSpeech, currentTextPos, openAiPanel, sendFollowUp, toggleTts, startTtsFrom, restartTtsCurrent, getSelCtx: () => selCtx };

/* ================= 启动 ================= */
applySettings();
refreshRecent();
