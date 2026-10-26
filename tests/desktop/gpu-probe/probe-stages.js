/* Stage bodies for the GPU stage probe (L2, plan section 3.2, step 2). Test tooling: the app never loads this page.
 * Each stage returns plain data or throws. S7, the real export spec, runs through run-default-export-repeat.ps1 instead. */
/* global document, window, navigator, performance, setTimeout, clearInterval, setInterval, VideoEncoder, VideoFrame, MediaRecorder */
(function () {
  'use strict';

  const WIDTH = 1280;
  const HEIGHT = 720;
  const FRAME_RATE = 30;
  const BITRATE = 5000000;
  const AVC_ENCODE = 'avc1.42001f';
  const AVC_RECORD = 'video/mp4;codecs=avc1.42E01E';
  const RECORD_MS = 1000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function canvasOf(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function webgl(canvas) {
    return canvas.getContext('webgl2') || canvas.getContext('webgl');
  }

  function paint2d(context, step) {
    context.fillStyle = 'hsl(' + ((step * 12) % 360) + ', 80%, 50%)';
    context.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function paintWebGL(gl, step) {
    gl.clearColor((step % 60) / 60, 0.5, 0.5, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  async function encodeOneFrame(hardwareAcceleration) {
    const canvas = canvasOf(WIDTH, HEIGHT);
    paint2d(canvas.getContext('2d'), 0);
    const chunkSizes = [];
    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk) => chunkSizes.push(chunk.byteLength),
      error: (error) => {
        encoderError = String(error);
      },
    });
    encoder.configure({
      codec: AVC_ENCODE,
      width: WIDTH,
      height: HEIGHT,
      bitrate: BITRATE,
      framerate: FRAME_RATE,
      hardwareAcceleration,
    });
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    encoder.close();
    if (encoderError) throw new Error(encoderError);
    return {
      chunks: chunkSizes.length,
      bytes: chunkSizes.reduce((total, size) => total + size, 0),
    };
  }

  async function recordCanvas(useWebGL) {
    if (!MediaRecorder.isTypeSupported(AVC_RECORD)) return { supported: false };
    const canvas = canvasOf(WIDTH, HEIGHT);
    const gl = useWebGL ? webgl(canvas) : null;
    if (useWebGL && !gl) return { supported: true, webgl: false };
    const context = useWebGL ? null : canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(FRAME_RATE), {
      mimeType: AVC_RECORD,
      videoBitsPerSecond: BITRATE,
    });
    const parts = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) parts.push(event.data);
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => reject(new Error(String(event.error || 'MediaRecorder error')));
    });
    let step = 0;
    const timer = setInterval(() => {
      if (gl) paintWebGL(gl, step);
      else paint2d(context, step);
      step += 1;
    }, 1000 / FRAME_RATE);
    recorder.start(100);
    await sleep(RECORD_MS);
    clearInterval(timer);
    recorder.stop();
    await stopped;
    return {
      supported: true,
      webgl: useWebGL,
      chunks: parts.length,
      bytes: parts.reduce((total, part) => total + part.size, 0),
    };
  }

  const stages = {
    S0: async () => {
      await sleep(RECORD_MS);
      return { idle: true };
    },
    S1: async () => {
      const gl = webgl(canvasOf(640, 360));
      if (!gl) return { webgl: false };
      gl.clearColor(0.2, 0.4, 0.6, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.finish();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl: true,
        version: gl.getParameter(gl.VERSION),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      };
    },
    S2: async () => {
      if (!navigator.mediaCapabilities) return { available: false };
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'record',
        video: {
          contentType: AVC_RECORD,
          width: WIDTH,
          height: HEIGHT,
          bitrate: BITRATE,
          framerate: FRAME_RATE,
        },
      });
      return {
        supported: info.supported,
        smooth: info.smooth,
        powerEfficient: info.powerEfficient,
      };
    },
    S3: async () => {
      if (typeof VideoEncoder === 'undefined') return { available: false };
      const support = await VideoEncoder.isConfigSupported({
        codec: AVC_ENCODE,
        width: WIDTH,
        height: HEIGHT,
        bitrate: BITRATE,
        framerate: FRAME_RATE,
        hardwareAcceleration: 'prefer-hardware',
      });
      return {
        supported: support.supported,
        hardwareAcceleration: support.config ? support.config.hardwareAcceleration : null,
      };
    },
    S4: async () => {
      if (typeof VideoEncoder === 'undefined') return { available: false };
      return encodeOneFrame('prefer-hardware');
    },
    S5: async () => recordCanvas(false),
    S6: async () => recordCanvas(true),
  };

  window.runProbeStage = async function runProbeStage(stage) {
    if (stage === 'S7') {
      throw new Error('S7 is the real export spec; run it through run-default-export-repeat.ps1');
    }
    const run = stages[stage];
    if (!run) throw new Error('unknown stage ' + stage);
    const started = performance.now();
    const result = await run();
    return Object.assign({}, result, { durationMs: Math.round(performance.now() - started) });
  };
})();
