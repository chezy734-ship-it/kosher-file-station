'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const f = require('../lib/filter');

const OPTS = {
  extensions: ['mp3', 'm4a', 'wav'],
  maxSizeMB: 250,
  minDurationMin: 20,
  maxDurationMin: 120,
  blockUnverifiable: true,
  strictContentCheck: true
};

test('סיומת לא מורשית נחסמת', () => {
  assert.strictEqual(f.matchesExtension('שיר.mp4', ['mp3']), false);
  assert.strictEqual(f.matchesExtension('שיעור.MP3', ['mp3']), true);
  const v = f.decideFile({ name: 'photo.jpg', sizeBytes: 1000, minutes: 30, sniff: 'unknown' }, OPTS);
  assert.strictEqual(v.allowed, false);
  assert.ok(v.reasons.length);
});

test('גודל גדול מהמותר נחסם', () => {
  const v = f.decideFile({ name: 'big.mp3', sizeBytes: 300 * 1024 * 1024, minutes: 60, sniff: 'match' }, OPTS);
  assert.strictEqual(v.allowed, false);
  assert.ok(v.reasons.join(' ').includes('גודל'));
});

test('אורך מחוץ לטווח נחסם', () => {
  const short = f.decideFile({ name: 'short.mp3', sizeBytes: 1000, minutes: 3, sniff: 'match' }, OPTS);
  assert.strictEqual(short.allowed, false);
  const long = f.decideFile({ name: 'long.mp3', sizeBytes: 1000, minutes: 300, sniff: 'match' }, OPTS);
  assert.strictEqual(long.allowed, false);
});

test('אורך בתוך הטווח עובר', () => {
  const v = f.decideFile({ name: 'class.mp3', sizeBytes: 40 * 1024 * 1024, minutes: 75, sniff: 'match' }, OPTS);
  assert.strictEqual(v.allowed, true);
});

test('קובץ ללא אורך מזוהה נחסם כברירת מחדל, ומותר אם מנטרלים', () => {
  const strict = f.decideFile({ name: 'unknown.m4a', sizeBytes: 1000, minutes: null, sniff: 'match' }, OPTS);
  assert.strictEqual(strict.allowed, false);
  const loose = f.decideFile({ name: 'unknown.m4a', sizeBytes: 1000, minutes: null, sniff: 'match' }, { ...OPTS, blockUnverifiable: false });
  assert.strictEqual(loose.allowed, true);
});

test('תוכן לא תואם לסיומת נחסם (מניעת שינוי סיומת)', () => {
  const v = f.decideFile({ name: 'fake.mp3', sizeBytes: 1000, minutes: 60, sniff: 'mismatch' }, OPTS);
  assert.strictEqual(v.allowed, false);
  assert.ok(v.reasons.join(' ').includes('תוכן'));
});

test('מגבלת כמות קבצים בפעולה', () => {
  assert.strictEqual(f.checkFileCount(7, 6).allowed, false);
  assert.strictEqual(f.checkFileCount(6, 6).allowed, true);
  assert.strictEqual(f.checkFileCount(400, 6).allowed, false);
});

test('ניקוי שמות קבצים מתווים מסוכנים', () => {
  assert.strictEqual(f.sanitizeFilename('שיעור: גמרא / פרק א'), 'שיעור_ גמרא _ פרק א');
  assert.strictEqual(f.sanitizeFilename('..\\..\\evil'), '.._.._evil');
  assert.strictEqual(f.sanitizeFilename(''), '');
});

test('שם הקלטה לפי תבנית', () => {
  const name = f.buildRecorderFilename('{date}_{rabbi}_{classNum}_{topic}', { rabbi: 'הרב כהן', classNum: '12', topic: 'גמרא בבא מציעא' });
  assert.match(name, /^\d{4}-\d{2}-\d{2}_הרב כהן_12_גמרא בבא מציעא\.mp3$/);
  // שם בלי תבנית מותאמת — ניקוי תווים
  const safe = f.buildRecorderFilename('{rabbi}:{topic}', { rabbi: 'א', topic: 'ב/ג' });
  assert.ok(!safe.includes('/') && !safe.includes(':'));
});

test('מיון קבצים — תיקיות ראשונות', () => {
  const files = [
    { name: 'b.mp3', isDir: false, sizeBytes: 2 },
    { name: 'A', isDir: true },
    { name: 'a.mp3', isDir: false, sizeBytes: 1 }
  ];
  const sorted = f.sortFiles(files, 'name', 'asc');
  assert.strictEqual(sorted[0].name, 'A');
  assert.strictEqual(sorted[2].name, 'b.mp3');
  const bySize = f.sortFiles(files, 'size', 'desc');
  assert.strictEqual(bySize[2].name, 'a.mp3');
});

test('extOf מחזיר סיומת באותיות קטנות', () => {
  assert.strictEqual(f.extOf('A.MP3'), 'mp3');
  assert.strictEqual(f.extOf('noext'), '');
  assert.strictEqual(f.extOf('.hidden'), '');
});
