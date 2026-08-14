'use strict';
// קריאת אורך הקלטות + זיהוי תוכן אמיתי (magic bytes) + המרה ל-MP3 באמצעות ffmpeg.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------
// זיהוי סוג תוכן אמיתי לפי ראשי הקובץ (נגד שינוי סיומת)
// ---------------------------------------------------------------
const MAGIC = {
  mp3: (buf) => (buf.length > 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // "ID3"
    (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0), // סינכרון MPEG
  wav: (buf) => buf.length > 11 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE',
  flac: (buf) => buf.length > 3 && buf.toString('latin1', 0, 4) === 'fLaC',
  m4a: (buf) => buf.length > 7 && buf.toString('latin1', 4, 8) === 'ftyp',
  m4b: (buf) => buf.length > 7 && buf.toString('latin1', 4, 8) === 'ftyp',
  mp4: (buf) => buf.length > 7 && buf.toString('latin1', 4, 8) === 'ftyp',
  aac: (buf) => buf.length > 1 && (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0), // ADTS
  ogg: (buf) => buf.length > 3 && buf.toString('latin1', 0, 4) === 'OggS',
  wma: (buf) => buf.length > 15 && buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75,
  amr: (buf) => buf.length > 5 && buf.toString('latin1', 0, 6) === '#!AMR',
  opus: (buf) => buf.length > 7 && buf.toString('latin1', 0, 8) === 'OpusHead'
};

function sniffExt(buf, ext) {
  const check = MAGIC[String(ext).toLowerCase()];
  if (!check) return 'unknown'; // סיומת שאין לנו בדיקה עבורה — לא נחרץ
  return check(buf) ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------
// חישוב אורך (בדקות) — פורמטים שונים
// ---------------------------------------------------------------
function readHead(fd, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return buf.subarray(0, n);
}

// MP3: אומדן משך לפי קצב סיביות ממוצע (מתמודד גם עם VBR)
function mp3Duration(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const first = readHead(fd, 16 * 1024);
    let off = 0;
    // דלג על תגית ID3
    if (first.length > 9 && first.toString('latin1', 0, 3) === 'ID3') {
      const tagSize = ((first[6] & 0x7f) << 21) | ((first[7] & 0x7f) << 14) | ((first[8] & 0x7f) << 7) | (first[9] & 0x7f);
      off = 10 + tagSize;
    }
    function frameBitrate(idx, version) {
      const table = version === 1
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
      return table[idx] || 0;
    }
    function findFrame(start) {
      const data = readHead(fd, Math.min(size - start, 16 * 1024));
      for (let i = 0; i < data.length - 4; i++) {
        if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) {
          const verBits = (data[i + 1] >> 3) & 0x03;
          const layerBits = (data[i + 1] >> 1) & 0x03;
          const brIdx = (data[i + 2] >> 4) & 0x0f;
          if (verBits !== 1 && layerBits !== 0 && brIdx !== 0 && brIdx !== 15) {
            const version = verBits === 3 ? 1 : 2; // MPEG1 או MPEG2/2.5
            return { bitrate: frameBitrate(brIdx, version) * 1000 };
          }
        }
      }
      return null;
    }
    // דגימה בכמה נקודות לאורך הקובץ
    const points = [off, Math.floor(size * 0.5), Math.floor(size * 0.8)];
    let bits = [];
    let frameCount = 0;
    for (const p of points) {
      if (p >= size) continue;
      const f = findFrame(p);
      if (f) { bits.push(f.bitrate); frameCount++; }
    }
    if (!bits.length) return null;
    const avg = bits.reduce((a, b) => a + b, 0) / bits.length;
    return (size * 8) / avg / 60;
  } finally {
    fs.closeSync(fd);
  }
}

