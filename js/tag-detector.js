// Main-thread wrapper around the AprilTag detection worker. Grabs frames from
// a video (or any image/canvas), sends them to the worker, and returns
// marker corners in the source's pixel coordinates.

export class TagDetector {
  constructor({ family = 'tag36h11', maxSize = 1280, maxHamming = 3 } = {}) {
    this.family = family;
    this.maxSize = maxSize;
    this.maxHamming = maxHamming;
    this.worker = new Worker(new URL('./apriltag-worker.js', import.meta.url));
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.busy = false;
    this.seq = 0;
    this.pending = new Map(); // seq -> { resolve, scale, time }
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      console.warn('[frame-ar] AprilTag worker failed:', e.message);
      this.failed = true;
      for (const p of this.pending.values()) p.resolve(null);
      this.pending.clear();
      this.busy = false;
    };
  }

  /**
   * Detect tags in the current frame of source (video, canvas or image).
   * Resolves to { time, width, height, markers } or null; resolves null at
   * once if a frame is already being processed.
   */
  detect(source) {
    if (this.busy || this.failed) return Promise.resolve(null);
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return Promise.resolve(null);
    const scale = Math.min(1, this.maxSize / Math.max(sw, sh));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(source, 0, 0, w, h);
    const { buffer } = this.ctx.getImageData(0, 0, w, h).data;

    this.busy = true;
    const seq = ++this.seq;
    const time = performance.now();
    return new Promise((resolve) => {
      this.pending.set(seq, { resolve, scale, time, width: sw, height: sh });
      this.worker.postMessage(
        { seq, width: w, height: h, buffer, family: this.family, maxHamming: this.maxHamming },
        [buffer],
      );
    });
  }

  _onMessage({ seq, markers, error }) {
    this.busy = false;
    const p = this.pending.get(seq);
    if (!p) return;
    this.pending.delete(seq);
    if (error) console.warn('[frame-ar] AprilTag detection error:', error);
    const inv = 1 / p.scale;
    p.resolve({
      time: p.time,
      width: p.width,
      height: p.height,
      markers: (markers || []).map((m) => ({ ...m, corners: m.corners.map(([x, y]) => [x * inv, y * inv]) })),
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
