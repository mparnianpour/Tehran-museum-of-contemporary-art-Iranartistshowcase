// UI for setup.html: photo -> corners -> size -> look -> compile -> save/test.

import { SETUP_DEFAULTS, fetchJSON, setupUrl } from './config.js';
import { saveLocalSetup, listLocalSetups, deleteLocalSetup } from './local-store.js';
import { TagDetector } from './tag-detector.js';
import {
  RATIO_PRESETS, estimateQuadAspect, isValidQuad, computeLayout, maxMargin, warpToTarget,
  compileTarget, trackingQuality, canvasToBlob, slugify, buildSetupJson, makeZip, formatJson,
  flattenOpening, tagsToTarget,
} from './setup-core.js';

const $ = (id) => document.getElementById(id);
const PHOTO_MAX = 2400;
const HANDLE_LABELS = ['TL', 'TR', 'BR', 'BL'];

const st = {
  photo: null, // working copy of the photo (canvas)
  photoBlob: null,
  corners: null, // opening corners in photo pixels: TL, TR, BR, BL
  selected: 0,
  margin: 0.12,
  marginMax: 0.6,
  bleed: 0,
  shadow: 0.35,
  exposure: 1,
  view: 'photo',
  layout: null,
  target: null,
  compiled: null, // { buffer, points, key }
  ignoreInside: true, // flatten the opening so what's inside the frame can't affect tracking
  tagsOnly: false, // plain surface: hold the picture with AprilTags only
  tagsOnlyTouched: false, // the user set it, so don't change it automatically
  photoTags: [], // AprilTags found in the photo: [{ id, corners }] in photo pixels
  tags: [], // the same tags in tracking-image pixels (on the wall plane)
  drag: null,
  art: null,
};
window.setupTool = { state: st, setCorners, loadPhotoFromUrl, compile, setSize, setMargin, makeZipBlob };

const canvas = $('stage-canvas');
const ctx = canvas.getContext('2d');

init();

function init() {
  $('photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadPhotoFromUrl(URL.createObjectURL(file)).catch((err) => toast(err.message));
    e.target.value = '';
  });
  $('existing-load').addEventListener('click', () => loadExisting($('existing-id').value.trim()));
  $('existing-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadExisting(e.target.value.trim()); });
  $('corners-reset').addEventListener('click', () => { resetCorners(); changed(); });

  for (const preset of RATIO_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = preset.label;
    b.addEventListener('click', () => setSize(preset.w, preset.h));
    $('ratio-chips').appendChild(b);
  }
  for (const id of ['size-w', 'size-h']) $(id).addEventListener('input', () => changed());

  bindSlider('margin', (v) => { st.margin = v; changed(); });
  $('ignore-inside').addEventListener('change', (e) => { st.ignoreInside = e.target.checked; changed(); });
  $('tag-depth').addEventListener('input', () => { mapTags(); refreshTagNote(); draw(); });
  $('tags-only').addEventListener('change', (e) => { st.tagsOnly = e.target.checked; st.tagsOnlyTouched = true; refreshTagNote(); });
  for (const id of ['occ-left-depth', 'occ-left-overlap', 'occ-right-depth', 'occ-right-overlap']) $(id).addEventListener('input', refreshOccNote);
  bindSlider('bleed', (v) => { st.bleed = v; draw(); });
  bindSlider('shadow', (v) => { st.shadow = v; draw(); });
  bindSlider('exposure', (v) => { st.exposure = v; draw(); });
  $('show-art').addEventListener('change', () => { setView('target'); draw(); });
  $('show-points').addEventListener('change', () => { setView('target'); draw(); });

  $('tab-photo').addEventListener('click', () => setView('photo'));
  $('tab-target').addEventListener('click', () => setView('target'));

  $('compile').addEventListener('click', () => compile().catch((err) => { console.error(err); toast(`Compile failed: ${err.message}`); }));
  $('test-ar').addEventListener('click', () => saveAndOpen(false));
  $('test-preview').addEventListener('click', () => saveAndOpen(true));
  $('download').addEventListener('click', () => download().catch((err) => toast(err.message)));

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey);
  new ResizeObserver(() => draw()).observe($('stage'));

  loadSampleArt();
  refreshSaved();
  refreshUI();
  draw();
}

