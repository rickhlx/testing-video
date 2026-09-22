// Wiring: pick a clip, pick a pipeline, run it, report the same numbers either
// way.
//
// The clip list comes from the server's scan of ingested manifests, so nothing
// here knows any clip by name and adding one is an ingest, not an edit.

import { FrameSequencePlayer } from './player.js';
import { Telemetry } from './telemetry.js';

const els = {
  clip: document.getElementById('clip'),
  modes: document.getElementById('modes'),
  meta: document.getElementById('meta'),
  stage: document.getElementById('stage'),
  notes: document.getElementById('notes'),
  panel: document.getElementById('panel'),
  play: document.getElementById('play'),
  pause: document.getElementById('pause'),
  restart: document.getElementById('restart'),
};

const t = new Telemetry({ mount: els.panel });

let clips = [];
let current = null;  // the selected clip
let mode = 'frames'; // 'frames' | 'reference'
let player = null;   // FrameSequencePlayer, in frames mode
let video = null;    // HTMLVideoElement, in reference mode

// ------------------------------------------------------------------- catalog

try {
  clips = await (await fetch('/api/clips')).json();
} catch (e) {
  t.fail(`could not read the clip catalog: ${e.message}`);
}

if (!clips.length) {
  empty();
} else {
  for (const c of clips) {
    els.clip.append(new Option(`${c.title} — ${describe(c)}`, c.slug));
  }

  // The URL carries the selection, so a particular clip and mode can be handed
  // to someone else, or to a fleet of clients, as one link.
  const params = new URLSearchParams(location.search);
  const wanted = clips.find((c) => c.slug === params.get('clip')) ?? clips[0];
  if (params.get('mode') === 'reference') mode = 'reference';
  els.clip.value = wanted.slug;
  load(wanted);
}

els.clip.addEventListener('change', () => {
  load(clips.find((c) => c.slug === els.clip.value));
});

els.modes.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || btn.dataset.mode === mode) return;
  mode = btn.dataset.mode;
  load(current);
});

els.play.addEventListener('click', () => (player ? player.play() : video?.play()));
els.pause.addEventListener('click', () => (player ? player.pause() : video?.pause()));
els.restart.addEventListener('click', () => {
  if (player) return player.restart();
  if (video) { video.currentTime = 0; video.play(); }
});

// --------------------------------------------------------------------- modes

function load(clip) {
  if (!clip) return;
  current = clip;

  // Reference mode is only offered for clips that were ingested with one.
  const refBtn = els.modes.querySelector('[data-mode="reference"]');
  refBtn.disabled = !clip.reference;
  if (!clip.reference && mode === 'reference') mode = 'frames';
  for (const b of els.modes.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }

  teardown();
  history.replaceState(null, '', `?clip=${encodeURIComponent(clip.slug)}&mode=${mode}`);
  els.meta.textContent = describe(clip);

  if (mode === 'frames') startFrames(clip);
  else startReference(clip);
}

function teardown() {
  player?.destroy();
  player = null;
  if (video) {
    // Blank the source before dropping the element, or Chromium keeps the
    // request in flight and the next run is measured against a link that is
    // still carrying the last one.
    video.pause();
    video.removeAttribute('src');
    video.load();
    video = null;
  }
  els.stage.textContent = '';
}

