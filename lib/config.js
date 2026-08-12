'use strict';
// ניהול הגדרות התוכנה: טעינה, שמירה, וסיסמאות (scrypt).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.KOSHER_CONFIG || path.join(ROOT, 'config.json');

const DEFAULTS = {
  port: 8787,
  settingsPasswordHash: null, // scrypt hash; null = עדיין לא הוגדרה
  filters: {
    // א. רק סוגי הקבצים האלה יוצגו
    extensions: ['mp3', 'm4a', 'm4b', 'wav', 'flac', 'ogg', 'wma', 'aac'],
    // ב. גודל מקסימלי לקובץ (MB) — גדול מזה לא יוצג
    maxSizeMB: 250,
    // ג. אורך ההקלטה: טווח דקות — מחוץ לטווח לא יוצג
    minDurationMin: 20,
    maxDurationMin: 120,
    // ד. כמה קבצים לכל היותר אפשר להעתיק בפעולה אחת
    maxFilesPerCopy: 6,
    // אם אי אפשר לקבוע את אורך הקובץ (וקלטת הקובץ לא מזוהה) — לא להציג
    blockUnverifiable: true,
    // בדיקת תוכן אמיתי (magic bytes) כדי לסכל שינוי סיומת
    strictContentCheck: true
  },
  drives: {
    // א. הסתרת כונן המערכת בלבד (כונן עם חלונות) — SSD חיצוני וקבועים אחרים מוצגים
    hideSystemDrives: true,
    allowedDriveLetters: [] // ריק = כל הכוננים
  },
  view: {
    // תצוגה: 'list' (רשימה) או 'icons' (סמלים גדולים)
    mode: 'list',
    // הצגת תמונת אלבום בתוך תצוגת הסמלים
    showArt: false
  },
  station: {
    enabled: true,
    libraryPath: '', // ריק = נבחר אוטומטית הכונן הקבוע הגדול ביותר
    rabbis: [],
    filenameTemplate: '{date}_{rabbi}_{classNum}_{topic}', // למקליט
    allowConvertOnUpload: true
  }
};

let cache = null;

function deepMerge(base, extra) {
  if (Array.isArray(extra)) return extra;
  if (extra && typeof extra === 'object') {
    const out = { ...base };
    for (const k of Object.keys(extra)) {
      out[k] = deepMerge(base && base[k], extra[k]);
    }
    return out;
  }
  return extra === undefined ? base : extra;
}

function loadConfig() {
  if (cache) return cache;
  let base = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      base = deepMerge(base, raw);
    }
  } catch (e) {
    console.error('שגיאה בקריאת config.json:', e.message);
  }
  cache = base;
  return cache;
}

function saveConfig(cfg) {
  cache = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// API ציבורי בלי גישה להגדרות? (לקריאה ראשונית של מצב)
function publicStatus(cfg) {
  return {
    filters: cfg.filters,
    drives: cfg.drives,
    station: cfg.station,
    view: cfg.view,
    hasPassword: !!cfg.settingsPasswordHash
  };
}

module.exports = { loadConfig, saveConfig, hashPassword, verifyPassword, publicStatus, CONFIG_PATH };
