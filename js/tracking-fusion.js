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
import { solveHomography, solveHomographyLS } from './homography.js';
import {
  solvePlanarPose, anchorMatrixFromMvt, mvtFromAnchorMatrix, imageToMarker, viewAngle, OneEuroMatrixFilter,
  cameraMatrix, decomposeHomography, focalFromHomography, projectPoint, imageToPlane,
} from './tag-pose.js';
import { squareFrame, poseFromTag, refinePose3D, uprightBasis, uprightAngle, refinePoseUpright } from './camera.js';

// How long a tag pose stays usable after the last detection: about 2.5 detection
// intervals, so a slower phone doesn't make the picture blink between detections.
const TAG_FRESH_MIN_MS = 300;
const TAG_FRESH_MAX_MS = 1000;
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
const MAX_POSE_ERROR_3D_PX = 6; // 3D fits also absorb the estimated lens; allow a little more
const UPRIGHT_MAX_VIEW_DEG = 75; // single-tag answers further round to the side than this are taken as mirror images
const MOTION_HOLD_MS = 8000; // after the tags leave the screen, keep the picture in place from the phone's turning this long
const MOTION_TURN_DEG = 1.5; // once the phone has turned this much since the last tag reading, follow the turn instead
const SENSOR_MISMATCH_LIMIT = 5; // the motion sensor disagreeing with the tags this often: stop using it
// A panel outline is only trusted if, in the phone's estimated lens, its sides come out this close to
// square to each other and to the picture's proportions (otherwise it's something else, or partly hidden).
const OUTLINE_MAX_SKEW = 0.12; // |cos| of the angle between its sides
const OUTLINE_MAX_ASPECT_ERROR = 0.12;
const FOCAL_SAMPLES = 40; // focal-length estimates kept (median used)
const DEFAULT_FOCAL = 0.75; // x the camera image's long side, typical for phone main cameras
// The lens can only be read from perspective that's big enough to measure: a tag ~50 px across
// gives anything from a third to a hundred times the real focal length. Only learn it from bigger views.
const FOCAL_MIN_SPAN_PX = 100;

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

/** 3x3 row-major products: A B, and A^T B. */
function mul9(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}
function mulT(A, B) {
  return mul9([A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]], B);
}