function bindSlider(id, onInput) {
  const el = $(id);
  el.addEventListener('input', () => { onInput(parseFloat(el.value)); updateOutputs(); });
}

/* ---------- loading ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not open image ${url.startsWith('blob:') ? '' : url}`));
    img.src = url;
  });
}

async function loadPhotoFromUrl(url, corners = null) {
  const img = await loadImage(url);
  const scale = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const cctx = c.getContext('2d');
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(img, 0, 0, c.width, c.height);
  st.photo = c;
  st.photoBlob = await canvasToBlob(c, 'image/jpeg', 0.9);
  st.compiled = null;
  st.photoTags = [];
  detectPhotoTags(c);
  if (corners) st.corners = corners.map(([x, y]) => [x * c.width, y * c.height]);
  else resetCorners();
  setView('photo');
  changed();
}

async function loadExisting(id) {
  if (!id) return toast('Type the setup ID, e.g. frame-01');
  try {
    const url = setupUrl(id);
    const json = await fetchJSON(url);
    const cal = json.calibration;
    if (!cal || !cal.photo || !cal.corners) throw new Error('This setup has no calibration photo, so start from a new photo.');
    if (cal.openingSize && cal.openingSize[0] > 0) setSize(cal.openingSize[0], cal.openingSize[1], false);
    else setSize('', '', false);
    st.margin = cal.margin ?? st.margin;
    st.ignoreInside = cal.ignoreInside ?? false;
    $('ignore-inside').checked = st.ignoreInside;
    for (const side of ['left', 'right']) {
      $(`occ-${side}-depth`).value = cal.sides?.[side]?.depth ?? '';
      $(`occ-${side}-overlap`).value = cal.sides?.[side]?.overlap ?? '';
    }
    st.tagsOnly = json.tracking?.image === false;
    st.tagsOnlyTouched = true;
    $('tags-only').checked = st.tagsOnly;
    $('tag-depth').value = cal.tagDepth ?? '';
    st.bleed = json.bleed ?? 0;
    st.shadow = json.innerShadow?.strength ?? st.shadow;
    st.exposure = json.exposure ?? 1;
    $('margin').value = st.margin;
    $('bleed').value = st.bleed;
    $('shadow').value = st.shadow;
    $('exposure').value = st.exposure;
    $('setup-id').value = slugify(id.replace(/^.*setups\//, '').replace(/\/setup\.json$/, ''));
    $('setup-name').value = json.name || '';
    await loadPhotoFromUrl(new URL(cal.photo, url).href, cal.corners);
    toast(`Loaded "${json.name || id}". Adjust it, then compile again.`);
  } catch (err) {
    toast(err.message);
  }
}

async function loadSampleArt() {
  try {
    const show = await fetchJSON('slideshow.json');
    const first = (Array.isArray(show) ? show : show.slides)?.[0];
    const src = typeof first === 'string' ? first : first?.src;
    if (src) st.art = await loadImage(new URL(src, new URL('slideshow.json', location.href)).href);
  } catch (err) {
    console.warn('No sample artwork:', err.message);
  }
  if (!st.art) {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 600;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 400, 600);
    grad.addColorStop(0, '#2b5876');
    grad.addColorStop(1, '#c97b4a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 400, 600);
    st.art = c;
  }
  draw();
}

/* ---------- state changes ---------- */

function resetCorners() {
  if (!st.photo) return;
  const { width: w, height: h } = st.photo;
  st.corners = [[w * 0.25, h * 0.2], [w * 0.75, h * 0.2], [w * 0.75, h * 0.8], [w * 0.25, h * 0.8]];
}

function setCorners(corners) {
  st.corners = corners.map((p) => [...p]);
  changed();
}

function setSize(w, h, notify = true) {
  $('size-w').value = w === '' ? '' : String(Math.round(w * 1000) / 1000);
  $('size-h').value = h === '' ? '' : String(Math.round(h * 1000) / 1000);
  if (notify) changed();
}

function setMargin(m) {
  $('margin').value = m;
  st.margin = m;
  changed();
}

function measuredSize() {
  const w = parseFloat($('size-w').value);
  const h = parseFloat($('size-h').value);
  return w > 0 && h > 0 ? [w, h] : null;
}

