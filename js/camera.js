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

/* ---------- tags anywhere, at any angle: full 3D ----------
 *
 * A tag's corners can be stored as 3D points in the picture's frame
 * (tracking-image px; z into the wall). The setup tool measures them from
 * the setup photo; the viewer then solves the phone's pose from whichever
 * tags it sees, whatever surface they are on.
 */

const solveHomography4 = (src, dst) => {
  // local copy to avoid a circular import; same maths as homography.solveHomography
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const M = A.map((row, r) => [...row, b[r]]);
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= 8; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [...M.map((row, r) => row[8] / row[r]), 1];
};

/** The square a tag's 3D corners span: origin, unit axes (x along the top edge, y down the side) and side length. */
export function squareFrame(c) {
  const sub = (a, b2) => [a[0] - b2[0], a[1] - b2[1], a[2] - b2[2]];
  const ex0 = sub(c[1], c[0]);
  const ey0 = sub(c[3], c[0]);
  const size = (norm(ex0) + norm(ey0)) / 2;
  const ex = ex0.map((v) => v / norm(ex0));
  // Gram-Schmidt: make ey exactly perpendicular to ex
  const d = ex[0] * ey0[0] + ex[1] * ey0[1] + ex[2] * ey0[2];
  let ey = [ey0[0] - d * ex[0], ey0[1] - d * ex[1], ey0[2] - d * ex[2]];
  ey = ey.map((v) => v / norm(ey));
  return { origin: c[0], ex, ey, ez: cross(ex, ey), size };
}

/**
 * Pose (R row-major 9, t) of a picture-frame from a tag seen at imageCorners, given its 3D frame.
 * With corners3d (the tag's own 3D corners), its real shape in its plane is used, so a print
 * that came out slightly stretched isn't explained away as a tilted square.
 */
export function poseFromTag(imageCorners, frame, K, corners3d = null) {
  const s = frame.size;
  const o = frame.origin;
  const planar = corners3d
    ? corners3d.map((c) => {
      const d = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
      return [d[0] * frame.ex[0] + d[1] * frame.ex[1] + d[2] * frame.ex[2], d[0] * frame.ey[0] + d[1] * frame.ey[1] + d[2] * frame.ey[2]];
    })
    : [[0, 0], [s, 0], [s, s], [0, s]];
  const H = solveHomography4(planar, imageCorners);
  const { R: Rt, t: tt } = decomposeHomography(H, K); // tag-local -> camera
  // picture -> tag-local: Xl = M^T (Xp - o), with M = [ex ey ez] as columns
  const M = [frame.ex, frame.ey, frame.ez];
  const Rp = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) Rp[r * 3 + c] = Rt[r * 3] * M[0][c] + Rt[r * 3 + 1] * M[1][c] + Rt[r * 3 + 2] * M[2][c];
  }
  const tp = [0, 1, 2].map((r) => tt[r] - (Rp[r * 3] * o[0] + Rp[r * 3 + 1] * o[1] + Rp[r * 3 + 2] * o[2]));
  return { R: Rp, t: tp, H };
}

