import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { TransitionShaderEntry } from '@joy-media/transition-shaders';
import { getTransitionShader } from '@joy-media/transition-shaders';

const TRANSITION_A = '/transitions/preview/transition1.png';
const TRANSITION_B = '/transitions/preview/transition2.png';

let sharedImageA: HTMLImageElement | null = null;
let sharedImageB: HTMLImageElement | null = null;
let loadPromise: Promise<readonly [HTMLImageElement, HTMLImageElement]> | null = null;

function loadSharedImages(): Promise<readonly [HTMLImageElement, HTMLImageElement]> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = Promise.all([
    loadImage(TRANSITION_A),
    loadImage(TRANSITION_B),
  ]).then(([a, b]) => {
    sharedImageA = a;
    sharedImageB = b;
    return [a, b] as const;
  }).catch((error) => {
    loadPromise = null;
    throw error;
  });
  return loadPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

interface TransitionPreviewCardProps {
  readonly entry: TransitionShaderEntry;
  readonly isActive: boolean;
}

export function TransitionPreviewCard({ entry, isActive }: TransitionPreviewCardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef<number>(0);
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSharedImages().then(() => {
      if (!cancelled) {
        loadedRef.current = true;
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const paint = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (canvas === null || sharedImageA === null || sharedImageB === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const w = canvas.width;
    const h = canvas.height;

    if (startRef.current === 0) startRef.current = time;
    const elapsed = time - startRef.current;
    const DURATION = 2400;
    const progress = (elapsed % DURATION) / DURATION;

    ctx.clearRect(0, 0, w, h);
    drawTransition(ctx, entry.id, sharedImageA, sharedImageB, progress, w, h);

    if (isActive) {
      rafRef.current = requestAnimationFrame(paint);
    }
  }, [entry.id, isActive]);

  useEffect(() => {
    if (!loaded || !isActive) return;
    startRef.current = 0;
    rafRef.current = requestAnimationFrame(paint);
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [loaded, isActive, paint]);

  const handleMouseEnter = useCallback(() => {
    if (!loaded) return;
    startRef.current = 0;
    rafRef.current = requestAnimationFrame(paint);
  }, [loaded, paint]);

  const handleMouseLeave = useCallback(() => {
    if (rafRef.current !== undefined) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="transition-preview-canvas"
      width={120}
      height={90}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ opacity: loaded ? 1 : 0 }}
    />
  );
}

function drawTransition(
  ctx: CanvasRenderingContext2D,
  id: string,
  imgA: HTMLImageElement,
  imgB: HTMLImageElement,
  progress: number,
  w: number,
  h: number,
) {
  const t = progress < 0.19 ? 0 :
    progress < 0.50 ? (progress - 0.19) / 0.31 :
    progress < 0.69 ? 1 :
    progress < 1.0 ? (1.0 - progress) / 0.31 : 0;

  const forward = progress < 0.69;

  if (id === 'dissolve' || id === 'gl:fade' || id === 'gl:fadegrayscale') {
    ctx.globalAlpha = 1;
    ctx.drawImage(forward ? imgA : imgB, 0, 0, w, h);
    ctx.globalAlpha = t;
    ctx.drawImage(forward ? imgB : imgA, 0, 0, w, h);
    ctx.globalAlpha = 1;
    return;
  }

  if (id === 'wipe' || id === 'gl:wipeLeft') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const clipX = forward ? w * (1 - t) : w * t;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, w - clipX, h);
    ctx.clip();
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'gl:wipeRight') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const clipX = forward ? w * t : w * (1 - t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, clipX, h);
    ctx.clip();
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'gl:wipeUp') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const clipY = forward ? h * (1 - t) : h * t;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipY, w, h - clipY);
    ctx.clip();
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'gl:wipeDown') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const clipY = forward ? h * t : h * (1 - t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, clipY);
    ctx.clip();
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'slide' || id === 'gl:Directional') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const offsetX = forward ? -w * (1 - t) : -w * t;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * t, h);
    ctx.clip();
    ctx.drawImage(imgB, offsetX, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'gl:CrossZoom') {
    const scale = 1 + t * 0.5;
    ctx.globalAlpha = 1 - t;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1 / (1 - t * 0.3 + 0.001), 1 / (1 - t * 0.3 + 0.001));
    ctx.drawImage(imgA, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.globalAlpha = t;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1 + t * 0.3, 1 + t * 0.3);
    ctx.drawImage(imgB, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }

  if (id === 'gl:SimpleZoom') {
    const z = t < 0.5 ? 1 + t * 2 : 2 - (t - 0.5) * 2;
    ctx.globalAlpha = 1;
    ctx.drawImage(imgA, 0, 0, w, h);
    ctx.globalAlpha = t < 0.5 ? 0 : (t - 0.5) * 2;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(z, z);
    ctx.drawImage(imgB, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }

  if (id === 'gl:GlitchDisplace') {
    ctx.drawImage(imgA, 0, 0, w, h);
    ctx.globalAlpha = t;
    const glitchX = Math.sin(t * 20) * 8;
    const stripeH = h / 8;
    for (let y = 0; y < h; y += stripeH) {
      const offset = Math.random() < t ? glitchX : 0;
      ctx.drawImage(imgB, offset, y, w, stripeH, 0, y, w, stripeH);
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (id === 'gl:CircleCrop') {
    ctx.drawImage(imgA, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    const r = t * Math.max(w, h) * 0.8;
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.restore();
    return;
  }

  if (id === 'gl:LinearBlur') {
    ctx.globalAlpha = 1;
    ctx.filter = `blur(${t * 8}px)`;
    ctx.drawImage(imgA, 0, 0, w, h);
    ctx.globalAlpha = t;
    ctx.drawImage(imgB, 0, 0, w, h);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    return;
  }

  if (id === 'gl:windowslice') {
    ctx.drawImage(imgA, 0, 0, w, h);
    const slices = 10;
    const sliceH = h / slices;
    for (let i = 0; i < slices; i++) {
      const offset = (i % 2 === 0 ? 1 : -1) * w * t;
      ctx.drawImage(imgB, offset, i * sliceH, w, sliceH, 0, i * sliceH, w, sliceH);
    }
    return;
  }

  // Default: simple crossfade
  ctx.globalAlpha = 1;
  ctx.drawImage(forward ? imgA : imgB, 0, 0, w, h);
  ctx.globalAlpha = t;
  ctx.drawImage(forward ? imgB : imgA, 0, 0, w, h);
  ctx.globalAlpha = 1;
}
