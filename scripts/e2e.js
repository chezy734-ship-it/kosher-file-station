'use strict';
// בדיקת קצה-לקצה מול שרת רץ (http://127.0.0.1:8787)
// הרצה: node test/e2e.js
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8787';
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'test-data', 'class40min.wav');
const DEST = path.join(ROOT, 'library-demo');

let cookie = null;
async function api(p, opts = {}) {
  const headers = {};
  if (opts.body && !opts.isForm) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers,
    body: opts.body && !opts.isForm ? JSON.stringify(opts.body) : undefined
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitJob(id, maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const { job } = await api('/api/job/' + id);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error || 'job error');
    await sleep(300);
  }
  throw new Error('job timeout');
}
// איפוס מצב הבדיקה: מנקה נתוני עמדה ומאפס את הסיסמה (config.json נשמר)
for (const f of ['users.json', 'history.json', 'audit.log']) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { }
}
try {
  const cfgPath = path.join(ROOT, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  delete cfg.settingsPasswordHash;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
} catch { }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  console.log('== רשימת קבצים מסוננת ==');
  const list = await api('/api/list?path=' + encodeURIComponent(path.join(ROOT, 'test-data')));
  const byName = Object.fromEntries(list.items.map((i) => [i.name, i]));
  check('class40min.wav מאושר', byName['class40min.wav'] && byName['class40min.wav'].minutes !== undefined);
  check('אורך 40 דקות', byName['class40min.wav'] && Math.round(byName['class40min.wav'].minutes) === 40);
  check('2sec.wav מוסתר לחלוטין (אורך)', !byName['2sec.wav']);
  check('fake.mp3 מוסתר לחלוטין (תוכן)', !byName['fake.mp3']);
  check('דיווח על מספר קבצים מוסתרים', typeof list.hidden === 'number' && list.hidden >= 3);

  console.log('== העתקה ==');
  const { job } = await api('/api/copy', { method: 'POST', body: { src: [SRC], dest: DEST, duplicates: 'skip' } });
  const done = await waitJob(job);
  check('העתקה הושלמה', done.status === 'done');
  check('הקובץ הגיע ליעד', fs.existsSync(path.join(DEST, path.basename(SRC))));

  console.log('== כפילות (skip) ==');
  const { job: j2 } = await api('/api/copy', { method: 'POST', body: { src: [SRC], dest: DEST, duplicates: 'skip' } });
  const d2 = await waitJob(j2);
  check('דווח על קובץ קיים', d2.errors && d2.errors.some((e) => e.includes('כבר קיים')));

  console.log('== מגבלת כמות ==');
  try {
    await api('/api/copy', { method: 'POST', body: { src: Array(7).fill(SRC), dest: DEST } });
    check('7 קבצים נחסמים', false);
  } catch (e) {
    check('7 קבצים נחסמים', /כמות/.test(e.message));
  }

  console.log('== הגדרות: הגדרת סיסמה ראשונה ==');
  const before = await api('/api/settings');
  check('מצב ראשוני: ללא סיסמה', before.settingsPasswordHash === null);
  const pw = 'test-pass-123';
  await api('/api/settings', { method: 'POST', body: { newPassword: pw, settings: { maxFilesPerCopy: 3 } } });
  // כניסה עם הסיסמה החדשה כדי לקרוא שוב
  await api('/api/login', { method: 'POST', body: { password: pw } });
  const after = await api('/api/settings');
  check('סיסמה נשמרה', !!after.settingsPasswordHash);
  // המשך בזהות אחראי
  const login = await api('/api/station/login', { method: 'POST', body: { password: pw } });
  check('כניסת אחראי', login.role === 'manager');
  const rabhis = (await api('/api/station/rabhis')).rabbis;
  check('רשימת רבנים מוגדרת', Array.isArray(rabhis) && rabhis.length > 0);
  const rec = await api('/api/station/users', { method: 'POST', body: { username: 'בחור-מקליט', password: 'rec1234', rabhis: [rabhis[0]] } });
  check('מקליט נוסף', rec.user && rec.user.username === 'בחור-מקליט');

  console.log('== העלאת מקליט (תבנית שם + הרשאות) ==');
  const recLogin = await api('/api/station/login', { method: 'POST', body: { username: 'בחור-מקליט', password: 'rec1234' } });
  check('כניסת מקליט', recLogin.role === 'recorder');
  // ניסיון העלאה לרב לא מורשה — אמור להיחסם
  try {
    await api('/api/station/upload', { method: 'POST', body: { src: [SRC], rabbi: rabhis[1] || 'רב אחר', classNum: '1', topic: 't' } });
    check('העלאה לרב לא מורשה נחסמת', false);
  } catch (e) {
    check('העלאה לרב לא מורשה נחסמת', /מורשה/.test(e.message));
  }
  const up = await api('/api/station/upload', { method: 'POST', body: { src: [SRC], rabbi: rabhis[0], classNum: '12', topic: 'גמרא בבא מציעא' } });
  const upJob = await waitJob(up.job);
  check('העלאה הושלמה', upJob.status === 'done');
  const finalize = await api('/api/station/upload-finalize', { method: 'POST', body: { job: up.job, entries: up.entries, rabbi: rabhis[0] } });
  check('היסטוריה נרשמה', finalize.count >= 1);
  const recDir = path.join(DEST, rabhis[0]);
  const uploaded = fs.readdirSync(recDir).find((f) => f.includes('_12_גמרא בבא מציעא'));
  check('שם הקובץ לפי התבנית', !!uploaded);

  console.log('== היסטוריה ==');
  const hist = await api('/api/station/history', { method: 'GET' });
  check('המקליט רואה את ההעלאות שלו', hist.history.length >= 1 && hist.history.every((h) => h.username === 'בחור-מקליט'));

  console.log(`\nסיכום: ${pass} הצלחות, ${fail} כשלונות`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('שגיאה בבדיקה:', e.message); process.exit(1); });
