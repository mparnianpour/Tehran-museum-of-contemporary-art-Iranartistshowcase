// Slideshow transition effects, rendered in one shader on the picture inside
// the frame. Each effect blends the current image (A) into the next (B) as
// uProgress goes from 0 to 1, so every transition stays clipped to the frame.

import * as THREE from 'three';

export const EFFECTS = [
  { id: 'fade', code: 1, label: 'Crossfade', fa: 'محو تدریجی' },
  { id: 'slide', code: 2, label: 'Slide', fa: 'لغزش' },
  { id: 'wipe', code: 3, label: 'Wipe', fa: 'پرده' },
  { id: 'zoom', code: 4, label: 'Zoom', fa: 'زوم' },
  { id: 'dissolve', code: 5, label: 'Ink dissolve', fa: 'حل شدن' },
  { id: 'iris', code: 6, label: 'Iris', fa: 'دایره' },
  { id: 'blinds', code: 7, label: 'Blinds', fa: 'کرکره' },
  { id: 'pixelate', code: 8, label: 'Pixelate', fa: 'پیکسلی' },
  { id: 'dip', code: 9, label: 'Dip to black', fa: 'گذر از سیاهی' },
  { id: 'cut', code: 0, label: 'Cut (no effect)', fa: 'برش مستقیم' },
  { id: 'random', code: -1, label: 'Random', fa: 'تصادفی' },
];

export function effectById(id) {
  return EFFECTS.find((e) => e.id === id) || EFFECTS[0];
}

