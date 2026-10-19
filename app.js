'use strict';
/* AV Site Survey — offline-first PWA with Google Drive sync */
const APP_VERSION = '1.0.7';
const CFG = Object.assign({ GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive' }, window.APP_CONFIG || {});
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const safeName = s => (String(s || '').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80)) || 'untitled';
const fileSafe = s => String(s || '').replace(/[^\w\- ]+/g, '').trim() || 'survey';
let toastT;
function toast(m, ms = 2800) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej({ code: 'script', message: 'Could not load ' + src }); document.head.appendChild(s); }); }
function blobDataUrl(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); }); }
async function blobB64(b) { return String(await blobDataUrl(b)).split(',')[1]; }
function b64Blob(b64, mime) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); }
function downloadFile(name, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
function resize(file, max, q) {
  return new Promise(res => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); c.toBlob(b => res(b), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(u); res(null); }; img.src = u;
  });
}

/* ---------- in-app dialogs (no browser pop-ups) ---------- */
function modal({ title = '', html = '', buttons = [], onOpen }) {
  return new Promise(res => {
    const root = $('#modal');
    root.innerHTML = `<div class="mback"></div><div class="mbox" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">${esc(title)}</h2><div class="mbody">${html}</div><div class="mbtns">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    root.classList.remove('hid');
    const kd = e => { if (e.key === 'Escape') close(null); };
    const close = v => { root.classList.add('hid'); root.innerHTML = ''; document.removeEventListener('keydown', kd); res(v); };
    document.addEventListener('keydown', kd);
    root.querySelector('.mback').onclick = () => close(null);
    root.querySelectorAll('.mbtns button').forEach(b => b.onclick = () => { const bt = buttons[b.dataset.i]; const v = typeof bt.value === 'function' ? bt.value(root) : bt.value; if (v === undefined) return; close(v); });
    root._close = close;
    if (onOpen) onOpen(root, close);
  });
}
const ui = {
  alert: (msg, title = '') => modal({ title, html: `<p>${esc(msg)}</p>`, buttons: [{ label: 'OK', value: true }] }),
  confirm: (msg, { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) =>
    modal({ title, html: `<p>${esc(msg)}</p>`, buttons: [{ label: cancel, cls: 'sec', value: false }, { label: ok, cls: danger ? 'dangerfill' : '', value: true }] }).then(v => !!v),
  prompt: (label, { title = '', value = '', placeholder = '', ok = 'OK' } = {}) =>
    modal({
      title, html: `<label class="f"><span class="l">${esc(label)}</span><input type="text" id="mIn" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
      buttons: [{ label: 'Cancel', cls: 'sec', value: null }, { label: ok, value: r => r.querySelector('#mIn').value }],
      onOpen: (r, close) => { const i = r.querySelector('#mIn'); i.focus(); i.select(); i.onkeydown = e => { if (e.key === 'Enter') close(i.value); }; }
    }),
  choose: (msg, options, title = '') =>
    modal({
      title, html: (msg ? `<p>${esc(msg)}</p>` : '') + options.map((o, i) => `<button class="btn ${o.cls || 'sec'} choice" data-c="${i}">${esc(o.label)}${o.sub ? `<span class="muted" style="display:block;font-weight:400">${esc(o.sub)}</span>` : ''}</button>`).join(''),
      buttons: [{ label: 'Cancel', cls: 'sec', value: null }],
      onOpen: (r, close) => r.querySelectorAll('[data-c]').forEach(b => b.onclick = () => close(options[b.dataset.c].value))
    })
};

/* ---------- local database (IndexedDB) ---------- */
let dbp;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('av-site-survey', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['sites', 'rooms', 'blobs', 'queue']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store); let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const idb = {
  get: (s, k) => tx(s, 'readonly', o => o.get(k)),
  all: s => tx(s, 'readonly', o => o.getAll()),
  put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
  del: (s, k) => tx(s, 'readwrite', o => o.delete(k))
};

/* ---------- data model ---------- */
const SPACE_TYPES = ['Enclosed room', 'Open-plan office / floor', 'Atrium / reception / foyer', 'Hall (sports, events, assembly)', 'Warehouse / distribution', 'Factory / production floor', 'Workshop / plant room', 'Retail / showroom', 'Car park', 'Outdoor area (yard, campus, stadium)', 'Other'];
const PURPOSES = ['Meeting room', 'Boardroom', 'Huddle space', 'Training room', 'Lecture theatre', 'Auditorium', 'Divisible space', 'Reception / digital signage', 'Simulation / clinical', 'Paging / announcements', 'Background music', 'Event / presentation space', 'Operations / control room', 'Signage / information', 'Other'];
const SYSTEMS = ['Display(s)', 'Projection', 'Video conferencing (MTR / Zoom Rooms)', 'BYOD / wireless presentation', 'Installed audio (speech reinforcement)', 'Ceiling / table microphones', 'Control system / touch panel', 'Room booking panel', 'Lecture capture / recording', 'Hearing assistance (loop / IR / RF)', 'Digital signage', 'Lighting / blind integration', 'PA / paging zones', 'Background music zones', 'Voice alarm / fire alarm interface', 'LED video wall', 'IP-rated / weatherproof equipment', 'Talkback / intercom'];
const O = {
  ceilingType: ['Suspended grid 600×600', 'Suspended grid other', 'Plasterboard (MF)', 'Exposed soffit', 'Coffered / feature', 'Profiled metal roof / purlins', 'Open sky (outdoor)', 'Other'],
  mountStruct: ['Walls', 'Steel beams / columns', 'Roof purlins / trusses', 'Pallet racking (owner approval needed)', 'Poles / masts', 'Ceiling grid', 'Mixed', 'Unknown — needs checking'],
  wallConstruction: ['Plasterboard on stud', 'Plasterboard dot & dab', 'Blockwork / masonry', 'Glass partition', 'Demountable partition', 'Unknown — needs checking'],
  light: ['Low — no windows', 'Moderate — windows with blinds', 'High — large glazing, no blinds', 'High — glass walls'],
  lightControl: ['Manual switches', 'Dimmable / scene control', 'Occupancy sensor', 'DALI / networked (integration possible)', 'Unknown'],
  blinds: ['None', 'Manual', 'Motorised', 'Blackout'],
  noise: ['Quiet', 'Noticeable HVAC hum', 'Loud HVAC', 'External noise (road, corridor)', 'Adjacent room bleed', 'Machinery / forklifts / extraction', 'Very loud — hearing protection zone'],
  acoustics: ['Dead — carpet, soft finishes', 'Average', 'Live — hard floor, glass, bare walls', 'Very reverberant', 'Outdoor — few reflections'],
  conditions: ['Clean, climate controlled', 'Dusty', 'Damp / humid', 'Cold store / unheated', 'Hot / high temperature', 'Outdoor — exposed to weather', 'Hazardous area (ATEX) — specialist kit'],
  heightAccess: ['Ladder / podium', 'Tower scaffold', 'MEWP / scissor lift', 'Boom lift / cherry picker', 'Specialist (rope access, roof)', 'Not required']
};
const CHECKLIST = [
  'Dimensions and ceiling / roof height measured',
  'Display wall identified and construction checked (stud / masonry / glass)',
  'Farthest viewer position measured',
  'Power outlet locations and counts noted',
  'Network outlet locations noted and VLAN / PoE confirmed with IT',
  'Cable routes and containment identified (floor box, ceiling void, trunking)',
  'Ceiling type noted (grid, plasterboard, exposed) and above-ceiling access checked',
  'Window / glazing positions and ambient light noted',
  'HVAC / background noise listened for',
  'Existing equipment and reusable infrastructure recorded',
  'Furniture layout and table positions recorded',
  'Access and delivery route (lift, stairs, door widths) checked',
  'Health & safety: working at height, asbestos register, permit to work',
  'Client contact and sign-off person confirmed',
  'Photos taken of all walls, ceiling / roof and floor',
  'Mounting points and structure checked (walls, beams, racking, poles)',
  'Working-at-height access method agreed (MEWP, scaffold, ladder)',
  'Environmental conditions noted (dust, moisture, temperature, IP rating)'
];
const newSite = () => ({ id: uid(), name: '', address: '', client: '', contact: '', date: today(), surveyor: '', created: today(), updated: nowIso() });
const newRoom = sid => { const st = data.sites.find(x => x.id === sid) || {}; return {
  id: uid(), siteId: sid, name: '', spaceType: '', floor: '', purpose: '', capacity: '', operatingHours: '', date: st.date || today(), surveyor: st.surveyor || '',
  systems: [], requirements: '', budgetNotes: '',
  L: '', W: '', H: '', ceilingType: '', ceilingVoid: '', maxMount: '', mountStruct: '', coverage: '', farthest: '', nearest: '', displayWall: '', displayWallWidth: '', wallConstruction: '', tableL: '', tableW: '',
  light: '', lightControl: '', windows: '', blinds: '', noise: '', acoustics: '', spl: '', conditions: '', ipRating: '',
  power: '', network: '', containment: '', floorBox: '', access: '', heightAccess: '',
  existing: '', notes: '', photos: [], clips: [], checks: {}, created: nowIso(), updated: nowIso()
}; };

/* ---------- state ---------- */
let data = { sites: [], rooms: [] };
let settings = { driveOn: true, keepLocal: true, folderId: '', folderName: '', folderUrl: '', signedInBefore: false };
let route = { v: 'home' };
const siteOf = r => data.sites.find(s => s.id === r.siteId);
async function saveSettings() { await idb.put('kv', { k: 'settings', v: settings }); }

const saveTimers = {};
function setStatus(t) { const st = $('#st'); if (st) st.textContent = t; }
function saveLater(kind, obj) {
  obj.updated = nowIso(); setStatus('Saving…');
  clearTimeout(saveTimers[obj.id]);
  saveTimers[obj.id] = setTimeout(async () => {
    try { await idb.put(kind, obj); setStatus('Saved on this device'); markSiteDirty(kind === 'sites' ? obj.id : obj.siteId); }
    catch (e) { setStatus('NOT SAVED'); toast('Could not save on this device: ' + (e.message || e)); }
  }, 400);
}
async function saveNow(kind, obj) { obj.updated = nowIso(); await idb.put(kind, obj); markSiteDirty(kind === 'sites' ? obj.id : obj.siteId); }

