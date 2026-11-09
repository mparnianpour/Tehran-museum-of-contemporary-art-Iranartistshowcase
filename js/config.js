// Loads config.json, the active frame setup and the slideshow, and applies
// URL overrides (?setup=frame-02&effect=wipe&interval=4 ...).

import { getLocalSetup } from './local-store.js';
import { estimateQuadAspect } from './homography.js';

export const APP_DEFAULTS = {
  title: 'Frame AR',
  subtitle: '',
  language: 'en',
  languages: ['en', 'fa'],
  setup: 'frame-01',
  slideshow: 'slideshow.json',
  strings: {},
  ui: {
    startScreen: true,
    scanningHint: true,
    caption: true,
    navigation: true,
    effectPicker: true,
    swipe: true,
  },
};

export const SLIDESHOW_DEFAULTS = {
  interval: 6, // seconds each artwork stays before the next transition
  transitionDuration: 1.4, // seconds
  effect: 'fade',
  direction: 'left', // for slide / wipe / blinds: left | right | up | down
  loop: true,
  shuffle: false,
  fit: 'cover', // cover = fill the opening (crop), contain = show whole image
  background: '#ebe6dc', // mat colour around "contain" images
  kenBurns: false, // slow zoom/pan while an artwork is shown
  kenBurnsZoom: 0.1,
  pauseWhenHidden: true, // don't advance while the frame is out of view
  maxTextureSize: 2048,
  effects: null, // effects offered in the picker and in "random" (null = all)
};

export const SETUP_DEFAULTS = {
  name: 'Untitled setup',
  target: 'target.mind',
  preview: 'target.jpg',
  bleed: 0, // grow (+) or shrink (-) the picture past the marked opening, as a fraction of its width
  exposure: 1, // brightness multiplier so the picture matches the room light
  innerShadow: { strength: 0.35, size: 0.035 },
  tracking: {
    filterMinCF: 0.001, // lower = steadier at rest but laggier
    filterBeta: 0.01, // higher = follows fast movement more closely (but more jitter)
    warmupTolerance: 5,
    missTolerance: 10,
    image: true, // false = hold the picture with AprilTags only (for plain surfaces image tracking can't recognise)
  },
  // Pillars or walls in front of the picture that should hide it (see occlusion.js).
  occluders: [],
  // Printed AprilTags (tag36h11) in the frame hold the picture at steep side angles.
  apriltag: {
    enabled: true,
    family: 'tag36h11',
    learn: true, // learn where a tag is once the frame has been recognised from the front
    obliqueAngle: 30, // degrees: beyond this, the tag holds the picture instead of image tracking
    tags: [], // [{ id, corners: [[x, y] x4] }] in tracking-image pixels (written by the setup tool)
    wallOffset: 0, // how far the tags' wall lies behind the opening's edge, in tracking-image pixels
  },
};

