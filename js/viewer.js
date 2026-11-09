// AR viewer: tracks the physical frame with MindAR and plays the slideshow
// inside its opening. ?preview=1 shows the same picture over the setup photo
// without a camera (for checking alignment and effects on a laptop).

import * as THREE from 'three';
import { loadAppConfig, loadSetup, loadSlideshow, params } from './config.js';
import { createOpeningGeometry, createDebugOutlines, createTagOutlines } from './frame-geometry.js';
import { TrackingFusion } from './tracking-fusion.js';
import { requestMotionPermission, startMotion, gravityInCamera, cameraOrientation } from './gravity.js';
import { createOcclusion, MAX_OCCLUDERS, MAX_EDGES } from './occlusion.js';
import { createSlideshowMaterial, EFFECTS } from './transitions.js';
import { Slideshow } from './slideshow.js';
import { getStrings, applyStrings } from './i18n.js';

const $ = (id) => document.getElementById(id);

const state = {
  cfg: null,
  setup: null,
  show: null,
  lang: 'en',
  strings: getStrings('en'),
  slideshow: null,
  material: null,
  mode: null, // 'ar' | 'preview'
  found: false,
  foundCount: 0,
  fade: { value: 0, target: 0 },
  currentSlide: null,
};
window.frameAR = state; // exposed for debugging in the browser console

main().catch((err) => showError(state.strings.loadError, err));

async function main() {
  const cfg = await loadAppConfig();
  state.cfg = cfg;
  setLanguage(pickLanguage(cfg));
  buildLanguageSwitch();

  const setup = await loadSetup(cfg.setup);
  const slideshowRef = params.has('slideshow') ? cfg.slideshow : setup.slideshowUrl || cfg.slideshow;
  const show = await loadSlideshow(slideshowRef);
  state.setup = setup;
  state.show = show;
  if (setup.previewUrl) $('scan-preview').src = setup.previewUrl;

  buildEffectPicker();
  wireControls();

  if (cfg.preview) return startPreview();
  if (cfg.autostart) return startAR();
  $('start').classList.remove('hidden');
  $('start-button').addEventListener('click', () => startAR(), { once: true });
  $('preview-button').addEventListener('click', () => startPreview(), { once: true });
}

/* ---------- language ---------- */

function pickLanguage(cfg) {
  if (params.has('lang')) return cfg.language;
  try {
    const saved = localStorage.getItem('frame-ar:lang');
    if (saved && cfg.languages.includes(saved)) return saved;
  } catch (err) { /* storage unavailable */ }
  return cfg.language;
}

function setLanguage(lang) {
  state.lang = lang;
  state.strings = getStrings(lang, state.cfg.strings);
  applyStrings(state.strings, lang);
  // Title/subtitle come from config.json, optionally translated via "strings".
  $('title').textContent = state.strings.title || state.cfg.title;
  $('subtitle').textContent = state.strings.subtitle ?? state.cfg.subtitle ?? '';
  document.title = $('title').textContent;
  for (const btn of $('language-switch').children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  }
  if (state.show) buildEffectPicker();
  if (state.currentSlide) updateCaption(state.currentSlide, true);
}

function buildLanguageSwitch() {
  const box = $('language-switch');
  box.textContent = '';
  const langs = state.cfg.languages || [];
  if (langs.length < 2) return;
  for (const lang of langs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.lang = lang;
    btn.textContent = getStrings(lang, state.cfg.strings).languageName || lang;
    btn.setAttribute('aria-pressed', String(lang === state.lang));
    btn.addEventListener('click', () => {
      setLanguage(lang);
      try { localStorage.setItem('frame-ar:lang', lang); } catch (err) { /* ignore */ }
    });
    box.appendChild(btn);
  }
}

/* ---------- picture + slideshow ---------- */

