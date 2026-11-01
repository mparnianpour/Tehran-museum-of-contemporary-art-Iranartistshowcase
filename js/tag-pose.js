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

/** Nearest rotation matrix (polar decomposition by Higham iteration). R: 9 elements, row-major. */
function orthonormalize(R) {
  let X = R.slice();
  for (let i = 0; i < 12; i++) {
    const inv = invertHomography(X); // general 3x3 inverse
    const invT = [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
    const next = X.map((v, k) => 0.5 * (v + invT[k]));
    const diff = next.reduce((s, v, k) => s + Math.abs(v - X[k]), 0);
    X = next;
    if (diff < 1e-10) break;
  }
  return X;
}

/** Rotation matrix from a rotation vector (Rodrigues). */
function rodrigues(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

function project(R, t, K, X, Y) {
  const x = R[0] * X + R[1] * Y + t[0];
  const y = R[3] * X + R[4] * Y + t[1];
  const z = R[6] * X + R[7] * Y + t[2];
  return [K[0][0] * (x / z) + K[0][2], K[1][1] * (y / z) + K[1][2], z];
}

function residuals(R, t, K, world, image) {
  const r = [];
  for (let i = 0; i < world.length; i++) {
    const [u, v, z] = project(R, t, K, world[i][0], world[i][1]);
    if (z <= 0) return null;
    r.push(u - image[i][0], v - image[i][1]);
  }
  return r;
}

const sumSq = (r) => r.reduce((s, v) => s + v * v, 0);

function solve6(A, b) {
  const n = 6;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Levenberg-Marquardt refinement of [R|t] on reprojection error. */
function refinePose(R, t, K, world, image, iterations = 8) {
  let r = residuals(R, t, K, world, image);
  if (!r) return { R, t, error: Infinity };
  let err = sumSq(r);
  let lambda = 1e-3;
  const tScale = Math.max(1, norm(t));
  for (let it = 0; it < iterations; it++) {
    const params = (d) => {
      const Rn = mul3(rodrigues([d[0], d[1], d[2]]), R);
      return [Rn, [t[0] + d[3] * tScale, t[1] + d[4] * tScale, t[2] + d[5] * tScale]];
    };
    const J = [];
    const eps = 1e-6;
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0];
      d[k] = eps;
      const [Rk, tk] = params(d);
      const rk = residuals(Rk, tk, K, world, image);
      if (!rk) return { R, t, error: Math.sqrt(err / r.length) };
      J.push(rk.map((v, i) => (v - r[i]) / eps));
    }
    const JtJ = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => J[i].reduce((s, v, n) => s + v * J[j][n], 0)));
    const Jtr = J.map((col) => col.reduce((s, v, n) => s + v * r[n], 0));
    let improved = false;
    for (let tries = 0; tries < 5 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const delta = solve6(A, Jtr.map((v) => -v));
      if (!delta) break;
      const [Rn, tn] = params(delta);
      const rn = residuals(Rn, tn, K, world, image);
      if (rn && sumSq(rn) < err) {
        R = orthonormalize(Rn);
        t = tn;
        r = residuals(R, t, K, world, image) || rn;
        const newErr = sumSq(r);
        const gain = err - newErr;
        err = newErr;
        lambda = Math.max(1e-7, lambda / 10);
        improved = true;
        if (gain < 1e-6) it = iterations;
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  return { R, t, error: Math.sqrt(err / r.length) };
}

/**
 * Camera pose of the marker plane from point pairs.
 * world: [[X, Y]] marker pixels; image: [[u, v]] camera-input pixels; K: 3x3 rows.
 * Returns { mvt, error (RMS px) } or null.
 */
export function solvePlanarPose(world, image, K) {
  if (world.length < 4) return null;
  let H;
  try {
    H = solveHomographyLS(world, image);
  } catch (err) {
    return null;
  }
  const A = mul3(invertHomography(flatK(K)), H);
  const a1 = [A[0], A[3], A[6]];
  const a2 = [A[1], A[4], A[7]];
  const a3 = [A[2], A[5], A[8]];
  let l = 2 / (norm(a1) + norm(a2));
  if (a3[2] * l < 0) l = -l;
  const r1 = a1.map((v) => v * l);
  const r2 = a2.map((v) => v * l);
  const t0 = a3.map((v) => v * l);
  const r3 = cross(r1, r2);
  const R0 = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  const { R, t, error } = refinePose(R0, t0, K, world, image);
  if (!Number.isFinite(error) || t[2] <= 0) return null;
  return {
    mvt: [[R[0], R[1], R[2], t[0]], [R[3], R[4], R[5], t[1]], [R[6], R[7], R[8], t[2]]],
    error,
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
