// Real things in front of the picture (pillars, the side walls of an alcove)
// should hide it, as they hide the real panel behind them.
//
// setup.json "occluders": boxes beside or over the picture, in tracking-image
// pixels on the picture's plane, standing out in front of it:
//   { "box": [x0, y0, x1, y1], "near": 120, "far": 0 }
// near / far: how far the box's front and back faces are in front of the
// picture (tracking-image pixels). A floor-to-ceiling pillar simply uses a
// box much taller than the picture.
//
// Each frame, the box is projected onto the picture's plane from where the
// phone actually is; the shader then leaves that part of the picture
// transparent, so the camera image of the real pillar shows through.

import { solveHomography, applyHomography } from './homography.js';

export const MAX_OCCLUDERS = 3;
export const MAX_EDGES = 8;

function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise (x right, y up)
}

/**
 * Returns null when the setup has no occluders, otherwise an object whose
 * update(C) fills `lines` / `counts` (shader uniforms) for a camera centre C
 * given in tracking-image pixels: [x, y, z], z negative in front of the picture.
 */
export function createOcclusion(setup, meshAspect) {
  const occluders = (setup.occluders || []).filter((o) => Array.isArray(o.box) && o.box.length === 4 && o.near > 0)
    .slice(0, MAX_OCCLUDERS);
  if (!occluders.length) return null;
  // tracking-image px -> unit square of the opening (v up), then -> mesh UV (with bleed)
  const toUnit = solveHomography(setup.opening, [[0, 1], [1, 1], [1, 0], [0, 0]]);
  const bx = setup.bleed || 0;
  const by = bx * setup.openingAspect;
  const toShader = (X, Y) => {
    const [u, v] = applyHomography(toUnit, X, Y);
    return [((u + bx) / (1 + 2 * bx)) * meshAspect, (v + by) / (1 + 2 * by)];
  };
  const lines = new Float32Array(MAX_OCCLUDERS * MAX_EDGES * 3);
  const counts = new Float32Array(MAX_OCCLUDERS);

  return {
    occluders,
    lines,
    counts,
    clear() {
      counts.fill(0);
    },
    update(C) {
      counts.fill(0);
      occluders.forEach((o, k) => {
        const [x0, y0, x1, y1] = o.box;
        const zs = [-o.near, -(o.far || 0)];
        if (!(C[2] < -o.near * 1.02)) return; // phone is not in front of it: nothing sensible to hide
        const pts = [];
        for (const x of [x0, x1]) {
          for (const y of [y0, y1]) {
            for (const z of zs) {
              const s = -C[2] / (z - C[2]); // ray from the phone through the corner, onto the picture's plane
              pts.push(toShader(C[0] + s * (x - C[0]), C[1] + s * (y - C[1])));
            }
          }
        }
        const hull = convexHull(pts);
        if (hull.length < 3) return;
        const n = Math.min(hull.length, MAX_EDGES);
        for (let e = 0; e < n; e++) {
          const p = hull[e];
          const q = hull[(e + 1) % hull.length];
          let nx = -(q[1] - p[1]);
          let ny = q[0] - p[0];
          const len = Math.hypot(nx, ny) || 1;
          nx /= len;
          ny /= len;
          const i = (k * MAX_EDGES + e) * 3;
          lines[i] = nx;
          lines[i + 1] = ny;
          lines[i + 2] = -(nx * p[0] + ny * p[1]);
        }
        counts[k] = n;
      });
    },
  };
}
