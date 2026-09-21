// Draws decoded frames onto an OffscreenCanvas, entirely off the main thread.
//
// Frames arrive as a transferred ReadableStream of VideoFrame objects from
// MediaStreamTrackProcessor, so the main thread does no per-frame work at all
// beyond receiving the counter update.
let painted = 0;
let drawMsTotal = 0;

self.onmessage = async ({ data: { canvas, readable } }) => {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const reader = readable.getReader();

  for (;;) {
    const { done, value: frame } = await reader.read();
    if (done) break;
    const t0 = performance.now();
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    drawMsTotal += performance.now() - t0;
    // VideoFrames hold real memory; failing to close them stalls the pipeline.
    frame.close();
    painted++;
    self.postMessage({ painted, avgDrawMs: drawMsTotal / painted });
  }
  self.postMessage({ painted, avgDrawMs: drawMsTotal / painted, done: true });
};