function cornersValid() {
  return !!(st.corners && isValidQuad(st.corners));
}

function aspect() {
  const size = measuredSize();
  return size ? size[0] / size[1] : estimateQuadAspect(st.corners);
}

function compileKey() {
  return JSON.stringify([st.corners?.map((p) => p.map((v) => v.toFixed(2))), aspect().toFixed(5), st.margin.toFixed(4), st.ignoreInside]);
}

let rebuildTimer = 0;

/** Something geometric changed: rebuild the straightened image (debounced). */
function changed() {
  st.target = null;
  st.layout = null;
  st.tags = [];
  refreshUI();
  draw();
  clearTimeout(rebuildTimer);
  if (!st.drag) rebuildTimer = setTimeout(rebuildTarget, 120);
}

function rebuildTarget() {
  if (!st.photo || !cornersValid()) return;
  const a = aspect();
  st.marginMax = maxMargin({ corners: st.corners, aspect: a }, st.photo.width, st.photo.height);
  const margin = Math.min(st.margin, st.marginMax);
  st.layout = computeLayout({ corners: st.corners, aspect: a, margin });
  st.layout.margin = margin;
  st.target = warpToTarget(st.photo, st.layout);
  if (st.ignoreInside) flattenOpening(st.target, st.layout);
  mapTags();
  refreshTagNote();
  refreshUI();
  draw();
}

let tagDetector = null;

/** Find printed AprilTags anywhere in the photo: inside the frame or on the wall around it. */
async function detectPhotoTags(photo) {
  tagDetector ||= new TagDetector({ maxSize: 2400, maxScale: 1.5 });
  let res = null;
  for (let tries = 0; tries < 20 && !res; tries++) {
    res = await tagDetector.detect(photo);
    if (!res) await new Promise((r) => setTimeout(r, 150)); // detector busy with a previous photo
  }
  if (!res || photo !== st.photo) return;
  const scale = photo.width / res.width;
  st.photoTags = res.markers.filter((m) => m.refined).map((m) => ({ id: m.id, corners: m.corners.map(([x, y]) => [x * scale, y * scale]) }));
  mapTags();
  refreshTagNote();
  draw();
}

/** Pillars / side walls entered in step 6, in the units of the measured size. */
function sideInputs() {
  const num = (id) => { const v = parseFloat($(id).value); return v > 0 ? v : 0; };
  const sides = {};
  for (const side of ['left', 'right']) {
    const depth = num(`occ-${side}-depth`);
    if (depth > 0) sides[side] = { depth, overlap: num(`occ-${side}-overlap`) };
  }
  return sides;
}

/** Boxes (tracking-image px) for the viewer to hide the picture behind. Needs the measured size. */
function occluderBoxes() {
  const sides = sideInputs();
  const size = measuredSize();
  if (!size || !st.layout || !Object.keys(sides).length) return [];
  const k = st.layout.openingWidth / size[0]; // px per unit
  const [[ox0, oy0], , [ox1, oy1]] = st.layout.opening;
  const ow = st.layout.openingWidth;
  const oh = st.layout.openingHeight;
  const far = 10; // "floor to ceiling" and "far out to the side": much bigger than the picture
  const out = [];
  if (sides.left) out.push({ box: [ox0 - far * ow, oy0 - far * oh, ox0 + sides.left.overlap * k, oy1 + far * oh], near: sides.left.depth * k, far: 0 });
  if (sides.right) out.push({ box: [ox1 - sides.right.overlap * k, oy0 - far * oh, ox1 + far * ow, oy1 + far * oh], near: sides.right.depth * k, far: 0 });
  return out;
}

function refreshOccNote() {
  const sides = Object.keys(sideInputs());
  const note = $('occ-note');
  if (sides.length && !measuredSize()) note.innerHTML = '<b class="poor">Enter the size in step 3</b> so these distances can be used.';
  else if (sides.length) note.textContent = `The ${sides.join(' and ')} side${sides.length > 1 ? 's' : ''} will hide the picture when seen from an angle.`;
  else note.textContent = '"Covers the edge" is how much of the picture it hides when seen straight on; usually 0.';
}