/** The larger side of the image points' bounding box (px). */
function imageSpan(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Element-wise blend; both poses describe nearly the same placement while switching. */
function blendMatrix(out, target, k) {
  const o = out.elements;
  const t = target.elements;
  for (let i = 0; i < 16; i++) o[i] += (t[i] - o[i]) * k;
  return out;
}

export class TrackingFusion extends EventTarget {
  constructor({ mindar, anchor, setup, gravity = null, motion = null }) {
    super();
    // () => which way is down in camera-image coordinates (phone motion sensor), or null
    this.gravity = gravity;
    // () => the phone's orientation (earth -> camera rotation, row-major 9), or null
    this.motion = motion;
    this.holdAnchor = null; // { Rwe: picture -> earth rotation, E0: phone orientation, C: phone position, time } from the last tag pose
    this.sensorChecks = { ok: 0, bad: 0 };
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
    this.wantCamera = (setup.occluders || []).length > 0; // pillars to hide behind need the phone's position
    this.detectInterval = 100; // smoothed time between detection results (ms)
    this.lastResultTime = 0;
  }

  get tagFreshMs() {
    return Math.min(TAG_FRESH_MAX_MS, Math.max(TAG_FRESH_MIN_MS, 2.5 * this.detectInterval));
  }

  /** Phone position in the picture's frame (tracking-image px, z < 0 in front) from a rigid pose of that plane. */
  static cameraCentre(R, t) {
    return [
      -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
      -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
      -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
  }

  /** Real rigid pose of the picture's plane from an image-tracking anchor matrix (re-solved with the phone's lens). */
  _poseFromImage(anchorMatrix) {
    const mvt = mvtFromAnchorMatrix(anchorMatrix, this.postInv, this.markerH);
    const P = [mvt[0][0], mvt[0][1], mvt[0][3], mvt[1][0], mvt[1][1], mvt[1][3], mvt[2][0], mvt[2][1], mvt[2][3]];
    const K = this.K;
    const Hfront = [
      K[0][0] * P[0] + K[0][2] * P[6], K[0][0] * P[1] + K[0][2] * P[7], K[0][0] * P[2] + K[0][2] * P[8],
      K[1][1] * P[3] + K[1][2] * P[6], K[1][1] * P[4] + K[1][2] * P[7], K[1][1] * P[5] + K[1][2] * P[8],
      P[6], P[7], P[8],
    ];
    return decomposeHomography(Hfront, this.Kreal);
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
    // How far the tags' plane is behind the picture (+), or in front of it (-, e.g. on a pillar).
    this.wallOffset = Number(this.cfg.wallOffset) || 0;
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(this.focalKey)); } catch (err) { /* ignore */ }
    this.focal = Number.isFinite(saved) ? saved : DEFAULT_FOCAL * Math.max(this.inputW, this.inputH);
    if (!this.cfg.enabled) return;

    for (const t of this.cfg.tags || []) {
      if (Array.isArray(t.corners) && t.corners.length === 4) this.known.set(t.id, { corners: t.corners, origin: 'setup' });
    }
    // Tags off the picture's surface (any angle, in front or behind) need the full 3D solve.
    const ow = Math.abs(this.setup.opening[1][0] - this.setup.opening[0][0]) || 1;
    this.tags3d = this.wallOffset !== 0
      || [...this.known.values()].some((t) => t.corners.some((c) => c.length === 3 && Math.abs(c[2]) > 0.005 * ow));
    if (this.cfg.learn) {
      try {
        const saved = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
        for (const t of saved) if (!this.known.has(t.id)) this.known.set(t.id, { corners: t.corners, origin: 'learned' });
      } catch (err) { /* storage unavailable */ }
    }
    const tracking = this.setup.tracking || {};
    const filterCfg = {
      minCutOff: this.cfg.filterMinCF ?? tracking.filterMinCF ?? 0.001,
      beta: this.cfg.filterBeta ?? tracking.filterBeta ?? 0.01,
    };
    this.filter = new OneEuroMatrixFilter(filterCfg);
    this.motionFilter = new OneEuroMatrixFilter(filterCfg); // fed every frame while the motion sensor drives the picture
    // With image tracking paused (tags only) the camera stream is HD: detect at up to 1920 px.
    const tagsOnly = this.setup.tracking?.image === false;
    this.detector = new TagDetector({ family: this.cfg.family || 'tag36h11', maxSize: tagsOnly ? 1920 : 1280 });
    this.minInterval = 1000 / (this.cfg.maxRate || 20);
    // A plain, bright panel with clear edges all round (setup.json "outline"): track its outline too.
    this.outlineEnabled = !!this.setup.outline?.enabled;
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

  /** Call once per rendered frame. Returns { visible, matrix, source, angle, camera }. */
  update(now, dtMs = 16) {
    const imageVisible = !!this.anchor.visible;
    const imageMatrix = this.anchor.group.matrix;

    // Look for tags when they can be used now, or learned from the current view.
    if (this.detector && !this.detector.busy && now - this.lastDetect >= this.minInterval && this._videoReady()
      && (this.known.size > 0 || this.outlineEnabled || (this.cfg.learn && imageVisible))) {
      this.lastDetect = now;
      const imageAtGrab = imageVisible ? imageMatrix.clone() : null;
      const sensors = this.sensorsOk;
      const downAtGrab = sensors && this.gravity ? this.gravity() : null;
      const orientAtGrab = sensors && this.motion ? this.motion() : null;
      const opts = {
        tags: this.known.size > 0 || (this.cfg.learn && imageVisible),
        outline: this.outlineEnabled ? { roll: downAtGrab ? Math.atan2(downAtGrab[0], downAtGrab[1]) : 0 } : null,
      };
      this.detector.detect(this.mindar.video, opts).then((res) => res && this._onDetections(res, imageAtGrab, downAtGrab, orientAtGrab));
    }

    let tagFresh = !!this.tagPose && now - this.tagPose.time < this.tagFreshMs;
    // While the phone turns, the last tag reading is out of date until the next one arrives: follow the turn instead.
    if (tagFresh && this.tagPose.ids.length === 1 && this._turnedSinceAnchor() > MOTION_TURN_DEG) tagFresh = false;
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
    // Nothing in view any more: for a few seconds, keep the picture where the tags last put it,
    // turning it with the phone (assumes the visitor stays roughly where they are).
    let heldMatrix = null;
    if (!source && this.holdAnchor && now - this.holdAnchor.time < this.motionHoldMs) {
      heldMatrix = this._heldMatrix(now);
      if (heldMatrix) {
        source = 'motion';
        this.angle = viewAngle(heldMatrix);
      }
    }

    if (source !== this.source) {
      if (source && this.source && this.visible) this.blendUntil = now + BLEND_MS;
      this.source = source;
    }
    if (source) {
      const target = source === 'tag' ? this.tagPose.matrix : source === 'motion' ? heldMatrix : imageMatrix;
      if (this.visible && now < this.blendUntil) blendMatrix(this.output, target, 1 - Math.exp(-dtMs / 70));
      else this.output.copy(target);
    }
    this.visible = !!source;
    let camera = null;
    if (this.wantCamera && source === 'tag') camera = this.tagPose.C;
    else if (this.wantCamera && source === 'motion') camera = this.holdAnchor.C;
    else if (this.wantCamera && source === 'image') {
      const { R, t } = this._poseFromImage(imageMatrix);
      camera = TrackingFusion.cameraCentre(R, t);
    }
    const shown = source === 'tag' && this.tagPose?.ids[0] === 'outline' ? 'outline' : source; // for the debug readout
    return { visible: this.visible, matrix: this.output, source: shown, angle: this.angle, camera };
  }

  _onDetections(res, imageAtGrab, down = null, orient = null) {
    this.detections += 1;
    const resultTime = performance.now();
    if (this.lastResultTime) this.detectInterval += 0.2 * (Math.min(2000, resultTime - this.lastResultTime) - this.detectInterval);
    this.lastResultTime = resultTime;
    this.lastMarkers = res.markers;
    if (res.width !== this.inputW || res.height !== this.inputH) return;
    const markers = res.markers.filter((m) => {
      const sides = sideLengths(m.corners);
      return Math.max(...sides) >= MIN_TAG_LONG_SIDE_PX && Math.min(...sides) >= MIN_TAG_SHORT_SIDE_PX;
    });

    if (this.cfg.learn && imageAtGrab && viewAngle(imageAtGrab) <= LEARN_MAX_ANGLE) {
      const mvt = mvtFromAnchorMatrix(imageAtGrab, this.postInv, this.markerH);
      let toWall;
      if (this.wallOffset !== 0) {
        // Image tracking describes the opening's plane; the tags are behind or in front of it.
        const { R, t } = this._poseFromImage(imageAtGrab);
        toWall = (p) => imageToPlane(R, t, this.Kreal, p, this.wallOffset);
      } else {
        toWall = (p) => imageToMarker(mvt, this.K, p);
      }
      for (const m of markers) {
        if (this.known.get(m.id)?.origin === 'setup') continue;
        this._learn(m.id, m.corners.map(toWall));
      }
    }

    // A plain bright panel seen whole: its own corners place the picture exactly, with no lens needed.
    let pose = null;
    let ids = [];
    for (const cand of res.outlines || []) {
      if (cand.partial) continue;
      pose = this._outlinePose(cand.corners);
      if (pose) {
        ids = ['outline'];
        break;
      }
    }
    if (!pose) {
      const tagIds = [];
      pose = (() => {
        const world = [];
        const image = [];
        for (const m of markers) {
          const known = this.known.get(m.id);
          if (!known) continue;
          known.corners.forEach((c, i) => {
            world.push(c);
            image.push(m.corners[i]);
          });
          tagIds.push(m.id);
        }
        if (world.length < 4) return null;
        // When every tag in view lies on the picture's own surface, the flat mapping is exact and
        // needs no lens; the 3D solve is only for tags off the surface (at an angle, on a pillar...).
        const ow = Math.abs(this.setup.opening[1][0] - this.setup.opening[0][0]) || 1;
        const offSurface = this.tags3d && markers.some((m) => this.known.has(m.id)
          && this._corners3d(this.known.get(m.id)).some((c) => Math.abs(c[2]) > 0.005 * ow));
        // One tag alone tilts the far side of a large picture with every small error in its own tilt;
        // when the phone says which way is down, solve in 3D with the picture kept upright.
        const upright = !!down && tagIds.length === 1;
        const use3D = offSurface || upright;
        const pose = use3D
          ? this._pose3D(markers.filter((m) => this.known.has(m.id)), upright ? down : null)
          : solvePlanarPose(world.map((c) => [c[0], c[1]]), image, this.K);
        if (!pose || pose.error > (use3D ? MAX_POSE_ERROR_3D_PX : MAX_POSE_ERROR_PX)) return null;
        if (this.wantCamera && !pose.C) {
          // Tags on the picture's own plane: its real pose (and the phone's lens) straight from the tags.
          try {
            const H = solveHomographyLS(world, image);
            const f = imageSpan(image) >= FOCAL_MIN_SPAN_PX ? focalFromHomography(H, this.inputW / 2, this.inputH / 2) : null;
            if (f) this._addFocalSample(f);
            const { R, t } = decomposeHomography(H, this.Kreal);
            pose.C = TrackingFusion.cameraCentre(R, t);
          } catch (err) { /* keep the previous position */ }
        }
        return pose;
      })();
      if (!pose) return;
      ids = tagIds;
    }
    const raw = anchorMatrixFromMvt(this.controller, this.post, pose.mvt);
    const nowMs = performance.now();
    if (!this.tagPose || nowMs - this.tagPose.time > 500) this.filter.reset();
    const matrix = new THREE.Matrix4().fromArray(this.filter.filter(res.time, raw.elements));
    this.tagPose = { matrix, time: nowMs, error: pose.error, ids, C: pose.C || null, upright: !!pose.upright };
    // Remember where the picture is relative to the room (earth frame), for holding it by motion alone.
    if (orient && pose.R && pose.C && this.sensorsOk) this.holdAnchor = { Rwe: mulT(orient, pose.R), E0: orient, C: pose.C, time: nowMs };
  }

  /** A tag's corners in 3D (tracking-image px, z into the wall): 2D ones sit on the plane wallOffset behind the picture. */
  _corners3d(known) {
    return known.corners.map((c) => (c.length === 3 ? c : [c[0], c[1], this.wallOffset]));
  }

  /**
   * Tags anywhere, at any angle: solve the phone's real pose from the 3D
   * corners of every tag in view (with the lens estimated from the tags),
   * project the picture's corners, and hand MindAR's renderer the mapping
   * that puts the picture exactly there.
   */
  _pose3D(markers, down = null) {
    const pts = [];
    const img = [];
    let best = null;
    let bestArea = 0;
    for (const m of markers) {
      const c3 = this._corners3d(this.known.get(m.id));
      c3.forEach((c, i) => { pts.push(c); img.push(m.corners[i]); });
      const frame = squareFrame(c3);
      const s = frame.size;
      try {
        if (imageSpan(m.corners) >= FOCAL_MIN_SPAN_PX) {
          const Hl = solveHomographyLS([[0, 0], [s, 0], [s, s], [0, s]], m.corners);
          const f = focalFromHomography(Hl, this.inputW / 2, this.inputH / 2);
          if (f) this._addFocalSample(f);
        }
      } catch (err) { /* degenerate view of this tag */ }
      const q = m.corners;
      const area = Math.abs((q[0][0] - q[2][0]) * (q[1][1] - q[3][1]) - (q[1][0] - q[3][0]) * (q[0][1] - q[2][1])) / 2;
      if (area > bestArea) { bestArea = area; best = { m, frame, c3 }; }
    }
    if (!best) return null;
    const K = this.Kreal;
    // Start from the biggest tag in view, and from the last pose if recent; keep the better fit.
    const starts = [poseFromTag(best.m.corners, best.frame, K, best.c3)];
    if (this.lastRigid && performance.now() - this.lastRigid.time < 600) starts.push(this.lastRigid);
    let fit = null;
    for (const s0 of starts) {
      const r = refinePose3D(pts, img, K, s0.R, s0.t, 8);
      if (!fit || r.error < fit.error) fit = r;
    }
    if (!fit || !Number.isFinite(fit.error)) return null;
    let up = down ? this._uprightPose(pts, img, K, fit, down) : null;
    if (up) {
      // With the sensor right, keeping the picture upright costs almost nothing in fit. If it costs a lot,
      // the sensor and the tags disagree (e.g. a phone reporting its axes differently): count it, and stop
      // using the sensor if it keeps happening.
      const consistent = up.error <= Math.max(2 * fit.error, fit.error + 1.5);
      this._sensorCheck(consistent);
      if (consistent) fit = up;
      else up = null;
    }
    this.lastRigid = { R: fit.R, t: fit.t, time: performance.now() };
    const corners = this.setup.opening;
    const projected = corners.map(([X, Y]) => projectPoint(fit.R, fit.t, K, X, Y, 0));
    if (projected.some((p) => !(p[2] > 0))) return null;
    const view = solvePlanarPose(corners, projected.map(([u, v]) => [u, v]), this.K);
    if (!view) return null;
    return { mvt: view.mvt, error: fit.error, C: TrackingFusion.cameraCentre(fit.R, fit.t), R: fit.R, upright: !!up };
  }

  /**
   * The phone's pose with the picture kept upright (down from the motion sensor):
   * keep the turn the tag itself suggests (or the last pose's, if that fits better),
   * and only look further round when that would put the phone behind the wall or
   * implausibly far to the side.
   */
  _uprightPose(pts, img, K, fit, down) {
    const R0 = uprightBasis(down);
    const th0 = uprightAngle(R0, fit.R);
    const recent = this.lastRigid && performance.now() - this.lastRigid.time < 600 ? this.lastRigid : null;
    const op = this.setup.opening;
    const mid = [(op[0][0] + op[1][0] + op[2][0] + op[3][0]) / 4, (op[0][1] + op[1][1] + op[2][1] + op[3][1]) / 4];
    const minCos = Math.cos((UPRIGHT_MAX_VIEW_DEG * Math.PI) / 180);
    const solve = (starts) => {
      let best = null;
      for (const th of starts) {
        const r = refinePoseUpright(pts, img, K, R0, th, fit.t);
        if (!r || !Number.isFinite(r.error)) continue;
        const C = TrackingFusion.cameraCentre(r.R, r.t);
        const off = Math.hypot(C[0] - mid[0], C[1] - mid[1], C[2]);
        if (!(C[2] < 0) || -C[2] / off < minCos) continue; // behind the wall, or round the side
        r.C = C;
        if (!best || r.error < best.error) best = r;
      }
      return best;
    };
    const near = [th0];
    if (recent) near.push(uprightAngle(R0, recent.R));
    return solve(near) || solve([-60, -40, -20, 20, 40, 60].map((d) => th0 + (d * Math.PI) / 180));
  }

  /**
   * Pose from the panel's outline (its four corners in the camera image), or null if the outline doesn't
   * have the picture's shape, or the phone is where a pillar or side wall could be hiding part of it.
   */
  _outlinePose(corners) {
    const op = this.setup.opening;
    let H;
    try {
      H = solveHomography(op, corners);
    } catch (err) {
      return null;
    }
    const K = this.Kreal;
    const [f, cx, cy] = [K[0][0], K[0][2], K[1][2]];
    const a1 = [(H[0] - cx * H[6]) / f, (H[3] - cy * H[6]) / f, H[6]];
    const a2 = [(H[1] - cx * H[7]) / f, (H[4] - cy * H[7]) / f, H[7]];
    const n1 = Math.hypot(...a1);
    const n2 = Math.hypot(...a2);
    if (!(n1 > 0 && n2 > 0)) return null;
    const skew = Math.abs(a1[0] * a2[0] + a1[1] * a2[1] + a1[2] * a2[2]) / (n1 * n2);
    if (skew > OUTLINE_MAX_SKEW || Math.abs(n1 / n2 - 1) > OUTLINE_MAX_ASPECT_ERROR) return null;
    const { R, t } = decomposeHomography(H, K);
    const C = TrackingFusion.cameraCentre(R, t);
    const ow = Math.abs(op[1][0] - op[0][0]);
    if (!(C[2] < 0) || -C[2] > 20 * ow) return null;
    // Outside the space between the pillar and the side wall, one of them may hide an edge of the panel.
    if ((this.setup.occluders || []).length && (C[0] < Math.min(op[0][0], op[3][0]) || C[0] > Math.max(op[1][0], op[2][0]))) return null;
    const view = solvePlanarPose(op, corners, this.K);
    if (!view) return null;
    if (imageSpan(corners) >= FOCAL_MIN_SPAN_PX) {
      const fs = focalFromHomography(H, this.inputW / 2, this.inputH / 2);
      if (fs) this._addFocalSample(fs);
    }
    return { mvt: view.mvt, error: 0, C, R };
  }

  get sensorsOk() {
    if (this.cfg.gravity === false) return false;
    const { ok, bad } = this.sensorChecks;
    return !(bad >= SENSOR_MISMATCH_LIMIT && bad > ok);
  }

  _sensorCheck(consistent) {
    if (consistent) this.sensorChecks.ok += 1;
    else this.sensorChecks.bad += 1;
    if (!this.sensorsOk) this.holdAnchor = null;
  }

  /** Degrees the phone has turned since the last tag reading (0 without the motion sensor). */
  _turnedSinceAnchor() {
    const a = this.holdAnchor;
    if (!a || !this.tagPose || a.time !== this.tagPose.time || !this.sensorsOk || !this.motion) return 0;
    const E = this.motion();
    if (!E) return 0;
    // angle of E E0^T: trace = 1 + 2 cos(angle)
    let tr = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tr += E[r * 3 + c] * a.E0[r * 3 + c];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  }

  get motionHoldMs() {
    return Number(this.cfg.motionHold ?? MOTION_HOLD_MS) || 0;
  }

  /** The picture placed from the phone's current orientation and the last tag pose (phone assumed not to have moved). */
  _heldMatrix(now) {
    const E = this.motion && this.sensorsOk ? this.motion() : null;
    if (!E) return null;
    const R = mul9(E, this.holdAnchor.Rwe);
    const C = this.holdAnchor.C;
    const t = [0, 1, 2].map((r) => -(R[r * 3] * C[0] + R[r * 3 + 1] * C[1] + R[r * 3 + 2] * C[2]));
    const corners = this.setup.opening;
    const K = this.Kreal;
    const projected = corners.map(([X, Y]) => projectPoint(R, t, K, X, Y, 0));
    if (projected.some((p) => !(p[2] > 0))) return null; // turned away
    const view = solvePlanarPose(corners, projected.map(([u, v]) => [u, v]), this.K);
    if (!view) return null;
    const raw = anchorMatrixFromMvt(this.controller, this.post, view.mvt);
    return new THREE.Matrix4().fromArray(this.motionFilter.filter(now, raw.elements));
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
