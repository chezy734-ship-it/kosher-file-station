'use strict';
// זיהוי כוננים ב-Windows: סוג (קבוע/נשלף), שטח פנוי, וזיהוי סריאלי של ההתקן.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
let cache = { at: 0, drives: [] };
const TTL = 5000; // רענון כל 5 שניות

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

// שליפת רשימת כוננים עם סוג — wmic עם גיבוי של PowerShell
async function rawDriveList() {
  let out = await run('wmic', ['logicaldisk', 'get', 'DeviceID,DriveType,VolumeName,FreeSpace,Size', '/format:csv']);
  if (!out.trim()) {
    out = await run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "{0},{1},{2},{3},{4}" -f $_.DeviceID,$_.DriveType,$_.VolumeName,$_.FreeSpace,$_.Size }']);
  }
  const drives = [];
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  // מיפוי עמודות לפי שורת הכותרת (wmic מוסיף עמודת Node)
  let idx = { dev: 0, type: 1, vol: 2, free: 3, size: 4 };
  if (lines.length && /DeviceID/i.test(lines[0])) {
    const h = lines[0].split(',').map((c) => c.trim().toLowerCase());
    idx = {
      dev: h.indexOf('deviceid'),
      type: h.indexOf('drivetype'),
      vol: h.indexOf('volumename'),
      free: h.indexOf('freespace'),
      size: h.indexOf('size')
    };
  }
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim());
    if (idx.dev < 0 || !cols[idx.dev]) continue;
    const letter = (cols[idx.dev] || '').match(/^([A-Za-z]):/);
    const type = parseInt(cols[idx.type], 10);
    if (!letter || isNaN(type)) continue;
    const root = letter[1].toUpperCase() + ':\\';
    if (!fs.existsSync(root)) continue;
    drives.push({
      letter: letter[1].toUpperCase(),
      root,
      type, // 2 = נשלף, 3 = קבוע, 5 = CD, 4 = רשת
      volume: cols[idx.vol] || '',
      free: parseFloat(cols[idx.free]) || 0,
      size: parseFloat(cols[idx.size]) || 0
    });
  }
  // סטטיסטיקת שטח עדכנית
  for (const d of drives) {
    try {
      const s = fs.statfsSync(d.root);
      if (s && s.bavail && s.bsize) d.free = Number(s.bavail) * Number(s.bsize);
    } catch { /* נשאר עם wmic */ }
  }
  return drives;
}

// זיהוי סריאלי של ההתקן הפיזי שמאחורי כונן נשלף (בדרך כלל הקורא, לא הכרטיס)
async function driveSerial(letter) {
  const ps = `$d = Get-Partition -DriveLetter ${letter} -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue; if ($d) { $d.SerialNumber }`;
  const out = await run('powershell', ['-NoProfile', '-Command', ps]);
  const s = (out || '').trim().replace(/\s+/g, ' ');
  return s || null;
}

// זיהוי כונן המערכת (זה עם חלונות) — מוסתר כברירת מחדל
function systemDrive() {
  const sd = process.env.SystemDrive || 'C:'; // למשל "C:"
  const letter = String(sd).replace(':', '').toUpperCase();
  // בדיקת גיבוי: כונן שמכיל את תיקיית Windows
  try {
    if (fs.existsSync(`${letter}:\\Windows\\System32`)) return letter;
  } catch { }
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    try { if (fs.existsSync(`${l}:\\Windows\\System32`)) return l; } catch { }
  }
  return letter;
}

// רשימה סופית לפי הגדרות: הסתרת כונן המערכת + חריגים
// (כוננים קבועים חיצוניים כמו SSD — מוצגים; רק כונן המערכת מוסתר)
async function visibleDrives(cfg) {
  const now = Date.now();
  if (now - cache.at > TTL) {
    cache = { at: now, drives: await rawDriveList() };
  }
  const hideSystem = cfg.drives.hideSystemDrives !== false;
  const allowed = (cfg.drives.allowedDriveLetters || []).map((l) => String(l).toUpperCase().replace(':', ''));
  const sys = systemDrive();
  const filtered = cache.drives.filter((d) => {
    if (allowed.includes(d.letter)) return true;
    if (hideSystem && d.letter === sys) return false;
    return d.type === 2 || d.type === 3 || d.type === 4; // נשלף / קבוע (כולל SSD חיצוני) / רשת
  });
  return filtered;
}

// בחירת כונן ברירת מחדל לספריית השיעורים של העמדה
async function pickLibraryPath(cfg) {
  if (cfg.station.libraryPath) {
    const p = cfg.station.libraryPath;
    try {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      return p;
    } catch { return null; }
  }
  const all = await rawDriveList();
  const fixed = all.filter((d) => d.type === 3).sort((a, b) => b.free - a.free);
  if (!fixed.length) return null;
  const root = path.join(fixed[0].root, 'שיעורים');
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return root;
  } catch { return null; }
}

module.exports = { visibleDrives, rawDriveList, driveSerial, pickLibraryPath };