/* ---------- Google Drive ---------- */
const gd = {
  token: '', exp: 0,
  configured() { return !!CFG.GOOGLE_CLIENT_ID && !/YOUR_/.test(CFG.GOOGLE_CLIENT_ID); },
  valid() { return !!this.token && Date.now() < this.exp; },
  gisReady() { return !!(window.google && google.accounts && google.accounts.oauth2); },
  preload() { if (this.configured() && navigator.onLine && !this.gisReady()) loadScript('https://accounts.google.com/gsi/client').catch(() => {}); },
  // Must be called straight from a tap so the Google sign-in window is allowed to open.
  signIn() {
    if (!this.configured()) return Promise.reject({ code: 'not_configured', message: 'Google Drive is not set up in config.js' });
    if (!navigator.onLine) return Promise.reject({ code: 'offline', message: 'No connection' });
    if (!this.gisReady()) { this.preload(); return Promise.reject({ code: 'loading', message: 'Google sign-in is still loading — tap again in a moment' }); }
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID, scope: CFG.DRIVE_SCOPE,
        callback: r => {
          if (r.error) { rej({ code: r.error, message: r.error_description || r.error }); return; }
          this.token = r.access_token; this.exp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          if (!settings.signedInBefore) { settings.signedInBefore = true; saveSettings(); }
          res(this.token);
        },
        error_callback: e => rej({ code: (e && e.type) || 'popup_error', message: (e && e.message) || 'Sign-in window was closed or blocked' })
      });
      tc.requestAccessToken({ prompt: settings.signedInBefore ? '' : 'consent' });
    });
  },
  async api(path, { method = 'GET', body, headers = {}, raw = false, upload = false } = {}) {
    if (!this.valid()) throw { code: 'auth', message: 'Not signed in to Google Drive' };
    const base = upload ? 'https://www.googleapis.com/upload/drive/v3/' : 'https://www.googleapis.com/drive/v3/';
    const url = base + path + (path.includes('?') ? '&' : '?') + 'supportsAllDrives=true';
    const r = await fetch(url, { method, body, headers: Object.assign({ Authorization: 'Bearer ' + this.token }, headers) });
    if (r.status === 401) { this.token = ''; throw { code: 'auth', message: 'Google sign-in expired' }; }
    if (!r.ok) { let m = ''; try { const j = await r.json(); m = j.error && j.error.message; } catch (e) {} throw { code: 'http_' + r.status, status: r.status, message: m || ('Drive error ' + r.status) }; }
    return raw ? r : r.json();
  },
  async folder(name, parent) {
    const j = await this.api('files?fields=id', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }), headers: { 'Content-Type': 'application/json' } });
    return j.id;
  },
  rename(id, name) { return this.api('files/' + encodeURIComponent(id) + '?fields=id', { method: 'PATCH', body: JSON.stringify({ name }), headers: { 'Content-Type': 'application/json' } }); },
  upload(name, blob, mime, parent) {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({ name, mimeType: mime, parents: [parent] })], { type: 'application/json' }));
    fd.append('file', blob);
    return this.api('files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', body: fd, upload: true });
  },
  replace(id, blob) { return this.api('files/' + encodeURIComponent(id) + '?uploadType=media&fields=id,webViewLink', { method: 'PATCH', body: blob, upload: true, headers: { 'Content-Type': blob.type || 'application/octet-stream' } }); },
  meta(id) { return this.api('files/' + encodeURIComponent(id) + '?fields=id,name,mimeType,webViewLink,trashed,capabilities(canAddChildren)'); },
  async list(q) {
    const j = await this.api('files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName))') + '&pageSize=200&includeItemsFromAllDrives=true&corpora=allDrives');
    return j.files || [];
  },
  async text(id) { const r = await this.api('files/' + encodeURIComponent(id) + '?alt=media', { raw: true }); return r.text(); },
  pickerReady() { return !!(window.google && google.picker); },
  async loadPicker() {
    if (this.pickerReady()) return;
    if (!window.gapi) await loadScript('https://apis.google.com/js/api.js');
    await new Promise((res, rej) => gapi.load('picker', { callback: res, onerror: () => rej({ code: 'script', message: 'Folder picker failed to load' }) }));
  },
  pickFolder() {
    return new Promise(res => {
      const P = google.picker;
      const mine = new P.DocsView(P.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setParent('root');
      const shared = new P.DocsView(P.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setOwnedByMe(false);
      const drives = new P.DocsView(P.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setEnableDrives(true);
      const b = new P.PickerBuilder().setOAuthToken(this.token).setDeveloperKey(CFG.GOOGLE_API_KEY).setTitle('Choose the folder for surveys')
        .addView(mine).addView(shared).addView(drives)
        .setCallback(d => { if (d.action === P.Action.PICKED) { const doc = d.docs[0]; res({ id: doc.id, name: doc.name, url: doc.url }); } else if (d.action === P.Action.CANCEL) res(null); });
      if (CFG.GOOGLE_APP_ID) b.setAppId(CFG.GOOGLE_APP_ID);
      b.build().setVisible(true);
    });
  }
};
function driveMsg(e) {
  const c = e && e.code;
  if (c === 'offline' || (e instanceof TypeError)) return 'No connection — saved on this phone, will upload later';
  if (c === 'auth') return 'Google sign-in needed — tap the bar at the top';
  if (c === 'not_configured') return 'Google Drive is not set up yet (see README)';
  if (c === 'http_403') return 'No permission for that Drive folder: ' + (e.message || '');
  if (c === 'http_404') return 'Drive folder or file not found, or not shared with you';
  if (c === 'access_denied') return 'Google access was not granted';
  return (e && e.message) || 'Google Drive error';
}
const isNetErr = e => e instanceof TypeError && /fetch|network|load/i.test(e.message || '');

async function siteFolder(s) {
  if (!settings.folderId) throw { code: 'no_folder', message: 'No Drive folder chosen' };
  if (s.driveFolderId && s.driveParent === settings.folderId) return s.driveFolderId;
  s.driveFolderId = await gd.folder(safeName(s.name || 'Untitled site'), settings.folderId);
  s.driveParent = settings.folderId; s.driveFolderName = safeName(s.name || 'Untitled site');
  await idb.put('sites', s); return s.driveFolderId;
}
async function roomFolder(r) {
  const s = siteOf(r); if (!s) throw { code: 'missing', message: 'Site not found' };
  const sf = await siteFolder(s);
  if (r.driveFolderId && r.driveParent === sf) return r.driveFolderId;
  r.driveFolderId = await gd.folder(safeName(r.name || 'Unnamed space'), sf);
  r.driveParent = sf; r.driveFolderName = safeName(r.name || 'Unnamed space');
  await idb.put('rooms', r); return r.driveFolderId;
}

/* ---------- upload queue ---------- */
let syncing = false, kickT, dirtyT; const dirty = new Set();
async function enqueue(job) { await idb.put('queue', Object.assign({ id: uid(), created: Date.now(), attempts: 0 }, job)); updateSyncBar(); kickSync(); }
function markSiteDirty(siteId) {
  if (!siteId) return; dirty.add(siteId); clearTimeout(dirtyT);
  dirtyT = setTimeout(async () => {
    for (const id of dirty) await idb.put('queue', { id: 'sitejson:' + id, type: 'sitejson', siteId: id, created: Date.now(), attempts: 0 });
    dirty.clear(); updateSyncBar(); kickSync();
  }, 1500);
}
function kickSync(ms = 1500) { clearTimeout(kickT); kickT = setTimeout(processQueue, ms); }
const canSync = () => navigator.onLine && settings.driveOn && !!settings.folderId && gd.valid();

async function processQueue() {
  if (syncing) return;
  if (!canSync()) { updateSyncBar(); return; }
  syncing = true; updateSyncBar();
  try {
    for (let pass = 0; pass < 4; pass++) {
      const jobs = (await idb.all('queue')).filter(j => (j.attempts || 0) < 6);
      if (!jobs.length) break;
      jobs.sort((a, b) => ((a.type === 'sitejson') - (b.type === 'sitejson')) || (a.created - b.created));
      let progressed = false;
      for (const j of jobs) {
        if (!canSync()) break;
        try {
          await runJob(j);
          const cur = await idb.get('queue', j.id);
          if (cur && cur.created === j.created) await idb.del('queue', j.id);
          progressed = true;
        } catch (e) {
          if (e && (e.code === 'auth' || e.code === 'offline')) throw e;
          if (isNetErr(e)) throw { code: 'offline' };
          if (e && e.status === 404) clearFolderIds(j);
          const cur = await idb.get('queue', j.id);
          if (cur && cur.created === j.created) { cur.attempts = (cur.attempts || 0) + 1; cur.lastError = (e && (e.message || e.code)) || String(e); await idb.put('queue', cur); }
        }
        updateSyncBar();
      }
      if (!progressed) break;
    }
  } catch (e) { if (e && e.code === 'auth') gd.token = ''; }
  finally { syncing = false; updateSyncBar(); }
}
function clearFolderIds(j) {
  const r = j.roomId && data.rooms.find(x => x.id === j.roomId);
  if (r) { r.driveFolderId = ''; idb.put('rooms', r); }
  else { const s = j.siteId && data.sites.find(x => x.id === j.siteId); if (s) { s.driveFolderId = ''; s.driveDataId = ''; idb.put('sites', s); } }
}
async function runJob(j) {
  if (j.type === 'photo' || j.type === 'clip') {
    const r = data.rooms.find(x => x.id === j.roomId); if (!r) return;
    const list = j.type === 'photo' ? r.photos : r.clips; const it = list.find(x => x.id === j.itemId);
    if (!it || it.driveId) return;
    const b = it.blobId && await idb.get('blobs', it.blobId); if (!b) return;
    const fid = await roomFolder(r);
    const n = String(list.indexOf(it) + 1).padStart(2, '0');
    const ext = j.type === 'photo' ? '.jpg' : (/mp4|aac|m4a/.test(b.mime) ? '.m4a' : (/ogg/.test(b.mime) ? '.ogg' : '.webm'));
    const name = safeName(r.name || 'space') + (j.type === 'photo' ? ' photo ' : ' voice ') + n + (it.caption || it.label ? ' - ' + safeName(it.caption || it.label) : '') + ext;
    const up = await gd.upload(name, b.blob, b.mime, fid);
    it.driveId = up.id; it.driveUrl = up.webViewLink || '';
    if (!settings.keepLocal) { await idb.del('blobs', it.blobId); it.blobId = ''; }
    await idb.put('rooms', r); markSiteDirty(r.siteId);
    if (route.v === 'room' && route.id === r.id) { if (j.type === 'photo') renderPhotos(r); else renderClips(r); }
  } else if (j.type === 'sitejson') {
    const s = data.sites.find(x => x.id === j.siteId); if (!s) return;
    const rooms = data.rooms.filter(x => x.siteId === s.id);
    const sf = await siteFolder(s);
    if (s.driveFolderName !== safeName(s.name || 'Untitled site')) { await gd.rename(sf, safeName(s.name || 'Untitled site')); s.driveFolderName = safeName(s.name || 'Untitled site'); }
    for (const r of rooms) {
      if (r.driveFolderId && r.driveParent === sf && r.driveFolderName !== safeName(r.name || 'Unnamed space')) {
        await gd.rename(r.driveFolderId, safeName(r.name || 'Unnamed space')); r.driveFolderName = safeName(r.name || 'Unnamed space'); await idb.put('rooms', r);
      }
    }
    // Find the site's data file in Drive (also catches one created by another device) and merge it in first.
    if (!(s.driveDataId && s.driveDataParent === sf)) {
      const found = await gd.list(`'${sf}' in parents and name='site-data.json' and trashed=false`);
      if (found.length) { found.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '')); s.driveDataId = found[0].id; s.driveDataParent = sf; }
    }
    if (s.driveDataId && s.driveDataParent === sf) {
      let remote = null;
      try { remote = JSON.parse(await gd.text(s.driveDataId)); } catch (e) { if (e && e.status && e.status !== 404) throw e; }
      if (remote) { const m = await mergeRemoteSite(s, remote); if (m.added) toast(m.added + ' space' + (m.added === 1 ? '' : 's') + ' added from Drive to “' + (s.name || 'site') + '”'); if (m.changed) refreshIfViewing(s.id); }
    }
    const blob = new Blob([JSON.stringify(await siteJson(s, data.rooms.filter(x => x.siteId === s.id), false))], { type: 'application/json' });
    let up = null;
    if (s.driveDataId && s.driveDataParent === sf) { try { up = await gd.replace(s.driveDataId, blob); } catch (e) { if (e.status !== 404) throw e; } }
    if (!up) { up = await gd.upload('site-data.json', blob, 'application/json', sf); s.driveDataId = up.id; s.driveDataParent = sf; }
    s.lastSynced = nowIso(); await idb.put('sites', s);
  } else if (j.type === 'pdf') {
    const b = j.blobId && await idb.get('blobs', j.blobId); if (!b) return;
    const s = data.sites.find(x => x.id === j.siteId); if (!s) { await idb.del('blobs', j.blobId); return; }
    const room = j.roomId && data.rooms.find(x => x.id === j.roomId);
    const fid = room ? await roomFolder(room) : await siteFolder(s);
    await gd.upload(j.name || 'AV survey report.pdf', b.blob, 'application/pdf', fid);
    await idb.del('blobs', j.blobId);
    toast('PDF report saved to Google Drive');
  } else if (j.type === 'report') {
    const s = data.sites.find(x => x.id === j.siteId); if (!s) return;
    const rooms = j.roomId ? data.rooms.filter(x => x.id === j.roomId) : data.rooms.filter(x => x.siteId === s.id);
    if (!rooms.length) return;
    const fid = j.roomId ? await roomFolder(rooms[0]) : await siteFolder(s);
    await gd.upload(reportName(s, j.roomId ? rooms : null), new Blob([buildMd(s, rooms)], { type: 'text/markdown' }), 'text/markdown', fid);
    toast('Report saved to Google Drive');
  }
}

async function connectDrive() {
  try { await gd.signIn(); toast('Connected to Google Drive'); if (!settings.folderId) { await chooseFolder(); } pullAllSites(); }
  catch (e) { toast(driveMsg(e)); }
  updateSyncBar(); if (route.v === 'settings') render();
}

async function updateSyncBar() {
  const bar = $('#syncbar'); if (!bar) return;
  const jobs = await idb.all('queue').catch(() => []);
  const failed = jobs.filter(j => (j.attempts || 0) >= 6).length;
  const waiting = jobs.length - failed;
  const files = jobs.filter(j => j.type !== 'sitejson').length;
  const w = waiting ? (files ? `${files} file${files === 1 ? '' : 's'}${waiting > files ? ' + survey data' : ''}` : 'survey data') + ' waiting' : '';
  let t, cls = '';
  if (!gd.configured()) { t = 'Saved on this phone only · Google Drive not set up'; }
  else if (!settings.driveOn) { t = 'Drive sync is off' + (w ? ' · ' + w : ''); }
  else if (!navigator.onLine) { t = 'Offline · saved on this phone' + (w ? ' · ' + w : ''); }
  else if (!settings.folderId) { t = 'Choose a Google Drive folder — tap here'; cls = 'warn'; }
  else if (!gd.valid()) { t = (w ? w + ' · ' : '') + 'Tap to connect Google Drive'; cls = w ? 'warn' : ''; }
  else if (syncing) { t = 'Uploading to Drive… ' + (w || ''); }
  else if (failed) { t = failed + ' upload' + (failed === 1 ? '' : 's') + ' failed — tap for details'; cls = 'warn'; }
  else if (waiting) { t = w; }
  else { t = '✓ Everything saved to Drive · ' + settings.folderName; cls = 'good'; }
  bar.textContent = t; bar.className = 'syncbar ' + cls;
}
$('#syncbar').onclick = () => {
  if (gd.configured() && settings.driveOn && navigator.onLine && settings.folderId && !gd.valid()) connectDrive();
  else go({ v: 'settings' });
};

