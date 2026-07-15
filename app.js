// ==================== Land Nav Plotter - app logic ====================

// ---------- tiny IndexedDB wrapper ----------
const DB_NAME = 'landnav-db';
const STORE = 'profiles';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(record) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uuid() {
  return 'xxxx-xxxx-xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
}

// ---------- azimuth / declination helpers ----------
function normAz(a) { return ((a % 360) + 360) % 360; }
function gridAzimuthBetween(e1, n1, e2, n2) {
  const az = (Math.atan2(e2 - e1, n2 - n1) * 180) / Math.PI;
  return normAz(az);
}
function distanceBetween(e1, n1, e2, n2) { return Math.hypot(e2 - e1, n2 - n1); }
function gridToMag(gridAz, decl) {
  if (!decl) return null;
  const mag = decl.dir === 'W' ? gridAz + decl.value : gridAz - decl.value;
  return normAz(mag);
}
function backAzimuth(az) { return normAz(az + 180); }

// ---------- waypoint categories ----------
const CATEGORIES = {
  rp: { label: 'Rally Point', color: '#5C6B3B', symbol: 'triangle' },
  danger: { label: 'Danger Area', color: '#B3261E', symbol: 'triangle-warn' },
  water: { label: 'Water Source', color: '#3E7CB1', symbol: 'droplet' },
  ccp: { label: 'Casualty Collection', color: '#E7E3D3', symbol: 'cross' },
  obj: { label: 'Objective', color: '#D2A02A', symbol: 'star' },
  other: { label: 'Other', color: '#E7E3D3', symbol: 'circle' },
};

// ---------- app state ----------
const state = {
  profile: null,        // current profile record
  image: null,          // HTMLImageElement
  transform: null,      // result of GeoTransform.computeTransform
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  mode: 'none',          // none | calibrate | waypoint | measure | live
  measurePoints: [],
  liveGPS: { active: false, lat: null, lon: null, watchId: null, headingDeg: null },
  lastTapPixel: null,
  reticleAnim: 0,
  pendingCalibPixel: null,
  pendingWaypointPixel: null,
};

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const canvas = $('mapCanvas');
const ctx = canvas.getContext('2d');

// ==================== Profile screen ====================
async function renderProfileList() {
  const list = $('profileList');
  list.innerHTML = '';
  const profiles = await idbGetAll();
  profiles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (profiles.length === 0) {
    list.innerHTML = '<div class="empty-hint">No saved maps yet. Add a photo of a map to get started.</div>';
    return;
  }
  for (const p of profiles) {
    const el = document.createElement('div');
    el.className = 'profile-item';
    const cpCount = (p.controlPoints || []).length;
    const status = cpCount >= 2 ? `calibrated (${cpCount} pts)` : 'not calibrated';
    el.innerHTML = `
      <div class="profile-item-main">
        <div class="profile-name">${escapeHTML(p.name)}</div>
        <div class="profile-meta">${status} &middot; ${(p.waypoints || []).length} waypoints</div>
      </div>
      <button class="btn-icon profile-delete" title="Delete">&times;</button>
    `;
    el.querySelector('.profile-item-main').addEventListener('click', () => openProfile(p.id));
    el.querySelector('.profile-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete map "${p.name}"? This cannot be undone.`)) {
        await idbDelete(p.id);
        renderProfileList();
      }
    });
    list.appendChild(el);
  }
}
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('newMapBtn').addEventListener('click', () => $('newMapFileInput').click());
$('newMapFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const name = prompt('Name this map (e.g. "Blue Ridge East 1:24k")', file.name.replace(/\.[^.]+$/, '')) || 'Untitled Map';
  const profile = {
    id: uuid(), name, imageBlob: file, controlPoints: [], waypoints: [],
    declination: null, refZone: null, refHemisphere: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await idbPut(profile);
  e.target.value = '';
  openProfile(profile.id);
});

$('importBtn').addEventListener('click', () => $('importFileInput').click());
$('importFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const blob = await (await fetch(data.imageDataURL)).blob();
    const profile = {
      id: uuid(), name: data.name + ' (imported)', imageBlob: blob,
      controlPoints: data.controlPoints || [], waypoints: data.waypoints || [],
      declination: data.declination || null, refZone: data.refZone || null,
      refHemisphere: data.refHemisphere || null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await idbPut(profile);
    renderProfileList();
    alert(`Imported "${profile.name}"`);
  } catch (err) {
    alert('Could not import file: ' + err.message);
  }
  e.target.value = '';
});