function startFrames(clip) {
  t.reset({ label: 'painted', target: clip.fps });
  t.log(`${clip.slug}: ${clip.count} frames @ ${clip.fps}fps, ${fmtBytes(clip.frameBytes)} of stills`, 'good');

  const canvas = document.createElement('canvas');
  els.stage.append(canvas);

  // The page paints images and has no media element, so sound rides on a
  // separate audio-only file. That is an audio element, not a video one, so
  // the pipeline this method avoids is still avoided.
  let audio = null;
  if (clip.audio) {
    audio = document.createElement('audio');
    audio.src = `/media/${clip.slug}/${clip.audio}`;
    audio.preload = 'auto';
  }

  player = new FrameSequencePlayer({
    clip, canvas, audio,
    onLog: (msg, cls) => t.log(msg, cls),
    onStats: (s) => {
      // markFrame drives the panel's own rate, so it must be called exactly
      // once per painted frame rather than once per stats callback.
      while (t.paints < s.painted) t.markFrame();

      t.set('frame', `${Math.max(0, s.index - clip.start + 1)} / ${s.total}`);
      t.set('buffered ahead', `${s.bufferedAhead} (want ${s.leadTarget})`,
        s.bufferedAhead >= s.leadTarget * 0.5 ? 'v-ok' : s.bufferedAhead > 0 ? 'v-warn' : 'v-bad');
      t.set('frames skipped', s.skipped, s.skipped ? 'v-bad' : 'v-ok');
      t.set('images decoded', s.decoded);
      t.set('fetches in flight', s.inflight);
      t.set('images downloaded', fmtBytes(s.bytes));
      if (s.waiting !== undefined) t.set('waiting on frame', s.waiting, 'v-warn');
      else t.unset('waiting on frame');
    },
  });
  player.play();

  notes(`
    <p>Every frame arrives as a still image, is decoded to an
       <code>ImageBitmap</code>, and is drawn to a 2D canvas on a
       <code>${clip.fps}</code>fps clock. No <code>&lt;video&gt;</code>, no
       <code>VideoDecoder</code>, no MSE: nothing on this page is a media
       element, so there is no video pipeline to intercept.</p>
    <p>If this holds ${clip.fps} while the reference encode of the same clip
       drops, the frames are being taken inside the media pipeline rather than
       on the link or in raw decode. The cost moves to image decode and to
       keeping frames fetched ahead, so a slow link starves the buffer and shows
       up as skipped frames &mdash; check <em>buffered ahead</em> before reading
       a low rate as a client problem.</p>
    <p>Stills for this clip are ${fmtBytes(clip.frameBytes)} against
       ${fmtBytes(clip.bytes - clip.frameBytes)} for its audio and reference
       encode. That ratio is the standing cost of having no codec.</p>`);
}

function startReference(clip) {
  video = document.createElement('video');
  video.src = `/media/${clip.slug}/${clip.reference}`;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  els.stage.append(video);

  t.reset({ video, label: 'presented', target: clip.fps });
  t.log(`${clip.slug}: h264 reference through the native decode path`, 'good');
  video.play().catch(() => t.log('autoplay blocked; press play', 'err'));

  notes(`
    <p>The same clip as an ordinary <code>&lt;video&gt;</code> against an h264
       encode of the same frames. This is the control: it engages every part of
       the pipeline the frame sequence avoids &mdash; demux, hardware decode,
       the compositor's video overlay.</p>
    <p>Compare <em>presented fps</em> and <em>frames dropped</em> here against
       <em>painted fps</em> and <em>frames skipped</em> in frames mode. A client
       that holds rate on the stills but not on this one is losing frames
       somewhere that knows it is looking at video.</p>`);
}

// --------------------------------------------------------------------- bits

function describe(c) {
  const secs = c.duration ? `${c.duration.toFixed(0)}s` : `${(c.count / c.fps).toFixed(0)}s`;
  return `${c.width}x${c.height} · ${c.fps}fps · ${secs} · ${fmtBytes(c.frameBytes)} stills`;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

function notes(html) { els.notes.innerHTML = html; }

function empty() {
  els.clip.disabled = true;
  for (const b of [...els.modes.querySelectorAll('button'), els.play, els.pause, els.restart]) b.disabled = true;
  els.stage.innerHTML = `
    <div class="empty">
      <p>No clips ingested yet.</p>
      <p><code>make sample</code> builds a synthetic one with a burned-in frame
         indicator.<br>
         <code>make ingest SRC=path/to/video.mp4</code> adds one of yours.</p>
    </div>`;
  notes(`<p>Clips are discovered by scanning <code>media/</code> for manifests,
            so adding one needs no change to this page.</p>`);
}
