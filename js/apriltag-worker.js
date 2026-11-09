/* AprilTag detection worker (classic worker script).
 *
 * Detects tag36h11 markers with js-aruco2, then refines each corner to
 * sub-pixel accuracy by fitting straight lines to the tag's outer edges.
 * Without the refinement, corners snap to whole pixels and the picture
 * visibly trembles when it is held by the tag.
 *
 * It can also find the outline of a plain bright panel (findOutline below),
 * so a panel with clear edges all round can hold the picture without tags.
 *
 * In:  { seq, width, height, buffer (RGBA ArrayBuffer), family, maxHamming, tags = true, outline: { roll } | null }
 * Out: { seq, markers: [{ id, corners: [[x, y] x4], hamming }], outlines: [{ corners, partial }], buffer }
 */

importScripts('../vendor/js-aruco2/cv.js', '../vendor/js-aruco2/aruco.js', '../vendor/js-aruco2/dictionaries/apriltag_36h11.js');

const DICTIONARIES = { tag36h11: 'APRILTAG_36h11' };
let detector = null;
let detectorKey = '';

onmessage = (e) => {
  const { seq, width, height, buffer, family = 'tag36h11', maxHamming = 3, tags = true, outline = null } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let found = [];
  if (tags) {
    const key = `${family}:${maxHamming}`;
    if (key !== detectorKey) {
      detector = new AR.Detector({ dictionaryName: DICTIONARIES[family] || family, maxHammingDistance: maxHamming });
      detectorKey = key;
    }
    let markers = [];
    try {
      markers = detector.detect({ width, height, data });
    } catch (err) {
      postMessage({ seq, error: String(err), markers: [], outlines: [], buffer }, [buffer]);
      return;
    }
    const grey = detector.grey;
    found = markers.map((m) => {
      const raw = m.corners.map((c) => [c.x, c.y]);
      const refined = refineQuad(grey, raw);
      return { id: m.id, corners: refined || raw, refined: !!refined, hamming: m.hammingDistance };
    });
  }
  let outlines = [];
  if (outline) {
    try {
      outlines = findOutlines(data, width, height, outline.roll || 0);
    } catch (err) {
      outlines = [];
    }
  }
  postMessage({ seq, markers: dedupe(found), outlines, buffer }, [buffer]);
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

/* ---------- plain bright panel: its outline ---------- */

/** Otsu's threshold over histogram bins [lo, 255]; returns { T, gap } (gap: difference of the two class means). */
function otsu(hist, lo = 0) {
  let total = 0;
  let sumAll = 0;
  for (let v = lo; v < 256; v++) { total += hist[v]; sumAll += v * hist[v]; }
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let T = lo;
  let gap = 0;
  for (let v = lo; v < 256; v++) {
    wB += hist[v];
    if (!wB || wB === total) continue;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) * (mB - mF);
    if (between > best) { best = between; T = v; gap = mF - mB; }
  }
  return { T, gap };
}

/**
 * Candidate outlines of a plain bright panel: the largest bright, nearly
 * convex four-sided region, for two brightness splits: bright vs dark, and,
 * when a lit wall beside the panel is nearly as bright, the brightest part
 * only. Each is { corners, partial }: corners as seen upright (top-left,
 * top-right, bottom-right, bottom-left), refined to sub-pixel accuracy on the
 * full image; `partial` when a side runs along the edge of the image (the
 * panel doesn't fit on screen). The viewer checks them against the panel's
 * known shape. `roll`: the phone's turn about its viewing axis (radians).
 */
function findOutlines(rgba, w, h, roll) {
  const n = w * h;
  const grey = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) grey[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  const s = Math.max(1, Math.ceil(Math.max(w, h) / 320));
  const gw = Math.floor(w / s);
  const gh = Math.floor(h / s);
  const small = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let acc = 0;
      for (let dy = 0; dy < s; dy++) {
        const row = (y * s + dy) * w + x * s;
        for (let dx = 0; dx < s; dx++) acc += grey[row + dx];
      }
      small[y * gw + x] = acc / (s * s);
    }
  }
  const hist = new Float64Array(256);
  for (let i = 0; i < small.length; i++) hist[small[i] | 0] += 1;
  const first = otsu(hist);
  if (first.gap < 40) return [];
  const thresholds = [first.T];
  const second = otsu(hist, first.T + 1);
  if (second.gap >= 35) thresholds.push(second.T);
  const out = [];
  for (const T of thresholds) {
    const r = outlineAt(grey, small, w, h, gw, gh, s, T, roll);
    if (r) out.push(r);
  }
  return out;
}

