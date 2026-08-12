'use strict';
// הסייר המסונן — היגיון הצד לקוח.

const state = {
  drives: [],
  currentPath: '',
  items: [],
  selected: new Set(), // שמות קבצים נבחרים בתיקייה הנוכחית
  cutItems: [], // קבצים מסומנים לגזירה (נתיב מלא)
  sortKey: 'name',
  sortDir: 'asc',
  status: null,
  hiddenCount: 0,
  viewMode: 'list',
  showArt: false,
  lastClicked: -1,
  history: []
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------
// כוננים + רענון אוטומטי
// ---------------------------------------------------------------
function renderDriveOptions() {
  const ds = $('driveSelect');
  const dest = $('destSelect');
  const cur = state.currentPath;
  ds.innerHTML = '';
  dest.innerHTML = '';
  if (!state.drives.length) {
    ds.innerHTML = '<option value="">לא נמצאו כוננים</option>';
    dest.innerHTML = '<option value="">אין יעד</option>';
    return;
  }
  for (const d of state.drives) {
    const label = `(${d.letter}:) ${d.volume || ''} ${fmtSize(d.free)} פנוי`;
    ds.insertAdjacentHTML('beforeend', `<option value="${esc(d.root)}">${esc(label)}</option>`);
    dest.insertAdjacentHTML('beforeend', `<option value="${esc(d.root)}">${esc(label)}</option>`);
  }
  // בחירת הכונן הנוכחי אם עודנו מחובר
  const stillThere = state.drives.find((d) => cur && cur.toUpperCase().startsWith(d.letter));
  if (stillThere) ds.value = cur;
  else ds.value = state.drives[0].root;
}

async function loadDrives({ silent } = {}) {
  try {
    const { drives } = await api('/api/drives');
    const changed = JSON.stringify(drives.map((d) => d.letter)) !== JSON.stringify(state.drives.map((d) => d.letter));
    state.drives = drives;
    renderDriveOptions();
    const stillThere = state.currentPath && drives.find((d) => state.currentPath.toUpperCase().startsWith(d.letter));
    if (!stillThere) {
      // הכונן הנוכחי התנתק או עוד לא נבחר — מעבר לכונן הראשון הזמין
      const target = drives[0] && drives[0].root;
      if (target && state.currentPath !== target) {
        if (changed && !silent) toast('רשימת הכוננים עודכנה', 'info');
        navigate(target);
      } else if (!target) {
        state.currentPath = '';
        state.items = [];
        render();
      }
    }
  } catch { }
}

// ---------------------------------------------------------------
// ניווט
// ---------------------------------------------------------------
async function navigate(dir) {
  if (!dir) { state.items = []; render(); return; }
  state.currentPath = dir;
  $('pathBox').value = dir;
  $('driveSelect').value = dir;
  try {
    const { items, hidden } = await api('/api/list?path=' + encodeURIComponent(dir));
    state.items = items;
    state.hiddenCount = hidden || 0;
    state.selected = new Set();
    state.lastClicked = -1;
    render();
  } catch (e) {
    toast(e.message, 'error');
    state.items = [];
    render();
  }
}

function sortItems() {
  const k = state.sortKey;
  const d = state.sortDir === 'desc' ? -1 : 1;
  return [...state.items].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (k === 'size') return (a.sizeBytes - b.sizeBytes) * d;
    if (k === 'duration') return ((a.minutes || 0) - (b.minutes || 0)) * d;
    if (k === 'modified') return (a.modifiedMs - b.modifiedMs) * d;
    if (k === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'he') * d;
    if (k === 'artist') return String(a.artist || '').localeCompare(String(b.artist || ''), 'he') * d;
    return String(a.name).localeCompare(String(b.name), 'he') * d;
  });
}