/* ---------- folder selection ---------- */
async function chooseFolder() {
  if (!gd.valid()) { await connectDrive(); return; }
  const opts = [];
  if (CFG.GOOGLE_API_KEY) opts.push({ label: 'Browse Google Drive', sub: 'My Drive, Shared with me, Shared drives', value: 'pick' });
  opts.push({ label: 'Paste a folder link', sub: 'From Drive: Share → Copy link, or the address bar', value: 'paste' });
  const how = opts.length === 1 ? 'paste' : await ui.choose('', opts, 'Where should surveys be saved?');
  if (!how) return;
  let f = null;
  try {
    if (how === 'pick') { await gd.loadPicker(); f = await gd.pickFolder(); if (!f) return; }
    else {
      const v = await ui.prompt('Google Drive folder link', { title: 'Paste folder link', placeholder: 'https://drive.google.com/drive/folders/…', ok: 'Check folder' });
      if (v === null) return;
      const id = folderIdFrom(v); if (!id) { toast('That doesn’t look like a Drive folder link'); return; }
      const m = await gd.meta(id);
      if (m.mimeType !== FOLDER_MIME) { toast('That link is a file, not a folder'); return; }
      if (m.trashed) { toast('That folder is in the bin'); return; }
      if (m.capabilities && m.capabilities.canAddChildren === false) { toast('You don’t have edit access to that folder'); return; }
      f = { id: m.id, name: m.name, url: m.webViewLink };
      if (!await ui.confirm(`Save surveys into “${m.name}”?`, { title: 'Use this folder?', ok: 'Use folder' })) return;
    }
  } catch (e) { toast(driveMsg(e)); return; }
  await setFolder(f);
}
async function setFolder(f) {
  settings.folderId = f.id; settings.folderName = f.name || 'Selected folder'; settings.folderUrl = f.url || '';
  await saveSettings();
  for (const s of data.sites) markSiteDirty(s.id);
  toast('Saving to “' + settings.folderName + '”'); updateSyncBar(); kickSync(10);
  if (route.v === 'settings' || route.v === 'setup') render();
}
function folderIdFrom(s) {
  s = (s || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/[?&]folder=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1]; if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s; return null;
}
function inviteLink() {
  const u = new URL(location.href); u.search = ''; u.hash = '';
  u.searchParams.set('folder', settings.folderId); u.searchParams.set('name', settings.folderName); return u.toString();
}
async function shareInvite() {
  const link = inviteLink();
  const text = `AV Site Survey app — opens with the shared Drive folder “${settings.folderName}” selected. Install it from Chrome (menu → Install app). The folder must be shared with you with edit access.`;
  try { if (navigator.share) { await navigator.share({ title: 'AV Site Survey', text, url: link }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (e) { await ui.alert(link, 'Copy this link'); }
}
async function handleInviteParams() {
  const p = new URLSearchParams(location.search); const id = p.get('folder'); if (!id) return;
  history.replaceState(history.state, '', location.pathname);
  const name = p.get('name') || 'shared folder';
  if (settings.folderId === id) return;
  const ok = await ui.confirm(`Save surveys into the Google Drive folder “${name}”?\n\nIt must be shared with your Google account with edit access.`, { title: 'Shared folder link', ok: 'Use this folder' });
  if (!ok) return;
  settings.driveOn = true; settings.setupDone = true;
  await setFolder({ id, name, url: 'https://drive.google.com/drive/folders/' + id });
  if (route.v === 'home') render();
}

/* ---------- merging site data between devices ---------- */
// Rooms, photos and clips are matched by id. Nothing is dropped unless it was deliberately deleted
// (deletions are remembered as "tombstones" so they don't come back). For the same room edited on two
// devices, the text fields from the most recently edited copy win; photos and clips from both are kept.
const ROOM_META = new Set(['id', 'siteId', 'photos', 'clips', 'deletedItems', 'checks', 'systems', 'driveFolderId', 'driveParent', 'driveFolderName', 'created']);
function remotePhoto(p) { return { id: p.id || uid(), blobId: '', thumb: p.thumb || (p.url && String(p.url).startsWith('data:') ? p.url : ''), caption: p.caption || '', driveId: p.driveId || '', driveUrl: p.driveUrl || '', ...(p.noReport ? { noReport: true } : {}) }; }
function remoteClip(c) { return { id: c.id || uid(), blobId: '', dur: c.dur, mime: c.mime, label: c.label || '', driveId: c.driveId || '', driveUrl: c.driveUrl || '' }; }
function mergeItems(local, remote, tomb, mk, textKey) {
  const out = []; const rmap = new Map((remote || []).map(x => [x.id, x])); let changed = false;
  for (const l of local) {
    if (tomb.has(l.id)) { changed = true; continue; }
    const r = rmap.get(l.id); rmap.delete(l.id);
    if (r) {
      if (!l.driveId && r.driveId) { l.driveId = r.driveId; l.driveUrl = r.driveUrl || ''; changed = true; }
      if (!l.thumb && r.thumb) { l.thumb = r.thumb; changed = true; }
      if (!l[textKey] && r[textKey]) { l[textKey] = r[textKey]; changed = true; }
    }
    out.push(l);
  }
  for (const r of rmap.values()) if (!tomb.has(r.id)) { out.push(mk(r)); changed = true; }
  return { out, changed };
}
function mergeRoomInto(l, r) {
  let changed = false;
  const tomb = new Set([...(l.deletedItems || []), ...(r.deletedItems || [])]);
  if ((r.updated || '') > (l.updated || '')) {
    for (const k of Object.keys(r)) if (!ROOM_META.has(k) && JSON.stringify(l[k]) !== JSON.stringify(r[k])) { l[k] = r[k]; changed = true; }
    l.systems = [...new Set([...(r.systems || [])])]; l.checks = Object.assign({}, r.checks || {});
  }
  if (!l.driveFolderId && r.driveFolderId) { l.driveFolderId = r.driveFolderId; l.driveParent = r.driveParent; l.driveFolderName = r.driveFolderName; changed = true; }
  const p = mergeItems(l.photos, r.photos, tomb, remotePhoto, 'caption'); l.photos = p.out;
  const c = mergeItems(l.clips, r.clips, tomb, remoteClip, 'label'); l.clips = c.out;
  l.deletedItems = [...tomb];
  return changed || p.changed || c.changed;
}
// Merges a remote site file into the local copy (mutating data.sites/data.rooms) and returns the number of rooms added.
async function mergeRemoteSite(s, remote) {
  if (!remote || !remote.site || !Array.isArray(remote.rooms)) return { added: 0, changed: false };
  const rs = remote.site; let changed = false, added = 0;
  const tomb = new Set([...(s.deletedRooms || []), ...(rs.deletedRooms || [])]);
  if ((rs.updated || '') > (s.updated || '')) for (const k of ['name', 'address', 'client', 'contact', 'date', 'surveyor']) if (rs[k] !== undefined && rs[k] !== s[k]) { s[k] = rs[k]; changed = true; }
  s.deletedRooms = [...tomb];
  for (const rr of remote.rooms) {
    if (tomb.has(rr.id)) continue;
    const lr = data.rooms.find(x => x.id === rr.id);
    if (lr) { if (lr.siteId === s.id && mergeRoomInto(lr, rr)) { await idb.put('rooms', lr); changed = true; } continue; }
    const nr = Object.assign(newRoom(s.id), rr, { siteId: s.id });
    nr.systems = rr.systems || []; nr.checks = rr.checks || {}; nr.deletedItems = rr.deletedItems || [];
    nr.photos = (rr.photos || []).map(remotePhoto); nr.clips = (rr.clips || []).map(remoteClip);
    await idb.put('rooms', nr); data.rooms.push(nr); added++; changed = true;
  }
  for (const lr of data.rooms.filter(x => x.siteId === s.id && tomb.has(x.id))) { await deleteRoomData(lr); changed = true; }
  await idb.put('sites', s);
  return { added, changed };
}
function refreshIfViewing(siteId) {
  if (route.v === 'home' || (route.v === 'site' && route.id === siteId)) render();
}
// Pull newer data for every site that lives in Drive (runs when you connect).
async function pullAllSites() { for (const s of data.sites) if (s.driveDataId) await idb.put('queue', { id: 'sitejson:' + s.id, type: 'sitejson', siteId: s.id, created: Date.now(), attempts: 0 }); updateSyncBar(); kickSync(10); }

/* ---------- export / import ---------- */
async function siteJson(s, rooms, includeLocalAudio) {
  const clips = {};
  if (includeLocalAudio) for (const r of rooms) for (const c of r.clips) if (!c.driveId && c.blobId) { const b = await idb.get('blobs', c.blobId); if (b) clips[c.id] = { mime: b.mime, b64: await blobB64(b.blob) }; }
  const strip = r => Object.assign({}, r, { photos: r.photos.map(p => Object.assign({}, p, { blobId: '' })), clips: r.clips.map(c => Object.assign({}, c, { blobId: '' })) });
  return { format: 'av-site-survey', version: 2, app: 'pwa ' + APP_VERSION, exported: nowIso(), site: s, rooms: rooms.map(strip), clips };
}
async function importSiteData(j, from) {
  let site, rooms, clips = {};
  if (j && j.format === 'av-site-survey' && j.site && Array.isArray(j.rooms)) { site = j.site; rooms = j.rooms; clips = j.clips || {}; }
  else if (j && j.site && j.room) { site = j.site; rooms = [j.room]; }
  else { toast('That is not an AV Site Survey file'); return; }
  const existing = data.sites.find(x => x.id === site.id);
  let mode = 'new';
  if (existing) {
    const localOnly = data.rooms.filter(r => r.siteId === existing.id).reduce((n, r) => n + r.photos.filter(p => !p.driveId).length + r.clips.filter(c => !c.driveId).length, 0);
    mode = await ui.choose(`“${existing.name || 'This site'}” is already on this device.` + (localOnly ? `\n\nWarning: it has ${localOnly} photo/clip(s) not yet uploaded to Drive. Replacing will remove them.` : ''), [
      { label: 'Merge (recommended)', sub: 'Add spaces and photos from the ' + from + ' version, keep everything on this device', value: 'merge', cls: '' },
      { label: 'Replace this device’s copy', sub: 'Use the ' + from + ' version', value: 'replace', cls: localOnly ? 'danger' : 'sec' },
      { label: 'Keep both', sub: 'Import as a separate copy', value: 'copy' }
    ], 'Site already here');
    if (!mode) return;
  }
  try {
    if (mode === 'merge') {
      const m = await mergeRemoteSite(existing, { site, rooms, clips });
      markSiteDirty(existing.id);
      toast(m.added ? m.added + ' space' + (m.added === 1 ? '' : 's') + ' added' : (m.changed ? 'Site updated' : 'Already up to date'));
      go({ v: 'site', id: existing.id }); return;
    }
    if (mode === 'replace') {
      for (const r of data.rooms.filter(r => r.siteId === existing.id)) await deleteRoomData(r);
      data.sites = data.sites.filter(x => x.id !== existing.id);
    }
    const copy = mode === 'copy';
    const ns = Object.assign(newSite(), site, copy ? { id: uid(), name: (site.name || 'Site') + ' (copy)', driveFolderId: '', driveParent: '', driveDataId: '', driveDataParent: '', driveFolderName: '' } : {});
    await idb.put('sites', ns); data.sites.push(ns);
    let missing = 0;
    for (const r0 of rooms) {
      const r = Object.assign(newRoom(ns.id), r0, { siteId: ns.id }, copy ? { id: uid(), driveFolderId: '', driveParent: '', driveFolderName: '' } : {});
      r.systems = r.systems || []; r.checks = r.checks || {};
      r.photos = (r0.photos || []).map(p => ({ id: p.id || uid(), blobId: '', thumb: p.thumb || (p.url && String(p.url).startsWith('data:') ? p.url : ''), caption: p.caption || '', driveId: p.driveId || '', driveUrl: p.driveUrl || '' }));
      const cl = [];
      for (const c of (r0.clips || [])) {
        if (c.driveId) { cl.push({ id: c.id || uid(), blobId: '', dur: c.dur, mime: c.mime, label: c.label || '', driveId: c.driveId, driveUrl: c.driveUrl || '' }); continue; }
        const d = clips[c.id]; if (!d) { missing++; continue; }
        const nc = { id: uid(), blobId: uid(), dur: c.dur, mime: d.mime, label: c.label || '', driveId: '', driveUrl: '' };
        await idb.put('blobs', { id: nc.blobId, blob: b64Blob(d.b64, d.mime), mime: d.mime }); cl.push(nc);
      }
      r.clips = cl;
      await idb.put('rooms', r); data.rooms.push(r);
      for (const c of r.clips) if (!c.driveId) await enqueue({ type: 'clip', roomId: r.id, itemId: c.id });
    }
    if (copy) markSiteDirty(ns.id);
    toast('Imported ' + rooms.length + ' space' + (rooms.length === 1 ? '' : 's') + (missing ? ` — ${missing} voice clip(s) not included` : ''));
    go({ v: 'site', id: ns.id });
  } catch (e) { toast('Import stopped part-way: ' + (e.message || e)); render(); }
}
async function importFile(file) {
  if (!file) return;
  let j; try { j = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid survey data'); return; }
  importSiteData(j, 'file');
}
async function openFromDrive() {
  if (!settings.folderId) { await chooseFolder(); if (!settings.folderId) return; }
  if (!gd.valid()) { try { await gd.signIn(); } catch (e) { toast(driveMsg(e)); return; } }
  toast('Looking in “' + settings.folderName + '”…', 6000);
  let items = [];
  try {
    const folders = await gd.list(`'${settings.folderId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`);
    for (const f of folders) {
      const files = await gd.list(`'${f.id}' in parents and name='site-data.json' and trashed=false`);
      for (const x of files) items.push({ folder: f.name, file: x });
    }
  } catch (e) { toast(driveMsg(e)); return; }
  $('#toast').classList.remove('show');
  if (!items.length) { await ui.alert('No surveyed sites found in “' + settings.folderName + '” yet.', 'Nothing to open'); return; }
  items.sort((a, b) => (b.file.modifiedTime || '').localeCompare(a.file.modifiedTime || ''));
  const pick = await ui.choose('', items.map(it => ({ label: it.folder, sub: 'Updated ' + new Date(it.file.modifiedTime).toLocaleString('en-GB') + (it.file.lastModifyingUser ? ' by ' + it.file.lastModifyingUser.displayName : ''), value: it.file.id })), 'Sites in Drive');
  if (!pick) return;
  try { const j = JSON.parse(await gd.text(pick)); await importSiteData(j, 'Drive'); }
  catch (e) { toast(e instanceof SyntaxError ? 'That site file is damaged' : driveMsg(e)); }
}
const line = (l, v) => v ? `- **${l}:** ${v}\n` : '';
function reportName(s, rooms) { return fileSafe(s.name || 'site') + (rooms && rooms.length === 1 ? ' - ' + fileSafe(rooms[0].name || 'space') : '') + ' survey ' + today() + '.md'; }
function buildMd(s, rooms) {
  let md = `# AV site survey — ${s.name || 'Untitled site'}\n\n${line('Client', s.client)}${line('Address', s.address)}${line('Contact', s.contact)}${line('Survey date', s.date)}${line('Surveyed by', s.surveyor)}\n`;
  for (const r of rooms) {
    md += `## ${r.name || 'Unnamed space'}\n\n${line('Type of space', r.spaceType)}${line('Floor / zone', r.floor)}${line('Purpose', r.purpose)}${line('Operating hours', r.operatingHours)}${line('Capacity', r.capacity)}${line('Survey date', r.date)}${line('Surveyed by', r.surveyor)}\n`;
    md += `### Client requirements\n${r.systems.length ? '- Systems: ' + r.systems.join(', ') + '\n' : ''}${r.requirements ? '\n' + r.requirements + '\n' : ''}${r.budgetNotes ? '\nConstraints: ' + r.budgetNotes + '\n' : ''}\n`;
    md += `### Measurements\n${line('L × W × H', [r.L, r.W, r.H].some(Boolean) ? `${r.L || '?'} × ${r.W || '?'} × ${r.H || '?'} m` : '')}${line('Ceiling', [r.ceilingType, r.ceilingVoid ? r.ceilingVoid + ' mm void' : ''].filter(Boolean).join(', '))}${line('Max mounting height', r.maxMount ? r.maxMount + ' m' : '')}${line('Mounting structure', r.mountStruct)}${line('Coverage zones', r.coverage)}${line('Farthest / nearest viewer', [r.farthest, r.nearest].some(Boolean) ? `${r.farthest || '?'} m / ${r.nearest || '?'} m` : '')}${line('Display wall', [r.displayWall, r.displayWallWidth ? r.displayWallWidth + ' m usable' : '', r.wallConstruction].filter(Boolean).join(', '))}${line('Table', [r.tableL, r.tableW].some(Boolean) ? `${r.tableL || '?'} × ${r.tableW || '?'} m` : '')}`;
    const d = parseFloat(r.farthest); if (d) md += `- Display estimate (4/6/8 rule, farthest viewer ${d} m): passive ≥ ${(d / 8 * 1000).toFixed(0)} mm image height, basic ≥ ${(d / 6 * 1000).toFixed(0)} mm, analytical ≥ ${(d / 4 * 1000).toFixed(0)} mm — verify against AVIXA DISCAS\n`;
    md += `\n### Environment\n${line('Ambient light', r.light)}${line('Lighting control', r.lightControl)}${line('Windows', r.windows)}${line('Blinds', r.blinds)}${line('Background noise', r.noise)}${line('Acoustics', r.acoustics)}${line('Measured background noise', r.spl ? r.spl + ' dB(A)' : '')}${line('Conditions', r.conditions)}${line('IP rating required', r.ipRating)}\n`;
    md += `### Infrastructure\n${line('Power', r.power)}${line('Network', r.network)}${line('Containment', r.containment)}${line('Floor boxes', r.floorBox)}${line('Access / H&S', r.access)}${line('Working at height', r.heightAccess)}\n`;
    if (r.existing) md += `### Existing equipment\n${r.existing}\n\n`;
    if (r.notes) md += `### Notes\n${r.notes}\n\n`;
    if (r.clips.length) md += `### Voice clips\n${r.clips.map((c, i) => `${i + 1}. ${c.label || 'untitled'} (${c.dur}s)${c.driveUrl ? ' — ' + c.driveUrl : ' — on device, not yet uploaded'}`).join('\n')}\n\n`;
    if (r.photos.length) md += `### Photos (${r.photos.length})\n${r.photos.map((p, i) => `${i + 1}. ${p.caption || '(no caption)'}${p.driveUrl ? ' — ' + p.driveUrl : ' — on device, not yet uploaded'}`).join('\n')}\n\n`;
    md += `### Checklist\n${CHECKLIST.map((c, i) => `- [${r.checks[i] ? 'x' : ' '}] ${c}`).join('\n')}\n\n`;
  }
  return md;
}

/* ---------- PDF report ---------- */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image could not be read')); i.src = src; }); }
async function prepImage(src, max = 1400, q = .8) {
  const img = await loadImg(src);
  const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL('image/jpeg', q), w: c.width, h: c.height };
}
async function photoSource(p) {
  if (p.blobId) { const b = await idb.get('blobs', p.blobId); if (b) { const u = URL.createObjectURL(b.blob); return { url: u, revoke: () => URL.revokeObjectURL(u) }; } }
  if (p.driveId && gd.valid() && navigator.onLine) {
    try { const r = await gd.api('files/' + encodeURIComponent(p.driveId) + '?alt=media', { raw: true }); const u = URL.createObjectURL(await r.blob()); return { url: u, revoke: () => URL.revokeObjectURL(u) }; } catch (e) {}
  }
  if (p.thumb) return { url: p.thumb, revoke: () => {}, low: true };
  return null;
}
// Built-in PDF fonts only cover Western European characters; convert the rest so nothing prints as garbage.
const pdfTxt = s => String(s ?? '').replace(/[łŁ]/g, m => m === 'ł' ? 'l' : 'L').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[—–•]/g, '-').replace(/×/g, 'x').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/≈/g, 'approx. ').replace(/[″“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/…/g, '...').replace(/→/g, '->').replace(/€/g, 'EUR ').replace(/²/g, '2').replace(/³/g, '3').replace(/[✓☁⏳]/g, '').replace(/[^\x0A\x20-\x7E\xA0-\xFF]/g, '?');
const pdfName = (s, rooms) => fileSafe(s.name || 'site') + (rooms.length === 1 && rooms[0] ? ' - ' + fileSafe(rooms[0].name || 'space') : '') + ' - AV survey report ' + today() + '.pdf';

const REPORT_PARTS = [
  ['cover', 'Cover page', 'Site details and list of spaces'],
  ['details', 'Space details', 'Date, surveyor, capacity, hours'],
  ['req', 'Client requirements', ''],
  ['meas', 'Measurements', ''],
  ['display', 'Display size estimate', '4/6/8 rule of thumb'],
  ['env', 'Environment', ''],
  ['infra', 'Infrastructure', ''],
  ['existing', 'Existing equipment', ''],
  ['notes', 'Notes', ''],
  ['voice', 'Voice notes list', 'Names, lengths and Drive links'],
  ['checklist', 'Survey checklist', ''],
  ['photos', 'Photos', 'Photos marked "leave out of report" are always skipped']
];
function reportDefaults() {
  const d = { parts: {}, cols: 2, check: 'all' }; REPORT_PARTS.forEach(([k]) => d.parts[k] = true);
  const sv = settings.reportOpts || {};
  return { parts: Object.assign(d.parts, sv.parts || {}), cols: sv.cols || 2, check: sv.check || 'all' };
}
async function reportOptions(rooms) {
  const d = reportDefaults();
  const multi = rooms.length > 1;
  const html = `
    <p class="muted" style="margin:0 0 4px">Sections</p>
    <div>${REPORT_PARTS.map(([k, l, sub]) => `<label class="chk"><input type="checkbox" data-part="${k}" ${d.parts[k] ? 'checked' : ''}><span>${esc(l)}${sub ? `<span class="muted" style="display:block">${esc(sub)}</span>` : ''}</span></label>`).join('')}</div>
    <div class="grid2" style="margin-top:12px">
      ${field('Photos per row', `<select id="optCols"><option value="1" ${d.cols == 1 ? 'selected' : ''}>1 (large)</option><option value="2" ${d.cols == 2 ? 'selected' : ''}>2</option><option value="3" ${d.cols == 3 ? 'selected' : ''}>3 (compact)</option></select>`)}
      ${field('Checklist items', `<select id="optCheck"><option value="all" ${d.check === 'all' ? 'selected' : ''}>All</option><option value="done" ${d.check === 'done' ? 'selected' : ''}>Ticked only</option><option value="open" ${d.check === 'open' ? 'selected' : ''}>Not ticked only</option></select>`)}
    </div>
    ${multi ? `<div class="row" style="margin:8px 0 4px;align-items:baseline"><p class="muted" style="margin:0;flex:2">Spaces</p><button class="btn sec sm" id="optAll" style="flex:0 0 auto">All</button><button class="btn sec sm" id="optNone" style="flex:0 0 auto">None</button></div>
    <div>${rooms.map(r => `<label class="chk"><input type="checkbox" data-room="${r.id}" checked><span>${esc(r.name || 'Unnamed space')}<span class="muted" style="display:block">${esc([r.spaceType, r.purpose].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div>` : ''}`;
  const res = await modal({
    title: 'What to include', html,
    buttons: [{ label: 'Cancel', cls: 'sec', value: null }, {
      label: 'Create PDF', value: root => {
        const parts = {}; root.querySelectorAll('[data-part]').forEach(c => parts[c.dataset.part] = c.checked);
        const roomIds = multi ? [...root.querySelectorAll('[data-room]')].filter(c => c.checked).map(c => c.dataset.room) : rooms.map(r => r.id);
        if (!roomIds.length) { toast('Select at least one space'); return undefined; }
        return { parts, cols: Number(root.querySelector('#optCols').value), check: root.querySelector('#optCheck').value, roomIds };
      }
    }],
    onOpen: root => {
      const all = root.querySelector('#optAll'), none = root.querySelector('#optNone');
      if (all) all.onclick = () => root.querySelectorAll('[data-room]').forEach(c => c.checked = true);
      if (none) none.onclick = () => root.querySelectorAll('[data-room]').forEach(c => c.checked = false);
    }
  });
  if (!res) return null;
  settings.reportOpts = { parts: res.parts, cols: res.cols, check: res.check }; saveSettings();
  return res;
}
async function buildPdf(s, rooms, onProg, opt) {
  opt = opt || reportDefaults(); const P = opt.parts;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210, H = 297, M = 15, CW = W - 2 * M, INK = [29, 33, 41], GREY = [89, 98, 112], ACC = [184, 84, 28], RULE = [217, 213, 204];
  const br = settings.brand || {};
  let y = 0, logo = null;
  if (br.logo) { try { const im = await loadImg(br.logo); logo = { data: br.logo, w: im.naturalWidth, h: im.naturalHeight, fmt: /^data:image\/png/.test(br.logo) ? 'PNG' : 'JPEG' }; } catch (e) {} }
  const header = () => {
    if (logo) { let h = 13, w = h * logo.w / logo.h; if (w > 55) { w = 55; h = w * logo.h / logo.w; } doc.addImage(logo.data, logo.fmt, M, 9 + (13 - h) / 2, w, h); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
    doc.text(pdfTxt('AV site survey - ' + (s.name || 'Untitled site')), W - M, 14, { align: 'right' });
    if (br.company) doc.text(pdfTxt(br.company), W - M, 18.5, { align: 'right' });
    doc.setDrawColor(...ACC); doc.setLineWidth(0.6); doc.line(M, 25, W - M, 25);
    doc.setTextColor(...INK); y = 33;
  };
  const newPage = () => { doc.addPage(); header(); };
  const ensure = h => { if (y + h > H - 18) newPage(); };
  const sectionTitle = t => { ensure(16); y += 2; doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...ACC); doc.text(pdfTxt(t).toUpperCase(), M, y); y += 1.8; doc.setDrawColor(...RULE); doc.setLineWidth(0.2); doc.line(M, y, W - M, y); y += 5; doc.setTextColor(...INK); };
  const kv = rows => {
    const LW = 54; doc.setFontSize(9.5);
    for (const [l, v] of rows) {
      if (v === '' || v == null) continue;
      doc.setFont('helvetica', 'normal'); const lines = doc.splitTextToSize(pdfTxt(v), CW - LW); const h = lines.length * 4.4 + 1.8;
      ensure(h); doc.setTextColor(...GREY); doc.text(doc.splitTextToSize(pdfTxt(l), LW - 3), M, y); doc.setTextColor(...INK); doc.text(lines, M + LW, y); y += h;
    }
  };
  const para = (t, label) => {
    if (!t) return; doc.setFontSize(9.5);
    if (label) { ensure(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GREY); doc.text(pdfTxt(label), M, y); y += 4.6; doc.setTextColor(...INK); }
    doc.setFont('helvetica', 'normal');
    for (const ln of doc.splitTextToSize(pdfTxt(t), CW)) { ensure(5); doc.text(ln, M, y); y += 4.4; }
    y += 2;
  };
  const any = (r, ks) => ks.some(k => r[k] !== '' && r[k] != null);

  /* cover */
  header();
  let fresh = true;
  if (P.cover) {
  fresh = false;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); const tl = doc.splitTextToSize(pdfTxt(s.name || 'Untitled site'), CW); doc.text(tl, M, y + 6); y += 6 + tl.length * 9;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...GREY); doc.text(rooms.length === 1 ? 'AV site survey report - ' + pdfTxt(rooms[0].name || 'space') : 'AV site survey report', M, y); y += 10; doc.setTextColor(...INK);
  kv([['Client', s.client], ['Site address', s.address], ['Site contact', s.contact], ['Survey date', s.date ? new Date(s.date).toLocaleDateString('en-GB') : ''], ['Surveyed by', s.surveyor], ['Report prepared by', br.company], ['Report generated', new Date().toLocaleString('en-GB')]]);
  if (rooms.length > 1) {
    sectionTitle('Spaces surveyed (' + rooms.length + ')');
    doc.setFontSize(9.5);
    rooms.forEach((r, i) => {
      ensure(6); doc.setFont('helvetica', 'bold'); doc.text(pdfTxt((i + 1) + '. ' + (r.name || 'Unnamed space')), M, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...GREY);
      const done = Object.values(r.checks || {}).filter(Boolean).length;
      doc.text(pdfTxt([r.spaceType, r.purpose, r.photos.length + ' photos', done + '/' + CHECKLIST.length + ' checks'].filter(Boolean).join('  |  ')), M + 70, y);
      doc.setTextColor(...INK); y += 5.5;
    });
  }
  }

  /* spaces */
  const inReport = r => P.photos ? r.photos.filter(p => !p.noReport) : [];
  const totalPhotos = rooms.reduce((n, r) => n + inReport(r).length, 0); let done = 0;
  for (const r of rooms) {
    if (fresh) fresh = false; else newPage();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); const nl = doc.splitTextToSize(pdfTxt(r.name || 'Unnamed space'), CW); doc.text(nl, M, y); y += nl.length * 7;
    const sub = [r.spaceType, r.purpose, r.floor ? 'Floor / zone: ' + r.floor : ''].filter(Boolean).join('  |  ');
    if (sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...GREY); doc.text(pdfTxt(sub), M, y); doc.setTextColor(...INK); y += 7; }
    if (P.details) kv([['Survey date', r.date ? new Date(r.date).toLocaleDateString('en-GB') : ''], ['Surveyed by', r.surveyor], ['Capacity / occupancy', r.capacity], ['Operating hours', r.operatingHours]]);

    if (P.req && (r.systems.length || r.requirements || r.budgetNotes)) {
      sectionTitle('Client requirements');
      kv([['Systems wanted', r.systems.join(', ')]]);
      para(r.requirements, 'What the client wants');
      para(r.budgetNotes, 'Constraints');
    }
    if (P.meas && any(r, ['L', 'W', 'H', 'ceilingType', 'ceilingVoid', 'maxMount', 'mountStruct', 'coverage', 'farthest', 'nearest', 'displayWall', 'displayWallWidth', 'wallConstruction', 'tableL', 'tableW'])) {
      sectionTitle('Measurements');
      const L = parseFloat(r.L), Wd = parseFloat(r.W), Ht = parseFloat(r.H);
      kv([
        ['Length x width x height', [r.L, r.W, r.H].some(Boolean) ? `${r.L || '?'} x ${r.W || '?'} x ${r.H || '?'} m` : ''],
        ['Floor area / volume', L && Wd ? (L * Wd).toFixed(1) + ' m²' + (Ht ? ' / ' + (L * Wd * Ht).toFixed(0) + ' m³' : '') : ''],
        ['Ceiling', [r.ceilingType, r.ceilingVoid ? r.ceilingVoid + ' mm void' : ''].filter(Boolean).join(', ')],
        ['Max mounting height', r.maxMount ? r.maxMount + ' m' : ''], ['Mounting structure', r.mountStruct], ['Coverage zones', r.coverage],
        ['Farthest / nearest viewer', [r.farthest, r.nearest].some(Boolean) ? `${r.farthest || '?'} m / ${r.nearest || '?'} m` : ''],
        ['Display wall', [r.displayWall, r.displayWallWidth ? r.displayWallWidth + ' m usable' : ''].filter(Boolean).join(', ')],
        ['Display wall construction', r.wallConstruction],
        ['Table', [r.tableL, r.tableW].some(Boolean) ? `${r.tableL || '?'} x ${r.tableW || '?'} m` : '']
      ]);
    }
    {
      const d = parseFloat(r.farthest);
      if (P.display && d) {
        if (!P.meas) sectionTitle('Display size estimate');
        kv([['Display size estimate', `Minimum image height for farthest viewer at ${d} m (4/6/8 rule of thumb): passive viewing ${(d / 8 * 1000).toFixed(0)} mm, basic decision making ${(d / 6 * 1000).toFixed(0)} mm, analytical ${(d / 4 * 1000).toFixed(0)} mm. Verify against AVIXA DISCAS before specifying.`]]);
      }
    }
    if (P.env && any(r, ['light', 'lightControl', 'windows', 'blinds', 'noise', 'acoustics', 'spl', 'conditions', 'ipRating'])) {
      sectionTitle('Environment');
      kv([['Ambient light', r.light], ['Lighting control', r.lightControl], ['Windows / glazing', r.windows], ['Blinds', r.blinds], ['Background noise', r.noise], ['Acoustics (clap test)', r.acoustics], ['Measured background noise', r.spl ? r.spl + ' dB(A)' : ''], ['Conditions', r.conditions], ['IP rating required', r.ipRating]]);
    }
    if (P.infra && any(r, ['power', 'network', 'containment', 'floorBox', 'access', 'heightAccess'])) {
      sectionTitle('Infrastructure');
      kv([['Power', r.power], ['Network', r.network], ['Cable routes / containment', r.containment], ['Floor boxes / grommets', r.floorBox], ['Access / H&S', r.access], ['Working at height', r.heightAccess]]);
    }
    if (P.existing && r.existing) { sectionTitle('Existing equipment'); para(r.existing); }
    if (P.notes && r.notes) { sectionTitle('Notes'); para(r.notes); }
    if (P.voice && r.clips.length) {
      sectionTitle('Voice notes'); doc.setFontSize(9.5); doc.setFont('helvetica', 'normal');
      r.clips.forEach((c, i) => {
        ensure(6); const t = pdfTxt(`${i + 1}. ${c.label || 'Untitled'} (${c.dur}s)`);
        if (c.driveUrl) { doc.setTextColor(...ACC); doc.textWithLink(t + '  - open in Google Drive', M, y, { url: c.driveUrl }); doc.setTextColor(...INK); }
        else doc.text(t + '  - stored on the surveyor\'s device', M, y);
        y += 5.2;
      });
    }
    const checkItems = CHECKLIST.map((c, i) => [c, i]).filter(([, i]) => opt.check === 'done' ? r.checks[i] : opt.check === 'open' ? !r.checks[i] : true);
    if (P.checklist && checkItems.length) {
    sectionTitle(opt.check === 'done' ? 'Survey checklist - completed items' : opt.check === 'open' ? 'Survey checklist - outstanding items' : 'Survey checklist');
    doc.setFontSize(9.5); doc.setFont('helvetica', 'normal');
    checkItems.forEach(([c, i]) => {
      const lines = doc.splitTextToSize(pdfTxt(c), CW - 8); ensure(lines.length * 4.4 + 1.5);
      doc.setDrawColor(...GREY); doc.setLineWidth(0.3); doc.rect(M, y - 3.1, 3.4, 3.4);
      if (r.checks[i]) { doc.setDrawColor(...ACC); doc.setLineWidth(0.6); doc.line(M + 0.6, y - 1.4, M + 1.4, y - 0.3); doc.line(M + 1.4, y - 0.3, M + 3.0, y - 2.7); }
      doc.setTextColor(...(r.checks[i] ? INK : GREY)); doc.text(lines, M + 6, y); doc.setTextColor(...INK); y += lines.length * 4.4 + 1.5;
    });
    }
    const photos = inReport(r);
    if (photos.length) {
      const cols = [1, 2, 3].includes(opt.cols) ? opt.cols : 2;
      const gap = 6, colW = (CW - gap * (cols - 1)) / cols, maxH = cols === 1 ? 115 : cols === 2 ? 64 : 42;
      ensure(maxH + 30);
      sectionTitle('Photos (' + photos.length + ')');
      let rowY = y;
      for (let k = 0; k < photos.length; k++) {
        const p = photos[k], i = r.photos.indexOf(p), col = k % cols;
        if (col === 0) { ensure(maxH + 12); rowY = y; }
        done++; if (onProg) onProg(done, totalPhotos);
        let img = null, src = null;
        try { src = await photoSource(p); if (src) img = await prepImage(src.url); } catch (e) {} finally { if (src) src.revoke(); }
        const x0 = M + col * (colW + gap);
        if (img) {
          let w = colW, h = w * img.h / img.w; if (h > maxH) { h = maxH; w = h * img.w / img.h; }
          const x = x0 + (colW - w) / 2;
          doc.addImage(img.data, 'JPEG', x, rowY, w, h);
          if (p.driveUrl) doc.link(x, rowY, w, h, { url: p.driveUrl });
        } else { doc.setDrawColor(...RULE); doc.rect(x0, rowY, colW, maxH); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY); doc.text('Image not available on this device', x0 + colW / 2, rowY + maxH / 2, { align: 'center' }); doc.setTextColor(...INK); }
        doc.setFontSize(cols === 3 ? 7.5 : 8.5); doc.setFont('helvetica', 'normal');
        const cap = pdfTxt(`Photo ${i + 1}${p.caption ? ': ' + p.caption : ''}${src && src.low ? ' (low-resolution preview)' : ''}`);
        doc.text(doc.splitTextToSize(cap, colW).slice(0, 2), x0, rowY + maxH + 4);
        if (col === cols - 1 || k === photos.length - 1) y = rowY + maxH + 13;
      }
    }
  }

  /* footer on every page */
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GREY);
    doc.setDrawColor(...RULE); doc.setLineWidth(0.2); doc.line(M, H - 13, W - M, H - 13);
    const ft = br.footer || br.company || ''; if (ft) doc.text(doc.splitTextToSize(pdfTxt(ft), CW - 30).slice(0, 2), M, H - 8.5);
    doc.text('Page ' + i + ' of ' + n, W - M, H - 8.5, { align: 'right' });
  }
  return doc.output('blob');
}
async function makePdf(s, rooms, btn) {
  if (!window.jspdf) { toast('The PDF tool did not load — reload the app'); return; }
  const opt = await reportOptions(rooms); if (!opt) return;
  rooms = rooms.filter(r => opt.roomIds.includes(r.id));
  const t = btn.textContent; btn.disabled = true; btn.textContent = 'Building PDF…';
  let blob;
  try { blob = await buildPdf(s, rooms, (i, n) => { btn.textContent = `Adding photos ${i}/${n}…`; }, opt); }
  catch (e) { toast('PDF failed: ' + (e.message || e)); return; }
  finally { btn.disabled = false; btn.textContent = t; }
  const name = pdfName(s, rooms);
  const file = new File([blob], name, { type: 'application/pdf' });
  let canShare = false; try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) {}
  const opts = [];
  if (canShare) opts.push({ label: 'Share', sub: 'Email, Teams, WhatsApp…', value: 'share' });
  opts.push({ label: 'Download PDF', sub: 'Save to the phone\'s Downloads', value: 'dl' });
  if (gd.configured() && settings.driveOn && settings.folderId) opts.push({ label: 'Save to Google Drive', sub: canSync() ? 'Uploads now' : 'Uploads when connected', value: 'drive' });
  const v = await ui.choose(`${name}\n${(blob.size / 1048576).toFixed(1)} MB${(settings.brand && settings.brand.logo) ? '' : '\nTip: add your logo in ⚙ Settings → Report branding.'}`, opts, 'Report ready');
  if (v === 'share') { try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed — try Download'); } }
  else if (v === 'dl') downloadFile(name, blob);
  else if (v === 'drive') {
    const bid = uid(); await idb.put('blobs', { id: bid, blob, mime: 'application/pdf' });
    await enqueue({ type: 'pdf', siteId: s.id, roomId: rooms.length === 1 ? rooms[0].id : '', blobId: bid, name });
    toast(canSync() ? 'Uploading report to Drive…' : 'Report queued — uploads when connected');
  }
}

/* ---------- navigation ---------- */
function go(r, push = true) { route = r; if (push) history.pushState(r, ''); render(); window.scrollTo(0, 0); }
window.addEventListener('popstate', e => { if (!$('#modal').classList.contains('hid') && $('#modal')._close) { $('#modal')._close(null); } route = e.state || { v: 'home' }; render(); });
$('#back').onclick = () => history.back();
$('#guideBtn').onclick = () => go({ v: 'guide' });
$('#setBtn').onclick = () => go({ v: 'settings' });
function setTitle(t, sub) { $('#title').innerHTML = esc(t) + (sub ? `<span class="sub">${esc(sub)}</span>` : ''); }

function render() {
  const main = $('#view'), fab = $('#fab'); fab.classList.add('hid'); fab.innerHTML = '';
  $('#back').style.visibility = (route.v === 'home' || (route.v === 'setup' && !settings.setupDone)) ? 'hidden' : 'visible';
  if (recog) { try { recog.stop(); } catch (e) {} }
  const v = { setup: renderSetup, home: renderHome, site: renderSite, editSite: renderEditSite, room: renderRoom, guide: renderGuide, settings: renderSettings }[route.v] || renderHome;
  v(main, fab); updateSyncBar();
}

/* ---------- save-location setup (first run, and from "Change" on home) ---------- */
function renderSetup(main) {
  setTitle('Where to save surveys', '');
  const conf = gd.configured();
  const useDrive = settings.driveOn && conf;
  main.innerHTML = `
  <p class="muted">Surveys are always saved on this phone first so the app works with no signal. Optionally they also upload to a Google Drive folder.</p>
  <button class="item" id="optLocal" aria-pressed="${!useDrive}"><span style="flex:1"><span class="t">${!useDrive ? '● ' : '○ '}This phone only</span><span class="m">Nothing leaves the device. Share sites by exporting a file.</span></span></button>
  <button class="item" id="optDrive" aria-pressed="${useDrive}" ${conf ? '' : 'disabled style="opacity:.6"'}><span style="flex:1"><span class="t">${useDrive ? '● ' : '○ '}Phone + Google Drive folder</span><span class="m">${conf ? 'Uploads photos, clips, reports and survey data to a folder you choose. Colleagues can use the same shared folder.' : 'Not available yet: this copy of the app has no Google Client ID in config.js. See README section 2.'}</span></span></button>
  ${useDrive ? `<div class="card">
    <p style="margin:0 0 4px"><b>Google account:</b> ${gd.valid() ? 'connected' : 'not connected'}</p>
    <p style="margin:0 0 10px"><b>Folder:</b> ${settings.folderId ? esc(settings.folderName) : '<span class="muted">none chosen</span>'}</p>
    <div class="stack">
      ${gd.valid() ? '' : `<button class="btn sm" id="setConnect" ${navigator.onLine ? '' : 'disabled'}>Connect Google Drive</button>`}
      ${gd.valid() ? `<button class="btn ${settings.folderId ? 'sec' : ''} sm" id="setFolder">${settings.folderId ? 'Change folder' : 'Choose folder'}</button>` : ''}
      ${navigator.onLine ? '' : '<p class="muted">You are offline. Connect when you have signal — surveys save on the phone meanwhile.</p>'}
    </div></div>` : ''}
  <button class="btn" id="setDone" style="margin-top:12px">${settings.setupDone ? 'Done' : 'Continue'}</button>`;
  $('#optLocal').onclick = async () => { settings.driveOn = false; await saveSettings(); render(); };
  if (conf) $('#optDrive').onclick = async () => { settings.driveOn = true; await saveSettings(); render(); };
  const c = $('#setConnect'); if (c) c.onclick = async () => { try { await gd.signIn(); toast('Connected to Google Drive'); } catch (e) { toast(driveMsg(e)); } render(); };
  const f = $('#setFolder'); if (f) f.onclick = async () => { await chooseFolder(); render(); };
  $('#setDone').onclick = async () => {
    settings.setupDone = true; await saveSettings(); kickSync(10);
    if (history.state && history.state.v === 'setup' && history.length > 1 && route.fromHome) history.back();
    else { history.replaceState({ v: 'home' }, ''); route = { v: 'home' }; render(); }
  };
}

/* ---------- home ---------- */
function renderHome(main, fab) {
  setTitle('AV Site Survey', '');
  const sites = [...data.sites].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const where = !settings.driveOn || !gd.configured() ? 'This phone only' : settings.folderId ? 'Google Drive · ' + settings.folderName : 'Google Drive · no folder chosen yet';
  main.innerHTML = `<div class="card row" style="margin-bottom:12px"><span style="flex:3;min-width:0"><span class="muted" style="display:block">Saving to</span><b style="display:block;overflow:hidden;text-overflow:ellipsis">${esc(where)}</b></span><button class="btn sec sm" id="whereBtn" style="flex:0 0 auto">Change</button></div>` + (sites.length ? sites.map(s => {
    const n = data.rooms.filter(r => r.siteId === s.id).length;
    return `<button class="item" data-id="${s.id}"><span style="flex:1;min-width:0"><span class="t">${esc(s.name) || 'Untitled site'}</span><span class="m">${esc([s.client, s.address].filter(Boolean).join(' · '))}</span><span class="m">${n} space${n === 1 ? '' : 's'}${s.date ? ' · surveyed ' + esc(new Date(s.date).toLocaleDateString('en-GB')) : ''}</span></span><span class="chev">›</span></button>`;
  }).join('') : '<div class="empty">No sites yet. Add the building or campus you are visiting, then add each room or area to survey.</div>')
    + `<div class="row" style="margin-top:14px">${gd.configured() ? '<button class="btn sec sm" id="fromDrive">Open site from Drive</button>' : ''}<button class="btn sec sm" id="impBtn">Import site file</button></div><input type="file" id="impInput" accept=".json,application/json" class="hid">`;
  main.querySelectorAll('.item').forEach(b => b.onclick = () => go({ v: 'site', id: b.dataset.id }));
  $('#whereBtn').onclick = () => go({ v: 'setup', fromHome: true });
  const fd = $('#fromDrive'); if (fd) fd.onclick = openFromDrive;
  $('#impBtn').onclick = () => $('#impInput').click();
  $('#impInput').onchange = e => { importFile(e.target.files[0]); e.target.value = ''; };
  fab.classList.remove('hid'); fab.innerHTML = '<button class="btn" id="addSite">+ Add site</button>';
  $('#addSite').onclick = async () => { const s = newSite(); data.sites.push(s); await idb.put('sites', s); go({ v: 'editSite', id: s.id }); };
}
const field = (l, inner) => `<label class="f"><span class="l">${l}</span>${inner}</label>`;
function renderEditSite(main) {
  const s = data.sites.find(x => x.id === route.id); if (!s) { route = { v: 'home' }; return render(); }
  setTitle('Site details', s.name);
  main.innerHTML = `<div class="card">
    ${field('Site / building name', `<input type="text" data-k="name" value="${esc(s.name)}" placeholder="e.g. Aintree University Hospital">`)}
    ${field('Address', `<input type="text" data-k="address" value="${esc(s.address)}">`)}
    ${field('Client / organisation', `<input type="text" data-k="client" value="${esc(s.client)}">`)}
    ${field('Site contact (name, role, phone)', `<input type="text" data-k="contact" value="${esc(s.contact)}">`)}
    <div class="grid2">${field('Survey date', `<input type="date" data-k="date" value="${esc(s.date || '')}">`)}${field('Surveyed by', `<input type="text" data-k="surveyor" value="${esc(s.surveyor || '')}">`)}</div>
    <p class="muted" style="margin:0">New spaces take this date and surveyor; you can change them per space.</p>
  </div>
  <button class="btn" id="done">Done</button>
  <p style="margin-top:24px"><button class="btn danger sm" id="delSite">Delete site from this device</button></p>`;
  main.querySelectorAll('[data-k]').forEach(i => i.oninput = () => { s[i.dataset.k] = i.value; saveLater('sites', s); });
  $('#done').onclick = () => { history.replaceState({ v: 'site', id: s.id }, ''); route = { v: 'site', id: s.id }; render(); };
  $('#delSite').onclick = async () => {
    const rooms = data.rooms.filter(r => r.siteId === s.id);
    if (!await ui.confirm(`Delete “${s.name || 'this site'}” and its ${rooms.length} space survey(s) from this device?\n\nAnything already uploaded stays in Google Drive.`, { title: 'Delete site', ok: 'Delete', danger: true })) return;
    for (const r of rooms) await deleteRoomData(r);
    await idb.del('queue', 'sitejson:' + s.id); await idb.del('sites', s.id);
    data.sites = data.sites.filter(x => x.id !== s.id);
    history.replaceState({ v: 'home' }, ''); route = { v: 'home' }; render();
  };
}
async function deleteRoomData(r) {
  for (const it of [...r.photos, ...r.clips]) if (it.blobId) await idb.del('blobs', it.blobId);
  for (const j of await idb.all('queue')) if (j.roomId === r.id) { if (j.blobId) await idb.del('blobs', j.blobId); await idb.del('queue', j.id); }
  await idb.del('rooms', r.id); data.rooms = data.rooms.filter(x => x.id !== r.id);
}

/* ---------- site ---------- */
function renderSite(main, fab) {
  const s = data.sites.find(x => x.id === route.id); if (!s) { route = { v: 'home' }; return render(); }
  setTitle(s.name || 'Untitled site', s.client || s.address || '');
  const rooms = data.rooms.filter(r => r.siteId === s.id);
  main.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn sec sm" id="editSite">Edit site</button><button class="btn sm" id="pdfSite">PDF report</button></div>`
    + (rooms.length ? rooms.map(r => {
      const done = Object.values(r.checks || {}).filter(Boolean).length;
      const pend = r.photos.filter(p => !p.driveId).length + r.clips.filter(c => !c.driveId).length;
      return `<button class="item" data-id="${r.id}"><span style="flex:1;min-width:0"><span class="t">${esc(r.name) || 'Unnamed space'}</span><span class="m">${esc([r.spaceType, r.purpose, r.floor].filter(Boolean).join(' · '))}</span><span class="m">${r.photos.length} photo${r.photos.length === 1 ? '' : 's'} · ${done}/${CHECKLIST.length} checks${pend && gd.configured() ? ` · ${pend} not uploaded` : ''}</span></span><span class="chev">›</span></button>`;
    }).join('') : '<div class="empty">No rooms or areas surveyed at this site yet.</div>')
    + `<div class="stack" style="margin-top:14px"><button class="btn sec sm" id="jsonSite">Export site file (.json) for another device</button></div>`
    + (s.lastSynced ? `<p class="muted" style="text-align:center">Survey data last saved to Drive ${new Date(s.lastSynced).toLocaleString('en-GB')}</p>` : '');
  main.querySelectorAll('.item').forEach(b => b.onclick = () => go({ v: 'room', id: b.dataset.id }));
  $('#editSite').onclick = () => go({ v: 'editSite', id: s.id });
  $('#pdfSite').onclick = e => { if (!rooms.length) { toast('Add at least one room or area first'); return; } makePdf(s, rooms, e.currentTarget); };
  $('#jsonSite').onclick = async () => downloadFile(fileSafe(s.name || 'site') + ' site data.json', JSON.stringify(await siteJson(s, rooms, true)), 'application/json');
  fab.classList.remove('hid'); fab.innerHTML = '<button class="btn" id="addRoom">+ Add room / area</button>';
  $('#addRoom').onclick = async () => { const r = newRoom(s.id); data.rooms.push(r); await idb.put('rooms', r); go({ v: 'room', id: r.id }); };
}

/* ---------- room / space survey ---------- */
const txt = (r, k, l, ph = '') => field(l, `<input type="text" data-k="${k}" value="${esc(r[k])}" placeholder="${esc(ph)}">`);
const num = (r, k, l, unit = 'm') => field(l + (unit ? ' (' + unit + ')' : ''), `<input type="number" inputmode="decimal" step="0.01" data-k="${k}" value="${esc(r[k])}">`);
const area = (r, k, l, ph = '') => field(l, `<textarea data-k="${k}" placeholder="${esc(ph)}">${esc(r[k])}</textarea>`);
const sel = (r, k, l, opts) => field(l, `<select data-k="${k}"><option value="">—</option>${opts.map(o => `<option ${r[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}${r[k] && !opts.includes(r[k]) ? `<option selected>${esc(r[k])}</option>` : ''}</select>`);
const sec = (id, title, count, body, open) => `<details class="sec" id="s-${id}" ${open ? 'open' : ''}><summary>${title}<span class="n">${count || ''}</span></summary><div class="body">${body}</div></details>`;

function renderRoom(main) {
  const r = data.rooms.find(x => x.id === route.id); if (!r) { route = { v: 'home' }; return render(); }
  const s = siteOf(r);
  setTitle(r.name || 'New space', s ? s.name : '');
  const filled = (...ks) => ks.filter(k => r[k] !== '' && r[k] != null).length + '/' + ks.length;
  main.innerHTML = `
  <div class="status" id="st">Saved on this device</div>
  ${sec('id', 'Space', filled('name', 'spaceType', 'purpose', 'capacity', 'surveyor'), `
    ${txt(r, 'name', 'Space name / number', 'e.g. Boardroom 2.14, Warehouse Bay C, Loading yard')}
    ${sel(r, 'spaceType', 'Type of space', SPACE_TYPES)}
    <div class="grid2">${txt(r, 'floor', 'Floor / zone')}${txt(r, 'capacity', 'Capacity / occupancy')}</div>
    ${sel(r, 'purpose', 'Purpose / use', PURPOSES)}
    ${txt(r, 'operatingHours', 'Operating hours / shifts', 'e.g. 24/7, 06:00–22:00')}
    <div class="grid2">${field('Survey date', `<input type="date" data-k="date" value="${esc(r.date)}">`)}${txt(r, 'surveyor', 'Surveyed by')}</div>`, true)}
  ${sec('req', 'Client requirements', r.systems.length ? r.systems.length + ' systems' : '', `
    <span class="muted">Systems wanted</span>
    <div class="chips" style="margin-top:6px">${SYSTEMS.map(x => `<button class="chip" data-sys="${esc(x)}" aria-pressed="${r.systems.includes(x)}">${esc(x)}</button>`).join('')}</div>
    ${area(r, 'requirements', 'What the client wants (in their words)', 'Use cases, who uses the space, pain points, must-haves, nice-to-haves…')}
    ${area(r, 'budgetNotes', 'Constraints: budget, programme, standards, IT policy', 'e.g. must match existing MTR estate, Dante preferred, works only in August')}`)}
  ${sec('meas', 'Measurements', filled('L', 'W', 'H', 'farthest', 'maxMount'), `
    <div class="grid3">${num(r, 'L', 'Length')}${num(r, 'W', 'Width')}${num(r, 'H', 'Ceiling / roof height')}</div>
    <div class="grid2">${sel(r, 'ceilingType', 'Ceiling type', O.ceilingType)}${num(r, 'ceilingVoid', 'Ceiling void depth', 'mm')}</div>
    <div class="grid2">${num(r, 'maxMount', 'Max usable mounting height')}${sel(r, 'mountStruct', 'Mounting structure', O.mountStruct)}</div>
    ${area(r, 'coverage', 'Coverage zones', 'e.g. picking aisles 1–12, dispatch, mezzanine — note areas needing separate paging zones')}
    <div class="grid2">${num(r, 'farthest', 'Farthest viewer from display')}${num(r, 'nearest', 'Nearest viewer from display')}</div>
    <div class="grid2">${txt(r, 'displayWall', 'Display wall (orientation)', 'e.g. North wall')}${num(r, 'displayWallWidth', 'Usable wall width')}</div>
    ${sel(r, 'wallConstruction', 'Display wall construction', O.wallConstruction)}
    <div class="grid2">${num(r, 'tableL', 'Table length')}${num(r, 'tableW', 'Table width')}</div>
    <div class="card calc" id="calc"></div>`)}
  ${sec('env', 'Environment', filled('light', 'noise', 'acoustics', 'conditions'), `
    ${sel(r, 'light', 'Ambient light', O.light)}
    ${sel(r, 'lightControl', 'Lighting control', O.lightControl)}
    <div class="grid2">${txt(r, 'windows', 'Windows / glazing position', 'e.g. full width East wall')}${sel(r, 'blinds', 'Blinds', O.blinds)}</div>
    ${sel(r, 'noise', 'Background noise (listen)', O.noise)}
    ${sel(r, 'acoustics', 'Acoustics (clap test)', O.acoustics)}
    ${num(r, 'spl', 'Measured background noise', 'dB(A)')}
    ${sel(r, 'conditions', 'Conditions', O.conditions)}
    ${txt(r, 'ipRating', 'IP rating required', 'e.g. IP54, IP66')}`)}
  ${sec('infra', 'Infrastructure', filled('power', 'network', 'containment', 'access'), `
    ${area(r, 'power', 'Power: outlet locations, count, spare capacity, DB location', 'e.g. 2× double socket on display wall at 300mm AFF, none at table')}
    ${area(r, 'network', 'Network: data outlets, patch cabinet, PoE / VLAN notes', 'Confirm with IT: VLAN for AV, PoE budget, Dante VLAN if needed')}
    ${area(r, 'containment', 'Cable routes and containment', 'Ceiling void route, trunking, dado, wall chases, existing conduit')}
    ${txt(r, 'floorBox', 'Floor boxes / table grommets', 'e.g. 1× floor box under table centre')}
    ${area(r, 'access', 'Access, delivery route, rack location, H&S notes', 'Lift size, door widths, ceiling access, asbestos register, permit to work')}
    ${sel(r, 'heightAccess', 'Working-at-height access', O.heightAccess)}`)}
  ${sec('exist', 'Existing equipment', r.existing ? '✓' : '', area(r, 'existing', 'Existing AV equipment and whether reusable', 'Make / model, condition, mounts, cabling to retain'))}
  ${sec('photos', 'Photos', r.photos.length || '', `
    <div class="photos" id="photos"></div>
    <div class="row"><button class="btn sec sm" id="camBtn">📷 Take photo</button><button class="btn sec sm" id="libBtn">Add from gallery</button></div>
    <input type="file" accept="image/*" capture="environment" id="cam" class="hid">
    <input type="file" accept="image/*" id="lib" class="hid" multiple>
    <p class="muted">Tap a photo to view it, caption it, leave it out of the report or delete it. ⏳ = waiting to upload, ☁ = in Drive.</p>`)}
  ${sec('notes', 'Notes and voice', r.clips.length ? r.clips.length + ' clips' : '', `
    ${area(r, 'notes', 'Notes')}
    <div class="row" style="margin-bottom:12px"><button class="btn sec sm" id="dictate">🎤 Dictate into notes</button><button class="btn sec sm" id="recBtn">● Record voice clip</button></div>
    <div id="clips"></div>
    <p class="muted" id="voiceHelp"></p>`)}
  ${sec('check', 'Survey checklist', Object.values(r.checks).filter(Boolean).length + '/' + CHECKLIST.length,
    CHECKLIST.map((c, i) => `<label class="chk"><input type="checkbox" data-chk="${i}" ${r.checks[i] ? 'checked' : ''}><span>${esc(c)}</span></label>`).join(''))}
  <div class="stack" style="margin-top:16px">
    <button class="btn sm" id="pdfRoom">PDF report for this space</button>
  </div>
  <p style="margin-top:24px"><button class="btn danger sm" id="delRoom">Delete this survey from this device</button></p>`;

  const calcKeys = ['L', 'W', 'H', 'farthest'];
  main.querySelectorAll('[data-k]').forEach(i => i.oninput = () => {
    r[i.dataset.k] = i.value; saveLater('rooms', r);
    if (calcKeys.includes(i.dataset.k)) renderCalc(r);
    if (i.dataset.k === 'name') $('#title').firstChild.textContent = i.value || 'New space';
  });
  main.querySelectorAll('.chip').forEach(c => c.onclick = () => { const x = c.dataset.sys; const i = r.systems.indexOf(x); if (i >= 0) r.systems.splice(i, 1); else r.systems.push(x); c.setAttribute('aria-pressed', i < 0); saveLater('rooms', r); });
  main.querySelectorAll('[data-chk]').forEach(c => c.onchange = () => { r.checks[c.dataset.chk] = c.checked; $('#s-check summary .n').textContent = Object.values(r.checks).filter(Boolean).length + '/' + CHECKLIST.length; saveLater('rooms', r); });
  renderCalc(r); renderPhotos(r); renderClips(r); setupVoice(r);
  $('#camBtn').onclick = () => $('#cam').click(); $('#libBtn').onclick = () => $('#lib').click();
  $('#cam').onchange = e => addPhotos(r, e.target.files); $('#lib').onchange = e => addPhotos(r, e.target.files);
  $('#pdfRoom').onclick = e => makePdf(s, [r], e.currentTarget);
  $('#delRoom').onclick = async () => {
    const pend = r.photos.filter(p => !p.driveId).length + r.clips.filter(c => !c.driveId).length;
    if (!await ui.confirm('Delete this survey from this device?' + (pend ? `\n\n${pend} photo/clip(s) have not been uploaded and will be lost.` : '') + '\n\nAnything already uploaded stays in Google Drive.', { title: 'Delete survey', ok: 'Delete', danger: true })) return;
    const sid = r.siteId; if (s) { s.deletedRooms = [...new Set([...(s.deletedRooms || []), r.id])]; await idb.put('sites', s); }
    await deleteRoomData(r); markSiteDirty(sid);
    history.replaceState({ v: 'site', id: sid }, ''); route = { v: 'site', id: sid }; render();
  };
}
function renderCalc(r) {
  const el = $('#calc'); if (!el) return;
  const d = parseFloat(r.farthest), L = parseFloat(r.L), W = parseFloat(r.W), H = parseFloat(r.H);
  let html = '';
  if (L && W) html += `<div>Floor area ${(L * W).toFixed(1)} m²${H ? ' · volume ' + (L * W * H).toFixed(0) + ' m³' : ''}</div>`;
  if (d) {
    const row = (lbl, div) => { const h = d / div; return `<tr><td>${lbl} (≤ ${div}× image height)</td><td>H ${(h * 1000).toFixed(0)} mm ≈ ${(h * 2.04 / 0.0254).toFixed(0)}″ 16:9</td></tr>`; };
    html += `<div style="margin-top:8px">Minimum image height from farthest viewer ${d} m</div><table>${row('Passive viewing', 8)}${row('Basic decision making', 6)}${row('Analytical / detailed', 4)}</table>
    <div class="muted" style="font-family:inherit;margin-top:6px">Rule of thumb only (4/6/8 × image height). Check against AVIXA DISCAS and the content type before specifying.</div>`;
  }
  el.innerHTML = html || '<span class="muted">Enter length, width and farthest viewer distance for area and a display-size estimate.</span>';
}

/* ---------- photos ---------- */
async function addPhotos(r, files) {
  const list = [...files]; $('#cam').value = ''; $('#lib').value = '';
  for (const f of list) {
    toast('Saving photo…');
    try {
      const full = await resize(f, 3000, .88); const th = await resize(f, 400, .65); if (!full) { toast('Could not read that image'); continue; }
      const ph = { id: uid(), blobId: uid(), thumb: th ? await blobDataUrl(th) : '', caption: '', driveId: '', driveUrl: '' };
      await idb.put('blobs', { id: ph.blobId, blob: full, mime: 'image/jpeg' });
      r.photos.push(ph); await saveNow('rooms', r);
      await enqueue({ type: 'photo', roomId: r.id, itemId: ph.id });
    } catch (e) { toast('Photo not saved: ' + (e.message || e)); }
  }
  renderPhotos(r); const n = $('#s-photos summary .n'); if (n) n.textContent = r.photos.length || '';
  toast(list.length === 1 ? 'Photo saved' : list.length + ' photos saved');
}
function renderPhotos(r) {
  const el = $('#photos'); if (!el) return;
  el.innerHTML = r.photos.map((p, i) => `<button class="ph" data-i="${i}" aria-label="Photo ${i + 1}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : ''}<span class="badge">${p.driveId ? '☁' : '⏳'}</span>${p.noReport ? '<span class="badge" style="right:auto;left:4px">not in report</span>' : ''}${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}</button>`).join('');
  el.querySelectorAll('.ph').forEach(b => b.onclick = () => viewPhoto(r, r.photos[b.dataset.i]));
}
async function viewPhoto(r, p) {
  let url = p.thumb, obj = null;
  if (p.blobId) { const b = await idb.get('blobs', p.blobId); if (b) { obj = URL.createObjectURL(b.blob); url = obj; } }
  const html = `${url ? `<img class="full" src="${esc(url)}" alt="">` : '<p class="muted">No preview on this device.</p>'}
    ${field('Caption', `<input type="text" id="capIn" value="${esc(p.caption)}" placeholder="e.g. Display wall, ceiling void at door">`)}
    <label class="chk"><input type="checkbox" id="inRep" ${p.noReport ? '' : 'checked'}><span>Include in PDF report</span></label>
    <p class="muted">${p.driveUrl ? `In Google Drive · <a href="${esc(p.driveUrl)}" target="_blank" rel="noopener">open full size</a>` : 'On this phone · waiting to upload to Drive'}</p>`;
  const v = await modal({ title: 'Photo', html, buttons: [{ label: 'Delete', cls: 'danger', value: 'del' }, { label: 'Save', value: root => ({ cap: root.querySelector('#capIn').value, inRep: root.querySelector('#inRep').checked }) }] });
  if (obj) URL.revokeObjectURL(obj);
  if (!v) return;
  if (v === 'del') {
    if (!await ui.confirm(p.driveId ? 'Remove this photo from the survey? The copy in Google Drive is kept.' : 'Delete this photo? It has not been uploaded, so it will be lost.', { ok: 'Delete', danger: true })) return;
    r.photos = r.photos.filter(x => x !== p); r.deletedItems = [...new Set([...(r.deletedItems || []), p.id])]; if (p.blobId) await idb.del('blobs', p.blobId);
    for (const j of await idb.all('queue')) if (j.itemId === p.id) await idb.del('queue', j.id);
  } else { p.caption = v.cap; if (v.inRep) delete p.noReport; else p.noReport = true; }
  await saveNow('rooms', r); renderPhotos(r); const n = $('#s-photos summary .n'); if (n) n.textContent = r.photos.length || '';
}

/* ---------- voice: dictation and clips ---------- */
let recog = null, mediaRec = null, recTimer = null;
function setupVoice(r) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dBtn = $('#dictate'), rBtn = $('#recBtn'), help = $('#voiceHelp'); const notes = [];
  if (!SR) { dBtn.disabled = true; notes.push('Dictation is not supported by this browser.'); }
  else notes.push('Dictation normally needs a data connection; voice clips record fine offline.');
  if (!navigator.mediaDevices || !window.MediaRecorder) { rBtn.disabled = true; notes.push('Audio recording is not supported by this browser.'); }
  else notes.push('Clips up to 10 minutes are saved on the phone and uploaded to Drive when possible.');
  help.textContent = notes.join(' ');
  dBtn.onclick = () => {
    if (recog) { recog.stop(); return; }
    if (!navigator.onLine) toast('You are offline — dictation may not work. Record a voice clip instead.');
    recog = new SR(); recog.lang = 'en-GB'; recog.continuous = true; recog.interimResults = false;
    const ta = document.querySelector('[data-k="notes"]');
    recog.onresult = e => { let t = ''; for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) t += e.results[i][0].transcript + ' '; if (t) { ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + t.trim() + '. '; r.notes = ta.value; saveLater('rooms', r); } };
    recog.onerror = e => toast('Dictation: ' + (e.error === 'network' ? 'needs a connection' : e.error));
    recog.onend = () => { recog = null; dBtn.classList.remove('mic-on'); dBtn.textContent = '🎤 Dictate into notes'; };
    recog.start(); dBtn.classList.add('mic-on'); dBtn.textContent = '■ Stop dictation';
  };
  rBtn.onclick = async () => {
    if (mediaRec) { mediaRec.stop(); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Microphone access was refused'); return; }
    const chunks = []; let opts = {};
    for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) { opts = { mimeType: m, audioBitsPerSecond: 32000 }; break; }
    const rec = new MediaRecorder(stream, opts); mediaRec = rec; const t0 = Date.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearTimeout(recTimer); stream.getTracks().forEach(t => t.stop()); mediaRec = null;
      rBtn.classList.remove('rec'); rBtn.textContent = '● Record voice clip';
      const mime = (rec.mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: mime }); const dur = Math.round((Date.now() - t0) / 1000);
      if (!blob.size) { toast('Nothing was recorded'); return; }
      try {
        const c = { id: uid(), blobId: uid(), dur, mime, label: '', driveId: '', driveUrl: '' };
        await idb.put('blobs', { id: c.blobId, blob, mime });
        r.clips.push(c); await saveNow('rooms', r); await enqueue({ type: 'clip', roomId: r.id, itemId: c.id });
        renderClips(r); const n = $('#s-notes summary .n'); if (n) n.textContent = r.clips.length + ' clips';
        toast('Clip saved');
      } catch (e) { toast('Clip not saved: ' + (e.message || e)); }
    };
    rec.start(1000); rBtn.classList.add('rec'); rBtn.textContent = '■ Stop recording';
    recTimer = setTimeout(() => { if (mediaRec === rec) rec.stop(); }, 600000);
  };
}
function renderClips(r) {
  const el = $('#clips'); if (!el) return;
  el.innerHTML = r.clips.map((c, i) => `<div class="clip">
    ${c.blobId ? `<button class="ib" data-play="${i}" aria-label="Play">▶</button>` : (c.driveUrl ? `<a class="ib" href="${esc(c.driveUrl)}" target="_blank" rel="noopener" aria-label="Open in Drive">↗</a>` : '<span class="ib">–</span>')}
    <span class="lab"><input type="text" data-lab="${i}" value="${esc(c.label)}" placeholder="Label (e.g. ceiling void)"></span>
    <span class="muted">${c.dur}s ${c.driveId ? '☁' : '⏳'}</span>
    <button class="ib" data-cdel="${i}" aria-label="Delete clip">×</button></div>`).join('');
  el.querySelectorAll('[data-lab]').forEach(i => i.oninput = () => { r.clips[i.dataset.lab].label = i.value; saveLater('rooms', r); });
  el.querySelectorAll('[data-play]').forEach(b => b.onclick = async () => {
    const c = r.clips[b.dataset.play]; const d = await idb.get('blobs', c.blobId); if (!d) { toast('Audio not found on this device'); return; }
    const u = URL.createObjectURL(d.blob); const a = new Audio(u); a.onended = () => URL.revokeObjectURL(u); a.play().catch(() => toast('Playback failed'));
  });
  el.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => {
    const c = r.clips[b.dataset.cdel];
    if (!await ui.confirm(c.driveId ? 'Remove this clip from the survey? The copy in Google Drive is kept.' : 'Delete this clip? It has not been uploaded, so it will be lost.', { ok: 'Delete', danger: true })) return;
    r.clips = r.clips.filter(x => x !== c); r.deletedItems = [...new Set([...(r.deletedItems || []), c.id])]; if (c.blobId) await idb.del('blobs', c.blobId);
    for (const j of await idb.all('queue')) if (j.itemId === c.id) await idb.del('queue', j.id);
    await saveNow('rooms', r); renderClips(r);
  });
}

