'use strict';
// היסטוריית העלאות (לחובת המקליטים) + יומן פעולות.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_PATH = path.join(__dirname, '..', 'history.json');
const AUDIT_PATH = path.join(__dirname, '..', 'audit.log');

function loadHistory() {
  try {
    return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) : [];
  } catch {
    return [];
  }
}

function saveHistory(h) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2), 'utf8');
}

function addUpload(entry) {
  const h = loadHistory();
  h.unshift({
    id: crypto.randomUUID(),
    ...entry,
    at: new Date().toISOString()
  });
  if (h.length > 5000) h.length = 5000;
  saveHistory(h);
  audit('UPLOAD', entry.username || '?', entry.file || '', entry.rabbi || '');
  return h[0];
}

function listHistory(filter) {
  let h = loadHistory();
  if (filter && filter.username) h = h.filter((e) => e.username === filter.username);
  return h;
}

function audit(action, who, what, detail) {
  try {
    const line = `${new Date().toISOString()} | ${action} | ${who} | ${what} | ${detail || ''}\n`;
    fs.appendFileSync(AUDIT_PATH, line, 'utf8');
  } catch { }
}

module.exports = { addUpload, listHistory, audit };