// ==================== Open a profile / map screen ====================
async function openProfile(id) {
  const profiles = await idbGetAll();
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  state.profile = p;
  const url = URL.createObjectURL(p.imageBlob);
  const img = new Image();
  img.onload = () => {
    state.image = img;
    fitImageToView();
    recomputeTransform();
    $('profileScreen').hidden = true;
    $('mapScreen').hidden = false;
    $('mapTitle').textContent = p.name;
    setMode('none');
    draw();
  };
  img.src = url;
}

function backToProfiles() {
  if (state.liveGPS.watchId !== null) navigator.geolocation.clearWatch(state.liveGPS.watchId);
  state.liveGPS = { active: false, lat: null, lon: null, watchId: null, headingDeg: null };
  state.profile = null;
  state.image = null;
  state.transform = null;
  $('mapScreen').hidden = true;
  $('profileScreen').hidden = false;
  renderProfileList();
}
$('backBtn').addEventListener('click', backToProfiles);

async function saveProfile() {
  state.profile.updatedAt = Date.now();
  await idbPut(state.profile);
}

// ==================== canvas view / rendering ====================
function resizeCanvas() {
  const wrap = $('canvasWrap');
  canvas.width = wrap.clientWidth * devicePixelRatio;
  canvas.height = wrap.clientHeight * devicePixelRatio;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  draw();
}
window.addEventListener('resize', resizeCanvas);

function fitImageToView() {
  const wrap = $('canvasWrap');
  const cw = wrap.clientWidth || 400, ch = wrap.clientHeight || 400;
  const s = Math.min(cw / state.image.width, ch / state.image.height) * 0.95;
  state.view.scale = s;
  state.view.offsetX = (cw - state.image.width * s) / 2;
  state.view.offsetY = (ch - state.image.height * s) / 2;
}

function screenToImage(sx, sy) {
  return { x: (sx - state.view.offsetX) / state.view.scale, y: (sy - state.view.offsetY) / state.view.scale };
}
function imageToScreen(ix, iy) {
  return { x: ix * state.view.scale + state.view.offsetX, y: iy * state.view.scale + state.view.offsetY };
}

function recomputeTransform() {
  const cps = state.profile.controlPoints;
  if (cps.length >= 2) {
    try {
      state.transform = GeoTransform.computeTransform(cps);
    } catch (err) {
      state.transform = null;
      console.error(err);
    }
  } else {
    state.transform = null;
  }
  updateCalibBadge();
}

function updateCalibBadge() {
  const badge = $('calibBadge');
  if (!state.transform) {
    badge.textContent = `Not calibrated (${state.profile.controlPoints.length}/4 pts)`;
    badge.className = 'calib-badge calib-bad';
  } else {
    const acc = state.transform.rmsResidual;
    badge.textContent = `${state.transform.method} \u00B7 \u00B1${acc.toFixed(1)}m`;
    badge.className = acc > 30 ? 'calib-badge calib-warn' : 'calib-badge calib-good';
  }
}

