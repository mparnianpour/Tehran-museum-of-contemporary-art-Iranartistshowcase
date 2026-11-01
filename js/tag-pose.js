// Pose maths for holding the picture with AprilTags, in MindAR's conventions:
//
// - "marker" coordinates are tracking-image pixels (x right, y down, z = 0)
// - a model-view transform (mvt) is a 3x4 [R | t] taking marker coordinates
//   to camera coordinates (x right, y down, z forward), as in OpenCV
// - K is MindAR's camera matrix (controller.projectionTransform)
//
// A tag pose expressed this way goes through MindAR's own getWorldMatrix()
// and postMatrix, so it lands exactly where MindAR would put the picture.

import * as THREE from 'three';
import { solveHomographyLS, invertHomography, applyHomography, mul3 } from './homography.js';

const flatK = (K) => [K[0][0], K[0][1], K[0][2], K[1][0], K[1][1], K[1][2], K[2][0], K[2][1], K[2][2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Where the wall plane sits for the camera, from tag corners.
 *
 * world: [[X, Y]] marker pixels; image: [[u, v]] camera-input pixels; K: 3x3 rows.
 * Returns { mvt, error } or null, where error is the RMS corner fit in pixels.
 *
 * The mvt is deliberately not forced to be a rigid rotation: MindAR's camera
 * model assumes a 45 degree field of view, which rarely matches the phone,
 * and squeezing the tag's view into a rigid pose under that model shifts the
 * picture at steep angles (measured: ~7% of the frame width at 60 degrees).
 * Using the plane-to-image homography directly keeps the flat picture exactly
 * where the tag says the wall is, whatever the real camera's lens.
 */
export function solvePlanarPose(world, image, K) {
  if (world.length < 4) return null;
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

  const A = mul3(invertHomography(flatK(K)), H);
  const a1 = [A[0], A[3], A[6]];
  const a2 = [A[1], A[4], A[7]];
  const a3 = [A[2], A[5], A[8]];
  let l = 2 / (norm(a1) + norm(a2));
  if (a3[2] * l < 0) l = -l;
  const c1 = a1.map((v) => v * l);
  const c2 = a2.map((v) => v * l);
  const t = a3.map((v) => v * l);
  for (const [X, Y] of world) if (c1[2] * X + c2[2] * Y + t[2] <= 0) return null; // behind the camera
  const n = cross(c1, c2);
  const s = (norm(c1) + norm(c2)) / 2 / (norm(n) || 1);
  const c3 = n.map((v) => v * s); // only used for the viewing angle; the picture lies at z = 0
  return {
    mvt: [[c1[0], c2[0], c3[0], t[0]], [c1[1], c2[1], c3[1], t[1]], [c1[2], c2[2], c3[2], t[2]]],
    error: Number.isFinite(error) ? error : Infinity,
  };
}

/** MindAR anchor matrix (what MindAR would assign to anchor.group.matrix) from an mvt. */
export function anchorMatrixFromMvt(controller, postMatrix, mvt, rotated = false) {
  let world = controller.getWorldMatrix(mvt, 0);
  if (rotated) world = controller.getRotatedZ90Matrix(world);
  return new THREE.Matrix4().fromArray(world).multiply(postMatrix);
}

/** Inverse of the above: the mvt behind a MindAR anchor matrix. */
export function mvtFromAnchorMatrix(anchorMatrix, postMatrixInverse, markerHeight) {
  const e = anchorMatrix.clone().multiply(postMatrixInverse).elements;
  const M = (r, c) => e[c * 4 + r];
  const h = markerHeight;
  return [
    [M(0, 0), -M(0, 1), -M(0, 2), M(0, 3) + M(0, 1) * h],
    [-M(1, 0), M(1, 1), M(1, 2), -M(1, 3) - M(1, 1) * h],
    [-M(2, 0), M(2, 1), M(2, 2), -M(2, 3) - M(2, 1) * h],
  ];
}

/** Camera-input pixel -> marker-plane point for a given mvt. */
export function imageToMarker(mvt, K, [u, v]) {
  const P = [
    mvt[0][0], mvt[0][1], mvt[0][3],
    mvt[1][0], mvt[1][1], mvt[1][3],
    mvt[2][0], mvt[2][1], mvt[2][3],
  ];
  const Hm = mul3(flatK(K), P);
  return applyHomography(invertHomography(Hm), u, v);
}

/** Angle (degrees) between the line of sight and the wall's normal, from an anchor matrix. */
export function viewAngle(anchorMatrix) {
  const e = anchorMatrix.elements;
  const n = [e[8], e[9], e[10]];
  const c = [e[12], e[13], e[14]];
  const cos = Math.abs(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]) / (norm(n) * norm(c) || 1);
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

/** One Euro filter over the 16 elements of a matrix (time in ms), as MindAR uses. */
export class OneEuroMatrixFilter {
  constructor({ minCutOff = 0.001, beta = 0.01, dCutOff = 0.001 } = {}) {
    this.minCutOff = minCutOff;
    this.beta = beta;
    this.dCutOff = dCutOff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = null;
    this.t = 0;
  }

  filter(t, values) {
    if (!this.x) {
      this.x = values.slice();
      this.dx = values.map(() => 0);
      this.t = t;
      return this.x.slice();
    }
    const te = Math.max(1, t - this.t);
    this.t = t;
    const alpha = (cutoff) => {
      const r = 2 * Math.PI * cutoff * te;
      return r / (r + 1);
    };
    const ad = alpha(this.dCutOff);
    for (let i = 0; i < values.length; i++) {
      const dx = (values[i] - this.x[i]) / te;
      this.dx[i] = ad * dx + (1 - ad) * this.dx[i];
      const a = alpha(this.minCutOff + this.beta * Math.abs(this.dx[i]));
      this.x[i] = a * values[i] + (1 - a) * this.x[i];
    }
    return this.x.slice();
  }
}