// WAV: משך = גודל הנתונים / קצב הבתים
function wavDuration(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    let off = 12;
    while (off < Math.min(size, 512 * 1024) - 8) {
      const hdr = Buffer.alloc(8);
      const n = fs.readSync(fd, hdr, 0, 8, off);
      if (n < 8) break;
      const id = hdr.toString('latin1', 0, 4);
      const len = hdr.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(2);
        fs.readSync(fd, fmt, 0, 2, off + 8);
        const byteRate = Buffer.alloc(4);
        fs.readSync(fd, byteRate, 0, 4, off + 8 + 8);
        if (id === 'fmt ' && byteRate.readUInt32LE(0) > 0) {
          // המשך: מצא chunk data
          let dOff = off + 8 + len;
          if (len % 2) dOff++;
          while (dOff < size - 8) {
            const d = Buffer.alloc(8);
            const m = fs.readSync(fd, d, 0, 8, dOff);
            if (m < 8) break;
            const did = d.toString('latin1', 0, 4);
            const dlen = d.readUInt32LE(4);
            if (did === 'data') return dlen / byteRate.readUInt32LE(0) / 60;
            dOff += 8 + dlen + (dlen % 2);
          }
        }
        return null;
      }
      off += 8 + len + (len % 2);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// M4A/MP4: קופסת mvhd — timescale ו-duration
function mp4Duration(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    let off = 0;
    for (let depth = 0; depth < 64 && off < Math.min(size, 8 * 1024 * 1024) - 8; depth++) {
      const hdr = Buffer.alloc(8);
      const n = fs.readSync(fd, hdr, 0, 8, off);
      if (n < 8) break;
      const len = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (len < 8 || len > size - off) break; // קופסה לא תקינה
      if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'udta') {
        off += 8;
        continue;
      }
      if (type === 'mvhd') {
        const ver = Buffer.alloc(1);
        fs.readSync(fd, ver, 0, 1, off + 8);
        const tsBuf = Buffer.alloc(4);
        const durBuf = Buffer.alloc(ver[0] === 1 ? 8 : 4);
        fs.readSync(fd, tsBuf, 0, 4, off + 8 + 4 + 12); // mvhd: ver/flags(4) + creation(4/8) + modification(4/8) → timescale
        fs.readSync(fd, durBuf, 0, durBuf.length, off + 8 + 4 + 12 + 4 + (ver[0] === 1 ? 8 : 0) + 4);
        const timescale = tsBuf.readUInt32BE(0);
        const duration = ver[0] === 1 ? Number(durBuf.readBigUInt64BE(0)) : durBuf.readUInt32BE(0);
        if (timescale > 0) return duration / timescale / 60;
        return null;
      }
      off += len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// FLAC: STREAMINFO — total samples / sample rate
function flacDuration(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = Buffer.alloc(34);
    const n = fs.readSync(fd, st, 0, 34, 8); // אחרי "fLaC" + header byte + length
    if (n < 34) return null;
    const sampleRate = (st[10] << 12) | (st[11] << 4) | (st[12] >> 4);
    const totalSamples = (BigInt(st[13]) << 32n) | (BigInt(st[14]) << 24n) | (BigInt(st[15]) << 16n) | (BigInt(st[16]) << 8n) | BigInt(st[17]);
    if (sampleRate > 0) return Number(totalSamples) / sampleRate / 60;
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin) return resolve(null);
    const probeBin = bin.toLowerCase().endsWith('ffmpeg.exe') ? bin.slice(0, -9) + 'ffprobe.exe' : bin.replace(/ffmpeg$/i, 'ffprobe');
    const child = spawn(probeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const secs = parseFloat(out.trim());
      resolve(code === 0 && !isNaN(secs) && secs > 0 ? secs / 60 : null);
    });
    setTimeout(() => { try { child.kill(); } catch {} }, 8000);
  });
}

function findFfmpeg() {
  const candidates = [
    path.join(__dirname, '..', 'ffmpeg', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'ffmpeg.exe'),
    'ffmpeg'
  ];
  for (const c of candidates) {
    try {
      if (c === 'ffmpeg') { spawnSyncCheck(c); return c; }
      if (fs.existsSync(c)) return c;
    } catch { /* ניסיון הבא */ }
  }
  return null;
}
function spawnSyncCheck(cmd) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 4000 });
  return r.status === 0;
}