function draw() {
  const dpr = devicePixelRatio;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0C0F0A';
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  if (state.image) {
    const p0 = imageToScreen(0, 0);
    ctx.drawImage(state.image, p0.x, p0.y, state.image.width * state.view.scale, state.image.height * state.view.scale);
  }
  // control points
  state.profile.controlPoints.forEach((cp, i) => {
    const s = imageToScreen(cp.px, cp.py);
    drawReticle(s.x, s.y, '#D2A02A', String(i + 1));
  });
  // waypoints
  (state.profile.waypoints || []).forEach((wp) => {
    const s = imageToScreen(wp.px, wp.py);
    drawWaypointMarker(s.x, s.y, wp.category);
  });
  // measurement
  if (state.measurePoints.length > 0) {
    const s0 = imageToScreen(state.measurePoints[0].px, state.measurePoints[0].py);
    drawReticle(s0.x, s0.y, '#3E7CB1', 'A');
    if (state.measurePoints.length > 1) {
      const s1 = imageToScreen(state.measurePoints[1].px, state.measurePoints[1].py);
      drawReticle(s1.x, s1.y, '#3E7CB1', 'B');
      ctx.strokeStyle = '#3E7CB1';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // live GPS blip
  if (state.liveGPS.active && state.liveGPS.lat != null && state.transform && state.profile.refZone) {
    const utm = GeoConv.latLonToUTM(state.liveGPS.lat, state.liveGPS.lon, state.profile.refZone);
    const px = state.transform.utmToPixel(utm.easting, utm.northing);
    const s = imageToScreen(px.x, px.y);
    drawLiveBlip(s.x, s.y);
  }
  ctx.restore();
}

function drawReticle(x, y, color, label) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  const r = 12;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  // corner ticks
  [0, 90, 180, 270].forEach((deg) => {
    const a = (deg * Math.PI) / 180;
    const x1 = x + Math.cos(a) * (r + 3), y1 = y + Math.sin(a) * (r + 3);
    const x2 = x + Math.cos(a) * (r + 8), y2 = y + Math.sin(a) * (r + 8);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });
  if (label) {
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#0C0F0A';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = '#0C0F0A';
    ctx.fillText(label, x, y + 1);
  }
}

function drawWaypointMarker(x, y, catKey) {
  const cat = CATEGORIES[catKey] || CATEGORIES.other;
  ctx.fillStyle = cat.color;
  ctx.strokeStyle = '#0C0F0A';
  ctx.lineWidth = 1.5;
  const s = 10;
  ctx.beginPath();
  if (cat.symbol === 'triangle' || cat.symbol === 'triangle-warn') {
    ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s); ctx.lineTo(x - s, y + s); ctx.closePath();
  } else if (cat.symbol === 'droplet') {
    ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x + s, y + s * 0.6, x, y + s); ctx.quadraticCurveTo(x - s, y + s * 0.6, x, y - s);
  } else if (cat.symbol === 'star') {
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? s : s * 0.45;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (cat.symbol === 'cross') {
    ctx.rect(x - 3, y - s, 6, s * 2); ctx.rect(x - s, y - 3, s * 2, 6);
  } else {
    ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
  }
  ctx.fill(); ctx.stroke();
}

function drawLiveBlip(x, y) {
  const t = performance.now() / 500;
  const pulse = 8 + Math.sin(t) * 3;
  ctx.strokeStyle = '#3E7CB1';
  ctx.beginPath(); ctx.arc(x, y, pulse + 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#3E7CB1';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
}

function animLoop() { draw(); requestAnimationFrame(animLoop); }
requestAnimationFrame(animLoop);

// ==================== pointer / gesture handling ====================
let pointers = new Map();
let gesture = { dragging: false, startScreen: null, startView: null, pinchStartDist: null, pinchStartScale: null };

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture.dragging = true;
    gesture.startScreen = { x: e.clientX, y: e.clientY };
    gesture.startView = { ...state.view };
    gesture.moved = false;
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    gesture.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    gesture.pinchStartScale = state.view.scale;
    gesture.pinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    gesture.pinchStartView = { ...state.view };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && gesture.dragging) {
    const dx = e.clientX - gesture.startScreen.x, dy = e.clientY - gesture.startScreen.y;
    if (Math.hypot(dx, dy) > 6) gesture.moved = true;
    state.view.offsetX = gesture.startView.offsetX + dx;
    state.view.offsetY = gesture.startView.offsetY + dy;
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const scaleFactor = dist / gesture.pinchStartDist;
    state.view.scale = gesture.pinchStartScale * scaleFactor;
    const rect = canvas.getBoundingClientRect();
    const midImg = screenToImage(gesture.pinchMid.x - rect.left, gesture.pinchMid.y - rect.top);
    const newMid = imageToScreen(midImg.x, midImg.y);
    state.view.offsetX += gesture.pinchMid.x - rect.left - newMid.x;
    state.view.offsetY += gesture.pinchMid.y - rect.top - newMid.y;
  }
});
function endPointer(e) {
  const wasSingle = pointers.size === 1;
  const tapValid = wasSingle && gesture.dragging && !gesture.moved;
  pointers.delete(e.pointerId);
  if (tapValid) {
    const rect = canvas.getBoundingClientRect();
    const img = screenToImage(e.clientX - rect.left, e.clientY - rect.top);
    handleTap(img.x, img.y);
  }
  if (pointers.size === 0) gesture.dragging = false;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const before = screenToImage(e.clientX - rect.left, e.clientY - rect.top);
  state.view.scale *= e.deltaY < 0 ? 1.1 : 0.9;
  const after = imageToScreen(before.x, before.y);
  state.view.offsetX += (e.clientX - rect.left) - after.x;
  state.view.offsetY += (e.clientY - rect.top) - after.y;
}, { passive: false });

