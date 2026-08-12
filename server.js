'use strict';
// שרת מקומי (127.0.0.1 בלבד) — הסייר המסונן + עמדת העתקת השיעורים.
// הרצה:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const config = require('./lib/config');
const filter = require('./lib/filter');
const audio = require('./lib/audio');
const drives = require('./lib/drives');
const copyLib = require('./lib/copy');
const usersLib = require('./lib/users');
const store = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const cfg = config.loadConfig();

// ---------------------------------------------------------------
// הפעלות (sessions) — בזיכרון בלבד, הכל מקומי
// ---------------------------------------------------------------
const sessions = new Map(); // token -> { role, username, at }
function newSession(role, username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, username, at: Date.now() });
  setTimeout(() => sessions.delete(token), 12 * 60 * 60 * 1000);
  return token;
}
function readSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)ks=([^;]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (s && Date.now() - s.at < 12 * 60 * 60 * 1000) return s;
  return null;
}
function isSettings(req) {
  const s = readSession(req);
  return s && (s.role === 'settings' || s.role === 'manager');
}

// ---------------------------------------------------------------
// ניתוח גוף JSON
// ---------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------
// מטמון ניתוח קבצי אודיו
// ---------------------------------------------------------------
const analysisCache = new Map();
async function cachedAnalyze(p, name) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  const key = `${p}|${st.size}|${st.mtimeMs}`;
  if (analysisCache.has(key)) return analysisCache.get(key);
  const res = await audio.analyzeFile(p, filter.extOf(name));
  analysisCache.set(key, res);
  if (analysisCache.size > 3000) {
    const first = analysisCache.keys().next().value;
    analysisCache.delete(first);
  }
  return res;
}

// ---------------------------------------------------------------
// רשימת תיקייה מסוננת
// ---------------------------------------------------------------
async function listDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  const opts = cfg.filters;
  const files = [];
  for (const e of entries) {
    if (filter.isSystemName(e.name)) continue;
    if (e.isDirectory()) {
      out.push({ name: e.name, isDir: true });
    } else if (e.isFile()) {
      files.push(e.name);
    }
  }
  // קבצים שסיומתם לא מורשית — לא מנותחים כלל ומוסתרים לחלוטין
  const candidates = files.filter((n) => filter.matchesExtension(n, opts.extensions));
  const extHidden = files.length - candidates.length;
  let hidden = extHidden;
  // ניתוח קבצי אודיו במקביל (מוגבל)
  const CONC = 8;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const name = candidates[idx++];
      const p = path.join(dirPath, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      const a = await cachedAnalyze(p, name);
      const meta = { name, sizeBytes: st.size, minutes: a ? a.minutes : null, sniff: a ? a.sniff : 'unknown' };
      const verdict = filter.decideFile(meta, opts);
      if (!verdict.allowed) {
        hidden++;
        continue;
      }
      const tags = (a && a.tags) || {};
      out.push({
        name, isDir: false, sizeBytes: st.size, modifiedMs: st.mtimeMs,
        minutes: meta.minutes, sniff: meta.sniff,
        title: tags.title || '', artist: tags.artist || '', album: tags.album || ''
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, candidates.length) }, worker));
  return { items: filter.sortFiles(out, 'name'), hidden };
}

// חיפוש רקורסיבי מוגבל
async function searchFiles(root, q, maxResults = 400) {
  const opts = cfg.filters;
  const ql = String(q || '').toLowerCase();
  const results = [];
  const visited = new Set();
  async function walk(dir, depth) {
    if (depth > 3 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      if (filter.isSystemName(e.name)) continue;
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          await walk(p, depth + 1);
        } else if (e.isFile()) {
          if (ql && !e.name.toLowerCase().includes(ql)) continue;
          if (!filter.matchesExtension(e.name, opts.extensions)) continue;
          const st = fs.statSync(p);
          const a = await cachedAnalyze(p, e.name);
          const meta = { name: e.name, sizeBytes: st.size, minutes: a ? a.minutes : null, sniff: a ? a.sniff : 'unknown' };
          const verdict = filter.decideFile(meta, opts);
          if (!verdict.allowed) continue;
          results.push({ name: e.name, path: p, parent: path.dirname(p), sizeBytes: st.size, minutes: meta.minutes, modifiedMs: st.mtimeMs });
        }
      } catch { }
    }
  }
  await walk(root, 0);
  return results;
}