// ---------------------------------------------------------------
// רינדור רשימה
// ---------------------------------------------------------------
function renderRow(it, tr) {
  if (it.isDir) {
    tr.className = 'dir-row';
    tr.innerHTML = `<td></td><td colspan="6"><span class="name-cell"><span class="ico">📁</span>${esc(it.name)}</span></td>`;
    tr.addEventListener('dblclick', () => navigate(pathJoin(state.currentPath, it.name)));
    return;
  }
  const checked = state.selected.has(it.name) ? 'checked' : '';
  const cut = state.cutItems.includes(pathJoin(state.currentPath, it.name)) ? ' cut-row' : '';
  tr.className = cut || '';
  tr.innerHTML = `
    <td><input type="checkbox" class="sel" data-name="${esc(it.name)}" ${checked}></td>
    <td><span class="name-cell"><span class="ico">🎵</span>${esc(it.name)}</span></td>
    <td>${esc(it.title || '—')}</td>
    <td>${esc(it.artist || '—')}</td>
    <td class="num">${fmtSize(it.sizeBytes)}</td>
    <td class="num">${fmtMin(it.minutes)}</td>
    <td class="num">${fmtDate(it.modifiedMs)}</td>`;
  tr.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    const idx = state.items.indexOf(it);
    if (e.shiftKey && state.lastClicked >= 0) {
      const [from, to] = [Math.min(idx, state.lastClicked), Math.max(idx, state.lastClicked)];
      state.selected = new Set();
      for (let i = from; i <= to; i++) {
        const x = state.items[i];
        if (!x.isDir) state.selected.add(x.name);
      }
      state.lastClicked = idx;
      render();
      return;
    }
    state.lastClicked = idx;
    toggleSel(it);
  });
  tr.addEventListener('dblclick', () => toast('לבחירה להעתקה — לחצו על השורה, ואז "העתק ליעד"', 'info'));
}

function renderTable() {
  const tbody = $('tbody');
  tbody.innerHTML = '';
  for (const it of sortItems()) {
    const tr = document.createElement('tr');
    renderRow(it, tr);
    tbody.appendChild(tr);
  }
  $('emptyBox').style.display = state.items.length ? 'none' : 'block';
}

// ---------------------------------------------------------------
// רינדור סמלים גדולים
// ---------------------------------------------------------------
function renderIcons() {
  const grid = $('iconGrid');
  grid.innerHTML = '';
  const all = sortItems();
  const files = all.filter((i) => !i.isDir);
  for (const it of all) {
    const full = pathJoin(state.currentPath, it.name);
    if (it.isDir) {
      const dirTile = document.createElement('div');
      dirTile.className = 'tile dir-tile';
      dirTile.innerHTML = `
        <div class="tile-box">📁</div>
        <div class="tile-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="tile-meta">תיקייה</div>
        <div class="tile-dur">לחיצה כפולה לכניסה</div>`;
      dirTile.addEventListener('dblclick', () => navigate(full));
      grid.appendChild(dirTile);
      continue;
    }
    const checked = state.selected.has(it.name) ? ' selected' : '';
    const cut = state.cutItems.includes(full) ? ' cut' : '';
    const tile = document.createElement('div');
    tile.className = 'tile' + checked + cut;
    const artHtml = state.showArt
      ? `<img class="tile-art" src="/api/art?path=${encodeURIComponent(full)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="tile-noart" style="display:none">🎵</div>`
      : `<div class="tile-noart">🎵</div>`;
    tile.innerHTML = `
      <div class="tile-box">${artHtml}</div>
      <div class="tile-name" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="tile-meta">${esc(it.title || '')}${it.title && it.artist ? ' · ' : ''}${esc(it.artist || '')}</div>
      <div class="tile-dur">${fmtMin(it.minutes)}</div>`;
    tile.addEventListener('click', (e) => {
      if (e.shiftKey && state.lastClicked >= 0) {
        const files2 = all.filter((i) => !i.isDir);
        const idx = files2.indexOf(it);
        const [from, to] = [Math.min(idx, state.lastClicked), Math.max(idx, state.lastClicked)];
        state.selected = new Set();
        for (let i = from; i <= to; i++) state.selected.add(files2[i].name);
        state.lastClicked = idx;
        render();
        return;
      }
      state.lastClicked = files.indexOf(it);
      toggleSel(it);
    });
    grid.appendChild(tile);
  }
  $('emptyIcons').style.display = all.length ? 'none' : 'block';
}