// ==================== tap handling per mode ====================
function handleTap(ix, iy) {
  if (state.mode === 'calibrate') {
    state.pendingCalibPixel = { px: ix, py: iy };
    openCalibModal();
  } else if (state.mode === 'waypoint') {
    if (!state.transform) { alert('Add at least 2 calibration points before placing waypoints.'); return; }
    state.pendingWaypointPixel = { px: ix, py: iy };
    openWaypointModal();
  } else if (state.mode === 'measure') {
    if (!state.transform) { alert('Add at least 2 calibration points before measuring.'); return; }
    if (state.measurePoints.length >= 2) state.measurePoints = [];
    state.measurePoints.push({ px: ix, py: iy });
    if (state.measurePoints.length === 2) showMeasurementResult();
    else $('measureHint').textContent = 'Tap the second point.';
  }
}

// ==================== mode / toolbar ====================
function setMode(mode) {
  state.mode = mode;
  ['calibrate', 'waypoint', 'measure', 'live'].forEach((m) => $(`mode-${m}`).classList.toggle('active', m === mode));
  $('measurePanel').hidden = mode !== 'measure';
  if (mode !== 'measure') state.measurePoints = [];
  if (mode === 'measure') $('measureHint').textContent = 'Tap the first point.';
  $('livePanel').hidden = mode !== 'live';
}
$('mode-calibrate').addEventListener('click', () => setMode(state.mode === 'calibrate' ? 'none' : 'calibrate'));
$('mode-waypoint').addEventListener('click', () => setMode(state.mode === 'waypoint' ? 'none' : 'waypoint'));
$('mode-measure').addEventListener('click', () => setMode(state.mode === 'measure' ? 'none' : 'measure'));
$('mode-live').addEventListener('click', () => setMode(state.mode === 'live' ? 'none' : 'live'));

// ==================== calibration modal ====================
function openCalibModal() {
  $('calibMgrsInput').value = '';
  $('calibError').textContent = '';
  $('calibModal').hidden = false;
  $('calibMgrsInput').focus();
}
$('calibCancelBtn').addEventListener('click', () => { $('calibModal').hidden = true; });
$('calibConfirmBtn').addEventListener('click', async () => {
  const raw = $('calibMgrsInput').value.trim();
  try {
    const parsed = GeoConv.parseMGRS(raw);
    let refZone = state.profile.refZone, refHemisphere = state.profile.refHemisphere;
    let e = parsed.easting, n = parsed.northing;
    if (state.profile.controlPoints.length === 0) {
      refZone = parsed.zone; refHemisphere = parsed.hemisphere;
      state.profile.refZone = refZone; state.profile.refHemisphere = refHemisphere;
    } else {
      if (parsed.hemisphere !== refHemisphere) throw new Error('Point falls in a different hemisphere than your first control point.');
      const utm = GeoConv.latLonToUTM(parsed.lat, parsed.lon, refZone);
      e = utm.easting; n = utm.northing;
    }
    state.profile.controlPoints.push({ px: state.pendingCalibPixel.px, py: state.pendingCalibPixel.py, e, n, mgrs: raw.toUpperCase() });
    recomputeTransform();
    await saveProfile();
    $('calibModal').hidden = true;
    draw();
  } catch (err) {
    $('calibError').textContent = err.message;
  }
});
$('calibListBtn').addEventListener('click', () => {
  const cps = state.profile.controlPoints;
  if (cps.length === 0) { alert('No control points yet.'); return; }
  const lines = cps.map((cp, i) => {
    const res = state.transform ? state.transform.residuals[i] : null;
    return `${i + 1}. ${cp.mgrs}${res != null ? `  (residual ${res.toFixed(1)}m)` : ''}`;
  });
  if (confirm(lines.join('\n') + '\n\nRemove the last control point?')) {
    cps.pop();
    recomputeTransform();
    saveProfile();
    draw();
  }
});

