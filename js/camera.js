// Real 3D camera geometry for planes seen by a phone camera. No three.js here,
// so the setup tool can use it too. Matrices are row-major 9-element arrays,
// camera matrices K are 3x3 row arrays; marker coordinates are tracking-image
// pixels with x right, y down and z pointing into the wall.

import { invertHomography, mul3 } from './homography.js';

const flatK = (K) => [K[0][0], K[0][1], K[0][2], K[1][0], K[1][1], K[1][2], K[2][0], K[2][1], K[2][2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/* ---------- real 3D geometry, for tags that are not on the picture's plane ----------
 *
 * Tags fixed on the wall around a deep frame sit behind the opening's edge.
 * From the side, that depth shifts the opening relative to the tags
 * (parallax), so treating them as one flat plane would slide the picture
 * sideways. Undoing it needs the phone's real focal length, which a tag seen
 * at an angle reveals (see focalFromHomography).
 */

/** Nearest rotation matrix (polar decomposition by Higham iteration). R: 9 elements, row-major. */
function orthonormalize(R) {
  let X = R.slice();
  for (let i = 0; i < 20; i++) {
    const inv = invertHomography(X); // general 3x3 inverse
    const invT = [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
    const next = X.map((v, k) => 0.5 * (v + invT[k]));
    const diff = next.reduce((s, v, k) => s + Math.abs(v - X[k]), 0);
    X = next;
    if (diff < 1e-12) break;
  }
  return X;
}

/** Camera matrix rows for focal f and principal point (cx, cy). */
export function cameraMatrix(f, cx, cy) {
  return [[f, 0, cx], [0, f, cy], [0, 0, 1]];
}

/** Rigid pose { R (row-major 9), t } of the plane z = 0 from its plane-to-image homography. */
export function decomposeHomography(H, K) {
  const A = mul3(invertHomography(flatK(K)), H);
  const a1 = [A[0], A[3], A[6]];
  const a2 = [A[1], A[4], A[7]];
  const a3 = [A[2], A[5], A[8]];
  let l = 2 / (norm(a1) + norm(a2));
  if (a3[2] * l < 0) l = -l;
  const r1 = a1.map((v) => v * l);
  const r2 = a2.map((v) => v * l);
  const t = a3.map((v) => v * l);
  const r3 = cross(r1, r2);
  const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  return { R, t };
}

/**
 * Focal length (pixels) from a plane-to-image homography, assuming square
 * pixels and the principal point at (cx, cy). Uses the two constraints a
 * homography puts on the camera (Zhang's calibration with one unknown).
 * Returns null when the plane is seen too square-on to tell.
 */
export function focalFromHomography(H, cx, cy) {
  const a = [H[0] - cx * H[6], H[3] - cy * H[6], H[6]];
  const b = [H[1] - cx * H[7], H[4] - cy * H[7], H[7]];
  const c1 = a[0] * b[0] + a[1] * b[1];
  const d1 = a[2] * b[2];
  const c2 = a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1];
  const d2 = a[2] * a[2] - b[2] * b[2];
  const den = c1 * c1 + c2 * c2;
  if (!(den > 0)) return null;
  const w = -(c1 * d1 + c2 * d2) / den; // 1 / f^2
  if (!(w > 0)) return null;
  const f = 1 / Math.sqrt(w);
  // How strongly perspective shows: roughly tan(viewing angle). Too little, and f is noise.
  const tilt = (Math.hypot(a[2], b[2]) * f) / Math.sqrt((a[0] ** 2 + a[1] ** 2 + b[0] ** 2 + b[1] ** 2) / 2);
  return tilt > 0.3 ? f : null;
}

/** Project marker point (X, Y, Z) to the image. Returns [u, v, depth]. */
export function projectPoint(R, t, K, X, Y, Z) {
  const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
  const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
  const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  return [K[0][0] * (x / z) + K[0][2], K[1][1] * (y / z) + K[1][2], z];
}

/** Image pixel -> marker point on the plane z = Z (z points into the wall). */
export function imageToPlane(R, t, K, [u, v], Z) {
  const d = [(u - K[0][2]) / K[0][0], (v - K[1][2]) / K[1][1], 1];
  // Camera centre and ray direction in marker coordinates (R is a rotation: inverse = transpose).
  const C = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  const D = [
    R[0] * d[0] + R[3] * d[1] + R[6] * d[2],
    R[1] * d[0] + R[4] * d[1] + R[7] * d[2],
    R[2] * d[0] + R[5] * d[1] + R[8] * d[2],
  ];
  const s = (Z - C[2]) / D[2];
  return [C[0] + s * D[0], C[1] + s * D[1]];
}
