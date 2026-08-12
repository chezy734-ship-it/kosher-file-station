'use strict';
// פעולות קבצים: העתקה/העברה עם התקדמות ברמת בייט, ביטול, בדיקת כפילות, היסטוריית סשן.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const jobs = new Map();
let jobSeq = 1;

// היסטוריית פעולות הסשן (בזיכרון בלבד — מתאפסת עם הפעלת השרת מחדש)
const sessionHistory = [];
function addHistory(entry) {
  sessionHistory.unshift({ at: new Date().toISOString(), ...entry });
  if (sessionHistory.length > 500) sessionHistory.length = 500;
}
function getHistory() { return sessionHistory; }

function statfsFree(dir) {
  try {
    const s = fs.statfsSync(dir);
    if (s && s.bavail && s.bsize) return Number(s.bavail) * Number(s.bsize);
  } catch { }
  return null;
}

function checkSpace(srcPaths, destDir) {
  const free = statfsFree(destDir);
  if (free === null) return { ok: true };
  let needed = 0;
  for (const p of srcPaths) {
    try { needed += fs.statSync(p).size; } catch { }
  }
  return { ok: needed <= free, needed, free };
}

function copyFileStream(src, dest, onBytes, isCancelled) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    rs.on('error', () => { try { ws.destroy(); } catch { } reject(new Error('שגיאה בקריאת הקובץ: ' + path.basename(src))); });
    ws.on('error', (e) => { try { rs.destroy(); } catch { } reject(new Error(e.code === 'ENOSPC' ? 'אין מספיק מקום פנוי ביעד' : e.message)); });
    ws.on('finish', resolve);
    rs.on('data', (chunk) => {
      if (isCancelled && isCancelled()) {
        try { rs.destroy(); ws.destroy(); } catch { }
        reject(new Error('cancelled'));
        return;
      }
      onBytes && onBytes(chunk.length);
    });
    rs.pipe(ws);
  });
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let n = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, n))) {
    n = `${base} (${i})${ext}`;
    i++;
  }
  return path.join(dir, n);
}

function resolveDest(destDir, name, policy) {
  let dest = path.join(destDir, name);
  if (!fs.existsSync(dest)) return dest;
  if (policy === 'skip') return null;
  if (policy === 'rename') return uniqueName(destDir, name);
  return dest; // 'overwrite'
}

function makeJob(id, srcPaths, destDir, opts) {
  const job = {
    id, status: 'running', progress: 0, done: 0, total: srcPaths.length,
    current: '', action: '', actionVerb: 'מעתיק', errors: [], cancelled: false,
    duplicatePolicy: opts.duplicates || 'skip', copiedBytes: 0, totalBytes: 0,
    created: Date.now(), finishedAt: null
  };
  for (const s of srcPaths) {
    try { job.totalBytes += fs.statSync(s).size; } catch { }
  }
  return job;
}

async function runJob(job, srcPaths, destDir, opts) {
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const space = checkSpace(srcPaths, destDir);
    if (!space.ok) {
      job.status = 'error';
      job.error = `אין מספיק מקום פנוי ביעד (נדרש ~${fmtSize(space.needed)}, פנוי ${fmtSize(space.free)})`;
      return;
    }
    for (let i = 0; i < srcPaths.length; i++) {
      if (job.cancelled) { job.status = 'cancelled'; return; }
      const src = srcPaths[i];
      const name = path.basename(src);
      let dest = opts.dests && opts.dests[i] ? path.resolve(opts.dests[i]) : path.join(destDir, name);
      if (opts.convert && path.extname(name).toLowerCase() !== '.mp3') {
        dest = path.join(destDir, path.basename(name, path.extname(name)) + '.mp3');
      }
      job.current = name;
      job.action = opts.convert && path.extname(name).toLowerCase() !== '.mp3' ? 'המרה ל-MP3' : 'העתקה';
      job.actionVerb = job.action === 'המרה ל-MP3' ? 'ממיר' : 'מעתיק';
      const resolved = resolveDest(destDir, path.basename(dest), job.duplicatePolicy);
      if (resolved === null) {
        job.errors.push(`${name}: כבר קיים ביעד — דולג`);
        job.done++;
        job.progress = Math.round((job.done / job.total) * 100);
        continue;
      }
      dest = resolved;
      if (opts.convert && path.extname(name).toLowerCase() !== '.mp3') {
        if (!opts.converter) {
          job.errors.push(`${name}: אין ממיר זמין`);
          job.done++;
          job.progress = Math.round((job.done / job.total) * 100);
          continue;
        }
        job.action = 'המרה ל-MP3';
        job.actionVerb = 'ממיר';
        await opts.converter(src, dest, () => {}, () => job.cancelled);
      } else {
        const st = fs.statSync(src);
        let fileDone = 0;
        await copyFileStream(src, dest, (n) => {
          fileDone += n;
          job.copiedBytes += n;
          if (st.size > 0) {
            job.progress = Math.min(99, Math.round(((job.done + fileDone / st.size) / job.total) * 100));
          }
        }, () => job.cancelled);
      }
      if (job.cancelled) {
        // מחיקת חלקי ההעתקה שלא הושלמה
        try { fs.unlinkSync(dest); } catch { }
        job.status = 'cancelled';
        return;
      }
      if (opts.move) {
        try { fs.unlinkSync(src); } catch { }
      }
      job.done++;
      job.progress = Math.round((job.done / job.total) * 100);
    }
    job.status = 'done';
    job.progress = 100;
    job.finishedAt = Date.now();
    addHistory({
      mode: opts.convert ? 'המרה ל-MP3' : (opts.move ? 'העברה' : 'העתקה'),
      files: srcPaths.map((s) => path.basename(s)),
      dest: destDir
    });
  } catch (e) {
    job.status = e.message === 'cancelled' ? 'cancelled' : 'error';
    job.error = e.message === 'cancelled' ? undefined : e.message;
    job.finishedAt = Date.now();
  }
}