function render() {
  if (state.viewMode === 'icons') {
    $('listView').style.display = 'none';
    $('iconView').style.display = 'block';
    renderIcons();
  } else {
    $('iconView').style.display = 'none';
    $('listView').style.display = 'block';
    renderTable();
  }
  renderFilterbar();
  renderSelInfo();
}

function pathJoin(a, b) {
  return (a.endsWith('\\') || a.endsWith('/') ? a : a + '\\') + b;
}

function toggleSel(item) {
  if (state.selected.has(item.name)) state.selected.delete(item.name);
  else state.selected.add(item.name);
  render();
}

// ---------------------------------------------------------------
// שורת הסינון
// ---------------------------------------------------------------
function renderFilterbar() {
  const f = state.status ? state.status.filters : null;
  if (!f) return;
  const chips = [];
  chips.push(`<span class="chip">סיומות: ${f.extensions.join(', ')}</span>`);
  chips.push(`<span class="chip">גודל מקסימלי: ${f.maxSizeMB}MB</span>`);
  chips.push(`<span class="chip">אורך: ${f.minDurationMin}–${f.maxDurationMin} דקות</span>`);
  chips.push(`<span class="chip">מקסימום קבצים בפעולה: ${f.maxFilesPerCopy}</span>`);
  if (state.hiddenCount) chips.push(`<span class="chip dim">🔒 הוסתרו ${state.hiddenCount} קבצים שאינם עומדים בסינון</span>`);
  $('filterbar').innerHTML = chips.join('');
}

function renderSelInfo() {
  const n = state.selected.size;
  $('selInfo').textContent = `נבחרו ${n} קבצים`;
  $('copyBtn').disabled = n === 0;
  $('convertBtn').disabled = n === 0;
  $('cutBtn').disabled = n === 0;
  $('renameBtn').disabled = n !== 1;
  $('trashBtn').disabled = n === 0;
  $('pasteBtn').disabled = state.cutItems.length === 0;
  if (state.cutItems.length) $('selInfo').textContent += ` · מסומנים לגזירה: ${state.cutItems.length}`;
}

function selectedPaths() {
  return [...state.selected].map((name) => pathJoin(state.currentPath, name));
}

// ---------------------------------------------------------------
// דיאלוג כפילות + העתקה/המרה
// ---------------------------------------------------------------
async function dupPolicyModal(existing) {
  return new Promise((resolve) => {
    const { close } = openModal(`
      <h2>⚠️ קובץ כבר קיים ביעד</h2>
      <p>הקבצים הבאים כבר קיימים במועתק:</p>
      <ul class="dup-list">${existing.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="modal-actions" style="flex-wrap:wrap">
        <button class="btn primary" data-p="overwrite">העתק והחלף</button>
        <button class="btn" data-p="rename">שמור את שניהם</button>
        <button class="btn" data-p="skip">דלג על הקיימים</button>
        <button class="btn" data-p="cancel">ביטול</button>
      </div>`);
    document.querySelectorAll('[data-p]').forEach((b) => {
      b.addEventListener('click', () => { close(); resolve(b.dataset.p); });
    });
  });
}