/* ---------- settings ---------- */
async function renderSettings(main) {
  setTitle('Settings', 'Version ' + APP_VERSION);
  const jobs = await idb.all('queue').catch(() => []);
  const failed = jobs.filter(j => (j.attempts || 0) >= 6);
  let est = ''; try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); est = `Using ${(e.usage / 1048576).toFixed(1)} MB of about ${(e.quota / 1073741824).toFixed(1)} GB available to the app.`; } } catch (e) {}
  let persisted = null; try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) {}
  const conf = gd.configured();
  main.innerHTML = `
  <div class="card"><h2>Google Drive</h2>
    ${!conf ? '<p class="muted">Not set up. Add your Google Client ID to config.js (see README). Everything still saves on this phone.</p>' : `
    <p class="muted">${gd.valid() ? 'Connected for this session.' : navigator.onLine ? 'Not connected — sign-in lasts about an hour, then tap the bar at the top again.' : 'Offline.'}</p>
    <label class="chk"><input type="checkbox" id="drvOn" ${settings.driveOn ? 'checked' : ''}><span>Upload surveys, photos and clips to Drive</span></label>
    <p style="margin:10px 0 6px"><b>Folder:</b> ${settings.folderId ? (settings.folderUrl ? `<a href="${esc(settings.folderUrl)}" target="_blank" rel="noopener">${esc(settings.folderName)}</a>` : esc(settings.folderName)) : '<span class="muted">none chosen</span>'}</p>
    <div class="stack">
      ${gd.valid() ? '' : '<button class="btn sm" id="conBtn">Connect Google Drive</button>'}
      <button class="btn sec sm" id="folderBtn" ${gd.valid() ? '' : 'disabled'}>${settings.folderId ? 'Change folder' : 'Choose folder'}</button>${gd.valid() ? '' : '<p class="muted" style="margin:0">Connect first, then choose the folder.</p>'}
      ${settings.folderId ? '<button class="btn sec sm" id="inviteBtn">Send app link with this folder to a colleague</button>' : ''}
      ${settings.folderId ? '<button class="btn sec sm" id="openDrv">Open a site from this folder</button>' : ''}
      ${jobs.length ? `<button class="btn sec sm" id="syncNow">Upload now (${jobs.length} waiting)</button>` : ''}
    </div>`}
    ${failed.length ? `<div class="card" style="margin-top:12px;background:var(--warn-bg)"><b>${failed.length} failed upload(s)</b><p class="muted">Last error: ${esc(failed[0].lastError || 'unknown')}</p><button class="btn sec sm" id="retryBtn">Retry failed uploads</button></div>` : ''}
  </div>
  <div class="card"><h2>Storage on this device</h2>
    <p class="muted">${est || 'Storage usage not available in this browser.'} ${persisted === true ? 'Protected from automatic clean-up.' : persisted === false ? 'Not yet protected from automatic clean-up — installing the app usually fixes this.' : ''}</p>
    <label class="chk"><input type="checkbox" id="keepLocal" ${settings.keepLocal ? 'checked' : ''}><span>Keep full-size photos and clips on the phone after upload</span></label>
    <button class="btn sec sm" id="freeBtn" style="margin-top:8px">Free up space (remove uploaded files from this phone)</button>
  </div>
  <div class="card"><h2>Report branding</h2>
    <div style="margin-bottom:8px">${settings.brand && settings.brand.logo ? `<img src="${esc(settings.brand.logo)}" alt="Logo" style="max-height:60px;max-width:100%;background:#fff;padding:4px;border-radius:6px">` : '<p class="muted" style="margin:0">No logo yet. PNG or JPG; a PNG with transparent background looks best.</p>'}</div>
    <div class="row" style="margin-bottom:12px"><button class="btn sec sm" id="logoBtn">${settings.brand && settings.brand.logo ? 'Change logo' : 'Choose logo'}</button>${settings.brand && settings.brand.logo ? '<button class="btn sec sm" id="logoDel">Remove</button>' : ''}</div>
    <input type="file" id="logoIn" accept="image/png,image/jpeg" class="hid">
    ${field('Company name (top of each page)', `<input type="text" id="brCo" value="${esc((settings.brand || {}).company || '')}" placeholder="e.g. Green Monkey AV Ltd">`)}
    ${field('Footer text (bottom of each page)', `<input type="text" id="brFt" value="${esc((settings.brand || {}).footer || '')}" placeholder="e.g. address · phone · website">`)}
    <p class="muted" style="margin:0">Saved on this phone. Colleagues set their own.</p>
  </div>
  <div class="card"><h2>Install</h2>
    <p class="muted">Android: open this page in Chrome → menu ⋮ → <b>Install app</b> (or Add to Home screen). It then opens full screen and works with no signal. Desktop: use the install icon in Chrome or Edge's address bar.</p>
    <button class="btn sec sm hid" id="installBtn">Install app</button>
  </div>`;
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  on('conBtn', connectDrive); on('folderBtn', chooseFolder); on('inviteBtn', shareInvite); on('openDrv', openFromDrive);
  on('syncNow', () => { if (!gd.valid()) connectDrive(); else { processQueue(); toast('Uploading…'); } });
  on('retryBtn', async () => { for (const j of failed) { j.attempts = 0; await idb.put('queue', j); } toast('Retrying'); kickSync(10); render(); });
  const dOn = $('#drvOn'); if (dOn) dOn.onchange = async () => { settings.driveOn = dOn.checked; await saveSettings(); kickSync(10); updateSyncBar(); };
  $('#keepLocal').onchange = async e => { settings.keepLocal = e.target.checked; await saveSettings(); };
  $('#freeBtn').onclick = freeSpace;
  settings.brand = settings.brand || {};
  $('#logoBtn').onclick = () => $('#logoIn').click();
  $('#logoIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const u = URL.createObjectURL(f); const im = await loadImg(u); URL.revokeObjectURL(u);
      const sc = Math.min(1, 800 / Math.max(im.naturalWidth, im.naturalHeight)); const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * sc); c.height = Math.round(im.naturalHeight * sc);
      const x = c.getContext('2d'); const png = f.type === 'image/png';
      if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
      x.drawImage(im, 0, 0, c.width, c.height);
      settings.brand.logo = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', .9);
      await saveSettings(); toast('Logo saved'); render();
    } catch (err) { toast('Could not read that image — use PNG or JPG'); }
  };
  const ld = $('#logoDel'); if (ld) ld.onclick = async () => { delete settings.brand.logo; await saveSettings(); render(); };
  let brT; const brSave = () => { clearTimeout(brT); brT = setTimeout(saveSettings, 400); };
  $('#brCo').oninput = e => { settings.brand.company = e.target.value; brSave(); };
  $('#brFt').oninput = e => { settings.brand.footer = e.target.value; brSave(); };
  if (deferredInstall) { const ib = $('#installBtn'); ib.classList.remove('hid'); ib.onclick = async () => { deferredInstall.prompt(); deferredInstall = null; ib.classList.add('hid'); }; }
}
async function freeSpace() {
  let n = 0;
  for (const r of data.rooms) for (const it of [...r.photos, ...r.clips]) if (it.driveId && it.blobId) n++;
  if (!n) { toast('Nothing to remove — only files already in Drive can be removed'); return; }
  if (!await ui.confirm(`Remove ${n} uploaded photo/clip file(s) from this phone? They stay in Google Drive; thumbnails stay in the app.`, { title: 'Free up space', ok: 'Remove' })) return;
  for (const r of data.rooms) {
    let ch = false;
    for (const it of [...r.photos, ...r.clips]) if (it.driveId && it.blobId) { await idb.del('blobs', it.blobId); it.blobId = ''; ch = true; }
    if (ch) await idb.put('rooms', r);
  }
  toast('Space freed'); render();
}