function rodrigues(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

function solveN(A, b) {
  const n = b.length;
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

/** Refine a pose on 3D points (Levenberg-Marquardt on reprojection error). Returns { R, t, error (RMS px) }. */
export function refinePose3D(points, image, K, R, t, iterations = 10) {
  const residuals = (Rr, tr) => {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const [u, v, z] = projectPoint(Rr, tr, K, points[i][0], points[i][1], points[i][2]);
      if (!(z > 0)) return null;
      out.push(u - image[i][0], v - image[i][1]);
    }
    return out;
  };
  const sq = (r) => r.reduce((s, v) => s + v * v, 0);
  let r = residuals(R, t);
  if (!r) return { R, t, error: Infinity };
  let err = sq(r);
  let lambda = 1e-3;
  const ts = Math.max(1, norm(t));
  const apply = (d) => [mul3(rodrigues([d[0], d[1], d[2]]), R), [t[0] + d[3] * ts, t[1] + d[4] * ts, t[2] + d[5] * ts]];
  for (let it = 0; it < iterations; it++) {
    const J = [];
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0];
      d[k] = 1e-6;
      const [Rk, tk] = apply(d);
      const rk = residuals(Rk, tk);
      if (!rk) return { R, t, error: Math.sqrt(err / r.length) };
      J.push(rk.map((v, i) => (v - r[i]) / 1e-6));
    }
    const JtJ = J.map((a) => J.map((b2) => a.reduce((s, v, i) => s + v * b2[i], 0)));
    const Jtr = J.map((a) => a.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const delta = solveN(A, Jtr.map((v) => -v));
      if (!delta) break;
      const [Rn, tn] = apply(delta);
      const rn = residuals(Rn, tn);
      if (rn && sq(rn) < err) {
        R = orthonormalize(Rn);
        t = tn;
        r = residuals(R, t) || rn;
        const e2 = sq(r);
        const gain = err - e2;
        err = e2;
        lambda = Math.max(1e-9, lambda / 10);
        improved = true;
        if (gain < 1e-8) it = iterations;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return { R, t, error: Math.sqrt(err / r.length) };
}

/**
 * Focal length in pixels from a 35 mm-equivalent focal length (EXIF
 * FocalLengthIn35mmFilm). Phones quote it for their full 4:3 sensor, and
 * wide photos are crops of its height, so the long side sets the scale.
 */
export function focalFrom35mm(f35, width, height) {
  const long = Math.max(width, height);
  return (f35 * Math.hypot(long, 0.75 * long)) / Math.hypot(36, 24);
}

/* ---------- upright pose: which way is down is known (phone motion sensor) ---------- */

/** Rotation (row-major 9) that takes the picture's down axis (+y) to `down`, given in camera coordinates. */
export function uprightBasis(down) {
  const d = down.map((v) => v / norm(down));
  const axis = cross([0, 1, 0], d);
  const s = norm(axis);
  const c = d[1];
  if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  return rodrigues(axis.map((v) => (v / s) * Math.atan2(s, c)));
}

const turnY = (th) => [Math.cos(th), 0, Math.sin(th), 0, 1, 0, -Math.sin(th), 0, Math.cos(th)];

/** The turn about the vertical that brings uprightBasis R0 closest to pose rotation R. */
export function uprightAngle(R0, R) {
  // M = R0^T R should be a pure turn about y: [c 0 s; 0 1 0; -s 0 c]
  const m00 = R0[0] * R[0] + R0[3] * R[3] + R0[6] * R[6];
  const m02 = R0[0] * R[2] + R0[3] * R[5] + R0[6] * R[8];
  const m20 = R0[2] * R[0] + R0[5] * R[3] + R0[8] * R[6];
  const m22 = R0[2] * R[2] + R0[5] * R[5] + R0[8] * R[8];
  return Math.atan2(m02 - m20, m00 + m22);
}

/**
 * Like refinePose3D, but the picture stays upright: R = R0 * turnY(theta),
 * so only the turn about the vertical and the position are solved (4 unknowns).
 */
export function refinePoseUpright(points, image, K, R0, theta, t, iterations = 15) {
  const pose = (p) => ({ R: mul3(R0, turnY(p[0])), t: [p[1], p[2], p[3]] });
  const residuals = (p) => {
    const { R, t: tt } = pose(p);
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const [u, v, z] = projectPoint(R, tt, K, points[i][0], points[i][1], points[i][2]);
      if (!(z > 0)) return null;
      out.push(u - image[i][0], v - image[i][1]);
    }
    return out;
  };
  const sq = (r) => r.reduce((s, v) => s + v * v, 0);
  let p = [theta, t[0], t[1], t[2]];
  let r = residuals(p);
  if (!r) return null;
  let err = sq(r);
  let lambda = 1e-3;
  const ts = Math.max(1, norm(t));
  const steps = [1e-6, 1e-6 * ts, 1e-6 * ts, 1e-6 * ts];
  for (let it = 0; it < iterations; it++) {
    const J = [];
    for (let k = 0; k < 4; k++) {
      const q = [...p];
      q[k] += steps[k];
      const rk = residuals(q);
      if (!rk) return null;
      J.push(rk.map((v, i) => (v - r[i]) / steps[k]));
    }
    // scale-free normal equations: parameters in units of their step
    const JtJ = J.map((a) => J.map((b2) => a.reduce((s, v, i) => s + v * b2[i], 0)));
    const Jtr = J.map((a) => a.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const delta = solveN(A, Jtr.map((v) => -v));
      if (!delta) break;
      const q = p.map((v, i) => v + delta[i]);
      const rn = residuals(q);
      if (rn && sq(rn) < err) {
        const gain = err - sq(rn);
        p = q;
        r = rn;
        err = sq(rn);
        lambda = Math.max(1e-9, lambda / 10);
        improved = true;
        if (gain < 1e-8) it = iterations;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return { ...pose(p), theta: p[0], error: Math.sqrt(err / r.length) };
}
