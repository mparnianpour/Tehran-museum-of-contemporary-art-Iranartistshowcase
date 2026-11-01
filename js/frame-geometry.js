// Builds the picture surface that sits inside the frame opening.
//
// MindAR anchor space: the tracking image is centred on the origin, 1 unit
// wide, y up. setup.json describes the opening as four corners in tracking-
// image pixels, so any four-sided opening works (not just perfect rectangles);
// a homography maps the picture onto it with correct perspective.

import * as THREE from 'three';
import { solveHomography, applyHomography } from './homography.js';

/** Tracking-image pixel -> anchor-space [x, y]. */
export function targetToAnchor(setup, [px, py]) {
  const [w, h] = setup.targetSize;
  return [(px - w / 2) / w, (h / 2 - py) / w];
}

export function createOpeningGeometry(setup, segments = 16) {
  const corners = setup.opening.map((p) => targetToAnchor(setup, p)); // TL, TR, BR, BL
  // Unit square with v up (three.js UV convention) -> opening corners.
  const H = solveHomography([[0, 1], [1, 1], [1, 0], [0, 0]], corners);
  const bx = setup.bleed || 0;
  const by = bx * setup.openingAspect; // same physical amount top/bottom as left/right

  const n = segments;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const [x, y] = applyHomography(H, -bx + u * (1 + 2 * bx), -by + v * (1 + 2 * by));
      positions.push(x, y, 0);
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Debug helper: outlines of the tracking image (grey) and the opening (magenta). */
export function createDebugOutlines(setup) {
  const group = new THREE.Group();
  const [w, h] = setup.targetSize;
  const rect = [[0, 0], [w, 0], [w, h], [0, h]].map((p) => targetToAnchor(setup, p));
  const opening = setup.opening.map((p) => targetToAnchor(setup, p));
  const loop = (pts, color) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0.002)));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  };
  group.add(loop(rect, 0x9aa0a6));
  group.add(loop(opening, 0xff2bd6));
  group.renderOrder = 10;
  return group;
}