export const DIRECTIONS = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, 1],
  down: [0, -1],
};

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform float uAspectA;   // image width / height
  uniform float uAspectB;
  uniform float uFitA;      // 0 = cover, 1 = contain
  uniform float uFitB;
  uniform vec3 uKbA;        // Ken Burns: zoom, panX, panY
  uniform vec3 uKbB;
  uniform float uFrameAspect;
  uniform float uProgress;
  uniform int uEffect;
  uniform vec2 uDirection;
  uniform vec3 uBackground;
  uniform float uShadowStrength;
  uniform float uShadowSize;
  uniform float uExposure;
  uniform float uOpacity;
  // Pillars / walls in front of the picture: up to 3 convex silhouettes of up to
  // 8 edges each, as lines (nx, ny, c) in (u * aspect, v) space; inside >= 0.
  uniform vec3 uOcc[24];
  uniform float uOccCount[3];

  varying vec2 vUv;

  vec2 fitUv(vec2 uv, float imgAspect, float fit, vec3 kb) {
    uv = (uv - 0.5) / kb.x + 0.5 + kb.yz;
    float r = uFrameAspect / imgAspect;
    vec2 s = vec2(1.0);
    if (fit < 0.5) {
      if (r > 1.0) s.y = 1.0 / r; else s.x = r;
    } else {
      if (r > 1.0) s.x = r; else s.y = 1.0 / r;
    }
    return (uv - 0.5) * s + 0.5;
  }

  vec3 sampleImage(sampler2D tex, vec2 uv) {
    vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    vec3 c = texture2D(tex, clamp(uv, 0.0, 1.0)).rgb;
    return mix(uBackground, c, inside.x * inside.y);
  }

  vec3 imageA(vec2 uv) { return sampleImage(uTexA, fitUv(uv, uAspectA, uFitA, uKbA)); }
  vec3 imageB(vec2 uv) { return sampleImage(uTexB, fitUv(uv, uAspectB, uFitB, uKbB)); }

  bool inUnit(vec2 uv) {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  // Remap progress so a soft edge of width s fully clears both ends.
  float sweep(float p, float s) { return p * (1.0 + 2.0 * s) - s; }

  void main() {
    vec2 uv = vUv;
    float p = clamp(uProgress, 0.0, 1.0);
    vec2 dir = uDirection;
    vec3 col;

    if (p <= 0.0) {
      col = imageA(uv);
    } else if (p >= 1.0) {
      col = imageB(uv);
    } else if (uEffect == 1) {            // crossfade
      col = mix(imageA(uv), imageB(uv), p);
    } else if (uEffect == 2) {            // slide (push)
      vec2 uvA = uv - dir * p;
      vec2 uvB = uv - dir * (p - 1.0);
      col = inUnit(uvA) ? imageA(uvA) : imageB(uvB);
    } else if (uEffect == 3) {            // wipe with a soft edge
      float s = 0.06;
      float x = dot(uv - 0.5, dir) + 0.5;   // 0 at the edge the new image enters from
      float m = smoothstep(sweep(p, s) - s, sweep(p, s) + s, x);
      col = mix(imageB(uv), imageA(uv), m);
    } else if (uEffect == 4) {            // zoom through
      vec2 uvA = (uv - 0.5) / (1.0 + 0.35 * p) + 0.5;
      vec2 uvB = (uv - 0.5) / (1.0 + 0.12 * (1.0 - p)) + 0.5;
      float m = smoothstep(0.0, 1.0, p);
      col = mix(imageA(uvA), imageB(uvB), m);
    } else if (uEffect == 5) {            // ink dissolve
      float n = clamp((fbm(uv * vec2(uFrameAspect, 1.0) * 5.0) - 0.15) / 0.7, 0.0, 1.0);
      float s = 0.07;
      float t = sweep(p, s);
      float m = smoothstep(t - s, t + s, n);
      vec3 c = mix(imageB(uv), imageA(uv), m);
      float edge = 1.0 - abs(m * 2.0 - 1.0);
      col = c * (1.0 - 0.35 * edge);
    } else if (uEffect == 6) {            // iris
      vec2 c = (uv - 0.5) * vec2(uFrameAspect, 1.0);
      float maxR = length(vec2(uFrameAspect, 1.0)) * 0.5;
      float s = 0.03;
      float r = p * (maxR + 2.0 * s);
      float m = smoothstep(r - 2.0 * s, r, length(c));
      col = mix(imageB(uv), imageA(uv), m);
    } else if (uEffect == 7) {            // blinds
      float slats = 9.0;
      float x = abs(dir.x) > 0.5 ? uv.x : uv.y;
      float f = fract(x * slats);
      float s = 0.04;
      float m = smoothstep(sweep(p, s) - s, sweep(p, s) + s, f);
      col = mix(imageB(uv), imageA(uv), m);
    } else if (uEffect == 8) {            // pixelate
      float q = 1.0 - abs(p * 2.0 - 1.0);
      float cellsX = mix(600.0, 14.0, pow(q, 0.35));
      vec2 cells = vec2(cellsX, cellsX / uFrameAspect);
      vec2 uvq = (floor(uv * cells) + 0.5) / cells;
      col = mix(imageA(uvq), imageB(uvq), smoothstep(0.4, 0.6, p));
    } else if (uEffect == 9) {            // dip to black
      col = p < 0.5 ? mix(imageA(uv), vec3(0.0), p * 2.0)
                    : mix(vec3(0.0), imageB(uv), p * 2.0 - 1.0);
    } else {                              // cut
      col = p < 0.5 ? imageA(uv) : imageB(uv);
    }

    col *= uExposure;

    // Soft shadow cast by the frame onto the picture (light from above).
    float aspect = uFrameAspect;
    float sh = 1.0 - smoothstep(0.0, uShadowSize * 1.5, 1.0 - uv.y);
    sh = max(sh, 0.8 * (1.0 - smoothstep(0.0, uShadowSize, uv.x * aspect)));
    sh = max(sh, 0.8 * (1.0 - smoothstep(0.0, uShadowSize, (1.0 - uv.x) * aspect)));
    sh = max(sh, 0.5 * (1.0 - smoothstep(0.0, uShadowSize * 0.6, uv.y)));
    col *= 1.0 - uShadowStrength * sh;

    // Leave the picture transparent where a real pillar or wall is in front of it.
    float hidden = 0.0;
    vec2 q = vec2(vUv.x * uFrameAspect, vUv.y);
    for (int k = 0; k < 3; k++) {
      if (uOccCount[k] < 0.5) continue;
      float inside = 1.0;
      for (int e = 0; e < 8; e++) {
        if (float(e) >= uOccCount[k]) break;
        vec3 L = uOcc[k * 8 + e];
        inside *= smoothstep(-0.002, 0.002, dot(L.xy, q) + L.z);
      }
      hidden = max(hidden, inside);
    }

    gl_FragColor = vec4(col, uOpacity * (1.0 - hidden));
  }
`;

function blankTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([17, 17, 17, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export function createSlideshowMaterial({ frameAspect, background = '#ebe6dc', innerShadow = {}, exposure = 1 }) {
  const blank = blankTexture();
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexA: { value: blank },
      uTexB: { value: blank },
      uAspectA: { value: 1 },
      uAspectB: { value: 1 },
      uFitA: { value: 0 },
      uFitB: { value: 0 },
      uKbA: { value: new THREE.Vector3(1, 0, 0) },
      uKbB: { value: new THREE.Vector3(1, 0, 0) },
      uFrameAspect: { value: frameAspect },
      uProgress: { value: 0 },
      uEffect: { value: 1 },
      uDirection: { value: new THREE.Vector2(-1, 0) },
      uBackground: { value: new THREE.Color(background) },
      uShadowStrength: { value: innerShadow.strength ?? 0.35 },
      uShadowSize: { value: innerShadow.size ?? 0.035 },
      uExposure: { value: exposure },
      uOpacity: { value: 1 },
      uOcc: { value: Array.from({ length: 24 }, () => new THREE.Vector3()) },
      uOccCount: { value: [0, 0, 0] },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
