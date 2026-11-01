// Slideshow engine: timing, preloading, transitions and Ken Burns motion.
// Drives the uniforms of the material from transitions.js.
//
// Events (EventTarget): 'slidechange' {index, slide, position, total},
//                       'playstate' {playing}, 'error' {message}

import * as THREE from 'three';
import { EFFECTS, effectById, DIRECTIONS } from './transitions.js';

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(img));
    img.onerror = () => reject(new Error(`Could not load image ${src}`));
    img.src = src;
  });
}

export class Slideshow extends EventTarget {
  constructor({ material, renderer, slides, settings }) {
    super();
    this.u = material.uniforms;
    this.renderer = renderer;
    this.slides = slides;
    this.settings = settings;
    this.effect = settings.effect;
    this.order = slides.map((_, i) => i);
    if (settings.shuffle) this.order.sort(() => Math.random() - 0.5);

    this.cache = new Map(); // slide index -> { promise, texture, aspect, ready, failed }
    this.phase = 'idle'; // idle | hold | transition
    this.t = 0;
    this.playing = true;
    this.visible = false;
    this.current = null; // slide index in slot A
    this.incoming = null; // slide index in slot B during a transition
    this.pending = null; // slide index requested by next()/prev()
    this.fast = false;
    this.transitionDuration = 1;
    this.lastRandom = null;
    this.kb = { A: null, B: null };
    this.maxTextureSize = Math.min(renderer.capabilities.maxTextureSize, settings.maxTextureSize || 2048);
    this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  get effectPool() {
    const allowed = this.settings.effects || EFFECTS.map((e) => e.id);
    return allowed.filter((id) => id !== 'random' && id !== 'cut' && EFFECTS.some((e) => e.id === id));
  }

  get position() {
    return this.order.indexOf(this.current);
  }

  async start() {
    while (this.order.length) {
      const index = this.order[0];
      const entry = await this._load(index);
      if (!entry.failed) {
        this._setSlot('A', index, entry);
        this.current = index;
        this.kb.A = this._newKenBurns(index);
        this.phase = 'hold';
        this.t = 0;
        this._emitChange(index);
        this._preloadAround();
        return;
      }
      this._drop(index);
    }
    this.dispatchEvent(new CustomEvent('error', { detail: { message: 'None of the slideshow images could be loaded.' } }));
  }

  setVisible(visible) {
    this.visible = visible;
  }

  setEffect(id) {
    this.effect = id;
  }

  togglePlay(force) {
    this.playing = force !== undefined ? force : !this.playing;
    this.dispatchEvent(new CustomEvent('playstate', { detail: { playing: this.playing } }));
  }

  next() {
    this._jump(1);
  }

  prev() {
    this._jump(-1);
  }

  goTo(slideIndex) {
    if (this.phase === 'idle' || !this.order.includes(slideIndex)) return;
    if (this.phase === 'transition') this._endTransition();
    if (slideIndex === this.current) return;
    this.pending = slideIndex;
    this.fast = true;
  }

  _jump(step) {
    if (this.phase === 'idle' || this.order.length < 2) return;
    if (this.phase === 'transition') this._endTransition();
    const n = this.order.length;
    const pos = (this.position + step + n) % n;
    this.pending = this.order[pos];
    this.fast = true;
  }

  _nextAuto() {
    const n = this.order.length;
    if (n < 2) return null;
    const pos = this.position + 1;
    if (pos >= n && !this.settings.loop) return null;
    return this.order[pos % n];
  }

  _holdTime(index) {
    const s = this.slides[index];
    return s.duration ?? s.interval ?? this.settings.interval;
  }

  update(dt) {
    if (this.phase === 'idle') return;
    if (!this.visible && this.settings.pauseWhenHidden) return;

    if (this.kb.A) this.kb.A.t += dt;
    if (this.phase === 'hold') {
      if (this.playing) this.t += dt;
      let target = this.pending;
      if (target === null && this.playing && this.t >= this._holdTime(this.current)) target = this._nextAuto();
      if (target !== null) {
        this._load(target);
        const entry = this.cache.get(target);
        if (entry.failed) {
          this._drop(target);
          if (this.pending === target) this.pending = null;
        } else if (entry.ready) {
          this._beginTransition(target);
        }
      }
    } else if (this.phase === 'transition') {
      if (this.kb.B) this.kb.B.t += dt;
      this.t += dt;
      const p = Math.min(1, this.t / this.transitionDuration);
      this.u.uProgress.value = easeInOutCubic(p);
      if (p >= 1) this._endTransition();
    }
    this._applyKenBurns();
  }

  _pickEffect(index) {
    let id = this.slides[index].effect || this.effect;
    if (id === 'random') {
      const pool = this.effectPool.filter((e) => e !== this.lastRandom);
      id = pool[Math.floor(Math.random() * pool.length)] || 'fade';
      this.lastRandom = id;
    }
    return effectById(id);
  }

  _beginTransition(index) {
    const slide = this.slides[index];
    const effect = this._pickEffect(index);
    const dir = DIRECTIONS[slide.direction || this.settings.direction] || DIRECTIONS.left;
    let duration = slide.transitionDuration ?? this.settings.transitionDuration;
    if (this.fast) duration = Math.min(duration, 0.7);
    if (effect.id === 'cut') duration = 0.001;

    this.u.uEffect.value = effect.code;
    this.u.uDirection.value.set(dir[0], dir[1]);
    this._setSlot('B', index, this.cache.get(index));
    this.kb.B = this._newKenBurns(index);
    this.u.uProgress.value = 0;

    this.transitionDuration = Math.max(0.001, duration);
    this.incoming = index;
    this.pending = null;
    this.fast = false;
    this.phase = 'transition';
    this.t = 0;
    this._emitChange(index);
  }

  _endTransition() {
    const index = this.incoming;
    this._setSlot('A', index, this.cache.get(index));
    this.kb.A = this.kb.B;
    this.kb.B = null;
    this.u.uProgress.value = 0;
    this.current = index;
    this.incoming = null;
    this.phase = 'hold';
    this.t = 0;
    this._applyKenBurns();
    this._preloadAround();
  }

  _emitChange(index) {
    this.dispatchEvent(new CustomEvent('slidechange', {
      detail: { index, slide: this.slides[index], position: this.order.indexOf(index), total: this.order.length },
    }));
  }

  _setSlot(slot, index, entry) {
    const slide = this.slides[index];
    const fit = (slide.fit || this.settings.fit) === 'contain' ? 1 : 0;
    this.u[`uTex${slot}`].value = entry.texture;
    this.u[`uAspect${slot}`].value = entry.aspect;
    this.u[`uFit${slot}`].value = fit;
  }

  _drop(index) {
    console.warn('[frame-ar] Skipping slide that failed to load:', this.slides[index].src);
    this.order = this.order.filter((i) => i !== index);
    this.cache.delete(index);
    if (this.order.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: 'None of the slideshow images could be loaded.' } }));
    }
  }

  _load(index) {
    const existing = this.cache.get(index);
    if (existing) return existing.promise;
    const entry = { texture: null, aspect: 1, ready: false, failed: false };
    entry.promise = loadImage(this.slides[index].src)
      .then((img) => {
        entry.texture = this._makeTexture(img);
        entry.aspect = img.naturalWidth / img.naturalHeight;
        entry.ready = true;
        return entry;
      })
      .catch((err) => {
        console.warn('[frame-ar]', err.message);
        entry.failed = true;
        return entry;
      });
    this.cache.set(index, entry);
    return entry.promise;
  }

  _makeTexture(img) {
    let source = img;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(1, this.maxTextureSize / Math.max(w, h));
    if (scale < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      source = canvas;
    }
    const tex = new THREE.Texture(source);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.maxAnisotropy;
    tex.needsUpdate = true;
    this.renderer.initTexture(tex); // upload now so the transition doesn't stutter
    return tex;
  }

  /** Keep the previous, current and next images in memory; free the rest. */
  _preloadAround() {
    const n = this.order.length;
    const pos = this.position;
    const keep = new Set([this.current]);
    if (n > 1) {
      keep.add(this.order[(pos + 1) % n]);
      keep.add(this.order[(pos - 1 + n) % n]);
    }
    for (const index of keep) this._load(index);
    for (const [index, entry] of this.cache) {
      if (!keep.has(index) && entry.ready && index !== this.incoming) {
        entry.texture.dispose();
        this.cache.delete(index);
      }
    }
  }

  _newKenBurns(index) {
    const slide = this.slides[index];
    const enabled = slide.kenBurns ?? this.settings.kenBurns;
    if (!enabled) return null;
    const amount = this.settings.kenBurnsZoom ?? 0.1;
    const zoomIn = Math.random() < 0.5;
    const transition = slide.transitionDuration ?? this.settings.transitionDuration;
    return {
      t: 0,
      duration: this._holdTime(index) + 2 * transition,
      z0: zoomIn ? 1 : 1 + amount,
      z1: zoomIn ? 1 + amount : 1,
      p0: [rand(-1, 1), rand(-1, 1)],
      p1: [rand(-1, 1), rand(-1, 1)],
    };
  }

  _applyKenBurns() {
    for (const slot of ['A', 'B']) {
      const kb = this.kb[slot];
      const u = this.u[`uKb${slot}`].value;
      if (!kb) {
        u.set(1, 0, 0);
        continue;
      }
      const e = Math.min(1, kb.t / kb.duration);
      const z = lerp(kb.z0, kb.z1, e);
      const maxPan = (1 - 1 / z) / 2;
      u.set(z, lerp(kb.p0[0], kb.p1[0], e) * maxPan, lerp(kb.p0[1], kb.p1[1], e) * maxPan);
    }
  }
}