/* ---------- guide ---------- */
function renderGuide(main) {
  setTitle('Survey guide', '');
  main.innerHTML = `<div class="card guide">
  <p>A working checklist for what to capture on an AV site visit. These are field rules of thumb drawn from common industry practice; where a figure matters for a specification, verify it against the current AVIXA standard (DISCAS for display size, APS for audio performance) and the manufacturer's data.</p>
  <h3>Before you arrive</h3><ul><li>Get floor plans or room numbers, the client's brief, and the name of the person who signs off.</li><li>Ask IT in advance about network: VLANs, PoE budget, switch locations, Dante or AES67 policy.</li><li>Check site induction, permits, and the asbestos register for older buildings.</li></ul>
  <h3>Geometry</h3><ul><li>Measure length, width and ceiling height; note where the height changes.</li><li>Identify the display wall and measure its usable width between obstructions.</li><li>Measure the farthest and nearest seated viewer positions from the display wall.</li><li>Record the table size and position — it drives microphone and camera coverage.</li></ul>
  <h3>Display sizing</h3><ul><li>The estimate uses the common 4/6/8 rule: farthest viewer no more than 4× image height for detailed content, 6× for basic decision making, 8× for passive viewing. A starting point, not a specification.</li><li>Consider the nearest viewer and mounting-height constraints too.</li></ul>
  <h3>Cameras and video conferencing</h3><ul><li>Note camera position options and line of sight to the farthest seat.</li><li>Record windows behind seating — backlighting is a common VC complaint.</li><li>For MTR rooms, confirm where the compute, touch controller and peripherals will live, and the USB / network run lengths.</li></ul>
  <h3>Audio</h3><ul><li>Clap test and listen: hard surfaces make a live room and harder microphone pickup.</li><li>Note HVAC diffuser positions and noise.</li><li>Check ceiling type and void depth for ceiling microphones and speakers, and above-ceiling access.</li></ul>
  <h3>Warehouses, industrial and outdoor areas</h3><ul><li>Measure to the underside of the roof structure and record the highest point you can realistically fix to and maintain.</li><li>Note noise sources. If you have a sound level meter, record dB(A) at typical working positions — paging over high background noise needs enough headroom above it to stay intelligible.</li><li>Ask whether the PA must interface with, or act as, a voice alarm system. In the UK that falls under BS 5839-8 and EN 54 — specialist scope, flag it early.</li><li>Record exposure to dust, moisture, temperature, washdown or weather, and the IP rating needed.</li><li>Fixing to pallet racking normally needs the racking owner's approval.</li><li>Plan working at height: MEWP access, operating hours, and whether areas need closing off.</li></ul>
  <h3>Power and data</h3><ul><li>Count and photograph outlets at the display wall, table and rack position.</li><li>Identify the nearest data cabinet and spare patching.</li><li>Trace a realistic cable route.</li></ul>
  <h3>Photos to take every time</h3><ul><li>All walls straight on, ceiling, floor, display wall close-up, existing outlets and cabinets, equipment labels, and the view from the farthest seat.</li></ul>
  </div>`;
}

