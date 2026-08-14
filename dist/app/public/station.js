'use strict';
// עמדת השיעורים — היגיון הצד לקוח (העתקה, העלאה, ניהול).

const $ = (id) => document.getElementById(id);
const state = { mode: null, session: null, library: null, rabbis: [] };

// ---------------------------------------------------------------
// מעבר בין תצוגות
// ---------------------------------------------------------------
function show(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.landing').forEach((v) => (v.style.display = 'none'));
  if (name === 'landing') {
    document.querySelector('.landing').style.display = 'flex';
    return;
  }
  state.mode = name;
  $('view-' + name).classList.add('active');
  if (name === 'copy') initCopyView();
  if (name === 'recorder') initRecorderView();
  if (name === 'manager') initManagerView();
}

// ---------------------------------------------------------------
// דפדפן קבצים משותף (העתקה ומקליט) — מציג רק קבצי אודיו מורשים
// ---------------------------------------------------------------
class FileBrowser {
  constructor(opts) {
    this.opts = opts;
    this.path = '';
    this.items = [];
    this.selected = new Set();
    this.selEl = opts.selEl;
    this.tbody = opts.tbody;
    this.driveSel = opts.driveSel;
    this.pathBox = opts.pathBox;
    this.checkAll = opts.checkAll;
  }
  async init() {
    await this.refreshDrives();
    this.driveSel.addEventListener('change', (e) => this.navigate(e.target.value));
    this.checkAll.addEventListener('change', (e) => {
      this.items.forEach((it) => {
        if (!it.isDir) {
          if (e.target.checked) this.selected.add(it.name);
          else this.selected.delete(it.name);
        }
      });
      this.render();
    });
    this.opts.upBtn.addEventListener('click', () => {
      const parent = this.path.slice(0, -1);
      const slash = Math.max(parent.lastIndexOf('\\'), parent.lastIndexOf('/'));
      if (slash > 0) this.navigate(parent.slice(0, slash + 1));
    });
    this.opts.refresh.addEventListener('click', () => this.navigate(this.path));
    this.setupSearch();
    // רענון אוטומטי לגילוי חיבור/ניתוק התקנים
    setInterval(() => this.refreshDrives(true), 4000);
  }
  async refreshDrives(silent) {
    try {
      const { drives } = await api('/api/drives');
      this.drives = drives;
      const cur = this.driveSel.value;
      this.driveSel.innerHTML = '';
      if (!drives.length) {
        this.driveSel.innerHTML = '<option value="">לא נמצאו כוננים</option>';
        return;
      }
      for (const d of drives) {
        this.driveSel.insertAdjacentHTML('beforeend', `<option value="${esc(d.root)}">(${esc(d.letter)}:) ${esc(d.volume || '')} — ${fmtSize(d.free)} פנוי</option>`);
      }
      const still = drives.find((d) => cur && cur.toUpperCase().startsWith(d.letter));
      if (still) {
        this.driveSel.value = cur;
      } else if (!this.path || !drives.find((d) => this.path.toUpperCase().startsWith(d.letter))) {
        this.path = drives[0].root;
        this.driveSel.value = this.path;
        await this.navigate(this.path);
        if (!silent) toast('רשימת הכוננים עודכנה', 'info');
      }
    } catch { }
  }
  async navigate(dir) {
    this.path = dir;
    this.pathBox.value = dir;
    this.driveSel.value = dir;
    try {
      const { items } = await api('/api/list?path=' + encodeURIComponent(dir));
      this.items = items.filter((it) => it.isDir || it.allowed);
      this.selected = new Set();
      this.render();
    } catch (e) {
      toast(e.message, 'error');
      this.items = [];
      this.render();
    }
  }
  render() {
    const tbody = this.tbody;
    tbody.innerHTML = '';
    const sorted = [...this.items].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'he');
    });
    for (const it of sorted) {
      const tr = document.createElement('tr');
      if (it.isDir) {
        tr.className = 'dir-row';
        tr.innerHTML = `<td></td><td colspan="4"><span class="name-cell"><span class="ico">📁</span>${esc(it.name)}</span></td>`;
        tr.addEventListener('dblclick', () => this.navigate(this.join(it.name)));
        tbody.appendChild(tr);
        continue;
      }
      const checked = this.selected.has(it.name) ? 'checked' : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="sel" data-name="${esc(it.name)}" ${checked}></td>
        <td><span class="name-cell"><span class="ico">🎵</span>${esc(it.name)}</span></td>
        <td class="num">${fmtSize(it.sizeBytes)}</td>
        <td class="num">${fmtMin(it.minutes)}</td>
        <td class="num">${fmtDate(it.modifiedMs)}</td>`;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input')) return;
        if (this.selected.has(it.name)) this.selected.delete(it.name);
        else this.selected.add(it.name);
        this.render();
      });
      tbody.appendChild(tr);
    }
    this.selEl.textContent = `נבחרו ${this.selected.size} קבצים`;
  }
  join(name) {
    return (this.path.endsWith('\\') ? this.path : this.path + '\\') + name;
  }
  selectedPaths() {
    return [...this.selected].map((n) => this.join(n));
  }
  setupSearch() {
    const box = this.opts.search;
    const panel = this.opts.searchPanel;
    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      const q = box.value.trim();
      if (!q) { panel.style.display = 'none'; return; }
      timer = setTimeout(async () => {
        try {
          const { results } = await api('/api/search?path=' + encodeURIComponent(this.path) + '&q=' + encodeURIComponent(q));
          panel.innerHTML = '';
          if (!results.length) panel.innerHTML = '<div class="item">לא נמצאו תוצאות</div>';
          results.slice(0, 60).forEach((r) => {
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = `<div>🎵 ${esc(r.name)}</div><div class="p">${esc(r.parent)}</div>`;
            item.addEventListener('click', () => {
              panel.style.display = 'none';
              this.navigate(r.parent);
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
}

// ---------------------------------------------------------------
// תצוגת העתקה מהמכשיר
// ---------------------------------------------------------------
let copyBrowser = null;
async function initCopyView() {
  if (copyBrowser) return;
  copyBrowser = new FileBrowser({
    driveSel: $('copyDrive'), pathBox: $('copyPath'), tbody: $('copyTbody'),
    selEl: $('copySelInfo'), checkAll: $('copyCheckAll'),
    upBtn: document.querySelector('#view-copy [data-up]'), refresh: document.querySelector('#view-copy [data-refresh]'),
    search: $('copySearch'), searchPanel: $('copySearchPanel')
  });
  await copyBrowser.init();
  await refreshLibInfo();
  $('copyToLib').addEventListener('click', async () => {
    const srcs = copyBrowser.selectedPaths();
    if (!srcs.length) return toast('לא נבחרו קבצים', 'error');
    if (!state.library) return toast('ספריית השיעורים לא מוגדרת', 'error');
    try {
      const dir = state.library;
      // דיאלוג כפילות: החלף / שמור שניהם / דלג / ביטול
      let duplicates = 'rename';
      const { existing } = await api('/api/dupcheck', { method: 'POST', body: { src: srcs, dest: dir } });
      if (existing.length) {
        const choice = await dupPolicyModal(existing);
        if (choice === 'cancel') return;
        duplicates = choice;
      }
      const { job } = await api('/api/copy', { method: 'POST', body: { src: srcs, dest: dir, duplicates } });
      await trackJob(job, 'מעתיק לספריית השיעורים...');
      refreshLibInfo();
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function refreshLibInfo() {
  const { library, free } = await api('/api/station/library');
  state.library = library;
  $('copyLibInfo').textContent = library ? `ספרייה: ${library} — ${fmtSize(free)} פנוי` : 'ספריית השיעורים לא מוגדרת';
}

// ---------------------------------------------------------------
// תצוגת מקליט
// ---------------------------------------------------------------
let recBrowser = null;
async function initRecorderView() {
  if (recBrowser) {
    // כבר אותחל — רק לבדוק סטטוס התחברות
  }
  const { session } = await api('/api/session');
  if (session && session.role === 'recorder') {
    state.session = session;
    showRecorderPanel();
  } else {
    $('recLogin').style.display = 'block';
    $('recPanel').style.display = 'none';
  }
  $('recLoginBtn').onclick = async () => {
    try {
      const data = await api('/api/station/login', { method: 'POST', body: { username: $('recUser').value, password: $('recPass').value } });
      state.session = { role: 'recorder', user: data.user };
      showRecorderPanel();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('recLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.session = null;
    $('recLogin').style.display = 'block';
    $('recPanel').style.display = 'none';
  });
}

async function showRecorderPanel() {
  const u = state.session.user;
  $('recLogin').style.display = 'none';
  $('recPanel').style.display = 'flex';
  $('recWho').textContent = `מחובר: ${u.username}`;
  $('recRabbi').innerHTML = '';
  for (const r of u.rabhis || []) {
    $('recRabbi').insertAdjacentHTML('beforeend', `<option value="${esc(r)}">${esc(r)}</option>`);
  }
  if (!u.rabhis || !u.rabhis.length) $('recRabbi').innerHTML = '<option value="">לא הוקצו לך רבנים</option>';
  const { station } = await api('/api/status');
  $('recConvWrap').style.display = station.allowConvertOnUpload ? 'flex' : 'none';
  // זיהוי התקן (מידע בלבד)
  try {
    const { fingerprints } = await api('/api/fingerprint');
    const fps = fingerprints.filter((f) => f.serial).map((f) => `${f.letter}: ${f.serial}`).join(' ; ');
    $('recFp').innerHTML = fps
      ? `📟 זיהוי התקן מחובר: ${esc(fps)}<br><span style="font-size:11px">שימו לב: בקוראי כרטיסים פשוטים הזיהוי חוזר על עצמו לכל הכרטיסים.</span>`
      : '📟 לא זוהה מספר סריאלי להתקן המחובר.';
  } catch { $('recFp').textContent = ''; }
  updateNamePreview();
  ['recClass', 'recTopic'].forEach((id) => $(id).addEventListener('input', updateNamePreview));
  if (!recBrowser) {
    recBrowser = new FileBrowser({
      driveSel: $('recDrive'), pathBox: $('recPath'), tbody: $('recTbody'),
      selEl: $('recSelInfo'), checkAll: $('recCheckAll'),
      upBtn: document.querySelector('#view-recorder [data-up2]'), refresh: document.querySelector('#view-recorder [data-refresh2]'),
      search: $('recSearch'), searchPanel: $('recSearchPanel')
    });
    await recBrowser.init();
    $('recUpload').addEventListener('click', doUpload);
    await loadRecHistory();
  }
  recBrowser.selEl.textContent = '';
}

function updateNamePreview() {
  const rabbi = $('recRabbi').value || '[רב]';
  const cls = $('recClass').value.trim() || '[מספר]';
  const topic = $('recTopic').value.trim() || '[נושא]';
  const today = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  $('recNamePrev').textContent = `${date}_${rabbi}_${cls}_${topic}.mp3`;
}

async function doUpload() {
  const srcs = recBrowser ? recBrowser.selectedPaths() : [];
  if (!srcs.length) return toast('לא נבחרו קבצים', 'error');
  const rabbi = $('recRabbi').value;
  const classNum = $('recClass').value.trim();
  const topic = $('recTopic').value.trim();
  if (!rabbi) return toast('לא נבחר רב', 'error');
  if (!classNum) return toast('יש למלא מספר שיעור', 'error');
  if (!topic) return toast('יש למלא נושא', 'error');
  try {
    const { job, entries } = await api('/api/station/upload', {
      method: 'POST',
      body: { src: srcs, rabbi, classNum, topic, convert: $('recConv').checked }
    });
    await trackJob(job, 'מעלה את ההקלטה לעמדה...');
    // רישום היסטוריה
    await api('/api/station/upload-finalize', { method: 'POST', body: { job, entries, rabbi } });
    await loadRecHistory();
    toast('ההקלטה הועלתה בהצלחה ✓', 'success');
    recBrowser.selected.clear();
    recBrowser.render();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadRecHistory() {
  try {
    const { history } = await api('/api/station/history');
    $('recHistory').innerHTML = history.slice(0, 50).map((h) => `
      <tr><td class="d">${esc(new Date(h.at).toLocaleString('he-IL'))}</td>
      <td>${esc(h.file)}</td><td>${esc(h.rabbi)}</td></tr>`).join('') || '<tr><td colspan="3">אין העלאות עדיין</td></tr>';
  } catch { }
}

// ---------------------------------------------------------------
// תצוגת ניהול
// ---------------------------------------------------------------
async function initManagerView() {
  const { session } = await api('/api/session');
  if (session && (session.role === 'manager' || session.role === 'settings')) {
    showManagerPanel();
  } else {
    $('mgrLogin').style.display = 'block';
    $('mgrPanel').style.display = 'none';
  }
  $('mgrLoginBtn').onclick = async () => {
    try {
      const data = await api('/api/station/login', { method: 'POST', body: { password: $('mgrPass').value } });
      state.session = { role: data.role };
      showManagerPanel();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('mgrAddUser').addEventListener('click', addUserModal);
}

async function showManagerPanel() {
  $('mgrLogin').style.display = 'none';
  $('mgrPanel').style.display = 'flex';
  $('mgrWho').textContent = 'מחובר: אחראי';
  await loadUsers();
  await loadMgrHistory();
  await loadLib();
}

async function loadUsers() {
  const { users } = await api('/api/station/users');
  $('mgrUsers').innerHTML = users.map((u) => `
    <tr>
      <td>${esc(u.username)}</td>
      <td>${esc((u.rabhis || []).join(', ') || '—')}</td>
      <td>${esc(u.deviceFingerprint || '—')}</td>
      <td class="d">${esc(new Date(u.createdAt).toLocaleDateString('he-IL'))}</td>
      <td><button class="btn small danger" data-del="${esc(u.id)}">מחיקה</button></td>
    </tr>`).join('') || '<tr><td colspan="5">אין מקליטים רשומים</td></tr>';
  document.querySelectorAll('#mgrUsers [data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      const ok = await confirmModal('מחיקת מקליט', 'למחוק מקליט זה?', 'מחק');
      if (!ok) return;
      try {
        await api('/api/station/users', { method: 'DELETE', body: { id: b.dataset.del } });
        toast('נמחק', 'success');
        loadUsers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function addUserModal() {
  const { rabbis } = await api('/api/station/rabhis');
  const { close, el } = openModal(`
    <h2>+ הוספת מקליט</h2>
    <label>שם משתמש<input id="nuUser"></label>
    <label>סיסמה<input type="password" id="nuPass"></label>
    <label>הרשאות רבנים
      <div class="rabbi-list" id="nuRabbis"></div>
    </label>
    <label>זיהוי התקן (אופציונלי)<input id="nuFp" placeholder="מספר סריאלי או ריק"></label>
    <div class="modal-actions">
      <button class="btn primary" id="nuOk">שמירה</button>
      <button class="btn" id="nuCancel">ביטול</button>
    </div>`);
  const list = el.querySelector('#nuRabbis');
  if (!rabbis.length) list.innerHTML = '<span style="font-size:12px;color:var(--muted)">אין רבנים מוגדרים — הוסיפו אותם בהגדרות.</span>';
  for (const r of rabbis) {
    list.insertAdjacentHTML('beforeend', `<label><input type="checkbox" value="${esc(r)}"> ${esc(r)}</label>`);
  }
  el.querySelector('#nuOk').addEventListener('click', async () => {
    const sel = [...el.querySelectorAll('#nuRabbis input:checked')].map((i) => i.value);
    try {
      await api('/api/station/users', { method: 'POST', body: { username: el.querySelector('#nuUser').value, password: el.querySelector('#nuPass').value, rabhis: sel, deviceFingerprint: el.querySelector('#nuFp').value.trim() || null } });
      toast('המקליט נוסף ✓', 'success');
      close();
      loadUsers();
    } catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('#nuCancel').addEventListener('click', close);
}

async function loadMgrHistory() {
  const { history } = await api('/api/station/history');
  $('mgrHistory').innerHTML = history.slice(0, 200).map((h) => `
    <tr><td class="d">${esc(new Date(h.at).toLocaleString('he-IL'))}</td>
    <td>${esc(h.username)}</td><td>${esc(h.file)}</td><td>${esc(h.rabbi)}</td></tr>`).join('') || '<tr><td colspan="4">אין העלאות</td></tr>';
}

async function loadLib() {
  const el = $('mgrLib');
  if (!state.library) { el.innerHTML = '<p style="padding:8px 14px;color:var(--muted)">ספריית השיעורים לא מוגדרת.</p>'; return; }
  const { items } = await api('/api/list?path=' + encodeURIComponent(state.library));
  const dirs = items.filter((i) => i.isDir);
  let html = '';
  for (const d of dirs) {
    html += `<details style="padding:4px 14px"><summary style="cursor:pointer;font-size:14px;font-weight:600">📂 ${esc(d.name)}</summary><div style="padding:4px 20px">`;
    try {
      const { items: files } = await api('/api/list?path=' + encodeURIComponent(state.library + '\\' + d.name));
      const good = files.filter((f) => !f.isDir);
      if (!good.length) html += '<span style="color:var(--muted);font-size:12px">ריק</span>';
      for (const f of good) {
        html += `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px">
          <span>🎵 ${esc(f.name)} <span style="color:var(--muted)">(${fmtMin(f.minutes)})</span></span>
          <button class="btn small danger" data-libdel="${esc(state.library + '\\' + d.name + '\\' + f.name)}">מחק</button></div>`;
      }
    } catch { }
    html += '</div></details>';
  }
  el.innerHTML = html || '<p style="padding:8px 14px;color:var(--muted)">הספרייה ריקה.</p>';
  document.querySelectorAll('#mgrLib [data-libdel]').forEach((b) => {
    b.addEventListener('click', async () => {
      const ok = await confirmModal('מחיקה מהספרייה', 'למחוק קובץ זה לאשפה?', 'מחק');
      if (!ok) return;
      try {
        await api('/api/trash', { method: 'POST', body: { paths: [b.dataset.libdel] } });
        toast('נמחק', 'success');
        loadLib();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// ---------------------------------------------------------------
// דיאלוג כפילות
// ---------------------------------------------------------------
function dupPolicyModal(existing) {
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

// ---------------------------------------------------------------
// הפעלת עבודה + מעקב התקדמות
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
        win.set(job.progress, `${pct} ${cur} (${job.done}/${job.total})`.trim(), job.action);
        if (job.status === 'done') {
          setTimeout(() => win.close(), 400);
          toast(job.errors && job.errors.length ? 'הושלם עם הערות' : 'הושלם בהצלחה ✓', job.errors && job.errors.length ? 'info' : 'success');
          resolve(job);
        } else if (job.status === 'cancelled') {
          win.close();
          toast('הפעולה בוטלה', 'info');
          resolve(job);
        } else if (job.status === 'error') {
          win.close();
          toast('שגיאה: ' + (job.error || ''), 'error');
          resolve(job);
        } else setTimeout(tick, 300);
      } catch (e) { win.close(); toast(e.message, 'error'); resolve(null); }
    };
    tick();
  });
}

// ---------------------------------------------------------------
// התחלה
// ---------------------------------------------------------------
document.querySelectorAll('.card[data-view]').forEach((c) => {
  c.addEventListener('click', () => show(c.dataset.view));
});
document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => show('landing'));
});
show('landing');