function createPicture(renderer) {
  const { setup, show, cfg } = state;
  const a = setup.openingAspect;
  const b = setup.bleed || 0;
  const meshAspect = (a * (1 + 2 * b)) / (1 + 2 * b * a);
  state.occlusion = createOcclusion(setup, meshAspect);
  const material = createSlideshowMaterial({
    frameAspect: meshAspect,
    background: show.settings.background,
    innerShadow: setup.innerShadow,
    exposure: setup.exposure,
  });
  const mesh = new THREE.Mesh(createOpeningGeometry(setup), material);
  mesh.renderOrder = 1;

  const slideshow = new Slideshow({ material, renderer, slides: show.slides, settings: show.settings });
  slideshow.addEventListener('slidechange', (e) => updateCaption(e.detail));
  slideshow.addEventListener('playstate', (e) => {
    const btn = $('play-button');
    btn.classList.toggle('paused', !e.detail.playing);
    const label = e.detail.playing ? state.strings.pause : state.strings.play;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.dataset.i18nLabel = e.detail.playing ? 'pause' : 'play';
  });
  slideshow.addEventListener('error', (e) => showError(e.detail.message));
  state.material = material;
  state.slideshow = slideshow;

  const group = new THREE.Group();
  group.add(mesh);
  if (cfg.debug) group.add(createDebugOutlines(setup));
  state.pictureGroup = group;
  return group;
}

function setFound(found) {
  state.found = found;
  if (found) {
    state.foundCount += 1;
    state.fade.value = 0;
  }
  state.fade.target = found ? 1 : 0;
  state.slideshow?.setVisible(found);
  refreshCaptionVisibility();
}

function runLoop(renderer, scene, camera, beforeRender) {
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    beforeRender?.(dt);
    state.slideshow.update(dt);
    const fade = state.fade;
    fade.value = fade.target > fade.value ? Math.min(fade.target, fade.value + dt / 0.5) : fade.target;
    state.material.uniforms.uOpacity.value = fade.value;
    renderer.render(scene, camera);
  });
}

/* ---------- AR mode ---------- */

