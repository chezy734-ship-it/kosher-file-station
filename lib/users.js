'use strict';
// משתמשי המקליטים (בקשה ב'): שם משתמש + סיסמה + הרשאות רבנים + זיהוי התקן אופציונלי.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./config');

const USERS_PATH = path.join(__dirname, '..', 'users.json');

let cache = null;

function loadUsers() {
  if (cache) return cache;
  try {
    cache = fs.existsSync(USERS_PATH) ? JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')) : { recorders: [] };
  } catch {
    cache = { recorders: [] };
  }
  if (!Array.isArray(cache.recorders)) cache.recorders = [];
  return cache;
}

function saveUsers(u) {
  cache = u;
  fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2), 'utf8');
}

function publicUser(u) {
  return { id: u.id, username: u.username, rabhis: u.rabhis || [], deviceFingerprint: u.deviceFingerprint || null, createdAt: u.createdAt };
}

function listRecorders() {
  return loadUsers().recorders.map(publicUser);
}

function findRecorder(username) {
  return loadUsers().recorders.find((u) => String(u.username).toLowerCase() === String(username || '').toLowerCase());
}

function addRecorder({ username, password, rabhis = [], deviceFingerprint = null }) {
  const uname = String(username || '').trim();
  if (!uname) throw new Error('שם משתמש ריק');
  if (!password || String(password).length < 4) throw new Error('סיסמה קצרה מדי (לפחות 4 תווים)');
  if (findRecorder(uname)) throw new Error('שם משתמש כבר קיים');
  const u = loadUsers();
  u.recorders.push({
    id: crypto.randomUUID(),
    username: uname,
    passwordHash: hashPassword(String(password)),
    rabhis: Array.isArray(rabhis) ? rabhis : [],
    deviceFingerprint: deviceFingerprint || null,
    createdAt: new Date().toISOString()
  });
  saveUsers(u);
  return publicUser(u.recorders[u.recorders.length - 1]);
}

function removeRecorder(id) {
  const u = loadUsers();
  const before = u.recorders.length;
  u.recorders = u.recorders.filter((r) => r.id !== id);
  if (u.recorders.length === before) throw new Error('משתמש לא נמצא');
  saveUsers(u);
}

function verifyRecorder(username, password) {
  const r = findRecorder(username);
  if (!r) return null;
  if (!verifyPassword(String(password), r.passwordHash)) return null;
  return publicUser(r);
}

module.exports = { loadUsers, saveUsers, listRecorders, addRecorder, removeRecorder, verifyRecorder, findRecorder };