// ==================== waypoint modal ====================
function populateCategorySelect() {
  const sel = $('waypointCategory');
  sel.innerHTML = '';
  Object.entries(CATEGORIES).forEach(([key, cat]) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = cat.label;
    sel.appendChild(opt);
  });
}
populateCategorySelect();

function openWaypointModal() {
  $('waypointName').value = '';
  $('waypointNotes').value = '';
  $('waypointCategory').value = 'other';
  const utm = state.transform.pixelToUTM(state.pendingWaypointPixel.px, state.pendingWaypointPixel.py);
  const ll = GeoConv.utmToLatLon(utm.x, utm.y, state.profile.refZone, state.profile.refHemisphere);
  const mgrs = GeoConv.toMGRS(ll.lat, ll.lon);
  $('waypointCoordPreview').textContent = mgrs;
  state.pendingWaypointCoord = { lat: ll.lat, lon: ll.lon, mgrs };
  $('waypointModal').hidden = false;
  $('waypointName').focus();
}
$('waypointCancelBtn').addEventListener('click', () => { $('waypointModal').hidden = true; });
$('waypointConfirmBtn').addEventListener('click', async () => {
  const wp = {
    id: uuid(),
    name: $('waypointName').value.trim() || 'Unnamed',
    category: $('waypointCategory').value,
    notes: $('waypointNotes').value.trim(),
    px: state.pendingWaypointPixel.px, py: state.pendingWaypointPixel.py,
    lat: state.pendingWaypointCoord.lat, lon: state.pendingWaypointCoord.lon,
    mgrs: state.pendingWaypointCoord.mgrs, timestamp: Date.now(),
  };
  state.profile.waypoints.push(wp);
  await saveProfile();
  $('waypointModal').hidden = true;
  draw();
});

// ==================== waypoint list panel ====================
$('waypointListBtn').addEventListener('click', () => {
  const panel = $('waypointListPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderWaypointList();
});
function renderWaypointList() {
  const container = $('waypointListItems');
  container.innerHTML = '';
  const wps = state.profile.waypoints || [];
  if (wps.length === 0) { container.innerHTML = '<div class="empty-hint">No waypoints yet.</div>'; return; }
  wps.slice().reverse().forEach((wp) => {
    const cat = CATEGORIES[wp.category] || CATEGORIES.other;
    const el = document.createElement('div');
    el.className = 'wp-item';
    el.innerHTML = `
      <div class="wp-swatch" style="background:${cat.color}"></div>
      <div class="wp-main">
        <div class="wp-name">${escapeHTML(wp.name)}</div>
        <div class="wp-mgrs">${wp.mgrs}</div>
        ${wp.notes ? `<div class="wp-notes">${escapeHTML(wp.notes)}</div>` : ''}
      </div>
      <button class="btn-icon wp-delete">&times;</button>
    `;
    el.querySelector('.wp-main').addEventListener('click', () => {
      const s = imageToScreen(wp.px, wp.py);
      centerOn(wp.px, wp.py);
    });
    el.querySelector('.wp-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.profile.waypoints = state.profile.waypoints.filter((x) => x.id !== wp.id);
      await saveProfile();
      renderWaypointList();
      draw();
    });
    container.appendChild(el);
  });
}
function centerOn(ix, iy) {
  const wrap = $('canvasWrap');
  state.view.offsetX = wrap.clientWidth / 2 - ix * state.view.scale;
  state.view.offsetY = wrap.clientHeight / 2 - iy * state.view.scale;
  draw();
}

// ==================== measurement ====================
function showMeasurementResult() {
  const [a, b] = state.measurePoints;
  const utmA = state.transform.pixelToUTM(a.px, a.py);
  const utmB = state.transform.pixelToUTM(b.px, b.py);
  const dist = distanceBetween(utmA.x, utmA.y, utmB.x, utmB.y);
  const gridAz = gridAzimuthBetween(utmA.x, utmA.y, utmB.x, utmB.y);
  const back = backAzimuth(gridAz);
  const decl = state.profile.declination;
  const magAz = decl ? gridToMag(gridAz, decl) : null;

  $('measureHint').textContent = '';
  $('measureDistance').textContent = `${dist.toFixed(0)} m  (${(dist / 1000).toFixed(2)} km, ${(dist * 1.09361).toFixed(0)} yd)`;
  $('measureGridAz').textContent = `${gridAz.toFixed(1)}\u00B0`;
  $('measureMagAz').textContent = magAz != null ? `${magAz.toFixed(1)}\u00B0` : 'set declination in Settings';
  $('measureBackAz').textContent = `${back.toFixed(1)}\u00B0`;
}
$('measureClearBtn').addEventListener('click', () => {
  state.measurePoints = [];
  $('measureHint').textContent = 'Tap the first point.';
  $('measureDistance').textContent = '\u2014';
  $('measureGridAz').textContent = '\u2014';
  $('measureMagAz').textContent = '\u2014';
  $('measureBackAz').textContent = '\u2014';
  draw();
});

