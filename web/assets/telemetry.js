// Shared measurement for every page in the matrix.
//
// The point of this app is comparison, so all twelve pages must report the same
// numbers computed the same way. Two frame sources are supported: a <video>
// element (where the browser tells us what it actually presented) and a manual
// paint loop (canvas / WebCodecs, where we count for ourselves).

const WINDOW_MS = 2000; // rolling window for rate calculations

export const CODECS = {
  'h264 High@4.0': { type: 'video/mp4; codecs="avc1.640028"', mse: 'video/mp4; codecs="avc1.640028,mp4a.40.2"' },
  'vp9 profile 0': { type: 'video/webm; codecs="vp09.00.40.08"', mse: 'video/webm; codecs="vp09.00.40.08,opus"' },
  'av1 Main': { type: 'video/mp4; codecs="av01.0.08M.08"', mse: 'video/mp4; codecs="av01.0.08M.08"' },
  'hevc Main@4.0': { type: 'video/mp4; codecs="hvc1.1.6.L120.90"', mse: 'video/mp4; codecs="hvc1.1.6.L120.90"' },
};

const TARGET = { width: 1920, height: 1080, bitrate: 5_000_000, framerate: 24 };

const READY = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
const NETWORK = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
const MEDIA_ERR = {
  1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/** Probe what this client claims it can do, before anything is played. */
export async function probeCapabilities() {
  const probe = document.createElement('video');
  const out = { codecs: {}, features: {}, agent: {} };

  for (const [name, c] of Object.entries(CODECS)) {
    const entry = {
      canPlayType: probe.canPlayType(c.type) || 'no',
      mseSupported: 'MediaSource' in self && MediaSource.isTypeSupported(c.mse),
    };
    // decodingInfo is the only API that answers the question this app exists to
    // ask: not "can you decode it" but "can you decode it smoothly at 1080p24".
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'file', video: { contentType: c.type, ...TARGET },
      });
      entry.supported = info.supported;
      entry.smooth = info.smooth;
      entry.powerEfficient = info.powerEfficient;
    } catch {
      entry.supported = null;
    }
    out.codecs[name] = entry;
  }

  out.features = {
    'MediaSource': 'MediaSource' in self,
    'ManagedMediaSource': 'ManagedMediaSource' in self,
    'VideoDecoder (WebCodecs)': 'VideoDecoder' in self,
    'OffscreenCanvas': 'OffscreenCanvas' in self,
    'WebGL2': (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })(),
    'WebGPU': 'gpu' in navigator,
    'requestVideoFrameCallback': 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    'Picture-in-Picture': !!document.pictureInPictureEnabled,
    'Document PiP': 'documentPictureInPicture' in self,
    'EME': 'requestMediaKeySystemAccess' in navigator,
    'native HLS': (probe.canPlayType('application/vnd.apple.mpegurl') || '') !== '',
    'secure context': self.isSecureContext,
  };

  out.agent = {
    'hardware threads': navigator.hardwareConcurrency ?? '?',
    'device memory': navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '?',
    'screen': `${screen.width}x${screen.height} @${devicePixelRatio}x`,
    'platform': navigator.platform || '?',
  };
  return out;
}

/**
 * Frames/sec over a trailing window. Stutter shows up in a short window and
 * averages away in a long one, so every rate in this app uses the same one.
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
}

/** Colour a frame rate against the 1080p24 bar this app is built around. */
export function rateClass(fps) {
  if (fps === null) return 'v-dim';
  return fps >= 23 ? 'v-ok' : fps >= 20 ? 'v-warn' : 'v-bad';
}

export class Telemetry {
  /**
   * @param {object} opts
   * @param {Element} opts.mount   container for the panel
   * @param {HTMLVideoElement} [opts.video]  frame source, when there is one
   * @param {string} [opts.label]  name for the paint-rate row
   */
  constructor({ mount, video = null, label = 'presented' }) {
    this.video = video;
    this.label = label;
    this.t0 = performance.now();
    this.firstFrameAt = null;
    this.stalls = 0;
    this.paints = 0;
    this.rate = new Rate();
    this.lastQuality = null;
    this.extra = {};
    this.#build(mount);
    if (video) this.#watchVideo(video);
    this.#tick();
  }

  // ------------------------------------------------------------------ public

  /** Call once per painted frame from a canvas or WebCodecs loop. */
  markFrame() {
    this.paints++;
    if (this.firstFrameAt === null) this.#firstFrame();
  }

  /** Surface a page-specific value in the panel. */
  set(key, value, cls = '') { this.extra[key] = { value, cls }; }

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
    const noisy = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'play', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'stalled', 'suspend', 'emptied'];
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
        this.presented = meta.presentedFrames;
        this.mediaTime = meta.mediaTime;
        if (this.firstFrameAt === null) this.#firstFrame();
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    } else {
      this.log('no requestVideoFrameCallback; rates fall back to polling', 'err');
    }
  }

  #frameCount() {
    if (this.presented !== undefined) return this.presented;
    if (this.video?.getVideoPlaybackQuality) return this.video.getVideoPlaybackQuality().totalVideoFrames;
    return this.paints;
  }

  #tick() {
    const v = this.video;
    const fps = this.rate.sample(this.#frameCount());

    // 24fps is the bar this whole app is built to check.
    this.#row(`${this.label} fps`, fps === null ? '--' : fps.toFixed(1), rateClass(fps));

    this.#row('time to first frame',
      this.firstFrameAt === null ? 'waiting' : `${this.firstFrameAt.toFixed(0)} ms`,
      this.firstFrameAt === null ? 'v-dim' : 'v-ok');

    if (v) {
      this.#row('resolution', v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '--',
        v.videoWidth >= 1920 ? 'v-ok' : v.videoWidth ? 'v-warn' : 'v-dim');
      this.#row('readyState', READY[v.readyState] ?? v.readyState,
        v.readyState >= 3 ? 'v-ok' : 'v-warn');
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
    } else {
      this.#row('frames painted', this.paints);
    }

    this.#row('rebuffers', this.stalls, this.stalls === 0 ? 'v-ok' : 'v-bad');

    const net = this.#networkBytes();
    if (net) this.#row('media downloaded', `${(net / 1e6).toFixed(1)} MB`);

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
