// The frame-sequence player: a clip as individual still images, blitted to a
// canvas on a fixed clock.
//
// There is no <video>, no VideoDecoder and no MediaSource anywhere in here. The
// browser's media pipeline is never engaged, so a frame-drop control that hooks
// that pipeline has nothing to act on. Any drop this reports is the page's own
// doing -- images that did not arrive in time -- which is why it reports the
// buffer state alongside the rate.
//
// Everything that varies between clips (rate, size, frame count, file naming)
// comes from the clip manifest, so a clip plays at its own rate rather than an
// assumed 1080p24.

/** Seconds of frames to keep fetched ahead of the presentation clock. */
const LEAD_SECONDS = 2;

/** Concurrent image fetches. Enough to fill a fat pipe, few enough that a slow
 *  one does not queue thousands of requests the clock has already passed. */
const MAX_INFLIGHT = 6;

export class FrameSequencePlayer {
  /**
   * @param {object} opts
   * @param {object} opts.clip      manifest entry from /api/clips
   * @param {HTMLCanvasElement} opts.canvas
   * @param {HTMLAudioElement} [opts.audio]
   * @param {(stats: object) => void} [opts.onStats]  called once per painted frame
   * @param {(msg: string, cls?: string) => void} [opts.onLog]
   */
  constructor({ clip, canvas, audio = null, onStats = () => {}, onLog = () => {} }) {
    this.clip = clip;
    this.canvas = canvas;
    this.audio = audio;
    this.onStats = onStats;
    this.onLog = onLog;

    this.lead = Math.max(12, Math.round(clip.fps * LEAD_SECONDS));
    this.bitmaps = new Map(); // index -> ImageBitmap, a sliding window
    this.playing = false;
    this.stopped = false;

    canvas.width = clip.width;
    canvas.height = clip.height;
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.#resetCounters();
    requestAnimationFrame(this.#loop);

    // Buffering runs on its own clock, not the paint loop's.
    // requestAnimationFrame is throttled hard in a backgrounded tab and the
    // fetch pipeline must not be dragged down with it: keep the lead topped up
    // independently of how often the canvas actually repaints.
    this.pumpTimer = setInterval(() => {
      if (this.playing) this.#pump(this.lastDrawn + 1);
    }, 100);
  }

  // ------------------------------------------------------------------ public

  play() {
    if (this.playing) return;
    if (this.ended) this.#rewind();
    this.playing = true;
    // A pause moves the clock's origin, otherwise the elapsed time counts the
    // wall clock spent paused and the run resumes several seconds late.
    if (this.pausedAt !== null && this.startedAt !== null) {
      this.startedAt += performance.now() - this.pausedAt;
    }
    this.pausedAt = null;
    this.#pump(this.lastDrawn + 1);
    this.audio?.play().catch(() => this.onLog('sound needs a click on play', 'err'));
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.pausedAt = performance.now();
    this.audio?.pause();
  }

  restart() {
    this.#rewind();
    this.playing = true;
    this.#pump(this.clip.start);
    if (this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }
  }

  /** Release every held bitmap and stop the loops. Call before swapping clips:
   *  ImageBitmaps hold real memory the GC will not reclaim on its own. */
  destroy() {
    this.stopped = true;
    this.playing = false;
    clearInterval(this.pumpTimer);
    this.#dropBitmaps();
    this.audio?.pause();
  }

  // ----------------------------------------------------------------- private

  #resetCounters() {
    this.decoded = 0;
    this.painted = 0;
    this.skipped = 0;
    this.bytes = 0;
    this.inflight = 0;
    this.fetchCursor = this.clip.start;
    this.lastDrawn = this.clip.start - 1;
    this.startedAt = null;
    this.pausedAt = null;
    this.ended = false;
  }