async function runTransfer(convert) {
  const srcs = selectedPaths();
  const dest = $('destSelect').value;
  if (!srcs.length) return toast('לא נבחרו קבצים', 'error');
  if (!dest) return toast('לא נבחר יעד', 'error');
  if (dest.toUpperCase() === state.currentPath.toUpperCase()) return toast('היעד זהה לתיקייה הנוכחית', 'error');
  let duplicates = convert ? 'rename' : 'skip';
  try {
    // בדיקת כפילות לפני ההעתקה
    if (!convert) {
      const { existing } = await api('/api/dupcheck', { method: 'POST', body: { src: srcs, dest } });
      if (existing.length) {
        const choice = await dupPolicyModal(existing);
        if (choice === 'cancel') return;
        duplicates = choice;
      }
    }
    const ep = convert ? '/api/convert' : '/api/copy';
    const { job } = await api(ep, { method: 'POST', body: { src: srcs, dest, duplicates } });
    await trackJob(job, convert ? 'המרה ל-MP3 והעתקה...' : 'העתקה...');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// גזור + הדבק (העברה אמיתית)
// ---------------------------------------------------------------
function cutSelected() {
  const srcs = selectedPaths();
  if (!srcs.length) return;
  state.cutItems = srcs;
  render();
  toast(`סומנו ${srcs.length} קבצים לגזירה — נווטו ליעד ולחצו "הדבק כאן"`, 'info');
}

async function pasteHere() {
  const srcs = [...state.cutItems];
  const dest = state.currentPath;
  if (!srcs.length) return;
  if (!dest) return toast('אין תיקיית יעד', 'error');
  // מניעת העברה לתוך עצמה
  const same = srcs.filter((s) => path.dirname(s).toUpperCase() === dest.toUpperCase());
  if (same.length) return toast('היעד זהה למקור — לא ניתן להדביק כאן', 'error');
  try {
    const { existing } = await api('/api/dupcheck', { method: 'POST', body: { src: srcs, dest } });
    let duplicates = 'rename';
    if (existing.length) {
      const choice = await dupPolicyModal(existing);
      if (choice === 'cancel') return;
      duplicates = choice;
    }
    const { job } = await api('/api/move', { method: 'POST', body: { src: srcs, dest, duplicates } });
    await trackJob(job, 'העברה (גזור+הדבק)...');
    state.cutItems = [];
    render();
    await refreshHistory();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// מעקב עבודה עם התקדמות וביטול
// ---------------------------------------------------------------
async function trackJob(jobId, title) {
  const win = progressModal(title);
  let cancelled = false;
  win.addCancel(() => { cancelled = true; api('/api/job/' + jobId + '/cancel').catch(() => {}); });
  return new Promise((resolve) => {
    const tick = async () => {
      if (cancelled) return;
      try {
        const { job } = await api('/api/job/' + jobId);
        const pct = job.progress == null ? '' : job.progress + '%';
        const cur = job.current ? `${job.actionVerb || 'מעתיק'} את ${job.current}` : '';
        const counts = `(${job.done}/${job.total})`;
        win.set(job.progress, `${pct} ${cur} ${counts}`.trim(), job.action);
        if (job.status === 'done') {
          setTimeout(() => win.close(), 500);
          let msg = 'הושלם בהצלחה ✓';
          if (job.errors && job.errors.length) msg = 'הושלם עם הערות: ' + job.errors.slice(0, 3).join(' | ');
          toast(msg, job.errors && job.errors.length ? 'info' : 'success');
          await refreshHistory();
          resolve(job);
        } else if (job.status === 'cancelled') {
          win.close();
          toast('הפעולה בוטלה', 'info');
          resolve(job);
        } else if (job.status === 'error') {
          win.close();
          toast('שגיאה: ' + (job.error || 'אירעה שגיאה'), 'error');
          resolve(job);
        } else {
          setTimeout(tick, 250);
        }
      } catch (e) {
        win.close();
        toast(e.message, 'error');
        resolve(null);
      }
    };
    tick();
  });
}

// ---------------------------------------------------------------
// שינוי שם (רק בסיס השם — הסיומת נשמרת)
// ---------------------------------------------------------------
async function renameSelected() {
  const name = [...state.selected][0];
  if (!name) return;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const newName = await promptModal('שינוי שם', `שם חדש (הסיומת ${ext || 'לא קיימת'} תישאר כמות שהיא):`, base);
  if (newName == null) return;
  try {
    await api('/api/rename', { method: 'POST', body: { path: pathJoin(state.currentPath, name), newName: newName.trim() + ext } });
    toast('השם עודכן', 'success');
    navigate(state.currentPath);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// מחיקה
// ---------------------------------------------------------------
async function trashSelected() {
  const paths = selectedPaths();
  if (!paths.length) return;
  const ok = await confirmModal('מחיקה', `למחוק ${paths.length} פריטים לאשפה?`, 'מחק לאשפה');
  if (!ok) return;
  try {
    const { results } = await api('/api/trash', { method: 'POST', body: { paths } });
    const bad = results.filter((r) => !r.ok);
    if (bad.length) toast('חלק מהפריטים נכשלו: ' + bad.map((b) => b.error).join('; '), 'error');
    else toast('נמחק לאשפה', 'success');
    await refreshHistory();
    navigate(state.currentPath);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// הוצאה בטוחה
// ---------------------------------------------------------------
async function ejectDrive() {
  const root = $('driveSelect').value;
  const m = (root || '').match(/^([A-Za-z]):/);
  if (!m) return toast('לא נבחר כונן', 'error');
  const ok = await confirmModal('הוצאה בטוחה', `להוציא בבטחה את הכונן (${m[1]}:)?`, 'הוצא');
  if (!ok) return;
  try {
    await api('/api/eject', { method: 'POST', body: { letter: m[1] } });
    toast('הכונן הוצא בבטחה — אפשר לנתקו', 'success');
    setTimeout(() => loadDrives(), 3000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// היסטוריה
// ---------------------------------------------------------------
async function refreshHistory() {
  try {
    const { history } = await api('/api/history');
    state.history = history;
    if ($('historyDrawer').style.display !== 'none') renderHistory();
  } catch { }
}

function renderHistory() {
  const el = $('historyList');
  if (!state.history.length) {
    el.innerHTML = '<div class="hist-empty">עדיין אין פעולות בסשן זה</div>';
    return;
  }
  el.innerHTML = state.history.map((h) => `
    <div class="hist-item">
      <div class="hist-mode">${esc(h.mode)}</div>
      <div class="hist-files">${esc(h.files.join(', '))}</div>
      <div class="hist-dest">→ ${esc(h.dest)}</div>
      <div class="hist-at">${esc(new Date(h.at).toLocaleTimeString('he-IL'))}</div>
    </div>`).join('');
}

// ---------------------------------------------------------------
// חיפוש
// ---------------------------------------------------------------
let searchTimer = null;
function setupSearch() {
  const box = $('searchBox');
  const panel = $('searchPanel');
  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = box.value.trim();
    if (!q) { panel.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { results } = await api('/api/search?path=' + encodeURIComponent(state.currentPath) + '&q=' + encodeURIComponent(q));
        panel.innerHTML = '';
        if (!results.length) { panel.innerHTML = '<div class="item">לא נמצאו תוצאות</div>'; }
        results.slice(0, 60).forEach((r) => {
          const item = document.createElement('div');
          item.className = 'item';
          item.innerHTML = `<div>🎵 ${esc(r.name)}</div><div class="p">${esc(r.parent)}</div>`;
          item.addEventListener('click', () => {
            panel.style.display = 'none';
            navigate(r.parent);
            toast(`נמצא: ${r.name} (${fmtMin(r.minutes)})`, 'info');
          });
          panel.appendChild(item);
        });
        panel.style.display = 'block';
      } catch { panel.style.display = 'none'; }
    }, 350);
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== box) panel.style.display = 'none';
  });
}

// ---------------------------------------------------------------
// הגדרות
// ---------------------------------------------------------------
function openSettings() {
  const hasPw = state.status && state.status.hasPassword;
  if (!hasPw) return settingsEditor();
  const { close, el } = openModal(`
    <h2>⚙️ הגדרות</h2>
    <p>ההגדרות מוגנות בסיסמה.</p>
    <label>סיסמה
      <input type="password" id="pwInput">
    </label>
    <div class="modal-actions">
      <button class="btn primary" id="pwOk">כניסה</button>
      <button class="btn" id="pwCancel">ביטול</button>
    </div>`);
  el.querySelector('#pwOk').addEventListener('click', async () => {
    try {
      await api('/api/login', { method: 'POST', body: { password: el.querySelector('#pwInput').value } });
      close();
      settingsEditor();
    } catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('#pwCancel').addEventListener('click', close);
  el.querySelector('#pwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.querySelector('#pwOk').click();
  });
}

async function settingsEditor() {
  let cfg;
  try { cfg = await api('/api/settings'); } catch (e) { return toast('נדרשת סיסמת הגדרות: ' + e.message, 'error'); }
  const f = cfg.filters, dr = cfg.drives, st = cfg.station, vw = cfg.view || {};
  const { close, el } = openModal(`
    <h2>⚙️ הגדרות סינון</h2>
    <div class="row">
      <label>סיומות מותרות להצגה (מופרדות בפסיק)<input id="sExt" value="${esc(f.extensions.join(', '))}" placeholder="לדוגמה: mp3, m4a, wav, docx"></label>
      <label>גודל מקסימלי (MB)<input id="sSize" type="number" min="0" value="${f.maxSizeMB}"></label>
    </div>
    <div class="row">
      <label>אורך מינימלי (דק')<input id="sMin" type="number" min="0" value="${f.minDurationMin}"></label>
      <label>אורך מקסימלי (דק')<input id="sMax" type="number" min="0" value="${f.maxDurationMin}"></label>
    </div>
    <div class="row">
      <label>מקסימום קבצים בפעולה<input id="sCount" type="number" min="1" value="${f.maxFilesPerCopy}"></label>
      <label>תצוגה
        <select id="sView">
          <option value="list" ${vw.mode !== 'icons' ? 'selected' : ''}>רשימה</option>
          <option value="icons" ${vw.mode === 'icons' ? 'selected' : ''}>סמלים גדולים</option>
        </select>
      </label>
    </div>
    <div class="row">
      <label>כוננים מורשים (אותיות, ריק = כל הכוננים)<input id="sLetters" value="${esc((dr.allowedDriveLetters || []).join(','))}" placeholder="לדוגמה: E,F"></label>
    </div>
    <div class="checkbox-inline"><input type="checkbox" id="sHideSys" ${dr.hideSystemDrives ? 'checked' : ''}> הסתרת כונן המערכת בלבד (SSD חיצוני יוצג)</div>
    <div class="checkbox-inline"><input type="checkbox" id="sStrict" ${f.strictContentCheck ? 'checked' : ''}> בדיקת תוכן אמיתי (מניעת שינוי סיומת)</div>
    <div class="checkbox-inline"><input type="checkbox" id="sBlockUnv" ${f.blockUnverifiable ? 'checked' : ''}> הסתרת קבצים שאורך ההקלטה שלהם לא מזוהה</div>
    <div class="checkbox-inline"><input type="checkbox" id="sShowArt" ${vw.showArt ? 'checked' : ''}> הצגת תמונת אלבום בתצוגת סמלים</div>
    <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
    <div class="row">
      <label>ספריית השיעורים (ריק = אוטומטי)<input id="sLib" value="${esc(st.libraryPath || '')}" placeholder="לדוגמה D:\\שיעורים"></label>
      <label>תבנית שם הקלטה<input id="sTpl" value="${esc(st.filenameTemplate)}"></label>
    </div>
    <label>רבנים (מופרדים בפסיק)
      <input id="sRabbis" value="${esc((st.rabbis || []).join(', '))}" placeholder="לדוגמה: הרב כהן, הרב לוי">
    </label>
    <div class="checkbox-inline"><input type="checkbox" id="sConv" ${st.allowConvertOnUpload ? 'checked' : ''}> לאפשר המרה ל-MP3 בהעלאה</div>
    <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
    <label>סיסמה חדשה (השאר ריק אם לא משנים)<input type="password" id="sPw" placeholder="לפחות 4 תווים"></label>
    <div id="sSaveMsg" style="display:none;color:var(--green);font-size:13px;margin-top:6px">✓ נשמר בהצלחה</div>
    <div class="modal-actions">
      <button class="btn primary" id="sSave">שמירה</button>
      <button class="btn" id="sCancel">ביטול</button>
    </div>`);
  el.querySelector('#sSave').addEventListener('click', async () => {
    const body = {
      settings: {
        extensions: el.querySelector('#sExt').value.split(','),
        maxSizeMB: +el.querySelector('#sSize').value,
        minDurationMin: +el.querySelector('#sMin').value,
        maxDurationMin: +el.querySelector('#sMax').value,
        maxFilesPerCopy: +el.querySelector('#sCount').value,
        hideSystemDrives: el.querySelector('#sHideSys').checked,
        strictContentCheck: el.querySelector('#sStrict').checked,
        blockUnverifiable: el.querySelector('#sBlockUnv').checked,
        viewMode: el.querySelector('#sView').value,
        showArt: el.querySelector('#sShowArt').checked,
        allowedDriveLetters: el.querySelector('#sLetters').value.split(',').map((x) => x.trim()).filter(Boolean),
        libraryPath: el.querySelector('#sLib').value.trim(),
        filenameTemplate: el.querySelector('#sTpl').value.trim(),
        rabbis: el.querySelector('#sRabbis').value.split(','),
        allowConvertOnUpload: el.querySelector('#sConv').checked
      },
      newPassword: el.querySelector('#sPw').value
    };
    try {
      const res = await api('/api/settings', { method: 'POST', body });
      const msg = el.querySelector('#sSaveMsg');
      msg.textContent = res.passwordChanged ? '✓ נשמר — הסיסמה עודכנה. זכרו אותה!' : '✓ נשמר בהצלחה';
      msg.style.display = 'block';
      toast(msg.textContent, 'success');
      state.status = await api('/api/status');
      state.viewMode = state.status.view ? state.status.view.mode : 'list';
      state.showArt = state.status.view ? state.status.view.showArt : false;
      renderFilterbar();
      render();
    } catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('#sCancel').addEventListener('click', close);
}

// ---------------------------------------------------------------
// התחלה
// ---------------------------------------------------------------
async function init() {
  state.status = await api('/api/status');
  if (state.status.view) {
    state.viewMode = state.status.view.mode || 'list';
    state.showArt = !!state.status.view.showArt;
  }
  $('gearBtn').addEventListener('click', openSettings);
  $('upBtn').addEventListener('click', () => {
    const parent = state.currentPath.slice(0, -1);
    const slash = Math.max(parent.lastIndexOf('\\'), parent.lastIndexOf('/'));
    if (slash > 0) navigate(parent.slice(0, slash + 1));
  });
  $('driveSelect').addEventListener('change', (e) => navigate(e.target.value));
  $('refreshBtn').addEventListener('click', () => { loadDrives(); navigate(state.currentPath); });
  $('ejectBtn').addEventListener('click', ejectDrive);
  $('copyBtn').addEventListener('click', () => runTransfer(false));
  $('convertBtn').addEventListener('click', () => runTransfer(true));
  $('cutBtn').addEventListener('click', cutSelected);
  $('pasteBtn').addEventListener('click', pasteHere);
  $('renameBtn').addEventListener('click', renameSelected);
  $('trashBtn').addEventListener('click', trashSelected);
  $('histBtn').addEventListener('click', () => {
    const d = $('historyDrawer');
    d.style.display = d.style.display === 'none' ? 'block' : 'none';
    if (d.style.display === 'block') refreshHistory();
  });
  $('histClose').addEventListener('click', () => { $('historyDrawer').style.display = 'none'; });
  $('checkAll').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.items.forEach((it) => { if (!it.isDir) state.selected.add(it.name); });
    } else {
      state.selected.clear();
    }
    render();
  });
  document.querySelectorAll('th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = k; state.sortDir = 'asc'; }
      render();
    });
  });
  setupSearch();
  renderFilterbar();
  await loadDrives({ silent: true });
  // רענון אוטומטי של רשימת הכוננים (כדי לאתר חיבור/ניתוק התקנים)
  setInterval(() => loadDrives({ silent: true }), 4000);
  setInterval(refreshHistory, 10000);
  await refreshHistory();
}
init();