/** How far the tags' wall is behind the opening's edge, in tracking-image pixels (0 if unknown). */
function wallOffsetPx() {
  const depth = parseFloat($('tag-depth').value);
  const size = measuredSize();
  if (!(depth > 0) || !size || !st.layout) return 0;
  return (depth / size[0]) * st.layout.openingWidth;
}

function mapTags() {
  st.tags = st.layout && st.photoTags.length
    ? tagsToTarget(st.photoTags, st.layout, [st.photo.width, st.photo.height], wallOffsetPx())
    : [];
}

function refreshTagNote() {
  const note = $('tag-note');
  const depth = parseFloat($('tag-depth').value);
  if (st.photoTags.length) {
    const ids = st.photoTags.map((t) => t.id).join(', ');
    let extra = st.tagsOnly ? ' They will hold the picture on their own.' : ' They will hold the picture when visitors look from the side.';
    if (depth > 0 && !measuredSize()) extra = ' <b class="poor">Enter the opening size in step 3</b> so the frame depth can be used.';
    note.innerHTML = `<b class="good">AprilTag ${ids} found.</b>${extra}`;
  } else if (st.tagsOnly) {
    note.innerHTML = '<b class="poor">No AprilTag in this photo.</b> With tags only, the tags must be in the setup photo: put them up and take the photo again. <a href="apriltag.html" target="_blank">Print tags</a>.';
  } else {
    note.innerHTML = 'No AprilTag in this photo. That\'s fine: tags put up later are learned by the viewer once a phone recognises the frame from the front. <a href="apriltag.html" target="_blank">Print tags</a>.';
  }
  note.classList.toggle('hidden', !st.photo);
}

function refreshUI() {
  const hasPhoto = !!st.photo;
  const valid = hasPhoto && cornersValid();
  const compiledFresh = !!(st.compiled && valid && st.compiled.key === compileKey());
  for (const step of document.querySelectorAll('.step[data-needs]')) {
    const need = step.dataset.needs;
    const ok = need === 'photo' ? hasPhoto : need === 'corners' ? valid : compiledFresh;
    step.classList.toggle('disabled', !ok);
  }
  $('stage-empty').classList.toggle('hidden', hasPhoto);
  $('corners-warning').classList.toggle('hidden', !hasPhoto || valid);
  $('tab-target').disabled = !valid;
  if (!valid && st.view === 'target') setView('photo');

  if (valid) {
    const size = measuredSize();
    const a = aspect();
    $('aspect-note').textContent = size
      ? `Shape ${a.toFixed(3)} (width ÷ height), from your measurements.`
      : `Estimated shape ${a.toFixed(3)} (width ÷ height). Enter measurements for accuracy.`;
  }
  if (st.compiled && valid && !compiledFresh) {
    $('compile-result').innerHTML = 'Settings changed since the last compile, so compile again.';
    $('compile-result').classList.remove('hidden');
  }
  $('show-points-wrap').classList.toggle('hidden', !compiledFresh);
  updateOutputs();
}

function updateOutputs() {
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  const m = Math.min(st.margin, st.marginMax);
  $('margin').max = String(Math.max(0.01, st.marginMax));
  $('margin-out').textContent = st.margin > st.marginMax ? `${pct(m)} (photo limit)` : pct(m);
  $('bleed-out').textContent = `${st.bleed > 0 ? '+' : ''}${pct(st.bleed)}`;
  $('shadow-out').textContent = `${Math.round(st.shadow * 100)}%`;
  $('exposure-out').textContent = `${Math.round(st.exposure * 100)}%`;
}

function setView(view) {
  if (view === 'target' && !cornersValid()) return;
  st.view = view;
  $('tab-photo').setAttribute('aria-selected', String(view === 'photo'));
  $('tab-target').setAttribute('aria-selected', String(view === 'target'));
  $('stage-hint').textContent = !st.photo ? ''
    : view === 'photo' ? 'Drag the handles to the inner corners of the frame opening.'
      : 'This straightened image is what phones recognise. The dashed line is the picture area.';
  draw();
}

/* ---------- drawing ---------- */