// ---------------------------------------------------------------
// מטא-דאטה: כותרת / אמן / אלבום (ID3v2, FLAC VORBIS_COMMENT)
// ---------------------------------------------------------------
function decodeText(buf, enc) {
  try {
    if (enc === 0) return buf.toString('latin1');
    if (enc === 1) {
      // UTF-16 עם BOM
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le');
      }
      return buf.toString('utf16le');
    }
    if (enc === 2) { const b = Buffer.from(buf); b.swap16(); return b.toString('utf16le'); }
    return buf.toString('utf8');
  } catch { return ''; }
}

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

// פענוח תגיות ID3v2 מתוך חוצץ (החלק הראשון של הקובץ)
function parseId3(buf, wantArt) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return { tags: {}, art: null };
  const ver = buf[3];
  let tagSize = syncsafe(buf, 6);
  tagSize = Math.min(tagSize, buf.length - 10);
  let off = 10;
  if ((buf[5] & 0x40) && ver >= 3) {
    // תגית מורחבת
    if (ver === 4) off += 4 + syncsafe(buf, 10);
    else off += 6 + buf.readUInt32BE(10);
  }
  const tags = {};
  let art = null;
  const end = 10 + tagSize;
  const frameHeaderSize = ver === 2 ? 6 : 10;
  while (off + frameHeaderSize <= end) {
    const id = buf.toString('latin1', off, off + 4);
    let fsize;
    if (ver === 2) {
      fsize = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5];
      off += 6;
    } else {
      fsize = ver === 4 ? syncsafe(buf, off + 4) : buf.readUInt32BE(off + 4);
      off += 10;
    }
    if (!id.trim() || fsize <= 0) break;
    if (off + fsize > end) break;
    const data = buf.subarray(off, off + fsize);
    off += fsize;
    if (id === 'TIT2') tags.title = decodeText(data.subarray(1), data[0]).replace(/\u0000/g, '').trim();
    else if (id === 'TPE1') tags.artist = decodeText(data.subarray(1), data[0]).replace(/\u0000/g, '').trim();
    else if (id === 'TALB') tags.album = decodeText(data.subarray(1), data[0]).replace(/\u0000/g, '').trim();
    else if (id === 'APIC' && wantArt && !art) {
      const enc = data[0];
      let p = 1;
      let mimeEnd = data.indexOf(0, p);
      if (mimeEnd < 0) continue;
      const mime = data.toString('latin1', p, mimeEnd);
      p = mimeEnd + 1 + 1; // סוג תמונה
      // תיאור לפי קידוד
      if (enc === 0 || enc === 3) { const d = data.indexOf(0, p); if (d < 0) continue; p = d + 1; }
      else {
        let d = p;
        while (d + 1 < data.length && !(data[d] === 0 && data[d + 1] === 0)) d += 2;
        if (d + 1 >= data.length) continue;
        p = d + 2;
      }
      if (p < data.length && data.length - p > 30) art = { mime: mime || 'image/jpeg', data: Buffer.from(data.subarray(p)) };
    }
  }
  return { tags, art };
}

// תגיות + תמונה מקובצי FLAC (VORBIS_COMMENT / PICTURE)
function parseFlacMeta(buf, wantArt) {
  const tags = {};
  let art = null;
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'fLaC') return { tags, art };
  let off = 4;
  for (let i = 0; i < 32; i++) {
    if (off + 4 > buf.length) break;
    const header = buf[off];
    const type = header & 0x7f;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    off += 4;
    if (off + len > buf.length) break;
    const data = buf.subarray(off, off + len);
    off += len;
    if (type === 4) {
      // VORBIS_COMMENT
      let p = 4;
      let count = data.length >= 8 ? data.readUInt32LE(4) : 0;
      p = 8;
      for (let c = 0; c < count && p + 4 <= data.length; c++) {
        const l = data.readUInt32LE(p); p += 4;
        if (p + l > data.length) break;
        const kv = data.toString('utf8', p, p + l); p += l;
        const eq = kv.indexOf('=');
        if (eq > 0) {
          const k = kv.slice(0, eq).toUpperCase();
          const v = kv.slice(eq + 1);
          if (k === 'TITLE') tags.title = v;
          else if (k === 'ARTIST') tags.artist = v;
          else if (k === 'ALBUM') tags.album = v;
        }
      }
    } else if (type === 6 && wantArt && !art) {
      // PICTURE (base64)
      let p = 0;
      if (p + 8 > data.length) continue;
      const mimeLen = data.readUInt32LE(p + 4); p += 8;
      if (p + mimeLen > data.length) continue;
      const mime = data.toString('latin1', p, p + mimeLen); p += mimeLen;
      const descLen = data.readUInt32LE(p); p += 4;
      p += descLen + 16; // גודל/צבעים
      const dataLen = data.readUInt32LE(p); p += 4;
      if (p + dataLen <= data.length && dataLen > 30) art = { mime: mime || 'image/jpeg', data: Buffer.from(data.subarray(p, p + dataLen)) };
    }
    if (header & 0x80) break; // בלוק אחרון
  }
  return { tags, art };
}

