// Core of the setup tool: turns a photo of a frame + its four inner corners
// into a straightened tracking image, compiles it for MindAR, and packages
// the result. No UI code here.

import { solveHomography, applyHomography, homographyW, estimateQuadAspect } from './homography.js';

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
export function buildSetupJson({ name, layout, aspect, bleed, innerShadow, exposure, tracking, calibration, tags = [] }) {
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
      created: new Date().toISOString().slice(0, 10),
    },
  };
  if (tags.length) {
    // AprilTags seen in the setup photo: their exact place on the wall, in tracking-image pixels.
    json.apriltag = { tags: tags.map((t) => ({ id: t.id, corners: t.corners.map(([x, y]) => [round(x), round(y)]) })) };
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