function startCopyJob(srcPaths, destDir, opts = {}) {
  const id = 'job-' + (jobSeq++);
  const job = makeJob(id, srcPaths, destDir, opts);
  jobs.set(id, job);
  runJob(job, srcPaths, destDir, opts);
  return id;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

// בדיקת כפילות לפני העתקה: מחזיר שמות קיימים ביעד
function checkDuplicates(srcPaths, destDir) {
  const existing = [];
  for (const s of srcPaths) {
    const name = path.basename(s);
    const dest = path.join(destDir, name);
    if (fs.existsSync(dest)) existing.push(name);
  }
  return existing;
}

function getJob(id) {
  const j = jobs.get(id);
  if (j && (j.status === 'done' || j.status === 'error' || j.status === 'cancelled')) j.finishedAt = j.finishedAt || Date.now();
  return j;
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.status === 'done' || j.status === 'error' || j.status === 'cancelled') && (now - (j.finishedAt || now)) > 60 * 60 * 1000) jobs.delete(id);
  }
}
setInterval(cleanupOldJobs, 10 * 60 * 1000);

// מחיקה לאשפה של Windows (עם גיבוי: תיקיית _Trash_ מקומית)
async function trashPaths(paths) {
  const results = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    try {
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; $p='${abs.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $p -PathType Leaf) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') } elseif (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }`;
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err) => err ? reject(err) : resolve());
      });
      results.push({ path: abs, ok: true });
    } catch {
      try {
        const trashDir = path.join(path.dirname(abs), '_Trash_');
        fs.mkdirSync(trashDir, { recursive: true });
        const dest = uniqueName(trashDir, path.basename(abs));
        fs.renameSync(abs, dest);
        results.push({ path: abs, ok: true, note: 'הועבר לאשפה מקומית (_Trash_)' });
      } catch (e2) {
        results.push({ path: abs, ok: false, error: e2.message });
      }
    }
  }
  if (results.some((r) => r.ok)) addHistory({ mode: 'מחיקה לאשפה', files: results.filter((r) => r.ok).map((r) => path.basename(r.path)), dest: 'אשפה' });
  return results;
}

function renamePath(oldPath, newName) {
  const clean = newName.trim();
  if (!clean || /[<>:"/\\|?*\u0000-\u001f]/.test(clean)) {
    throw new Error('שם לא תקין — תווים אסורים או ריק');
  }
  const dest = path.join(path.dirname(oldPath), clean);
  if (path.resolve(oldPath) === path.resolve(dest)) return dest;
  if (fs.existsSync(dest)) throw new Error('קובץ בשם זה כבר קיים');
  fs.renameSync(oldPath, dest);
  addHistory({ mode: 'שינוי שם', files: [path.basename(oldPath)], dest: clean });
  return dest;
}

module.exports = {
  startCopyJob, getJob, cancelJob, checkDuplicates, trashPaths, renamePath,
  checkSpace, statfsFree, fmtSize, getHistory
};
