// Planar homography helpers (3x3 matrices stored row-major as 9-element arrays).
// Used by the viewer (to map the picture onto the frame opening) and by the
// setup tool (to straighten a photo of the frame into a flat tracking image).

/** Solve H such that dst ~ H * src for exactly four point pairs [[x, y], ...]. */
export function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

/** Multiply two 3x3 matrices (row-major, 9 elements). */
export function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

/**
 * Least-squares homography for four or more point pairs (normalised DLT).
 * With exactly four pairs this is the same as solveHomography.
 */
export function solveHomographyLS(src, dst) {
  if (src.length < 4) throw new Error('Need at least four point pairs');
  if (src.length === 4) return solveHomography(src, dst);
  const normaliser = (pts) => {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length;
    cy /= pts.length;
    let d = 0;
    for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
    const s = Math.SQRT2 / (d / pts.length || 1);
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  };
  const Ts = normaliser(src);
  const Td = normaliser(dst);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, b) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * b;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const [x, y] = applyHomography(Ts, src[i][0], src[i][1]);
    const [u, v] = applyHomography(Td, dst[i][0], dst[i][1]);
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const Hn = [...solveLinear(AtA, Atb), 1];
  const H = mul3(mul3(invertHomography(Td), Hn), Ts);
  return H.map((v) => v / H[8]);
}

/** Apply homography H to point (x, y). */
export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** The homogeneous w of (x, y) under H; positive means the point is in front. */
export function homographyW(H, x, y) {
  return H[6] * x + H[7] * y + H[8];
}

/** Invert a 3x3 matrix. */
export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Homography is not invertible');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det);
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, r) => [...row, b[r]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error('Corner points are degenerate (three of them may be on one line)');
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= factor * M[col][k];
    }
  }
  return M.map((row, r) => row[n] / row[r]);
}

/** Rough width/height ratio of a quad (TL, TR, BR, BL) from its side lengths. */
export function estimateQuadAspect(q) {
  const dist = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return w / h;
}