function outlineAt(grey, small, w, h, gw, gh, s, T, roll) {
  // 3. The largest bright connected region.
  const label = new Int32Array(gw * gh).fill(-1);
  const stack = new Int32Array(gw * gh);
  let bestLabel = -1;
  let bestArea = 0;
  let comp = 0;
  for (let i = 0; i < gw * gh; i++) {
    if (label[i] !== -1 || small[i] <= T) continue;
    let top = 0;
    stack[top++] = i;
    label[i] = comp;
    let area = 0;
    while (top) {
      const k = stack[--top];
      area++;
      const x = k % gw;
      const y = (k / gw) | 0;
      if (x > 0 && label[k - 1] === -1 && small[k - 1] > T) { label[k - 1] = comp; stack[top++] = k - 1; }
      if (x < gw - 1 && label[k + 1] === -1 && small[k + 1] > T) { label[k + 1] = comp; stack[top++] = k + 1; }
      if (y > 0 && label[k - gw] === -1 && small[k - gw] > T) { label[k - gw] = comp; stack[top++] = k - gw; }
      if (y < gh - 1 && label[k + gw] === -1 && small[k + gw] > T) { label[k + gw] = comp; stack[top++] = k + gw; }
    }
    if (area > bestArea) { bestArea = area; bestLabel = comp; }
    comp++;
  }
  if (bestArea < 0.03 * gw * gh) return null;

  // 4. Its outer boundary: the first and last pixel of each row and column.
  const pts = [];
  for (let y = 0; y < gh; y++) {
    let a = -1; let b = -1;
    for (let x = 0; x < gw; x++) if (label[y * gw + x] === bestLabel) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y]); pts.push([b + 1, y]); }
  }
  for (let x = 0; x < gw; x++) {
    let a = -1; let b = -1;
    for (let y = 0; y < gh; y++) if (label[y * gw + x] === bestLabel) { if (a < 0) a = y; b = y; }
    if (a >= 0) { pts.push([x, a]); pts.push([x, b + 1]); }
  }

  // 5. Four corners: the extreme boundary points along the diagonals, with the phone's roll taken out.
  const c = Math.cos(roll);
  const sn = Math.sin(roll);
  const up = (p) => [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c]; // roll-corrected: +y is down
  const pick = (score) => pts.reduce((bp, p) => (score(up(p)) > score(up(bp)) ? p : bp), pts[0]);
  let q = [pick(([x, y]) => -x - y), pick(([x, y]) => x - y), pick(([x, y]) => x + y), pick(([x, y]) => -x + y)];

  // 6. A straight line along each side, from the boundary points between its corners.
  const onBorder = (p) => p[0] <= 1 || p[1] <= 1 || p[0] >= gw - 1 || p[1] >= gh - 1;
  let partial = false;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 8) return null;
    const side = pts.filter((p) => {
      const t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (len * len);
      const d = Math.abs((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / len;
      return t > 0.12 && t < 0.88 && d < 3;
    });
    if (side.length < 6) return null;
    if (side.filter(onBorder).length > 0.4 * side.length) partial = true;
    lines.push(fitLine(side));
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    corners.push(p);
  }
  // Nearly the whole region should be inside the four sides (a convex quad, not a blob).
  const quadArea = Math.abs(corners.reduce((acc, p, i) => {
    const r = corners[(i + 1) % 4];
    return acc + p[0] * r[1] - r[0] * p[1];
  }, 0)) / 2;
  if (!(quadArea > 0) || bestArea / quadArea < 0.85 || bestArea / quadArea > 1.08) return null;

  // 7. Refine each side on the full image: strongest bright-to-dark step going outwards.
  const full = corners.map(([x, y]) => [x * s, y * s]);
  const g = { width: w, height: h, data: grey };
  const cx = (full[0][0] + full[1][0] + full[2][0] + full[3][0]) / 4;
  const cy = (full[0][1] + full[1][1] + full[2][1] + full[3][1]) / 4;
  const refinedLines = [];
  for (let i = 0; i < 4; i++) {
    const a = full[i];
    const b = full[(i + 1) % 4];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    let nx = -ey / len;
    let ny = ex / len;
    if ((a[0] + b[0]) / 2 * nx + (a[1] + b[1]) / 2 * ny < cx * nx + cy * ny) { nx = -nx; ny = -ny; } // point outwards
    const range = Math.max(3, 1.5 * s);
    const ptsFull = [];
    for (let k = 0; k < 32; k++) {
      const t = 0.08 + (0.84 * (k + 0.5)) / 32;
      const px = a[0] + ex * t;
      const py = a[1] + ey * t;
      if (px < 2 || py < 2 || px > w - 3 || py > h - 3) continue;
      let bi = 0; let bv = 0; const step = 0.5; const vals = [];
      for (let d = -range; d <= range + 1e-6; d += step) vals.push(sample(g, px + nx * d, py + ny * d));
      for (let j = 2; j < vals.length - 2; j++) {
        const v = vals[j - 1] - vals[j + 1]; // inside bright -> outside dark
        if (v > bv) { bv = v; bi = j; }
      }
      if (bv < 12) continue;
      const d0 = vals[bi - 2] - vals[bi]; const d2 = vals[bi] - vals[bi + 2];
      const den = d0 - 2 * bv + d2;
      const off = den ? Math.max(-1, Math.min(1, (0.5 * (d0 - d2)) / den)) : 0;
      const d = -range + (bi + off) * step;
      ptsFull.push([px + nx * d, py + ny * d]);
    }
    refinedLines.push(ptsFull.length >= 8 ? fitLine(ptsFull) : { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, dx: ex / len, dy: ey / len });
  }
  let out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(refinedLines[(i + 3) % 4], refinedLines[i]);
    if (!p || Math.hypot(p[0] - full[i][0], p[1] - full[i][1]) > 3 * s) { out = full; break; }
    out.push(p);
  }
  // 8. A plain panel is evenly bright from side to side (a shadow band across it is fine). A lit side
  //    wall or pillar taken in by mistake shows as a whole column clearly darker than the rest.
  const evenness = columnEvenness(g, out);
  if (evenness < 0.8) return null;
  return { corners: out, partial, evenness: Math.round(evenness * 1000) / 1000 };
}

