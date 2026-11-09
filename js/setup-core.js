// Core of the setup tool: turns a photo of a frame + its four inner corners
// into a straightened tracking image, compiles it for MindAR, and packages
// the result. No UI code here.

import { solveHomography, applyHomography, homographyW, estimateQuadAspect, invertHomography } from './homography.js';
import { cameraMatrix, decomposeHomography, imageToPlane, focalFromHomography, focalFrom35mm } from './camera.js';

// Typical phone main camera: focal length about 0.7 x the photo's long side.
// Only used to correct wall tags for depth, where a rough value is enough.
const PHOTO_FOCAL = 0.7;

export const TARGET_LONG_SIDE = 1024;

export const RATIO_PRESETS = [
  { label: '2:3', w: 2, h: 3 },
  { label: '3:4', w: 3, h: 4 },
  { label: '4:5', w: 4, h: 5 },
  { label: '1:1', w: 1, h: 1 },
  { label: 'A4/A3', w: 1, h: Math.SQRT2 },
  { label: '3:2', w: 3, h: 2 },
  { label: '4:3', w: 4, h: 3 },
];

export { estimateQuadAspect };

/** True when the corners form a convex quad ordered TL, TR, BR, BL (clockwise on screen). */
export function isValidQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign > 0;
}

/**
 * Layout of the straightened tracking image.
 * corners: opening corners in photo pixels (TL, TR, BR, BL)
 * aspect:  opening width / height
 * margin:  frame + wall kept around the opening, as a fraction of the opening width
 */
export function computeLayout({ corners, aspect, margin, longSide = TARGET_LONG_SIDE }) {
  const unitW = 1 + 2 * margin;
  const unitH = 1 / aspect + 2 * margin;
  const ow = longSide / Math.max(unitW, unitH);
  const oh = ow / aspect;
  const m = margin * ow;
  const width = Math.round(ow * unitW);
  const height = Math.round(ow * unitH);
  const opening = [[m, m], [m + ow, m], [m + ow, m + oh], [m, m + oh]];
  const toPhoto = solveHomography(opening, corners);
  return { width, height, opening, toPhoto, openingWidth: ow, openingHeight: oh };
}

/** Does the whole tracking image fall inside the photo? */
export function layoutFits(layout, photoW, photoH) {
  const { width, height, toPhoto, opening } = layout;
  const cx = (opening[0][0] + opening[2][0]) / 2;
  const cy = (opening[0][1] + opening[2][1]) / 2;
  const sign = Math.sign(homographyW(toPhoto, cx, cy));
  for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
    if (Math.sign(homographyW(toPhoto, x, y)) !== sign) return false;
    const [px, py] = applyHomography(toPhoto, x, y);
    if (px < 0 || py < 0 || px > photoW || py > photoH) return false;
  }
  return true;
}

