// Decides, every frame, what holds the picture in place:
//
//   - MindAR image tracking: steady and accurate when the frame is seen
//     roughly from the front.
//   - AprilTags printed and placed in the frame: still readable from steep
//     side angles, where image tracking drifts or loses the frame.
//
// A tag's position on the wall comes from setup.json (detected by the setup
// tool in the setup photo) or is learned live: once the frame has been
// recognised from the front, the tag's corners are projected onto the wall
// and remembered on this device.
//
// Tags may sit on the wall around the frame, behind the plane of the opening
// (apriltag.wallOffset, in tracking-image pixels). Then the tag pose is worked
// out in real 3D with the phone's focal length, estimated from the tags
// themselves, and the opening is placed that far in front of the wall.
//
// Events: 'tagschange' (known tag placements changed)

import * as THREE from 'three';
import { TagDetector } from './tag-detector.js';
import { solveHomographyLS, applyHomography } from './homography.js';
import {
  solvePlanarPose, anchorMatrixFromMvt, mvtFromAnchorMatrix, imageToMarker, viewAngle, OneEuroMatrixFilter,
  cameraMatrix, decomposeHomography, focalFromHomography, projectPoint, imageToPlane,
} from './tag-pose.js';

const TAG_FRESH_MS = 300; // how long a tag pose stays usable after the last detection
const BLEND_MS = 350; // cross-blend time when switching between image and tag tracking
const LEARN_MAX_ANGLE = 25; // only learn tag placements from near-frontal views
const LEARN_MIN_SAMPLES = 8;
const LEARN_MAX_SAMPLES = 30;
// Ignore tags too small to trust. A tag seen steeply from the side is narrow but
// still decoded reliably, and dropping it (leaving one tag far from the frame)
// costs far more accuracy than its slightly rougher corners do.
const MIN_TAG_LONG_SIDE_PX = 14;
const MIN_TAG_SHORT_SIDE_PX = 5;
const MAX_POSE_ERROR_PX = 3; // reject tag poses that don't fit the corners well
const FOCAL_SAMPLES = 40; // focal-length estimates kept (median used)
const DEFAULT_FOCAL = 0.75; // x the camera image's long side, typical for phone main cameras

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function sideLengths(corners) {
  return corners.map((p, i) => {
    const q = corners[(i + 1) % 4];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
}

/** Element-wise blend; both poses describe nearly the same placement while switching. */
function blendMatrix(out, target, k) {
  const o = out.elements;
  const t = target.elements;
  for (let i = 0; i < 16; i++) o[i] += (t[i] - o[i]) * k;
  return out;
}

export class TrackingFusion extends EventTarget {
  constructor({ mindar, anchor, setup }) {
    super();
    this.mindar = mindar;
    this.anchor = anchor;
    this.setup = setup;
    this.cfg = setup.apriltag || {};
    this.output = new THREE.Matrix4();
    this.visible = false;
    this.source = null; // 'image' | 'tag' | null
    this.angle = 0;
    this.tagPose = null; // { matrix, time, error, ids }
    this.known = new Map(); // tag id -> { corners (marker px), origin: 'setup' | 'learned' }
    this.samples = new Map(); // tag id -> [corners, ...] for learning
    this.blendUntil = 0;
    this.lastDetect = 0;
    this.lastSave = 0;
    this.detections = 0;
    this.lastMarkers = [];
    this.focalSamples = [];
  }

  get focalKey() {
    return `frame-ar:focal:${this.inputW}x${this.inputH}`;
  }

  /** The phone's camera matrix: focal length estimated from tags seen at an angle, remembered per camera size. */
  get Kreal() {
    return cameraMatrix(this.focal, this.inputW / 2, this.inputH / 2);
  }

  _addFocalSample(f) {
    const long = Math.max(this.inputW, this.inputH);
    if (!(f > 0.3 * long && f < 3 * long)) return;
    this.focalSamples.push(f);
    if (this.focalSamples.length > FOCAL_SAMPLES) this.focalSamples.shift();
    if (this.focalSamples.length >= 5) {
      this.focal = median(this.focalSamples);
      if (this.focalSamples.length % 10 === 0) {
        try { localStorage.setItem(this.focalKey, String(this.focal)); } catch (err) { /* ignore */ }
      }
    }
  }

  get storageKey() {
    const s = this.setup;
    return `frame-ar:tags:${s.source}:${hash(JSON.stringify([s.targetSize, s.opening]))}`;
  }

  start() {
    const c = this.mindar.controller;
    this.controller = c;
    this.K = c.projectionTransform;
    this.inputW = c.inputWidth;
    this.inputH = c.inputHeight;
    this.post = this.mindar.postMatrixs[0];
    this.postInv = this.post.clone().invert();
    this.markerH = c.markerDimensions[0][1];
    this.wallOffset = Math.max(0, Number(this.cfg.wallOffset) || 0);
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(this.focalKey)); } catch (err) { /* ignore */ }
    this.focal = Number.isFinite(saved) ? saved : DEFAULT_FOCAL * Math.max(this.inputW, this.inputH);
    if (!this.cfg.enabled) return;

    for (const t of this.cfg.tags || []) {
      if (Array.isArray(t.corners) && t.corners.length === 4) this.known.set(t.id, { corners: t.corners, origin: 'setup' });
    }
    if (this.cfg.learn) {
      try {
        const saved = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
        for (const t of saved) if (!this.known.has(t.id)) this.known.set(t.id, { corners: t.corners, origin: 'learned' });
      } catch (err) { /* storage unavailable */ }
    }
    const tracking = this.setup.tracking || {};
    this.filter = new OneEuroMatrixFilter({
      minCutOff: this.cfg.filterMinCF ?? tracking.filterMinCF ?? 0.001,
      beta: this.cfg.filterBeta ?? tracking.filterBeta ?? 0.01,
    });
    this.detector = new TagDetector({ family: this.cfg.family || 'tag36h11' });
    this.minInterval = 1000 / (this.cfg.maxRate || 20);
    if (this.known.size) this.dispatchEvent(new Event('tagschange'));
  }

  /** Known tag placements, for debug outlines. */
  get tags() {
    return [...this.known].map(([id, t]) => ({ id, corners: t.corners, origin: t.origin }));
  }

  _videoReady() {
    const v = this.mindar.video;
    return v && v.videoWidth === this.inputW && v.videoHeight === this.inputH && v.readyState >= 2;
  }

  /** Call once per rendered frame. Returns { visible, matrix, source, angle }. */
  update(now, dtMs = 16) {
    const imageVisible = !!this.anchor.visible;
    const imageMatrix = this.anchor.group.matrix;

    // Look for tags when they can be used now, or learned from the current view.
    if (this.detector && !this.detector.busy && now - this.lastDetect >= this.minInterval && this._videoReady()
      && (this.known.size > 0 || (this.cfg.learn && imageVisible))) {
      this.lastDetect = now;
      const imageAtGrab = imageVisible ? imageMatrix.clone() : null;
      this.detector.detect(this.mindar.video).then((res) => res && this._onDetections(res, imageAtGrab));
    }

    const tagFresh = !!this.tagPose && now - this.tagPose.time < TAG_FRESH_MS;
    if (tagFresh) this.angle = viewAngle(this.tagPose.matrix);
    else if (imageVisible) this.angle = viewAngle(imageMatrix);

    // Prefer the tags at steep angles (with a little hysteresis so it doesn't flicker),
    // and at any angle when two or more are in view: tags spread around the frame
    // pin it down better than image tracking of a frame with repetitive carving.
    const oblique = this.cfg.obliqueAngle ?? 30;
    const threshold = this.source === 'tag' ? oblique - 5 : oblique;
    const multiTag = tagFresh && this.tagPose.ids.length >= 2;
    let source = null;
    if (tagFresh && (!imageVisible || multiTag || this.angle > threshold)) source = 'tag';
    else if (imageVisible) source = 'image';
    else if (tagFresh) source = 'tag';

    if (source !== this.source) {
      if (source && this.source && this.visible) this.blendUntil = now + BLEND_MS;
      this.source = source;
    }
    if (source) {
      const target = source === 'tag' ? this.tagPose.matrix : imageMatrix;
      if (this.visible && now < this.blendUntil) blendMatrix(this.output, target, 1 - Math.exp(-dtMs / 70));
      else this.output.copy(target);
    }
    this.visible = !!source;
    return { visible: this.visible, matrix: this.output, source, angle: this.angle };
  }

  _onDetections(res, imageAtGrab) {
    this.detections += 1;
    this.lastMarkers = res.markers;
    if (res.width !== this.inputW || res.height !== this.inputH) return;
    const markers = res.markers.filter((m) => {
      const sides = sideLengths(m.corners);
      return Math.max(...sides) >= MIN_TAG_LONG_SIDE_PX && Math.min(...sides) >= MIN_TAG_SHORT_SIDE_PX;
    });

    if (this.cfg.learn && imageAtGrab && viewAngle(imageAtGrab) <= LEARN_MAX_ANGLE) {
      const mvt = mvtFromAnchorMatrix(imageAtGrab, this.postInv, this.markerH);
      let toWall;
      if (this.wallOffset > 0) {
        // Image tracking describes the opening's plane; the tags are on the wall behind it.
        const P = [mvt[0][0], mvt[0][1], mvt[0][3], mvt[1][0], mvt[1][1], mvt[1][3], mvt[2][0], mvt[2][1], mvt[2][3]];
        const K = this.K;
        const Hfront = [
          K[0][0] * P[0] + K[0][2] * P[6], K[0][0] * P[1] + K[0][2] * P[7], K[0][0] * P[2] + K[0][2] * P[8],
          K[1][1] * P[3] + K[1][2] * P[6], K[1][1] * P[4] + K[1][2] * P[7], K[1][1] * P[5] + K[1][2] * P[8],
          P[6], P[7], P[8],
        ];
        const { R, t } = decomposeHomography(Hfront, this.Kreal);
        toWall = (p) => imageToPlane(R, t, this.Kreal, p, this.wallOffset);
      } else {
        toWall = (p) => imageToMarker(mvt, this.K, p);
      }
      for (const m of markers) {
        if (this.known.get(m.id)?.origin === 'setup') continue;
        this._learn(m.id, m.corners.map(toWall));
      }
    }

    const world = [];
    const image = [];
    const ids = [];
    for (const m of markers) {
      const known = this.known.get(m.id);
      if (!known) continue;
      known.corners.forEach((c, i) => {
        world.push(c);
        image.push(m.corners[i]);
      });
      ids.push(m.id);
    }
    if (world.length < 4) return;
    const pose = this.wallOffset > 0 ? this._poseWithDepth(world, image) : solvePlanarPose(world, image, this.K);
    if (!pose || pose.error > MAX_POSE_ERROR_PX) return;
    const raw = anchorMatrixFromMvt(this.controller, this.post, pose.mvt);
    const nowMs = performance.now();
    if (!this.tagPose || nowMs - this.tagPose.time > 500) this.filter.reset();
    const matrix = new THREE.Matrix4().fromArray(this.filter.filter(res.time, raw.elements));
    this.tagPose = { matrix, time: nowMs, error: pose.error, ids };
  }

  /**
   * Tags on the wall, opening wallOffset in front of it: find the camera in 3D
   * from the tags (with the estimated focal length), project the opening's
   * corners at their real depth, and hand MindAR's renderer the mapping that
   * puts the picture exactly there.
   */
  _poseWithDepth(world, image) {
    let H;
    try {
      H = solveHomographyLS(world, image);
    } catch (err) {
      return null;
    }
    let sq = 0;
    for (let i = 0; i < world.length; i++) {
      const [u, v] = applyHomography(H, world[i][0], world[i][1]);
      sq += (u - image[i][0]) ** 2 + (v - image[i][1]) ** 2;
    }
    const error = Math.sqrt(sq / world.length);
    const f = focalFromHomography(H, this.inputW / 2, this.inputH / 2);
    if (f) this._addFocalSample(f);
    const K = this.Kreal;
    const { R, t } = decomposeHomography(H, K);
    const corners = this.setup.opening;
    const projected = corners.map(([X, Y]) => projectPoint(R, t, K, X, Y, -this.wallOffset));
    if (projected.some((p) => !(p[2] > 0))) return null;
    const view = solvePlanarPose(corners, projected.map(([u, v]) => [u, v]), this.K);
    return view && { mvt: view.mvt, error };
  }

  /** Accumulate a tag's corners on the wall (marker px) seen from the front; keep a robust median. */
  _learn(id, corners) {
    const list = this.samples.get(id) || [];
    list.push(corners);
    if (list.length > LEARN_MAX_SAMPLES) list.shift();
    this.samples.set(id, list);
    if (list.length < LEARN_MIN_SAMPLES) return;

    const med = [0, 1, 2, 3].map((i) => [median(list.map((c) => c[i][0])), median(list.map((c) => c[i][1]))]);
    const size = sideLengths(med).reduce((a, b) => a + b, 0) / 4;
    const spread = median(list.map((c) => Math.max(...c.map((p, i) => Math.hypot(p[0] - med[i][0], p[1] - med[i][1])))));
    if (!(size > 0) || spread > 0.04 * size) return; // camera moving too much to trust yet

    const isNew = !this.known.has(id);
    this.known.set(id, { corners: med, origin: 'learned' });
    const now = performance.now();
    if (isNew || now - this.lastSave > 5000) {
      this.lastSave = now;
      try {
        const learned = this.tags.filter((t) => t.origin === 'learned').map(({ id: i, corners: c }) => ({ id: i, corners: c }));
        localStorage.setItem(this.storageKey, JSON.stringify(learned));
      } catch (err) { /* storage unavailable */ }
    }
    if (isNew) {
      console.info(`[frame-ar] Learned AprilTag ${id} position (tracking-image px):`, JSON.stringify(med.map((p) => p.map((v) => Math.round(v * 10) / 10))));
      this.dispatchEvent(new Event('tagschange'));
    }
  }

  dispose() {
    this.detector?.dispose();
  }
}