/** How evenly bright the quad is from side to side: 1 = every column alike (inset a little from its sides). */
function columnEvenness(g, q) {
  const cols = 24;
  const rows = 17;
  const at = (u, v) => {
    // bilinear point in the quad: u across (left -> right), v down
    const top = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
    const bot = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
    return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
  };
  const medians = [];
  for (let c = 0; c < cols; c++) {
    const u = 0.06 + (0.88 * (c + 0.5)) / cols;
    const vals = [];
    for (let r = 0; r < rows; r++) {
      const [x, y] = at(u, 0.06 + (0.88 * (r + 0.5)) / rows);
      if (x >= 0 && y >= 0 && x <= g.width - 1 && y <= g.height - 1) vals.push(sample(g, x, y));
    }
    if (vals.length >= 5) {
      vals.sort((a, b) => a - b);
      medians.push(vals[vals.length >> 1]);
    }
  }
  if (medians.length < cols / 2) return 0;
  // the darkest stretch of three neighbouring columns (a wall or pillar strip), against the typical column
  // (a slightly shadowed edge column alone doesn't count)
  const typical = [...medians].sort((a, b) => a - b)[medians.length >> 1];
  let darkest = Infinity;
  for (let i = 0; i + 3 <= medians.length; i++) darkest = Math.min(darkest, (medians[i] + medians[i + 1] + medians[i + 2]) / 3);
  return darkest / typical;
}