/** Largest margin (0..0.6) that still keeps the tracking image inside the photo. */
export function maxMargin({ corners, aspect }, photoW, photoH) {
  if (!layoutFits(computeLayout({ corners, aspect, margin: 0 }), photoW, photoH)) return 0;
  let lo = 0;
  let hi = 0.6;
  if (layoutFits(computeLayout({ corners, aspect, margin: hi }), photoW, photoH)) return hi;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (layoutFits(computeLayout({ corners, aspect, margin: mid }), photoW, photoH)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Straighten the photo into the tracking image described by layout. Returns a canvas. */
export function warpToTarget(photo, layout) {
  const { width, height, openingWidth } = layout;
  let { toPhoto } = layout;
  const photoW = photo.naturalWidth || photo.width;
  const photoH = photo.naturalHeight || photo.height;

  // Pre-shrink large photos so the warp samples a similar resolution (less aliasing).
  const [tlx, tly] = applyHomography(toPhoto, layout.opening[0][0], layout.opening[0][1]);
  const [trx, try_] = applyHomography(toPhoto, layout.opening[1][0], layout.opening[1][1]);
  const photoOpeningW = Math.hypot(trx - tlx, try_ - tly);
  const s = Math.min(1, (1.3 * openingWidth) / photoOpeningW);
  const sw = Math.max(1, Math.round(photoW * s));
  const sh = Math.max(1, Math.round(photoH * s));
  const src = document.createElement('canvas');
  src.width = sw;
  src.height = sh;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(photo, 0, 0, sw, sh);
  const scaleX = sw / photoW;
  const scaleY = sh / photoH;
  toPhoto = [
    toPhoto[0] * scaleX, toPhoto[1] * scaleX, toPhoto[2] * scaleX,
    toPhoto[3] * scaleY, toPhoto[4] * scaleY, toPhoto[5] * scaleY,
    toPhoto[6], toPhoto[7], toPhoto[8],
  ];

  const srcData = sctx.getImageData(0, 0, sw, sh).data;
  const out = new ImageData(width, height);
  const dst = out.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = toPhoto;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = x + 0.5;
      const ty = y + 0.5;
      const w = h6 * tx + h7 * ty + h8;
      let px = (h0 * tx + h1 * ty + h2) / w - 0.5;
      let py = (h3 * tx + h4 * ty + h5) / w - 0.5;
      px = Math.min(Math.max(px, 0), sw - 1.001);
      py = Math.min(Math.max(py, 0), sh - 1.001);
      const x0 = px | 0;
      const y0 = py | 0;
      const fx = px - x0;
      const fy = py - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = srcData[i00 + c] + (srcData[i10 + c] - srcData[i00 + c]) * fx;
        const bottom = srcData[i01 + c] + (srcData[i11 + c] - srcData[i01 + c]) * fx;
        dst[o + c] = top + (bottom - top) * fy;
      }
      dst[o + 3] = 255;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas;
}

/**
 * Fill the opening with its own median colour, so whatever is inside the frame
 * (a board, the wall, an old picture) can't affect tracking if it changes.
 * A thin strip next to the frame's inner edge is kept so that edge stays crisp.
 */
export function flattenOpening(canvas, layout, inset = 0.012) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const [[x0, y0], , [x1, y1]] = layout.opening;
  const pad = inset * layout.openingWidth;
  const sx = Math.round(x0 + pad);
  const sy = Math.round(y0 + pad);
  const w = Math.round(x1 - x0 - 2 * pad);
  const h = Math.round(y1 - y0 - 2 * pad);
  if (w <= 0 || h <= 0) return canvas;
  const data = ctx.getImageData(sx, sy, w, h).data;
  const channels = [[], [], []];
  for (let i = 0; i < data.length; i += 4 * 7) for (let c = 0; c < 3; c++) channels[c].push(data[i + c]);
  const med = channels.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  ctx.fillStyle = `rgb(${med[0]}, ${med[1]}, ${med[2]})`;
  ctx.fillRect(sx, sy, w, h);
  return canvas;
}

/**
 * AprilTags found in the photo -> their corners in tracking-image pixels.
 * Tags on the wall sit wallOffset behind the opening's edge (tracking-image
 * pixels); seen from where the photo was taken, that depth makes them look
 * slightly closer to the middle, which is undone here.
 */
export function tagsToTarget(photoTags, layout, photoSize, wallOffset = 0) {
  if (!wallOffset) {
    const toTarget = invertHomography(layout.toPhoto);
    return photoTags.map((t) => ({ id: t.id, corners: t.corners.map(([u, v]) => applyHomography(toTarget, u, v)) }));
  }
  const [w, h] = photoSize;
  const K = cameraMatrix(PHOTO_FOCAL * Math.max(w, h), w / 2, h / 2);
  const { R, t } = decomposeHomography(layout.toPhoto, K);
  return photoTags.map((tag) => ({ id: tag.id, corners: tag.corners.map((p) => imageToPlane(R, t, K, p, wallOffset)) }));
}

/** EXIF FocalLengthIn35mmFilm from a JPEG's bytes, or null. */
export function readFocal35(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 < v.byteLength) {
      const marker = v.getUint16(p);
      const len = v.getUint16(p + 2);
      if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) { // "Exif"
        const tiff = p + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = (o) => v.getUint16(tiff + o, le);
        const u32 = (o) => v.getUint32(tiff + o, le);
        const findTag = (ifd, tag) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return e;
          }
          return -1;
        };
        const ptr = findTag(u32(4), 0x8769); // Exif sub-IFD
        if (ptr < 0) return null;
        const e = findTag(u32(ptr + 8), 0xa405); // FocalLengthIn35mmFilm (SHORT)
        return e < 0 ? null : u16(e + 8) || null;
      }
      if ((marker & 0xff00) !== 0xff00) return null;
      p += 2 + len;
    }
  } catch (err) { /* not a JPEG we can read */ }
  return null;
}

/**
 * Full 3D placement of tags seen in the setup photo, relative to the picture:
 * works for tags on any surface at any angle (beside, in front of or behind
 * the picture). Needs the picture's real size and the printed tag size (the
 * same unit) and the photo's focal length. Returns tags whose corners are
 * [x, y, z] in tracking-image px (z into the wall), plus the focal used.
 */