// ---------------------------------------------------------------
// ניתוב
// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);

  // קבצים סטטיים
  if (p === '/' || p === '/index.html') {
    return serveStatic(res, 'index.html');
  }
  if (p === '/station') {
    return serveStatic(res, 'station.html');
  }
  if (p.startsWith('/static/')) {
    return serveStatic(res, p.slice('/static/'.length));
  }

  if (!p.startsWith('/api/')) return send(res, 404, { error: 'לא נמצא' });

  try {
    if (p === '/api/status') {
      return send(res, 200, config.publicStatus(cfg));
    }

    if (p === '/api/drives') {
      const list = await drives.visibleDrives(cfg);
      return send(res, 200, { drives: list });
    }

    if (p === '/api/list') {
      const dir = String(q.path || '');
      if (!dir || !fs.existsSync(dir)) return send(res, 404, { error: 'התיקייה לא קיימת' });
      const { items, hidden } = await listDir(dir);
      return send(res, 200, { dir, parent: path.dirname(dir), items, hidden });
    }

    if (p === '/api/search') {
      const root = String(q.path || '');
      const qq = String(q.q || '');
      if (!root || !fs.existsSync(root)) return send(res, 404, { error: 'התיקייה לא קיימת' });
      const results = await searchFiles(root, qq);
      return send(res, 200, { results });
    }

    async function validateSrcs(srcs) {
      for (const s of srcs) {
        const name = path.basename(s);
        const a = await cachedAnalyze(s, name);
        let st; try { st = fs.statSync(s); } catch { return `קובץ לא נמצא: ${name}`; }
        const v = filter.decideFile({ name, sizeBytes: st.size, minutes: a ? a.minutes : null, sniff: a ? a.sniff : 'unknown' }, cfg.filters);
        if (!v.allowed) return `הקובץ "${name}" חסום לסינון: ${v.reasons.join(', ')}`;
      }
      return null;
    }
    function countGuard(srcs) {
      const cnt = filter.checkFileCount(srcs.length, cfg.filters.maxFilesPerCopy);
      return cnt.allowed ? null : `הגבלת כמות: מותר להעתיק עד ${cfg.filters.maxFilesPerCopy} קבצים בפעולה אחת. נבחרו ${cnt.count}.`;
    }

    if (p === '/api/copy') {
      const body = await parseBody(req);
      if (!Array.isArray(body.src) || !body.src.length) return send(res, 400, { error: 'לא נבחרו קבצים' });
      if (!body.dest) return send(res, 400, { error: 'לא נבחר יעד' });
      const g = countGuard(body.src);
      if (g) return send(res, 400, { error: g });
      const err = await validateSrcs(body.src);
      if (err) return send(res, 403, { error: err });
      const id = copyLib.startCopyJob(body.src.map((s) => path.resolve(s)), path.resolve(body.dest), { duplicates: body.duplicates || 'skip' });
      store.audit('COPY', 'משתמש', `${body.src.length} קבצים`, body.dest);
      return send(res, 200, { job: id });
    }

    if (p === '/api/move') {
      const body = await parseBody(req);
      if (!Array.isArray(body.src) || !body.src.length) return send(res, 400, { error: 'לא נבחרו קבצים' });
      if (!body.dest) return send(res, 400, { error: 'לא נבחר יעד' });
      const g = countGuard(body.src);
      if (g) return send(res, 400, { error: g });
      const err = await validateSrcs(body.src);
      if (err) return send(res, 403, { error: err });
      const id = copyLib.startCopyJob(body.src.map((s) => path.resolve(s)), path.resolve(body.dest), { duplicates: body.duplicates || 'rename', move: true });
      store.audit('MOVE', 'משתמש', `${body.src.length} קבצים`, body.dest);
      return send(res, 200, { job: id });
    }

    if (p === '/api/dupcheck') {
      const body = await parseBody(req);
      if (!Array.isArray(body.src) || !body.src.length || !body.dest) return send(res, 400, { error: 'חסרים פרטים' });
      const existing = copyLib.checkDuplicates(body.src.map((s) => path.resolve(s)), path.resolve(body.dest));
      return send(res, 200, { existing });
    }

    if (p.startsWith('/api/job/')) {
      const id = p.slice('/api/job/'.length);
      if (id.endsWith('/cancel')) {
        const real = id.slice(0, -'/cancel'.length);
        if (copyLib.cancelJob(real)) return send(res, 200, { ok: true });
        return send(res, 404, { error: 'עבודה לא נמצאה' });
      }
      const job = copyLib.getJob(id);
      if (!job) return send(res, 404, { error: 'עבודה לא נמצאה' });
      return send(res, 200, { job });
    }

    if (p === '/api/history') {
      return send(res, 200, { history: copyLib.getHistory() });
    }

    if (p === '/api/art') {
      const file = String(q.path || '');
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'לא נמצא' });
      const art = audio.extractArt(file, filter.extOf(path.basename(file)));
      if (!art) return send(res, 404, { error: 'אין תמונת אלבום' });
      res.writeHead(200, { 'Content-Type': art.mime, 'Cache-Control': 'public, max-age=3600' });
      return res.end(art.data);
    }

    if (p === '/api/eject') {
      const body = await parseBody(req);
      const letter = String(body.letter || '').toUpperCase().replace(':', '');
      if (!letter || !/^[A-Z]$/.test(letter)) return send(res, 400, { error: 'כונן לא תקין' });
      const ps = `$sh = New-Object -ComObject Shell.Application; $d = $sh.Namespace(17).ParseName('${letter}:'); if ($d) { $d.InvokeVerb('Eject') } else { exit 1 }`;
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err) => err ? reject(new Error('לא ניתן להוציא את הכונן — בדקו שאינו בשימוש')) : resolve());
      });
      store.audit('EJECT', 'משתמש', letter + ':', '');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/convert') {
      const body = await parseBody(req);
      if (!Array.isArray(body.src) || !body.src.length) return send(res, 400, { error: 'לא נבחרו קבצים' });
      if (!body.dest) return send(res, 400, { error: 'לא נבחר יעד' });
      const cnt = filter.checkFileCount(body.src.length, cfg.filters.maxFilesPerCopy);
      if (!cnt.allowed) return send(res, 400, { error: `הגבלת כמות: עד ${cfg.filters.maxFilesPerCopy} קבצים.` });
      if (!audio.findFfmpeg()) return send(res, 400, { error: 'ffmpeg לא נמצא — הניחו ffmpeg.exe בתיקיית התוכנה או ב-PATH.' });
      const id = copyLib.startCopyJob(body.src.map((s) => path.resolve(s)), path.resolve(body.dest), {
        duplicates: body.duplicates || 'rename',
        convert: true,
        converter: (src, dest, onBytes) => audio.convertToMp3(src, dest, onBytes)
      });
      return send(res, 200, { job: id });
    }

    if (p === '/api/trash') {
      const body = await parseBody(req);
      if (!Array.isArray(body.paths) || !body.paths.length) return send(res, 400, { error: 'לא נבחרו קבצים' });
      const results = await copyLib.trashPaths(body.paths.map((x) => path.resolve(x)));
      store.audit('DELETE', 'משתמש', `${body.paths.length} פריטים`, '');
      return send(res, 200, { results });
    }

    if (p === '/api/rename') {
      const body = await parseBody(req);
      if (!body.path || !body.newName) return send(res, 400, { error: 'חסרים פרטים' });
      const dest = copyLib.renamePath(path.resolve(body.path), body.newName);
      store.audit('RENAME', 'משתמש', body.path, body.newName);
      return send(res, 200, { dest });
    }

    // ---------- הגדרות (סיסמה) ----------
    if (p === '/api/login') {
      const body = await parseBody(req);
      if (config.verifyPassword(String(body.password || ''), cfg.settingsPasswordHash)) {
        const token = newSession('settings');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `ks=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end(JSON.stringify({ ok: true }));
      }
      return send(res, 403, { error: 'סיסמה שגויה' });
    }

    if (p === '/api/verify-master') {
      // אימות סיסמת אחראי בלבד (ללא יצירת סשן) — למעטפת החלון
      const body = await parseBody(req);
      if (!cfg.settingsPasswordHash) return send(res, 200, { ok: true });
      if (config.verifyPassword(String(body.password || ''), cfg.settingsPasswordHash)) return send(res, 200, { ok: true });
      return send(res, 403, { error: 'סיסמה שגויה' });
    }

    if (p === '/api/logout') {
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/(?:^|;\s*)ks=([^;]+)/);
      if (m) sessions.delete(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'ks=; Max-Age=0; Path=/' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (p === '/api/settings' && req.method === 'GET') {
      if (!isSettings(req) && cfg.settingsPasswordHash) return send(res, 401, { error: 'נדרשת סיסמת הגדרות' });
      return send(res, 200, cfg);
    }

    if (p === '/api/settings' && req.method === 'POST') {
      if (!isSettings(req) && cfg.settingsPasswordHash) return send(res, 401, { error: 'נדרשת סיסמת הגדרות' });
      const body = await parseBody(req);
      if (body.settings) {
        const s = body.settings;
        const f = cfg.filters;
        if (Array.isArray(s.extensions)) f.extensions = s.extensions.map((x) => String(x).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
        if (typeof s.maxSizeMB === 'number') f.maxSizeMB = Math.max(0, s.maxSizeMB);
        if (typeof s.minDurationMin === 'number') f.minDurationMin = Math.max(0, s.minDurationMin);
        if (typeof s.maxDurationMin === 'number') f.maxDurationMin = Math.max(0, s.maxDurationMin);
        if (typeof s.maxFilesPerCopy === 'number') f.maxFilesPerCopy = Math.max(1, Math.floor(s.maxFilesPerCopy));
        if (typeof s.blockUnverifiable === 'boolean') f.blockUnverifiable = s.blockUnverifiable;
        if (typeof s.strictContentCheck === 'boolean') f.strictContentCheck = s.strictContentCheck;
        const dr = cfg.drives;
        if (typeof s.hideSystemDrives === 'boolean') dr.hideSystemDrives = s.hideSystemDrives;
        if (Array.isArray(s.allowedDriveLetters)) dr.allowedDriveLetters = s.allowedDriveLetters.map((l) => String(l).toUpperCase().replace(':', ''));
        const v = cfg.view;
        if (s.viewMode === 'list' || s.viewMode === 'icons') v.mode = s.viewMode;
        if (typeof s.showArt === 'boolean') v.showArt = s.showArt;
        const st = cfg.station;
        if (typeof s.libraryPath === 'string') st.libraryPath = s.libraryPath;
        if (Array.isArray(s.rabbis)) st.rabbis = s.rabbis.map((r) => String(r).trim()).filter(Boolean);
        if (typeof s.filenameTemplate === 'string') st.filenameTemplate = s.filenameTemplate;
        if (typeof s.allowConvertOnUpload === 'boolean') st.allowConvertOnUpload = s.allowConvertOnUpload;
        if (typeof s.enabled === 'boolean') st.enabled = s.enabled;
      }
      let passwordChanged = false;
      if (body.newPassword && String(body.newPassword).length >= 4) {
        cfg.settingsPasswordHash = config.hashPassword(String(body.newPassword));
        passwordChanged = true;
      }
      config.saveConfig(cfg);
      store.audit('SETTINGS', 'אחראי', '', 'עדכון הגדרות');
      return send(res, 200, { ok: true, passwordChanged });
    }

    // ---------- עמדת השיעורים ----------
    if (p === '/api/station/login') {
      const body = await parseBody(req);
      if (config.verifyPassword(String(body.password || ''), cfg.settingsPasswordHash)) {
        const token = newSession('manager', 'manager');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `ks=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end(JSON.stringify({ ok: true, role: 'manager' }));
      }
      const rec = usersLib.verifyRecorder(String(body.username || ''), String(body.password || ''));
      if (rec) {
        const token = newSession('recorder', rec.username);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `ks=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end(JSON.stringify({ ok: true, role: 'recorder', user: rec }));
      }
      return send(res, 403, { error: 'פרטי התחברות שגויים' });
    }

    if (p === '/api/session') {
      const s = readSession(req);
      if (!s) return send(res, 200, { session: null });
      if (s.role === 'recorder') {
        const r = usersLib.findRecorder(s.username);
        if (!r) return send(res, 200, { session: null });
        return send(res, 200, { session: { role: 'recorder', user: usersLib.publicUser(r) } });
      }
      return send(res, 200, { session: { role: s.role } });
    }

    if (p === '/api/fingerprint') {
      const list = await drives.visibleDrives(cfg);
      const fps = [];
      for (const d of list) {
        const serial = await drives.driveSerial(d.letter);
        fps.push({ letter: d.letter, volume: d.volume, serial });
      }
      return send(res, 200, { fingerprints: fps });
    }

    if (p === '/api/station/rabhis') {
      return send(res, 200, { rabbis: cfg.station.rabbis });
    }

    if (p === '/api/station/library') {
      const lib = await drives.pickLibraryPath(cfg);
      if (!lib) return send(res, 200, { library: null });
      return send(res, 200, { library: lib, free: copyLib.statfsFree(lib) });
    }

    if (p === '/api/station/users' && req.method === 'GET') {
      if (!isSettings(req)) return send(res, 401, { error: 'נדרשת הרשאת אחראי' });
      return send(res, 200, { users: usersLib.listRecorders() });
    }
    if (p === '/api/station/users' && req.method === 'POST') {
      if (!isSettings(req)) return send(res, 401, { error: 'נדרשת הרשאת אחראי' });
      const body = await parseBody(req);
      try {
        const u = usersLib.addRecorder(body);
        store.audit('USER_ADD', 'אחראי', body.username, '');
        return send(res, 200, { user: u });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (p === '/api/station/users' && req.method === 'DELETE') {
      if (!isSettings(req)) return send(res, 401, { error: 'נדרשת הרשאת אחראי' });
      const body = await parseBody(req);
      try {
        usersLib.removeRecorder(body.id);
        store.audit('USER_DEL', 'אחראי', body.id, '');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (p === '/api/convert-test') {
      // בדיקת זמינות ffmpeg (להצגה בממשק)
      return send(res, 200, { available: !!audio.findFfmpeg() });
    }

    if (p === '/api/station/upload') {
      const s = readSession(req);
      if (!s || (s.role !== 'recorder' && s.role !== 'manager')) return send(res, 401, { error: 'נדרשת התחברות מקליט/אחראי' });
      const body = await parseBody(req);
      if (!Array.isArray(body.src) || !body.src.length) return send(res, 400, { error: 'לא נבחרו קבצים' });
      if (!body.rabbi) return send(res, 400, { error: 'לא נבחר רב' });
      const lib = await drives.pickLibraryPath(cfg);
      if (!lib) return send(res, 400, { error: 'ספריית השיעורים לא מוגדרת' });
      // הרשאת מקליט: רק לרבנים שהורשו לו
      if (s.role === 'recorder') {
        const rec = usersLib.findRecorder(s.username);
        if (!rec || !(rec.rabhis || []).includes(body.rabbi)) {
          return send(res, 403, { error: 'אינך מורשה להעלות לרב זה' });
        }
      }
      const cnt = filter.checkFileCount(body.src.length, cfg.filters.maxFilesPerCopy);
      if (!cnt.allowed) return send(res, 400, { error: `הגבלת כמות: עד ${cfg.filters.maxFilesPerCopy} קבצים.` });
      // בדיקת סינון לכל קובץ
      for (const s2 of body.src) {
        const name = path.basename(s2);
        const a = await cachedAnalyze(s2, name);
        let st; try { st = fs.statSync(s2); } catch { return send(res, 400, { error: `קובץ לא נמצא: ${name}` }); }
        const v = filter.decideFile({ name, sizeBytes: st.size, minutes: a ? a.minutes : null, sniff: a ? a.sniff : 'unknown' }, cfg.filters);
        if (!v.allowed) return send(res, 403, { error: `הקובץ "${name}" חסום לסינון: ${v.reasons.join(', ')}` });
      }
      const convert = !!body.convert && cfg.station.allowConvertOnUpload !== false;
      if (convert && !audio.findFfmpeg()) {
        return send(res, 400, { error: 'ffmpeg לא נמצא — לא ניתן להמיר ל-MP3. הניחו ffmpeg.exe בתיקיית התוכנה או ב-PATH.' });
      }
      const rabbiDir = path.join(lib, body.rabbi);
      fs.mkdirSync(rabbiDir, { recursive: true });
      const entries = [];
      for (const s2 of body.src) {
        const ext = convert ? 'mp3' : String(path.extname(s2) || '.mp3').replace('.', '');
        const base = filter.buildRecorderFilename(cfg.station.filenameTemplate, {
          rabbi: body.rabbi, classNum: body.classNum, topic: body.topic
        });
        const name = path.basename(base, path.extname(base)) + '.' + ext;
        let dest = path.join(rabbiDir, name);
        let i = 1;
        while (fs.existsSync(dest)) dest = path.join(rabbiDir, path.basename(dest, path.extname(dest)) + `_${i++}` + path.extname(dest));
        entries.push({ src: s2, dest });
      }
      // ביצוע בפועל — כל קובץ ליעד עם שם התבנית (ועם המרה אם ביקשו)
      const jobId = copyLib.startCopyJob(entries.map((e) => e.src), rabbiDir, {
        duplicates: 'rename',
        dests: entries.map((e) => e.dest),
        convert,
        converter: (src, dest, onBytes) => audio.convertToMp3(src, dest, onBytes)
      });
      store.audit('UPLOAD_START', s.username, `${body.src.length} קבצים`, body.rabbi);
      return send(res, 200, { job: jobId, entries, convert });
    }

    if (p === '/api/station/upload-finalize') {
      const s = readSession(req);
      if (!s) return send(res, 401, { error: 'לא מחובר' });
      const body = await parseBody(req);
      // רישום ההיסטוריה אחרי שההעתקה הסתיימה
      const job = copyLib.getJob(String(body.job || ''));
      const recorded = job && job.status === 'done' ? body.entries : [];
      for (const e of recorded || []) {
        store.addUpload({ username: s.username, rabbi: e.rabbi || body.rabbi || '', file: path.basename(e.dest), sizeBytes: 0 });
      }
      return send(res, 200, { ok: true, count: recorded.length });
    }

    if (p === '/api/station/history') {
      const s = readSession(req);
      if (!s) return send(res, 401, { error: 'לא מחובר' });
      const h = s.role === 'manager' ? store.listHistory() : store.listHistory({ username: s.username });
      return send(res, 200, { history: h });
    }

    return send(res, 404, { error: 'לא נמצא' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
}

function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'אסור' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'לא נמצא' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const PORT = Number(process.env.KOSHER_PORT) || cfg.port || 8787;
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: e.message }); } catch { } });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  עמדת שיעורים — עמדת העתקה מקומית');
  console.log('  ====================================');
  console.log(`  פתח בדפדפן:  http://127.0.0.1:${PORT}`);
  console.log(`  עמדת שיעורים: http://127.0.0.1:${PORT}/station`);
  console.log('  השרת מקשיב רק על המחשב הזה (127.0.0.1).');
  console.log('');
});