export const params = new URLSearchParams(location.search);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new Error(`Could not reach ${url}`);
  }
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${url} is not valid JSON: ${err.message}`);
  }
}

function boolParam(name) {
  if (!params.has(name)) return undefined;
  const v = params.get(name).toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function numParam(name) {
  if (!params.has(name)) return undefined;
  const v = parseFloat(params.get(name));
  return Number.isFinite(v) ? v : undefined;
}

/** config.json + URL overrides. */
export async function loadAppConfig() {
  let file = {};
  try {
    file = await fetchJSON('config.json');
  } catch (err) {
    console.warn('[frame-ar] Using defaults:', err.message);
  }
  const cfg = deepMerge(APP_DEFAULTS, file);
  if (params.has('setup')) cfg.setup = params.get('setup');
  if (params.has('slideshow')) cfg.slideshow = params.get('slideshow');
  if (params.has('lang')) cfg.language = params.get('lang');
  for (const key of ['caption', 'navigation', 'effectPicker', 'scanningHint', 'swipe']) {
    const v = boolParam(key);
    if (v !== undefined) cfg.ui[key] = v;
  }
  const controls = boolParam('controls');
  if (controls !== undefined) cfg.ui.navigation = cfg.ui.effectPicker = controls;
  cfg.preview = boolParam('preview') === true;
  cfg.autostart = boolParam('autostart') === true || cfg.ui.startScreen === false;
  cfg.debug = boolParam('debug') === true;
  return cfg;
}

/** "frame-02" -> setups/frame-02/setup.json; paths and URLs are used as-is. */
export function setupUrl(ref) {
  if (/\.json(\?|#|$)/i.test(ref) || ref.includes('/')) return new URL(ref, location.href).href;
  return new URL(`setups/${encodeURIComponent(ref)}/setup.json`, location.href).href;
}

/** Load a setup by name, path, or "local:<id>" (saved on this device by setup.html). */
export async function loadSetup(ref) {
  if (ref.startsWith('local:')) {
    const id = ref.slice(6);
    const rec = await getLocalSetup(id);
    if (!rec) throw new Error(`No setup called "${id}" is saved on this device. Open setup.html to create it.`);
    return normalizeSetup(rec.setup, {
      targetUrl: URL.createObjectURL(new Blob([rec.mind], { type: 'application/octet-stream' })),
      previewUrl: rec.target ? URL.createObjectURL(rec.target) : null,
      source: ref,
    });
  }
  const url = setupUrl(ref);
  const json = await fetchJSON(url);
  return normalizeSetup(json, { baseUrl: url, source: ref });
}

export function normalizeSetup(json, { baseUrl = location.href, targetUrl, previewUrl, source } = {}) {
  const s = deepMerge(SETUP_DEFAULTS, json);
  const resolve = (p) => (p ? new URL(p, baseUrl).href : null);
  s.source = source;
  s.targetUrl = targetUrl || resolve(s.target);
  s.previewUrl = previewUrl !== undefined ? previewUrl : resolve(s.preview);
  if (s.slideshow) s.slideshowUrl = resolve(s.slideshow);

  const size = s.targetSize;
  if (!Array.isArray(size) || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) {
    throw new Error('setup.json needs "targetSize": [width, height] of the tracking image in pixels');
  }
  if (!Array.isArray(s.opening) || s.opening.length !== 4) {
    throw new Error('setup.json needs "opening": four [x, y] corners (top-left, top-right, bottom-right, bottom-left)');
  }
  if (!(s.openingAspect > 0)) s.openingAspect = estimateQuadAspect(s.opening);

  // On-site tuning without editing files: ?bleed=0.01&exposure=0.9&filterBeta=0.01
  for (const key of ['bleed', 'exposure']) {
    const v = numParam(key);
    if (v !== undefined) s[key] = v;
  }
  for (const key of Object.keys(SETUP_DEFAULTS.tracking)) {
    const v = numParam(key);
    if (v !== undefined) s.tracking[key] = v;
  }
  const tags = boolParam('apriltag');
  if (tags !== undefined) s.apriltag.enabled = tags;
  const learn = boolParam('learn');
  if (learn !== undefined) s.apriltag.learn = learn;
  const oblique = numParam('obliqueAngle');
  if (oblique !== undefined) s.apriltag.obliqueAngle = oblique;
  return s;
}

/** Load slides + settings; slide paths are relative to the slideshow file. */
export async function loadSlideshow(ref) {
  const url = new URL(ref, location.href).href;
  const json = await fetchJSON(url);
  const list = Array.isArray(json) ? json : json.slides;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${ref} has no slides`);

  const settings = deepMerge(SLIDESHOW_DEFAULTS, Array.isArray(json) ? {} : json.settings || {});
  if (params.has('effect')) settings.effect = params.get('effect');
  if (params.has('direction')) settings.direction = params.get('direction');
  if (params.has('fit')) settings.fit = params.get('fit');
  const interval = numParam('interval');
  if (interval !== undefined) settings.interval = interval;
  const duration = numParam('duration');
  if (duration !== undefined) settings.transitionDuration = duration;
  const kb = boolParam('kenburns');
  if (kb !== undefined) settings.kenBurns = kb;
  const shuffle = boolParam('shuffle');
  if (shuffle !== undefined) settings.shuffle = shuffle;

  const slides = list
    .map((item) => (typeof item === 'string' ? { src: item } : item))
    .filter((item) => item && item.src)
    .map((item) => ({ ...item, src: new URL(item.src, url).href }));
  if (slides.length === 0) throw new Error(`${ref} has no slides with a "src"`);
  return { settings, slides };
}