/* ---------- install prompt & updates ---------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
window.onAppUpdate = async worker => {
  if (await ui.confirm('A new version of the app is ready.', { title: 'Update available', ok: 'Update now', cancel: 'Later' })) worker.postMessage('skipWaiting');
};
window.addEventListener('online', () => { gd.preload(); updateSyncBar(); kickSync(500); });
window.addEventListener('offline', updateSyncBar);
setInterval(() => { if (canSync()) processQueue(); }, 60000);

/* ---------- boot ---------- */
(async () => {
  $('#view').innerHTML = '<div class="status">Loading…</div>';
  try {
    const st = await idb.get('kv', 'settings'); if (st && st.v) settings = Object.assign(settings, st.v);
    data.sites = await idb.all('sites'); data.rooms = await idb.all('rooms');
    data.rooms.forEach(r => { r.photos = r.photos || []; r.clips = r.clips || []; r.checks = r.checks || {}; r.systems = r.systems || []; });
  } catch (e) {
    $('#view').innerHTML = '<div class="card">This browser blocked local storage (private browsing can do this). The app cannot save surveys here.</div>'; return;
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist(); }); } catch (e) {}
  gd.preload();
  if (!settings.setupDone && !new URLSearchParams(location.search).get('folder')) route = { v: 'setup' };
  history.replaceState(route, '');
  render();
  handleInviteParams();
})();