// קריאת תגיות לקובץ (ללא תמונה — קל)
function readTags(file, ext) {
  const e = String(ext).toLowerCase();
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(512 * 1024, fs.fstatSync(fd).size || 512 * 1024));
      const n = fs.readSync(fd, head, 0, head.length, 0);
      const buf = head.subarray(0, n);
      if (e === 'mp3') return parseId3(buf, false).tags;
      if (e === 'flac') return parseFlacMeta(buf, false).tags;
    } finally { fs.closeSync(fd); }
  } catch { }
  return {};
}

// שליפת תמונת אלבום (APIC/PICTURE) — לקריאה לפי דרישה
function extractArt(file, ext) {
  const e = String(ext).toLowerCase();
  try {
    const size = fs.statSync(file).size;
    const readLen = Math.min(size, 8 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const n = fs.readSync(fd, buf, 0, readLen, 0);
      const data = buf.subarray(0, n);
      if (e === 'mp3') return parseId3(data, true).art;
      if (e === 'flac') return parseFlacMeta(data, true).art;
    } finally { fs.closeSync(fd); }
  } catch { }
  return null;
}

// API ראשי: מחזיר { minutes, sniff, tags } עבור קובץ
async function analyzeFile(file, ext) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const size = stat.size;
  let sniff = 'unknown';
  try {
    const head = Buffer.alloc(64);
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    sniff = sniffExt(head.subarray(0, n), ext);
  } catch { }
  let minutes = null;
  try {
    switch (String(ext).toLowerCase()) {
      case 'mp3': minutes = mp3Duration(file, size); break;
      case 'wav': minutes = wavDuration(file, size); break;
      case 'm4a': case 'm4b': case 'mp4': minutes = mp4Duration(file, size); break;
      case 'flac': minutes = flacDuration(file, size); break;
      default: break;
    }
  } catch { minutes = null; }
  if (minutes === null) minutes = await ffprobeDuration(file);
  const tags = readTags(file, ext);
  return { size, minutes, sniff, unverifiable: minutes === null, tags };
}

// המרה ל-MP3 (ffmpeg) — מחזיר Promise עם התקדמות גסה
function convertToMp3(src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const bin = findFfmpeg();
    if (!bin) {
      return reject(new Error('ffmpeg לא נמצא — לא ניתן להמיר. הניחו את ffmpeg.exe בתיקיית התוכנה או ב-PATH.'));
    }
    const args = ['-y', '-i', src, '-codec:a', 'libmp3lame', '-qscale:a', '2', dest];
    const child = spawn(bin, args, { windowsHide: true });
    let done = false;
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch {} reject(new Error('ההמרה ארכה יותר מדי זמן ונעצרה.')); } }, 30 * 60 * 1000);
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('לא ניתן להריץ ffmpeg: ' + e.message)); });
    child.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(dest)) resolve(dest);
      else reject(new Error('המרה נכשלה (קוד ' + code + ').'));
    });
  });
}

module.exports = { analyzeFile, sniffExt, convertToMp3, findFfmpeg, extractArt, readTags };
