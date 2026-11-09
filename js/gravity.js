// Which way is down, from the phone's motion sensor, in the camera image's
// coordinates (x right, y down, z out of the back of the phone).
//
// A single small tag can't tell on its own how the picture is tilted far
// from it: a slight error in the tag's tilt swings the far side of a large
// panel up or down. The phone always knows which way is down, and the
// picture hangs upright, so the tag only has to give the rest.

let latest = null; // { down: [x, y, z] in device coordinates, time }
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
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    const b = (e.beta * Math.PI) / 180;
    const g = (e.gamma * Math.PI) / 180;
    // W3C device frame (x right, y to the top of the phone, z out of the screen):
    // up is the third row of Rz(alpha) Rx(beta) Ry(gamma), so down is its negative.
    latest = {
      down: [Math.cos(b) * Math.sin(g), -Math.sin(b), -Math.cos(b) * Math.cos(g)],
      time: performance.now(),
    };
  });
}

function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return (Number(a) * Math.PI) / 180;
}

/** Unit vector pointing down, in camera-image coordinates, or null when the sensor hasn't reported recently. */
export function gravityInCamera(maxAgeMs = 500) {
  if (!latest || performance.now() - latest.time > maxAgeMs) return null;
  const [dx, dy, dz] = latest.down;
  // The rear camera looks out of the back: y flips (image y points down) and z flips.
  const x = dx;
  const y = -dy;
  const z = -dz;
  // The camera image turns with the screen.
  const a = screenAngle();
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * x + s * y, -s * x + c * y, z];
}
