import { useEffect, useState, type ReactNode } from 'react';

const MATRIX_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEF';

function randomGlyph(): string {
  return MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)] ?? '0';
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * One-shot Matrix decode for a single login-title letter (J / o / y).
 * Scrambles through glyphs, then locks to `finalChar`.
 */
export function MatrixTitleChar({
  finalChar,
  delayMs,
  cascadeDelayMs,
}: {
  readonly finalChar: string;
  readonly delayMs: number;
  readonly cascadeDelayMs: number;
}): ReactNode {
  const [glyph, setGlyph] = useState(finalChar);
  const [scrambling, setScrambling] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setGlyph(finalChar);
      setScrambling(false);
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    const startId = window.setTimeout(() => {
      if (cancelled) return;
      setScrambling(true);
      const started = Date.now();
      const durationMs = 700;
      intervalId = window.setInterval(() => {
        if (cancelled) return;
        const elapsed = Date.now() - started;
        if (elapsed >= durationMs) {
          setGlyph(finalChar);
          setScrambling(false);
          if (intervalId !== undefined) window.clearInterval(intervalId);
          return;
        }
        setGlyph(randomGlyph());
      }, 40);
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(startId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [finalChar, delayMs]);

  return (
    <span
      className={`login-title-char login-title-matrix-slot${scrambling ? ' is-matrix' : ''}`}
      style={{ animationDelay: `${cascadeDelayMs}ms` }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
