// Measurement shared by both modes.
//
// The harness exists to compare a frame sequence against the same clip through
// the ordinary decode path, so both must report the same numbers computed the
// same way. Two frame sources are supported: a <video> element, where the
// browser tells us what it actually presented, and the manual paint loop, where
// we count for ourselves.

const WINDOW_MS = 2000; // rolling window for rate calculations

const READY = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
const NETWORK = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
const MEDIA_ERR = {
  1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/**
 * Frames/sec over a trailing window. Stutter shows up in a short window and
 * averages away in a long one, so every rate here uses the same one.
 */
export class Rate {
  constructor(windowMs = WINDOW_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  /** Record the cumulative count at this instant. */
  sample(total) {
    const now = performance.now();
    this.samples.push({ at: now, total });
    while (this.samples.length > 2 && now - this.samples[0].at > this.windowMs) this.samples.shift();
    return this.get();
  }

  get() {
    if (this.samples.length < 2) return null;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.at - a.at) / 1000;
    return dt > 0.4 ? (b.total - a.total) / dt : null;
  }

  reset() { this.samples = []; }
}

/**
 * Colour a rate against the clip's own frame rate rather than a fixed 24: the
 * whole point of the harness is that clips differ, and a 30fps clip holding 24
 * is dropping a fifth of its frames.
 */
export function rateClass(fps, target = 24) {
  if (fps === null) return 'v-dim';
  const ratio = fps / target;
  return ratio >= 0.96 ? 'v-ok' : ratio >= 0.83 ? 'v-warn' : 'v-bad';
}

export class Telemetry {
  /**
   * @param {object} opts
   * @param {Element} opts.mount   container for the panel
   * @param {number} [opts.target] the clip's own frame rate, for colouring
   */
  constructor({ mount, target = 24 }) {
    this.target = target;
    this.t0 = performance.now();
    this.firstFrameAt = null;
    this.stalls = 0;
    this.paints = 0;
    this.video = null;
    this.label = 'presented';
    this.rate = new Rate();
    this.extra = {};
    this.#build(mount);
    this.#tick();
  }

  // ------------------------------------------------------------------ public

  /**
   * Point the panel at a new source and clear everything measured about the
   * old one. Switching clip or mode has to zero the counters, or the first
   * seconds of the new run are read against the last run's history.
   */
  reset({ video = null, label = 'presented', target = this.target } = {}) {
    this.video = video;
    this.label = label;
    this.target = target;
    this.t0 = performance.now();
    this.firstFrameAt = null;
    this.stalls = 0;
    this.paints = 0;
    this.presented = undefined;
    this.rate.reset();
    this.extra = {};
    this.rowsEl.textContent = '';
    this.rowCache.clear();
    // Resource timings are cumulative across the page's whole life, so a clip
    // swap would charge the new run with the old one's bytes.
    try { performance.clearResourceTimings(); } catch {}
    if (video) this.#watchVideo(video);
  }

  /** Call once per painted frame from the frame-sequence loop. */
  markFrame() {
    this.paints++;
    if (this.firstFrameAt === null) this.#firstFrame();
  }

  /** Surface a mode-specific value in the panel. */
  set(key, value, cls = '') { this.extra[key] = { value, cls }; }

  /** Remove a value that no longer applies to the current mode. */
  unset(key) {
    delete this.extra[key];
    this.rowCache.get(key)?.remove();
    this.rowCache.delete(key);
  }

  log(msg, cls = '') {
    const at = ((performance.now() - this.t0) / 1000).toFixed(2).padStart(6);
    const line = document.createElement('div');
    line.innerHTML = `<span class="t">${at}s</span> `;
    line.append(msg);
    if (cls) line.className = cls;
    this.logEl.prepend(line);
    while (this.logEl.childElementCount > 120) this.logEl.lastElementChild.remove();
  }

  fail(msg) { this.log(msg, 'err'); }

  // ----------------------------------------------------------------- private

  #firstFrame() {
    this.firstFrameAt = performance.now() - this.t0;
    this.log(`first frame at ${this.firstFrameAt.toFixed(0)}ms`, 'good');
  }

  #build(mount) {
    mount.innerHTML = `
      <div class="panel">
        <h2>telemetry</h2>
        <div class="rows"></div>
        <div class="log"></div>
      </div>`;
    this.rowsEl = mount.querySelector('.rows');
    this.logEl = mount.querySelector('.log');
    this.rowCache = new Map();
  }

  #row(key, value, cls = '') {
    let el = this.rowCache.get(key);
    if (!el) {
      el = document.createElement('dl');
      el.className = 'row';
      el.innerHTML = `<dt></dt><dd></dd>`;
      el.querySelector('dt').textContent = key;
      this.rowsEl.append(el);
      this.rowCache.set(key, el);
    }
    const dd = el.querySelector('dd');
    if (dd.textContent !== String(value)) dd.textContent = value;
    dd.className = cls;
  }

  #watchVideo(v) {
    const noisy = ['loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'seeked', 'ended', 'stalled'];
    for (const ev of noisy) v.addEventListener(ev, () => this.log(ev));

    v.addEventListener('waiting', () => { this.stalls++; this.log('waiting (rebuffer)', 'err'); });
    v.addEventListener('error', () => {
      const e = v.error;
      this.fail(e ? `${MEDIA_ERR[e.code] || e.code}: ${e.message || '(no message)'}` : 'unknown media error');
    });

    // rVFC is the honest frame source: it fires per presented frame and carries
    // the browser's own presentedFrames counter.
    if ('requestVideoFrameCallback' in v) {
      const onFrame = (_now, meta) => {
        if (this.video !== v) return; // a later reset moved on from this element
        this.presented = meta.presentedFrames;
        if (this.firstFrameAt === null) this.#firstFrame();
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    } else {
      this.log('no requestVideoFrameCallback; rates fall back to polling', 'err');
    }
  }

  #frameCount() {
    if (this.video) {
      if (this.presented !== undefined) return this.presented;
      if (this.video.getVideoPlaybackQuality) return this.video.getVideoPlaybackQuality().totalVideoFrames;
    }
    return this.paints;
  }

  #tick() {
    const v = this.video;
    const fps = this.rate.sample(this.#frameCount());

    this.#row(`${this.label} fps`, fps === null ? '--' : fps.toFixed(1), rateClass(fps, this.target));
    this.#row('time to first frame',
      this.firstFrameAt === null ? 'waiting' : `${this.firstFrameAt.toFixed(0)} ms`,
      this.firstFrameAt === null ? 'v-dim' : 'v-ok');

    if (v) {
      this.#row('resolution', v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '--',
        v.videoWidth ? 'v-ok' : 'v-dim');
      this.#row('readyState', READY[v.readyState] ?? v.readyState, v.readyState >= 3 ? 'v-ok' : 'v-warn');
      this.#row('networkState', NETWORK[v.networkState] ?? v.networkState);

      if (v.getVideoPlaybackQuality) {
        const q = v.getVideoPlaybackQuality();
        const pct = q.totalVideoFrames ? (q.droppedVideoFrames / q.totalVideoFrames) * 100 : 0;
        this.#row('frames decoded', q.totalVideoFrames);
        this.#row('frames dropped', `${q.droppedVideoFrames} (${pct.toFixed(1)}%)`,
          pct < 1 ? 'v-ok' : pct < 5 ? 'v-warn' : 'v-bad');
        if (q.corruptedVideoFrames) this.#row('frames corrupted', q.corruptedVideoFrames, 'v-bad');
      }

      const ahead = this.#bufferAhead(v);
      this.#row('buffer ahead', ahead === null ? '--' : `${ahead.toFixed(1)} s`,
        ahead === null ? 'v-dim' : ahead > 2 ? 'v-ok' : ahead > 0.5 ? 'v-warn' : 'v-bad');
      this.#row('position', `${v.currentTime.toFixed(2)} / ${isFinite(v.duration) ? v.duration.toFixed(2) : '?'}`);
      this.#row('rebuffers', this.stalls, this.stalls === 0 ? 'v-ok' : 'v-bad');

      // Only meaningful for the reference encode: it is a handful of range
      // requests. A frame sequence is thousands of entries and overflows the
      // resource-timing buffer, so that mode reports bytes it counted itself.
      const net = this.#networkBytes();
      if (net) this.#row('media downloaded', `${(net / 1e6).toFixed(1)} MB`);
    } else {
      this.#row('frames painted', this.paints);
    }

    for (const [k, { value, cls }] of Object.entries(this.extra)) this.#row(k, value, cls);

    requestAnimationFrame(() => this.#tick());
  }

  #bufferAhead(v) {
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) && v.currentTime <= b.end(i)) return b.end(i) - v.currentTime;
    }
    return b.length ? 0 : null;
  }

  #networkBytes() {
    try {
      return performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('/media/'))
        .reduce((n, e) => n + (e.transferSize || e.encodedBodySize || 0), 0);
    } catch { return 0; }
  }
}