  // A run owns all of its buffer state, so rewinding has to drop what is held
  // as well as move the cursor -- otherwise the clock waits on a first frame
  // that was already consumed and closed, and presentation deadlocks while
  // decode races ahead.
  #rewind() {
    this.#dropBitmaps();
    this.#resetCounters();
  }

  #dropBitmaps() {
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
  }

  #url(i) {
    const m = this.clip.pattern.match(/%0(\d+)d/);
    const width = m ? Number(m[1]) : 5;
    return `/media/${this.clip.slug}/` +
      this.clip.pattern.replace(/%0\d+d/, String(i).padStart(width, '0'));
  }

  get #lastIndex() {
    return this.clip.start + this.clip.count - 1;
  }

  // Keep `lead` frames ahead of whatever the clock is about to want. Fetch as a
  // Blob, decode to an ImageBitmap off the main thread, hold it until drawn.
  #pump(target) {
    while (this.fetchCursor <= this.#lastIndex &&
           this.fetchCursor <= target + this.lead &&
           this.inflight < MAX_INFLIGHT) {
      const i = this.fetchCursor++;
      this.inflight++;
      (async () => {
        try {
          const res = await fetch(this.#url(i));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          this.bytes += blob.size;
          const bitmap = await createImageBitmap(blob);
          // A clip swap or rewind may have landed while this was in flight.
          if (this.stopped || i <= this.lastDrawn) bitmap.close();
          else this.bitmaps.set(i, bitmap);
          this.decoded++;
        } catch (e) {
          this.onLog(`frame ${i}: ${e.message}`, 'err');
        } finally {
          this.inflight--;
        }
      })();
    }
  }

  // An arrow-function field rather than a method: requestAnimationFrame needs a
  // bound callback, and a private method cannot be reassigned to a bound copy.
  #loop = (now) => {
    if (this.stopped) return;
    if (this.playing) this.#present(now);
    requestAnimationFrame(this.#loop);
  };

  #present(now) {
    // The clock starts when the first frame is actually in hand, not when play
    // was pressed: otherwise a slow first fetch is charged to the clip as a
    // burst of drops that never happened.
    if (this.startedAt === null) {
      if (!this.bitmaps.has(this.clip.start)) {
        this.onStats(this.#stats({ waiting: this.clip.start }));
        return;
      }
      this.startedAt = now;
    }

    const elapsed = (now - this.startedAt) / 1000;
    const want = this.clip.start + Math.floor(elapsed * this.clip.fps);
    const target = Math.min(want, this.#lastIndex);

    this.#pump(target);

    if (target > this.lastDrawn) {
      // Draw the newest frame actually held at or before the clock target. If
      // buffering fell behind the wall clock, skip ahead to it and count the
      // gap as drops -- never freeze on a frame that has not arrived, which
      // reads as a dead page rather than a starved one.
      let show = -1;
      for (let i = target; i > this.lastDrawn; i--) {
        if (this.bitmaps.has(i)) { show = i; break; }
      }
      if (show < 0) {
        // Nothing buffered at or before the target: a genuine starve, not a
        // hang. The next frame to land paints and the clock catches up.
        this.onStats(this.#stats({ waiting: target }));
        return;
      }

      this.ctx.drawImage(this.bitmaps.get(show), 0, 0, this.canvas.width, this.canvas.height);
      this.painted++;
      this.skipped += show - this.lastDrawn - 1;
      // Free everything already passed, so memory stays bounded.
      for (const [i, b] of this.bitmaps) {
        if (i <= show) { b.close(); this.bitmaps.delete(i); }
      }
      this.lastDrawn = show;
    }

    if (this.lastDrawn >= this.#lastIndex) {
      this.playing = false;
      this.ended = true;
      this.audio?.pause();
      this.onLog('ended', 'good');
    }
    this.onStats(this.#stats({}));
  }

  #stats(extra) {
    return {
      painted: this.painted,
      decoded: this.decoded,
      skipped: this.skipped,
      bytes: this.bytes,
      inflight: this.inflight,
      index: this.lastDrawn,
      total: this.clip.count,
      bufferedAhead: Math.max(0, this.fetchCursor - 1 - this.lastDrawn),
      leadTarget: this.lead,
      ...extra,
    };
  }
}