function stageSize() {
  const r = $('stage').getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function fitRect(srcW, srcH, pad = 18) {
  const { w, h } = stageSize();
  const s = Math.min((w - pad * 2) / srcW, (h - pad * 2) / srcH);
  return { s, ox: (w - srcW * s) / 2, oy: (h - srcH * s) / 2 };
}

function draw() {
  const { w, h } = stageSize();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!st.photo) return;
  if (st.view === 'target' && st.target) drawTarget();
  else drawPhoto();
}

function accent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d8b06a';
}

function drawPhoto() {
  const f = fitRect(st.photo.width, st.photo.height);
  ctx.drawImage(st.photo, f.ox, f.oy, st.photo.width * f.s, st.photo.height * f.s);
  if (!st.corners) return;
  const pts = st.corners.map(([x, y]) => [f.ox + x * f.s, f.oy + y * f.s]);
  const color = cornersValid() ? '#ff2bd6' : '#ff5252';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 43, 214, 0.10)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  pts.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = i === st.selected ? 'rgba(255, 43, 214, 0.35)' : 'rgba(0, 0, 0, 0.25)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    const dx = i === 0 || i === 3 ? -22 : 22;
    const dy = i < 2 ? -18 : 24;
    ctx.fillText(HANDLE_LABELS[i], x + dx, y + dy);
  });
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#39ff14';
  ctx.fillStyle = '#39ff14';
  ctx.font = '600 12px system-ui, sans-serif';
  for (const tag of st.photoTags) {
    const q = tag.corners.map(([x, y]) => [f.ox + x * f.s, f.oy + y * f.s]);
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillText(`Tag ${tag.id}`, q[0][0], q[0][1] - 6);
  }
  ctx.restore();
  if (st.drag) drawLoupe(f, st.drag.index);
}