async function fetchBlobUrl(url) {
  if (url.startsWith('blob:')) return url;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load tracking file ${url} (HTTP ${res.status})`);
  return URL.createObjectURL(await res.blob());
}

async function startAR() {
  const { cfg, setup, strings } = state;
  // A single tag holds the picture better when the phone says which way is down. Ask for the
  // motion sensor while still inside the tap (iPhones only allow it then); with two or more
  // tags it isn't needed, so visitors aren't asked.
  const useMotion = setup.apriltag.enabled && setup.apriltag.gravity !== false && (setup.apriltag.tags || []).length === 1;
  if (useMotion) {
    requestMotionPermission();
    startMotion(); // without permission no readings arrive, and tags work as before
  }
  state.mode = 'ar';
  $('start').classList.add('hidden');
  $('loading').classList.remove('hidden');

  if (!window.isSecureContext) return showError(strings.httpsError);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return showError(strings.cameraError);

  let MindARThree;
  let targetSrc;
  try {
    [{ MindARThree }, targetSrc] = await Promise.all([import('mindar-image-three'), fetchBlobUrl(setup.targetUrl)]);
  } catch (err) {
    return showError(strings.loadError, err);
  }

  const t = setup.tracking;
  const mindar = new MindARThree({
    container: $('ar-container'),
    imageTargetSrc: targetSrc,
    maxTrack: 1,
    uiLoading: '#loading',
    uiScanning: 'no', // shown by us, since AprilTags can hold the picture when MindAR can't
    uiError: 'no',
    filterMinCF: t.filterMinCF,
    filterBeta: t.filterBeta,
    warmupTolerance: t.warmupTolerance,
    missTolerance: t.missTolerance,
  });
  state.mindar = mindar;
  const { renderer, scene, camera } = mindar;
  // MindAR's anchor only reports the image-tracking pose; the picture follows the
  // fused pose (image tracking, or AprilTags at steep angles) set every frame.
  const anchor = mindar.addAnchor(0);
  const picture = new THREE.Group();
  picture.matrixAutoUpdate = false;
  picture.visible = false;
  picture.add(createPicture(renderer));
  scene.add(picture);
  if (cfg.debug) startDebugHud(anchor);

  const firstSlide = state.slideshow.start();
  // Tags only: image tracking is paused, so its processing budget is free; ask the phone for an
  // HD camera stream instead, so distant tags are 2-3x larger in pixels and read from further away.
  const md = navigator.mediaDevices;
  const originalGetUserMedia = md.getUserMedia;
  if (setup.tracking.image === false) {
    md.getUserMedia = (c) => originalGetUserMedia.call(md, {
      ...c, video: { ...(typeof c.video === 'object' ? c.video : {}), width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  }
  try {
    await mindar.start();
  } catch (err) {
    return showError(strings.cameraError, err);
  } finally {
    md.getUserMedia = originalGetUserMedia;
  }
  // Plain surfaces: image tracking can't recognise them, so don't spend the
  // phone's processing on it; the AprilTags hold the picture on their own.
  if (setup.tracking.image === false) mindar.controller.stopProcessVideo();

  const fusion = new TrackingFusion({
    mindar, anchor, setup, gravity: useMotion ? gravityInCamera : null, motion: useMotion ? cameraOrientation : null,
  });
  state.fusion = fusion;
  if (cfg.debug) {
    const tagLines = new THREE.Group();
    state.pictureGroup.add(tagLines);
    fusion.addEventListener('tagschange', () => {
      tagLines.clear();
      tagLines.add(createTagOutlines(setup, fusion.tags));
    });
  }
  fusion.start();

  await firstSlide;
  showControls();
  const scanning = $('scanning');
  if (cfg.ui.scanningHint) scanning.classList.remove('hidden');
  const smoothCam = { C: null };
  runLoop(renderer, scene, camera, (dt) => {
    const r = fusion.update(performance.now(), dt * 1000);
    picture.visible = r.visible;
    if (r.visible) picture.matrix.copy(r.matrix);
    if (state.occlusion) updateOcclusion(r.visible, r.camera, smoothCam, dt);
    state.trackingSource = r.source;
    state.viewAngle = r.angle;
    if (r.visible !== state.found) setFound(r.visible);
    if (cfg.ui.scanningHint) scanning.classList.toggle('hidden', r.visible);
  });
}

/** Hide the picture where pillars / walls stand in front of it, from where the phone is now. */
function updateOcclusion(visible, C, smooth, dt) {
  const occ = state.occlusion;
  const u = state.material.uniforms;
  if (!visible) {
    occ.clear();
    smooth.C = null;
  } else if (!C) {
    if (smooth.C) occ.update(smooth.C); // no fresh position this frame: keep the last one
    else occ.clear();
  } else {
    const k = smooth.C ? Math.min(1, dt * 12) : 1; // light smoothing; tag poses arrive in steps
    smooth.C = smooth.C ? smooth.C.map((v, i) => v + (C[i] - v) * k) : [...C];
    occ.update(smooth.C);
  }
  for (let i = 0; i < MAX_OCCLUDERS * MAX_EDGES; i++) u.uOcc.value[i].set(occ.lines[i * 3], occ.lines[i * 3 + 1], occ.lines[i * 3 + 2]);
  for (let k = 0; k < MAX_OCCLUDERS; k++) u.uOccCount.value[k] = occ.counts[k];
  state.occlusionActive = Array.from(occ.counts).some((n) => n > 0);
}

/* ---------- preview mode (no camera) ---------- */

async function startPreview() {
  const { setup } = state;
  state.mode = 'preview';
  $('start').classList.add('hidden');
  $('preview-badge').classList.remove('hidden');

  const container = $('ar-container');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0c);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const world = new THREE.Group();
  scene.add(world);

  const [tw, th] = setup.targetSize;
  const h = th / tw;
  const backdropMaterial = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, h), backdropMaterial);
  backdrop.position.z = -0.001;
  world.add(backdrop);
  if (setup.previewUrl) {
    new THREE.TextureLoader().load(setup.previewUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      backdropMaterial.map = tex;
      backdropMaterial.color.set(0xffffff);
      backdropMaterial.needsUpdate = true;
    });
  }
  world.add(createPicture(renderer));

  // Fit the wall into the space between the badge and the caption/controls.
  const resize = () => {
    const w = window.innerWidth;
    const hh = window.innerHeight;
    renderer.setSize(w, hh);
    camera.aspect = w / hh;
    const top = 48;
    const bottom = (state.cfg.ui.caption ? 92 : 0) + (state.cfg.ui.navigation || state.cfg.ui.effectPicker ? 76 : 0) + 8;
    const avail = Math.max(hh * 0.4, hh - top - bottom);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const margin = 1.06;
    const dist = Math.max(((h * margin) / 2 / tanHalf) * (hh / avail), (1 * margin) / 2 / (tanHalf * camera.aspect));
    const worldPerPx = (2 * dist * tanHalf) / hh;
    camera.position.set(0, -((bottom - top) / 2) * worldPerPx, dist);
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  // Drag or move the pointer to tilt the wall, as if walking around it.
  const tilt = { x: 0, y: 0 };
  container.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' && e.buttons === 0) return;
    tilt.y = (e.clientX / window.innerWidth - 0.5) * 0.6;
    tilt.x = (e.clientY / window.innerHeight - 0.5) * 0.35;
  });
  container.addEventListener('pointerleave', () => { tilt.x = tilt.y = 0; });

  await state.slideshow.start();
  setFound(true);
  showControls();
  runLoop(renderer, scene, camera, (dt) => {
    const k = Math.min(1, dt * 4);
    world.rotation.y += (tilt.y - world.rotation.y) * k;
    world.rotation.x += (tilt.x - world.rotation.x) * k;
  });
}

/* ---------- caption, controls, errors ---------- */

let captionTimer = 0;

function updateCaption(detail, immediate = false) {
  state.currentSlide = detail;
  const { slide, position, total } = detail;
  const loc = (state.lang !== 'en' && slide[state.lang]) || {};
  const title = loc.title ?? slide.title ?? '';
  const meta = [loc.artist ?? slide.artist, loc.year ?? slide.year, loc.medium ?? slide.medium].filter(Boolean).join(' · ');
  const fmt = new Intl.NumberFormat(state.lang);
  const apply = () => {
    $('caption-title').textContent = title;
    $('caption-meta').textContent = meta;
    $('caption-count').textContent = total > 1 ? `${fmt.format(position + 1)} / ${fmt.format(total)}` : '';
    $('caption').dataset.empty = String(!title && !meta);
    $('caption').classList.remove('fading');
    refreshCaptionVisibility();
  };
  clearTimeout(captionTimer);
  if (immediate) return apply();
  $('caption').classList.add('fading');
  captionTimer = setTimeout(apply, 300);
}

function refreshCaptionVisibility() {
  const el = $('caption');
  const show = state.cfg.ui.caption && state.found && el.dataset.empty === 'false';
  el.classList.toggle('hidden', !show);
}

function buildEffectPicker() {
  const select = $('effect-select');
  const { settings } = state.show;
  const ids = settings.effects ? [...settings.effects] : EFFECTS.map((e) => e.id);
  if (!ids.includes(settings.effect)) ids.unshift(settings.effect);
  const current = state.slideshow?.effect || settings.effect;
  select.textContent = '';
  for (const id of ids) {
    const effect = EFFECTS.find((e) => e.id === id);
    if (!effect) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = (state.lang !== 'en' && effect[state.lang]) || effect.label;
    opt.selected = id === current;
    select.appendChild(opt);
  }
}

function wireControls() {
  $('prev-button').addEventListener('click', () => state.slideshow?.prev());
  $('next-button').addEventListener('click', () => state.slideshow?.next());
  $('play-button').addEventListener('click', () => state.slideshow?.togglePlay());
  $('effect-select').addEventListener('change', (e) => state.slideshow?.setEffect(e.target.value));
  $('retry-button').addEventListener('click', () => location.reload());

  window.addEventListener('keydown', (e) => {
    if (!state.slideshow || e.target.closest('select')) return;
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === 'ArrowRight') rtl ? state.slideshow.prev() : state.slideshow.next();
    else if (e.key === 'ArrowLeft') rtl ? state.slideshow.next() : state.slideshow.prev();
    else if (e.key === ' ') { e.preventDefault(); state.slideshow.togglePlay(); }
  });

  if (state.cfg.ui.swipe) {
    const box = $('ar-container');
    let start = null;
    box.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    box.addEventListener('pointerup', (e) => {
      if (!start || !state.slideshow) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const quick = performance.now() - start.t < 600;
      start = null;
      if (!quick || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const forward = document.documentElement.dir === 'rtl' ? dx > 0 : dx < 0;
      forward ? state.slideshow.next() : state.slideshow.prev();
    });
  }
}

function showControls() {
  const { ui } = state.cfg;
  const nav = ui.navigation && state.show.slides.length > 1;
  $('nav-buttons').classList.toggle('hidden', !nav);
  $('effect-picker').classList.toggle('hidden', !ui.effectPicker);
  $('controls').classList.toggle('hidden', !nav && !ui.effectPicker);
}

/** ?debug=1: small readout of tracking rate and settings, for tuning on site. */
function startDebugHud(anchor) {
  const hud = document.createElement('div');
  hud.className = 'debug-hud';
  document.body.appendChild(hud);
  let updates = 0;
  let lastDetections = 0;
  anchor.onTargetUpdate = () => { updates += 1; };
  const t = state.setup.tracking;
  setInterval(() => {
    const f = state.fusion;
    const detections = f ? f.detections : 0;
    state.trackingFps = updates;
    state.tagFps = detections - lastDetections;
    const tags = f ? f.tags.map((tag) => `${tag.id}${tag.origin === 'setup' ? 's' : 'l'}`).join(',') || 'none' : '-';
    const seen = f ? f.lastMarkers.map((m) => m.id).join(',') || '-' : '-';
    hud.textContent = [
      `${state.found ? `held by ${state.trackingSource}` : 'searching'} · view ${Math.round(state.viewAngle || 0)}°`,
      `image ${anchor.visible ? 'on' : 'off'} ${updates}/s · minCF ${t.filterMinCF} β ${t.filterBeta}`,
      `tags known ${tags} · seen ${seen} · ${state.tagFps}/s${f?.tagPose ? ` · err ${f.tagPose.error.toFixed(1)}px` : ''}${f?.tagPose?.upright ? ' · upright' : ''}`,
      `motion ${gravityInCamera() ? gravityInCamera().map((v) => v.toFixed(2)).join(' ') : 'none'}`,
      f ? `focal ${Math.round(f.focal)}px (${f.focalSamples.length} est.)${f.wallOffset ? ` · wall ${Math.round(f.wallOffset)}px behind` : ''}` : '',
    ].join('\n');
    updates = 0;
    lastDetections = detections;
  }, 1000);
}

function showError(message, err) {
  console.error('[frame-ar]', message, err || '');
  for (const id of ['loading', 'start', 'scanning', 'controls', 'caption']) $(id).classList.add('hidden');
  $('error-message').textContent = message;
  const detail = err && (err.message || (typeof err === 'string' ? err : ''));
  $('error-detail').textContent = detail || '';
  $('error-detail').classList.toggle('hidden', !detail);
  $('error').classList.remove('hidden');
  state.error = message + (detail ? `: ${detail}` : '');
}
