/* AprilTag detection worker (classic worker script).
 *
 * Detects tag36h11 markers with js-aruco2, then refines each corner to
 * sub-pixel accuracy by fitting straight lines to the tag's outer edges.
 * Without the refinement, corners snap to whole pixels and the picture
 * visibly trembles when it is held by the tag.
 *
 * In:  { seq, width, height, buffer (RGBA ArrayBuffer), family, maxHamming }
 * Out: { seq, markers: [{ id, corners: [[x, y] x4], hamming }], buffer }
 */

importScripts('../vendor/js-aruco2/cv.js', '../vendor/js-aruco2/aruco.js', '../vendor/js-aruco2/dictionaries/apriltag_36h11.js');

const DICTIONARIES = { tag36h11: 'APRILTAG_36h11' };
let detector = null;
let detectorKey = '';

onmessage = (e) => {
  const { seq, width, height, buffer, family = 'tag36h11', maxHamming = 3 } = e.data;
  const key = `${family}:${maxHamming}`;
  if (key !== detectorKey) {
    detector = new AR.Detector({ dictionaryName: DICTIONARIES[family] || family, maxHammingDistance: maxHamming });
    detectorKey = key;
  }
  let markers = [];
  try {
    markers = detector.detect({ width, height, data: new Uint8ClampedArray(buffer) });
  } catch (err) {
    postMessage({ seq, error: String(err), markers: [], buffer }, [buffer]);
    return;
  }
  const grey = detector.grey;
  const found = markers.map((m) => {
    const raw = m.corners.map((c) => [c.x, c.y]);
    const refined = refineQuad(grey, raw);
    return { id: m.id, corners: refined || raw, refined: !!refined, hamming: m.hammingDistance };
  });
  postMessage({ seq, markers: dedupe(found), buffer }, [buffer]);
};

/**
 * The same tag can be found twice (its outer edge and a slightly smaller
 * contour just inside it). Counting it twice skews the pose, so keep one:
 * the refined one, else the larger.
 */
function dedupe(markers) {
  const centre = (c) => [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
  const size = (c) => Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]);
  const kept = [];
  for (const m of markers) {
    const [mx, my] = centre(m.corners);
    const twin = kept.findIndex((k) => {
      if (k.id !== m.id) return false;
      const [kx, ky] = centre(k.corners);
      return Math.hypot(mx - kx, my - ky) < 0.25 * Math.max(size(k.corners), size(m.corners));
    });
    if (twin < 0) kept.push(m);
    else {
      const k = kept[twin];
      const better = (m.refined && !k.refined) || (m.refined === k.refined && size(m.corners) > size(k.corners));
      if (better) kept[twin] = m;
    }
  }
  return kept;
}

function sample(g, x, y) {
  const w = g.width;
  const h = g.height;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const d = g.data;
  const top = d[i] + (d[i + 1] - d[i]) * fx;
  const bottom = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
  return top + (bottom - top) * fy;
}

/** Total-least-squares line through points: { cx, cy, dx, dy }. */
function fitLine(pts) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(angle), dy: Math.sin(angle) };
}

function intersect(a, b) {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const s = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / det;
  return [a.cx + a.dx * s, a.cy + a.dy * s];
}

/** Sub-pixel corners from the strongest intensity edge along each side of the quad. */
function refineQuad(g, q) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 10) return null;
    const nx = -ey / len;
    const ny = ex / len;
    // Stay well inside one cell of the 8-cell black border so the inner edge isn't picked up.
    const range = Math.max(1.5, Math.min(6, len * 0.07));
    const step = 0.5;
    const count = Math.max(6, Math.min(30, Math.floor(len / 3)));
    const pts = [];
    for (let s = 0; s < count; s++) {
      const t = 0.12 + (0.76 * (s + 0.5)) / count;
      const px = a[0] + ex * t;
      const py = a[1] + ey * t;
      const vals = [];
      for (let k = -range; k <= range + 1e-6; k += step) vals.push(sample(g, px + nx * k, py + ny * k));
      let bi = -1;
      let bv = 0;
      for (let j = 2; j < vals.length - 2; j++) {
        const d = Math.abs(vals[j + 1] - vals[j - 1]);
        if (d > bv) { bv = d; bi = j; }
      }
      if (bi < 0 || bv < 16) continue;
      const d0 = Math.abs(vals[bi] - vals[bi - 2]);
      const d2 = Math.abs(vals[bi + 2] - vals[bi]);
      const denom = d0 - 2 * bv + d2;
      let off = denom !== 0 ? (0.5 * (d0 - d2)) / denom : 0;
      off = Math.max(-1, Math.min(1, off));
      const k = -range + (bi + off) * step;
      pts.push([px + nx * k, py + ny * k]);
    }
    if (pts.length < 5) return null;
    lines.push(fitLine(pts));
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    const limit = Math.max(2.5, 0.05 * Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
    if (Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > limit) return null;
    out.push(p);
  }
  return out;
}