function drawLoupe(f, index) {
  const size = 160;
  const zoom = 4;
  const { w } = stageSize();
  const [cx, cy] = st.corners[index];
  const lx = cx * f.s + f.ox < w / 2 ? w - size - 14 : 14;
  const ly = 14;
  const srcHalf = size / 2 / (f.s * zoom);
  ctx.save();
  ctx.beginPath();
  ctx.arc(lx + size / 2, ly + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(lx, ly, size, size);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(st.photo, cx - srcHalf, cy - srcHalf, srcHalf * 2, srcHalf * 2, lx, ly, size, size);
  ctx.imageSmoothingEnabled = true;
  const k = size / (srcHalf * 2);
  const toLoupe = ([x, y]) => [lx + (x - (cx - srcHalf)) * k, ly + (y - (cy - srcHalf)) * k];
  ctx.beginPath();
  st.corners.map(toLoupe).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = '#ff2bd6';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lx + size / 2, ly + size / 2 - 14);
  ctx.lineTo(lx + size / 2, ly + size / 2 + 14);
  ctx.moveTo(lx + size / 2 - 14, ly + size / 2);
  ctx.lineTo(lx + size / 2 + 14, ly + size / 2);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(lx + size / 2, ly + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawTarget() {
  const t = st.target;
  const L = st.layout;
  const f = fitRect(t.width, t.height);
  ctx.drawImage(t, f.ox, f.oy, t.width * f.s, t.height * f.s);
  const [ox0, oy0] = L.opening[0];
  const ow = L.openingWidth;
  const oh = L.openingHeight;
  const bx = st.bleed * ow;
  const rect = {
    x: f.ox + (ox0 - bx) * f.s,
    y: f.oy + (oy0 - bx) * f.s,
    w: (ow + 2 * bx) * f.s,
    h: (oh + 2 * bx) * f.s,
  };

  if ($('show-art').checked && st.art) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    const aw = st.art.naturalWidth || st.art.width;
    const ah = st.art.naturalHeight || st.art.height;
    const s = Math.max(rect.w / aw, rect.h / ah);
    if ('filter' in ctx) ctx.filter = `brightness(${st.exposure})`;
    ctx.drawImage(st.art, rect.x + (rect.w - aw * s) / 2, rect.y + (rect.h - ah * s) / 2, aw * s, ah * s);
    if ('filter' in ctx) ctx.filter = 'none';
    // Frame shadow, matching the viewer's shader (size is a fraction of the picture height).
    const size = (SETUP_DEFAULTS.innerShadow.size || 0.035) * rect.h;
    const edge = (x0, y0, x1, y1, strength) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(0,0,0,${st.shadow * strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    };
    edge(0, rect.y, 0, rect.y + size * 1.5, 1);
    edge(rect.x, 0, rect.x + size, 0, 0.8);
    edge(rect.x + rect.w, 0, rect.x + rect.w - size, 0, 0.8);
    edge(0, rect.y + rect.h, 0, rect.y + rect.h - size * 0.6, 0.5);
    ctx.restore();
  }

  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ff2bd6';
  ctx.strokeRect(f.ox + ox0 * f.s, f.oy + oy0 * f.s, ow * f.s, oh * f.s);
  ctx.restore();

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#39ff14';
  ctx.fillStyle = '#39ff14';
  ctx.font = '600 12px system-ui, sans-serif';
  for (const tag of st.tags) {
    const pts = tag.corners.map(([x, y]) => [f.ox + x * f.s, f.oy + y * f.s]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillText(`Tag ${tag.id}`, pts[0][0], pts[0][1] - 6);
  }
  ctx.restore();

  const c = st.compiled;
  if (c && c.key === compileKey() && $('show-points').checked) {
    ctx.fillStyle = accent();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    for (const [x, y] of c.points) {
      ctx.beginPath();
      ctx.arc(f.ox + x * f.s, f.oy + y * f.s, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/* ---------- pointer + keyboard ---------- */

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function onPointerDown(e) {
  if (st.view !== 'photo' || !st.corners) return;
  const f = fitRect(st.photo.width, st.photo.height);
  const [px, py] = pointerPos(e);
  const radius = e.pointerType === 'touch' ? 36 : 22;
  let best = -1;
  let bestD = Infinity;
  st.corners.forEach(([x, y], i) => {
    const d = Math.hypot(f.ox + x * f.s - px, f.oy + y * f.s - py);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (bestD > radius) return;
  const [cx, cy] = st.corners[best];
  st.selected = best;
  st.drag = { index: best, pointerId: e.pointerId, offX: f.ox + cx * f.s - px, offY: f.oy + cy * f.s - py };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
  draw();
}

function onPointerMove(e) {
  if (!st.drag || e.pointerId !== st.drag.pointerId) return;
  const f = fitRect(st.photo.width, st.photo.height);
  const [px, py] = pointerPos(e);
  const x = (px + st.drag.offX - f.ox) / f.s;
  const y = (py + st.drag.offY - f.oy) / f.s;
  st.corners[st.drag.index] = [
    Math.min(Math.max(x, 0), st.photo.width),
    Math.min(Math.max(y, 0), st.photo.height),
  ];
  refreshUI();
  draw();
}

function onPointerUp(e) {
  if (!st.drag || e.pointerId !== st.drag.pointerId) return;
  st.drag = null;
  changed();
}

function onKey(e) {
  if (st.view !== 'photo' || !st.corners || e.target.closest('input, textarea, select')) return;
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    const p = st.corners[st.selected];
    st.corners[st.selected] = [p[0] + d[0], p[1] + d[1]];
    changed();
  } else if (e.key === 'Tab' && document.activeElement === document.body) {
    e.preventDefault();
    st.selected = (st.selected + (e.shiftKey ? 3 : 1)) % 4;
    draw();
  }
}

/* ---------- compile + save ---------- */

async function compile() {
  if (!st.target) rebuildTarget();
  if (!st.target) throw new Error('Mark the four corners first.');
  const key = compileKey();
  const btn = $('compile');
  const bar = $('compile-progress');
  btn.disabled = true;
  bar.classList.remove('hidden');
  $('compile-result').classList.add('hidden');
  const started = performance.now();
  try {
    const result = await compileTarget(st.target, (p) => { bar.firstElementChild.style.width = `${p}%`; });
    st.compiled = { ...result, key };
    const q = trackingQuality(result.points.length);
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    if (q.level === 'poor' && !st.tagsOnlyTouched) {
      st.tagsOnly = true;
      $('tags-only').checked = true;
      refreshTagNote();
    }
    $('compile-result').innerHTML = `<b class="${q.level}">${q.label} tracking expected</b>: ${result.points.length} feature points (${secs}s).`
      + (q.level === 'poor'
        ? (st.tagsOnly
          ? ' This surface is too plain for image tracking, so the AprilTags will hold the picture on their own (step 5).'
          : ' Try including more of the frame and wall, better light, or a more detailed backdrop, or use AprilTags only (step 5).')
        : '');
    $('compile-result').classList.remove('hidden');
    if (!$('setup-id').value) $('setup-id').value = `frame-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
    setView('target');
  } finally {
    btn.disabled = false;
    bar.classList.add('hidden');
    bar.firstElementChild.style.width = '0';
    refreshUI();
    draw();
  }
  return st.compiled;
}

function setupIdentity() {
  const id = slugify($('setup-id').value) || 'frame-new';
  $('setup-id').value = id;
  const name = $('setup-name').value.trim() || id;
  return { id, name };
}

function currentSetupJson(name) {
  return buildSetupJson({
    name,
    layout: st.layout,
    aspect: aspect(),
    bleed: st.bleed,
    innerShadow: { strength: st.shadow, size: SETUP_DEFAULTS.innerShadow.size },
    exposure: st.exposure,
    tracking: { ...SETUP_DEFAULTS.tracking, image: !st.tagsOnly },
    calibration: {
      photoSize: [st.photo.width, st.photo.height],
      corners: st.corners,
      openingSize: measuredSize(),
      margin: st.layout.margin,
      ignoreInside: st.ignoreInside,
      tagDepth: parseFloat($('tag-depth').value) > 0 ? parseFloat($('tag-depth').value) : null,
      sides: Object.keys(sideInputs()).length ? sideInputs() : null,
    },
    tags: st.tags,
    wallOffset: wallOffsetPx(),
    occluders: occluderBoxes(),
  });
}

function ensureCompiled() {
  if (!st.compiled || st.compiled.key !== compileKey()) throw new Error('Compile the tracking data first.');
}

async function saveAndOpen(preview) {
  const win = window.open('', '_blank');
  try {
    ensureCompiled();
    const { id, name } = setupIdentity();
    await saveLocalSetup({
      id,
      setup: currentSetupJson(name),
      mind: st.compiled.buffer.slice().buffer,
      target: await canvasToBlob(st.target, 'image/jpeg', 0.92),
      photo: st.photoBlob,
      savedAt: Date.now(),
    });
    refreshSaved();
    const url = `index.html?setup=local:${encodeURIComponent(id)}${preview ? '&preview=1' : ''}`;
    if (win) win.location.href = url;
    else location.href = url;
  } catch (err) {
    if (win) win.close();
    toast(err.message);
  }
}

async function makeZipBlob() {
  ensureCompiled();
  const { id, name } = setupIdentity();
  const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const dir = `setups/${id}/`;
  const zip = makeZip([
    { name: `${dir}setup.json`, data: formatJson(currentSetupJson(name)) },
    { name: `${dir}target.mind`, data: st.compiled.buffer },
    { name: `${dir}target.jpg`, data: await bytes(await canvasToBlob(st.target, 'image/jpeg', 0.92)) },
    { name: `${dir}photo.jpg`, data: await bytes(st.photoBlob) },
  ]);
  return { id, zip };
}

async function download() {
  const { id, zip } = await makeZipBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `setup-${id}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Downloaded setup-${id}.zip`);
}

async function refreshSaved() {
  let list = [];
  try {
    list = await listLocalSetups();
  } catch (err) {
    return;
  }
  const ul = $('saved-list');
  ul.textContent = '';
  $('saved-wrap').classList.toggle('hidden', list.length === 0);
  list.sort((a, b) => b.savedAt - a.savedAt);
  for (const rec of list) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${rec.setup.name} (${rec.id})`;
    const ar = document.createElement('a');
    ar.href = `index.html?setup=local:${encodeURIComponent(rec.id)}`;
    ar.target = '_blank';
    ar.textContent = 'AR';
    const pv = document.createElement('a');
    pv.href = `${ar.href}&preview=1`;
    pv.target = '_blank';
    pv.textContent = 'Preview';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${rec.setup.name}" from this device?`)) return;
      await deleteLocalSetup(rec.id);
      refreshSaved();
    });
    li.append(label, ar, pv, del);
    ul.appendChild(li);
  }
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}