// ==================== live GPS / compass ====================
$('liveGpsToggle').addEventListener('click', () => {
  if (!state.liveGPS.active) {
    if (!navigator.geolocation) { alert('Geolocation not available on this device/browser.'); return; }
    state.liveGPS.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.liveGPS.lat = pos.coords.latitude;
        state.liveGPS.lon = pos.coords.longitude;
        const mgrs = GeoConv.toMGRS(pos.coords.latitude, pos.coords.longitude);
        $('liveMgrs').textContent = mgrs + ` (\u00B1${Math.round(pos.coords.accuracy)}m)`;
      },
      (err) => { $('liveMgrs').textContent = 'GPS error: ' + err.message; },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    state.liveGPS.active = true;
    $('liveGpsToggle').textContent = 'Stop GPS';
  } else {
    navigator.geolocation.clearWatch(state.liveGPS.watchId);
    state.liveGPS.active = false;
    state.liveGPS.lat = null;
    $('liveGpsToggle').textContent = 'Start GPS';
    $('liveMgrs').textContent = '\u2014';
  }
});

$('liveCompassToggle').addEventListener('click', async () => {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') { alert('Compass permission was not granted.'); return; }
    } catch (err) { alert('This device requires HTTPS (not a local file) to allow compass access.'); return; }
  }
  window.addEventListener('deviceorientation', onOrientation, true);
  $('liveCompassToggle').textContent = 'Compass active';
  $('liveCompassToggle').disabled = true;
});
function onOrientation(e) {
  let heading = null;
  if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading; // iOS: true magnetic heading
  else if (e.alpha != null) heading = normAz(360 - e.alpha); // Android best-effort
  if (heading != null) $('liveHeading').textContent = `${heading.toFixed(0)}\u00B0 (verify against a known bearing)`;
}

// ==================== settings / declination ====================
$('settingsBtn').addEventListener('click', () => {
  const decl = state.profile.declination;
  $('declValue').value = decl ? decl.value : '';
  $('declDir').value = decl ? decl.dir : 'W';
  $('settingsModal').hidden = false;
});
$('settingsCloseBtn').addEventListener('click', () => { $('settingsModal').hidden = true; });
$('declSaveBtn').addEventListener('click', async () => {
  const v = parseFloat($('declValue').value);
  if (isNaN(v)) { state.profile.declination = null; }
  else { state.profile.declination = { value: Math.abs(v), dir: $('declDir').value }; }
  await saveProfile();
  $('settingsModal').hidden = true;
  if (state.measurePoints.length === 2) showMeasurementResult();
});
$('nightModeToggle').addEventListener('change', (e) => {
  document.body.classList.toggle('night-mode', e.target.checked);
});
$('renameMapBtn').addEventListener('click', async () => {
  const name = prompt('Rename map', state.profile.name);
  if (name) { state.profile.name = name; await saveProfile(); $('mapTitle').textContent = name; }
});
$('exportMapBtn').addEventListener('click', async () => {
  const reader = new FileReader();
  reader.onload = () => {
    const data = {
      name: state.profile.name, imageDataURL: reader.result,
      controlPoints: state.profile.controlPoints, waypoints: state.profile.waypoints,
      declination: state.profile.declination, refZone: state.profile.refZone, refHemisphere: state.profile.refHemisphere,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.profile.name.replace(/[^a-z0-9]/gi, '_') + '.landnav.json';
    a.click();
  };
  reader.readAsDataURL(state.profile.imageBlob);
});

// ==================== boot ====================
resizeCanvas();
renderProfileList();
