'use strict';
// עזרים משותפים לממשק: בקשת API, חלונות, התראות, פורמטים.

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  let data = {};
  try { data = await res.json(); } catch { }
  if (!res.ok) throw new Error(data.error || 'שגיאה בשרת');
  return data;
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function fmtMin(min) {
  if (min == null) return 'לא ידוע';
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

let toastSeq = 0;
function toast(msg, kind = 'info') {
  const root = document.getElementById('toasts') || document.body;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 5000);
}

// חלון מודאלי פשוט: מחזיר { close }
function openModal(html) {
  const root = document.getElementById('modalRoot') || document.body;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  root.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  return { el: wrap, close };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function confirmModal(title, text, okText = 'אישור') {
  return new Promise((resolve) => {
    const { close } = openModal(`
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
      <div class="modal-actions">
        <button class="btn danger" data-act="ok">${esc(okText)}</button>
        <button class="btn" data-act="cancel">ביטול</button>
      </div>`);
    document.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => { close(); resolve(b.dataset.act === 'ok'); });
    });
  });
}

function promptModal(title, label, value = '', okText = 'אישור') {
  return new Promise((resolve) => {
    const { close } = openModal(`
      <h2>${esc(title)}</h2>
      <label>${esc(label)}
        <input id="promptInput" type="text" value="${esc(value)}">
      </label>
      <div class="modal-actions">
        <button class="btn primary" data-act="ok">${esc(okText)}</button>
        <button class="btn" data-act="cancel">ביטול</button>
      </div>`);
    const input = document.getElementById('promptInput');
    input.focus();
    input.select();
    const done = (val) => { close(); resolve(val); };
    document.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => done(b.dataset.act === 'ok' ? input.value : null));
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  });
}

// חלון התקדמות עם סטטוס, פעולה נוכחית וכפתור ביטול
function progressModal(title) {
  const { close, el } = openModal(`
    <h2>${esc(title)}</h2>
    <div class="progress"><div class="progress-bar"></div></div>
    <p class="progress-action" dir="auto"></p>
    <p class="progress-text" dir="auto">מתחיל...</p>
    <div class="modal-actions"><button class="btn danger" data-cancel>ביטול</button></div>`);
  let cancelCb = null;
  el.querySelector('[data-cancel]').addEventListener('click', () => {
    el.querySelector('[data-cancel]').disabled = true;
    el.querySelector('[data-cancel]').textContent = 'מבטל...';
    if (cancelCb) cancelCb();
  });
  return {
    set(pct, text, action) {
      el.querySelector('.progress-bar').style.width = (pct || 0) + '%';
      if (action) el.querySelector('.progress-action').textContent = action;
      if (text) el.querySelector('.progress-text').textContent = text;
    },
    addCancel(cb) { cancelCb = cb; },
    close
  };
}