export function tagsTo3D({ photoTags, corners, size, tagSize, layout, photoSize, focal35, upright = true }) {
  const [w, h] = photoSize;
  const [W, H] = size;
  const Hp = solveHomography([[0, 0], [W, 0], [W, H], [0, H]], corners);
  const square = [[0, 0], [tagSize, 0], [tagSize, tagSize], [0, tagSize]];
  const tagH = photoTags.map((t) => solveHomography(square, t.corners));
  let focal = focal35 ? focalFrom35mm(focal35, w, h) : null;
  let focalFrom = 'photo EXIF';
  if (!focal) {
    // No EXIF: the picture's known shape and the tags' squares, seen at an angle, reveal it.
    const est = [Hp, ...tagH].map((Hm) => focalFromHomography(Hm, w / 2, h / 2)).filter((f) => f > 0.3 * Math.max(w, h) && f < 3 * Math.max(w, h));
    est.sort((a, b) => a - b);
    focal = est.length ? est[est.length >> 1] : PHOTO_FOCAL * Math.max(w, h);
    focalFrom = est.length ? 'perspective in the photo' : 'typical phone lens (guess)';
  }
  const K = cameraMatrix(focal, w / 2, h / 2);
  const { R: Rp, t: tp } = decomposeHomography(Hp, K);
  const k = layout.openingWidth / W; // tracking px per unit
  const [ox, oy] = layout.opening[0];
  const tags = photoTags.map((tag, i) => {
    const { R: Rt, t: tt } = decomposeHomography(tagH[i], K);
    let pts = square.map(([x, y]) => {
      const Xc = [0, 1, 2].map((r) => Rt[r * 3] * x + Rt[r * 3 + 1] * y + tt[r]);
      const d = [Xc[0] - tp[0], Xc[1] - tp[1], Xc[2] - tp[2]];
      return [0, 1, 2].map((c) => Rp[c] * d[0] + Rp[3 + c] * d[1] + Rp[6 + c] * d[2]); // R^T d, picture units
    });
    if (upright) pts = fitUprightTag(pts, tagSize, Rp, tp, K, tag.corners);
    // A tag flat on the picture's own surface comes out parallel to it and within a hair of it
    // (its distance is the least certain direction): place it exactly on the surface.
    const ex = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    const ey = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1], pts[3][2] - pts[0][2]];
    const nz = (ex[0] * ey[1] - ex[1] * ey[0]) / (Math.hypot(...ex) * Math.hypot(...ey));
    const meanZ = pts.reduce((acc, P) => acc + P[2], 0) / 4;
    if (Math.abs(nz) > Math.cos((3 * Math.PI) / 180) && Math.abs(meanZ) < 0.02 * W) pts = pts.map((P) => [P[0], P[1], 0]);
    return { id: tag.id, corners: pts.map((P) => [ox + P[0] * k, oy + P[1] * k, P[2] * k]) };
  });
  return { tags, focal, focalFrom };
}

/**
 * Re-fit a tag assuming it is on an upright surface (a wall or pillar, turned
 * at any angle; the tag itself may be rotated on it). A small square's tilt is
 * poorly determined by its four corners alone; fixing "upright" leaves
 * position, the surface's turn and the tag's rotation (5 numbers), which the
 * photo pins down far better.
 */
function fitUprightTag(pts, s, Rp, tp, K, observed) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((v) => v / n); };
  const a0 = unit(sub(pts[1], pts[0]));
  const b0 = unit(sub(pts[3], pts[0]));
  const n0 = [a0[1] * b0[2] - a0[2] * b0[1], a0[2] * b0[0] - a0[0] * b0[2], a0[0] * b0[1] - a0[1] * b0[0]];
  const psi0 = Math.atan2(n0[0], n0[2]);
  const h0 = [Math.cos(psi0), 0, -Math.sin(psi0)];
  const phi0 = Math.atan2(a0[1], a0[0] * h0[0] + a0[2] * h0[2]);
  const cornersOf = ([x, y, z, psi, phi]) => {
    const h = [Math.cos(psi), 0, -Math.sin(psi)];
    const a = [Math.cos(phi) * h[0], Math.sin(phi), Math.cos(phi) * h[2]];
    const b = [-Math.sin(phi) * h[0], Math.cos(phi), -Math.sin(phi) * h[2]];
    const o = [x, y, z];
    return [o, o.map((v, i) => v + s * a[i]), o.map((v, i) => v + s * (a[i] + b[i])), o.map((v, i) => v + s * b[i])];
  };
  const project = (P) => {
    const X = [0, 1, 2].map((r) => Rp[r * 3] * P[0] + Rp[r * 3 + 1] * P[1] + Rp[r * 3 + 2] * P[2] + tp[r]);
    return [K[0][0] * X[0] / X[2] + K[0][2], K[1][1] * X[1] / X[2] + K[1][2]];
  };
  const residuals = (q) => cornersOf(q).flatMap((P, i) => { const [u, v] = project(P); return [u - observed[i][0], v - observed[i][1]]; });
  const sq = (r) => r.reduce((acc, v) => acc + v * v, 0);
  let q = [...pts[0], psi0, phi0];
  let r = residuals(q);
  let err = sq(r);
  let lambda = 1e-3;
  const steps = [1e-4 * s, 1e-4 * s, 1e-4 * s, 1e-6, 1e-6];
  for (let it = 0; it < 30; it++) {
    const J = steps.map((h, k2) => { const qq = q.slice(); qq[k2] += h; return residuals(qq).map((v, i) => (v - r[i]) / h); });
    const JtJ = J.map((x) => J.map((y) => x.reduce((acc, v, i) => acc + v * y[i], 0)));
    const Jtr = J.map((x) => x.reduce((acc, v, i) => acc + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const d = solveSmall(A, Jtr.map((v) => -v));
      if (!d) break;
      const qn = q.map((v, i) => v + d[i]);
      const rn = residuals(qn);
      if (sq(rn) < err) { q = qn; r = rn; err = sq(rn); lambda = Math.max(1e-9, lambda / 10); improved = true; } else lambda *= 10;
    }
    if (!improved) break;
  }
  return cornersOf(q);
}

