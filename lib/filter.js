'use strict';
// מנוע הסינון — לב התוכנה.
// כל הפונקציות טהורות (בלי קבצים) כדי שניתן יהיה לבדוק אותן ביחידות.
const path = require('path');

const DEFAULT_EXTS = ['mp3', 'm4a', 'm4b', 'wav', 'flac', 'ogg', 'wma', 'aac'];

function extOf(name) {
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0 || dot === String(name).length - 1) return '';
  return String(name).slice(dot + 1).toLowerCase();
}

// תבניות שם קבועות למקליט — תיקיות/קבצים שהתוכנה עצמה יוצרת
const SYSTEM_NAMES = ['_Trash_', '.kosher'];

function isSystemName(name) {
  return SYSTEM_NAMES.includes(String(name).toLowerCase());
}

// א. סינון לפי סיומת
function matchesExtension(name, allowedExts) {
  const exts = (allowedExts && allowedExts.length ? allowedExts : DEFAULT_EXTS).map((e) => String(e).toLowerCase());
  const e = extOf(name);
  return exts.includes(e);
}

// ב. סינון לפי גודל (MB)
function matchesSize(sizeBytes, maxSizeMB) {
  if (!maxSizeMB || maxSizeMB <= 0) return true;
  return sizeBytes <= maxSizeMB * 1024 * 1024;
}

// ג. סינון לפי אורך (דקות)
function matchesDuration(minutes, minMin, maxMin) {
  if (minutes === null || minutes === undefined) {
    // לא ניתן לקבוע — ההחלטה נעשית ע"י blockUnverifiable
    return null;
  }
  const lo = minMin && minMin > 0 ? minMin : 0;
  const hi = maxMin && maxMin > 0 ? maxMin : Infinity;
  return minutes >= lo && minutes <= hi;
}

// ד. סינון לפי מספר קבצים בפעולה
function checkFileCount(count, maxPerCopy) {
  if (!maxPerCopy || maxPerCopy <= 0) return { allowed: true, count };
  return { allowed: count <= maxPerCopy, count };
}

/**
 * החלטה מלאה עבור קובץ אחד.
 * meta: { name, sizeBytes, minutes (או null), sniff: 'match'|'mismatch'|'unknown' }
 * opts:  { extensions, maxSizeMB, minDurationMin, maxDurationMin, blockUnverifiable, strictContentCheck }
 * החזרה: { allowed, reasons: string[] }
 */
function decideFile(meta, opts) {
  const reasons = [];
  const exts = opts.extensions && opts.extensions.length ? opts.extensions : DEFAULT_EXTS;
  if (!matchesExtension(meta.name, exts)) {
    reasons.push('סיומת לא מורשית');
    return { allowed: false, reasons };
  }
  if (!matchesSize(meta.sizeBytes, opts.maxSizeMB)) {
    reasons.push(`גודל גדול מהמותר (מקסימום ${opts.maxSizeMB}MB)`);
    return { allowed: false, reasons };
  }
  const dur = matchesDuration(meta.minutes, opts.minDurationMin, opts.maxDurationMin);
  if (dur === null) {
    if (opts.blockUnverifiable !== false) {
      reasons.push('אורך הקובץ לא ניתן לזיהוי');
      return { allowed: false, reasons };
    }
  } else if (dur === false) {
    reasons.push('אורך הקובץ מחוץ לטווח המותר');
    return { allowed: false, reasons };
  }
  if (opts.strictContentCheck !== false && meta.sniff === 'mismatch') {
    reasons.push('תוכן הקובץ אינו תואם לסיומת');
    return { allowed: false, reasons };
  }
  return { allowed: true, reasons };
}

// ניקוי שם קובץ מחתיכים מסוכנים (למקליט / שינוי שם)
function sanitizeFilename(name, maxLen = 80) {
  let n = String(name || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/\.+$/g, '');
  if (n.length > maxLen) n = n.slice(0, maxLen);
  return n;
}

// שם קובץ לפי תבנית המקליט
function buildRecorderFilename(template, data) {
  const t = template || '{date}_{rabbi}_{classNum}_{topic}';
  const today = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const values = { date, rabbi: data.rabbi || '', classNum: data.classNum || '', topic: data.topic || '' };
  let name = t;
  for (const k of Object.keys(values)) name = name.replace(new RegExp('{' + k + '}', 'g'), sanitizeFilename(values[k]));
  return sanitizeFilename(name) + '.mp3';
}

// מסדרת שמות קבצים לפי מיון
function sortFiles(files, key, dir) {
  const k = key || 'name';
  const d = dir === 'desc' ? -1 : 1;
  const cmp = (a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    switch (k) {
      case 'size': return (a.sizeBytes - b.sizeBytes) * d;
      case 'modified': return (a.modifiedMs - b.modifiedMs) * d;
      case 'duration': return ((a.minutes || 0) - (b.minutes || 0)) * d;
      default: return String(a.name).localeCompare(String(b.name), 'he') * d;
    }
  };
  return [...files].sort(cmp);
}

module.exports = {
  DEFAULT_EXTS, extOf, matchesExtension, matchesSize, matchesDuration,
  checkFileCount, decideFile, sanitizeFilename, buildRecorderFilename, sortFiles, isSystemName
};
