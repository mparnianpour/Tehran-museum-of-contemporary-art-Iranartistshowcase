// The phone's motion sensor, in the camera image's coordinates
// (x right, y down, z out of the back of the phone).
//
// - Which way is down: a single small tag can't tell on its own how the
//   picture is tilted far from it; a slight error in the tag's tilt swings
//   the far side of a large panel up or down. The phone always knows which
//   way is down, and the picture hangs upright, so the tag only has to give
//   the rest.
// - How the phone has turned: once the tags have placed the picture, the
//   phone's turning keeps it in place for a few seconds after they leave the
//   screen, so a visitor standing close can pan across a large panel.

let latest = null; // { alpha, beta, gamma (radians; alpha may be null), time }
let listening = false;

/**
 * iPhones (and recent Chrome) only report motion after the visitor allows it,
 * and only when asked from a tap. Call this first thing in the Start button's
 * handler. Whatever the answer, readings simply arrive or they don't.
 */
export function requestMotionPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

export function startMotion() {
  if (listening) return;
  listening = true;
  const rad = Math.PI / 180;
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    latest = { alpha: e.alpha == null ? null : e.alpha * rad, beta: e.beta * rad, gamma: e.gamma * rad, time: performance.now() };
  });
}

const mul = (A, B) => {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
};
const transpose = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];

/** W3C device frame (x right, y to the top of the phone, z out of the screen) -> earth: Rz(alpha) Rx(beta) Ry(gamma). */
export function deviceToEarth(alpha, beta, gamma) {
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha), Math.sin(alpha), Math.cos(beta), Math.sin(beta), Math.cos(gamma), Math.sin(gamma)];
  const Rz = [ca, -sa, 0, sa, ca, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cb, -sb, 0, sb, cb];
  const Ry = [cg, 0, sg, 0, 1, 0, -sg, 0, cg];
  return mul(mul(Rz, Rx), Ry);
}

/** Device -> camera image: the rear camera looks out of the back (y and z flip), and the image turns with the screen. */
function deviceToCamera() {
  const a = ((Number(screen.orientation?.angle ?? window.orientation ?? 0)) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, -s, -c, 0, 0, 0, -1]; // [c s 0; -s c 0; 0 0 1] * diag(1, -1, -1)
}

/** Unit vector pointing down, in camera-image coordinates, or null when the sensor hasn't reported recently. */
export function gravityInCamera(maxAgeMs = 500) {
  if (!latest || performance.now() - latest.time > maxAgeMs) return null;
  const R = deviceToEarth(0, latest.beta, latest.gamma); // alpha (heading) doesn't change which way is down
  // earth down (0, 0, -1) in device coordinates is minus the third row of R
  const down = [-R[6], -R[7], -R[8]];
  const Q = deviceToCamera();
  return [0, 1, 2].map((r) => Q[r * 3] * down[0] + Q[r * 3 + 1] * down[1] + Q[r * 3 + 2] * down[2]);
}

/**
 * The phone's orientation as a rotation from a fixed earth frame to the camera image
 * (row-major 9), or null without a recent reading that includes the heading (alpha).
 * Its heading may be relative to wherever the phone pointed at first; only changes are used.
 */
export function cameraOrientation(maxAgeMs = 1000) {
  if (!latest || latest.alpha == null || performance.now() - latest.time > maxAgeMs) return null;
  return mul(deviceToCamera(), transpose(deviceToEarth(latest.alpha, latest.beta, latest.gamma)));
}