function solveSmall(A, b) {
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
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= f * M[c][k2];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

let compilerModule = null;

/** Compile a tracking image (canvas or image) into a MindAR .mind buffer. */
export async function compileTarget(image, onProgress = () => {}) {
  compilerModule ||= await import('../vendor/mind-ar/mindar-image.prod.js');
  const compiler = new compilerModule.Compiler();
  const dataList = await compiler.compileImageTargets([image], (p) => onProgress(Math.min(100, p)));
  const buffer = await compiler.exportData();
  const data = dataList[0];
  const keyframe = data.matchingData[0];
  const scale = image.width / keyframe.width;
  const points = [...keyframe.maximaPoints, ...keyframe.minimaPoints].map((p) => [p.x * scale, p.y * scale]);
  return { buffer, points };
}

/** Rough tracking quality from the number of detected feature points. */
export function trackingQuality(pointCount) {
  if (pointCount >= 300) return { level: 'good', label: 'Good' };
  if (pointCount >= 120) return { level: 'fair', label: 'Fair' };
  return { level: 'poor', label: 'Poor' };
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** The setup.json that the viewer reads. */
export function buildSetupJson({ name, layout, aspect, bleed, innerShadow, exposure, tracking, calibration, tags = [], wallOffset = 0, occluders = [] }) {
  const json = {
    name,
    target: 'target.mind',
    preview: 'target.jpg',
    targetSize: [layout.width, layout.height],
    opening: layout.opening.map(([x, y]) => [round(x), round(y)]),
    openingAspect: round(aspect, 5),
    bleed: round(bleed, 4),
    exposure: round(exposure, 3),
    innerShadow: { strength: round(innerShadow.strength, 3), size: round(innerShadow.size, 4) },
    tracking,
    calibration: {
      photo: 'photo.jpg',
      photoSize: calibration.photoSize,
      corners: calibration.corners.map(([x, y]) => [round(x / calibration.photoSize[0], 5), round(y / calibration.photoSize[1], 5)]),
      openingSize: calibration.openingSize || null,
      margin: round(calibration.margin, 4),
      ignoreInside: !!calibration.ignoreInside,
      tagDepth: calibration.tagDepth ?? null,
      sides: calibration.sides ?? null,
      tagSize: calibration.tagSize ?? null,
      photoFocal35: calibration.photoFocal35 ?? null,
      created: new Date().toISOString().slice(0, 10),
    },
  };
  if (tags.length || wallOffset) {
    // AprilTags seen in the setup photo: their exact place on the wall, in tracking-image pixels,
    // and how far that wall lies behind the opening's edge.
    json.apriltag = { tags: tags.map((t) => ({ id: t.id, corners: t.corners.map((c) => c.map((v) => round(v))) })) };
    if (wallOffset) json.apriltag.wallOffset = round(wallOffset, 2); // + behind the picture, - in front
  }
  if (occluders.length) {
    // Pillars / side walls in front of the picture (tracking-image px; near = how far they stand out).
    json.occluders = occluders.map((o) => ({ box: o.box.map((v) => round(v, 1)), near: round(o.near, 2), far: round(o.far || 0, 2) }));
  }
  return json;
}

/** JSON with short number arrays kept on one line, so setup.json stays easy to hand-edit. */
export function formatJson(obj) {
  return `${JSON.stringify(obj, null, 2)
    .replace(/\[\s+([-\d.e+,\s]+?)\s+\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`)
    .replace(/\[\s+((?:\[[^[\]]*\],?\s*)+?)\s+\]/g, (_, inner) => `[${inner.trim().split(/\],\s*/).join('], ')}]`)}\n`;
}

/* ---------- minimal ZIP writer (stored, no compression) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: Uint8Array | string }] -> Blob (application/zip) */
export function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
