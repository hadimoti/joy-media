/**
 * The first JOY scene templates (WP-04.5 + OSS overlay pack). They are
 * deliberately small, network-free packages so they are usable as independent
 * authoring examples and as deterministic golden fixtures.
 *
 * Layout ideas adapted (re-authored) from MIT lower-third / title patterns;
 * motion is driven only by `ctx.progress` / `ctx.timeUs` (ADR-0006).
 */

import type { SceneManifestV1 } from './manifest.js';
import type { SceneVariableSchema, SceneVariableValue } from './variables.js';
import { resolveSceneVariables } from './variables.js';

export type FirstPartySceneId =
  | 'joy.firstparty.title'
  | 'joy.firstparty.product-card'
  | 'joy.firstparty.lower-third'
  | 'joy.firstparty.data-list'
  | 'joy.firstparty.lower-third-bar'
  | 'joy.firstparty.lower-third-split'
  | 'joy.firstparty.title-cinematic'
  | 'joy.firstparty.countdown'
  | 'joy.firstparty.caption-card'
  | 'joy.firstparty.end-slate'
  | 'joy.firstparty.super-app-hero'
  | 'joy.firstparty.news-ticker'
  | 'joy.firstparty.social-badge'
  | 'joy.firstparty.chapter-marker'
  | 'joy.firstparty.score-bug'
  | 'joy.firstparty.feature-portrait'
  | 'joy.firstparty.story-beat'
  | 'joy.firstparty.avatar-intro'
  | 'joy.firstparty.poster-reveal'
  | 'joy.firstparty.split-frame'
  | 'joy.firstparty.glass-card'
  | 'joy.firstparty.neon-sign'
  | 'joy.firstparty.chrome-title'
  | 'joy.firstparty.gradient-sweep'
  | 'joy.firstparty.photo-stack'
  | 'joy.firstparty.spotlight-quote'
  | 'joy.firstparty.ticket-stub'
  | 'joy.firstparty.aurora-panel'
  | 'joy.firstparty.magazine-cover'
  | 'joy.firstparty.holo-badge';

/** Normalized viewport crop (0–1) for catalog live thumbs — zooms the active region. */
export interface ScenePreviewFocus {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const FOCUS_CENTER: ScenePreviewFocus = { x: 0.08, y: 0.28, w: 0.84, h: 0.44 };
const FOCUS_CENTER_WIDE: ScenePreviewFocus = { x: 0.06, y: 0.22, w: 0.88, h: 0.52 };
const FOCUS_BOTTOM: ScenePreviewFocus = { x: 0.03, y: 0.68, w: 0.94, h: 0.28 };
const FOCUS_MID_CARD: ScenePreviewFocus = { x: 0.08, y: 0.3, w: 0.84, h: 0.38 };
const FOCUS_TOP_RIGHT: ScenePreviewFocus = { x: 0.42, y: 0.08, w: 0.54, h: 0.22 };
const FOCUS_TOP_LEFT: ScenePreviewFocus = { x: 0.02, y: 0.06, w: 0.58, h: 0.18 };
const FOCUS_HERO: ScenePreviewFocus = { x: 0.04, y: 0.14, w: 0.82, h: 0.48 };
// Image+text bands: normalized w === h crops to the 9:16 catalog tile exactly.
const FOCUS_PORTRAIT_BAND: ScenePreviewFocus = { x: 0.09, y: 0.29, w: 0.34, h: 0.34 };
const FOCUS_STORY_COLUMN: ScenePreviewFocus = { x: 0.05, y: 0.25, w: 0.38, h: 0.38 };
const FOCUS_AVATAR_ROW: ScenePreviewFocus = { x: 0.05, y: 0.34, w: 0.36, h: 0.36 };
const FOCUS_POSTER: ScenePreviewFocus = { x: 0.06, y: 0.44, w: 0.42, h: 0.42 };
const FOCUS_SPLIT: ScenePreviewFocus = { x: 0.1, y: 0.3, w: 0.38, h: 0.38 };
const FOCUS_GLASS: ScenePreviewFocus = { x: 0.06, y: 0.37, w: 0.36, h: 0.36 };
const FOCUS_NEON: ScenePreviewFocus = { x: 0.14, y: 0.32, w: 0.36, h: 0.36 };
const FOCUS_CHROME: ScenePreviewFocus = { x: 0.12, y: 0.33, w: 0.36, h: 0.36 };
const FOCUS_SWEEP: ScenePreviewFocus = { x: 0.1, y: 0.34, w: 0.36, h: 0.36 };
const FOCUS_STACK: ScenePreviewFocus = { x: 0.12, y: 0.28, w: 0.4, h: 0.4 };
const FOCUS_QUOTE: ScenePreviewFocus = { x: 0.1, y: 0.28, w: 0.42, h: 0.42 };
const FOCUS_TICKET: ScenePreviewFocus = { x: 0.05, y: 0.37, w: 0.38, h: 0.38 };
const FOCUS_AURORA: ScenePreviewFocus = { x: 0.07, y: 0.33, w: 0.4, h: 0.4 };
const FOCUS_MAGAZINE: ScenePreviewFocus = { x: 0.08, y: 0.1, w: 0.44, h: 0.44 };
const FOCUS_BADGE: ScenePreviewFocus = { x: 0.09, y: 0.35, w: 0.38, h: 0.38 };

export interface FirstPartyScenePackage {
  readonly id: FirstPartySceneId;
  readonly name: string;
  readonly manifest: SceneManifestV1;
  readonly source: string;
  readonly variableSchema: SceneVariableSchema;
  readonly previewFocus: ScenePreviewFocus;
}

export interface ResolvedSceneInstance {
  readonly scene: FirstPartyScenePackage;
  readonly variables: Readonly<Record<string, SceneVariableValue>>;
}

const sharedManifest = (id: FirstPartySceneId): SceneManifestV1 => ({
  formatVersion: 1,
  id,
  version: '1.0.0',
  runtime: 'joy-html-scene-1',
  entry: 'dist/index.js',
  viewport: { width: 1080, height: 1920 },
  transparent: true,
  durationUs: 5_000_000,
  permissions: { network: [], storage: 'none' },
  determinism: { seededRandom: true, wallClock: false },
  variablesSchema: 'schema.json',
});

const title: FirstPartyScenePackage = {
  id: 'joy.firstparty.title',
  name: 'JOY Title',
  previewFocus: FOCUS_CENTER,
  manifest: sharedManifest('joy.firstparty.title'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'JOY Media' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Make it memorable' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 4);
    var rise = Math.round((1 - t) * 64);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 18,
        color: v.accent, fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'translateY(' + rise + 'px)',
        background: 'rgba(12,12,14,' + (0.35 * t) + ')'
      }
    },
      React.createElement('h1', {
        style: { margin: 0, fontSize: 72, letterSpacing: '0.04em', fontWeight: 700 }
      }, v.title),
      React.createElement('p', {
        style: { margin: 0, fontSize: 32, color: '#f2f2f4', opacity: Math.min(1, ctx.progress * 3) }
      }, v.subtitle));
  };`,
};

const productCard: FirstPartyScenePackage = {
  id: 'joy.firstparty.product-card',
  name: 'JOY Product Card',
  previewFocus: FOCUS_CENTER_WIDE,
  manifest: sharedManifest('joy.firstparty.product-card'),
  variableSchema: {
    product: { type: 'string', label: 'Product', default: 'Signature Blend' },
    price: { type: 'string', label: 'Price', default: '$24' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 3);
    var scale = 0.88 + 0.12 * t;
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center'
      }
    },
      React.createElement('article', {
        style: {
          width: 720, padding: '48px 56px', border: '4px solid ' + v.accent,
          background: 'rgba(16,16,16,0.88)', color: '#f5f5f5',
          fontFamily: 'Helvetica, Arial, sans-serif',
          opacity: t, transform: 'scale(' + scale + ')'
        }
      },
        React.createElement('h2', {
          style: { margin: '0 0 18px', fontSize: 52, color: v.accent }
        }, v.product),
        React.createElement('strong', { style: { fontSize: 40 } }, v.price)));
  };`,
};

const lowerThird: FirstPartyScenePackage = {
  id: 'joy.firstparty.lower-third',
  name: 'JOY Lower Third',
  previewFocus: FOCUS_BOTTOM,
  manifest: sharedManifest('joy.firstparty.lower-third'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Alex Morgan' },
    role: { type: 'string', label: 'Role', default: 'Creative Director' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 5);
    var slide = Math.round((1 - t) * -120);
    return React.createElement('section', {
      style: {
        position: 'absolute', left: 64, right: 120, bottom: 260,
        borderLeft: '12px solid ' + v.accent,
        padding: '22px 28px', background: 'rgba(12,12,12,0.9)',
        color: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'translateX(' + slide + 'px)'
      }
    },
      React.createElement('strong', {
        style: { display: 'block', fontSize: 40, color: v.accent }
      }, v.name),
      React.createElement('span', { style: { fontSize: 26, opacity: 0.9 } }, v.role));
  };`,
};

const dataList: FirstPartyScenePackage = {
  id: 'joy.firstparty.data-list',
  name: 'JOY Data List',
  previewFocus: FOCUS_MID_CARD,
  manifest: sharedManifest('joy.firstparty.data-list'),
  variableSchema: {
    heading: { type: 'string', label: 'Heading', default: 'Today at JOY' },
    itemOne: { type: 'string', label: 'Item one', default: 'Design' },
    itemTwo: { type: 'string', label: 'Item two', default: 'Build' },
    itemThree: { type: 'string', label: 'Item three', default: 'Share' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 3);
    var items = [v.itemOne, v.itemTwo, v.itemThree];
    return React.createElement('section', {
      style: {
        position: 'absolute', left: 96, right: 96, top: '28%',
        color: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'translateY(' + Math.round((1 - t) * 40) + 'px)'
      }
    },
      React.createElement('h2', {
        style: { margin: '0 0 28px', fontSize: 48, color: v.accent }
      }, v.heading),
      React.createElement('ol', {
        style: { margin: 0, padding: '0 0 0 40px', fontSize: 34, lineHeight: 1.55 }
      },
        items.map(function (item, index) {
          var show = Math.min(1, Math.max(0, (ctx.progress - index * 0.12) * 4));
          return React.createElement('li', {
            key: String(index),
            style: { opacity: show, transform: 'translateX(' + Math.round((1 - show) * 24) + 'px)' }
          }, item);
        })));
  };`,
};

const lowerThirdBar: FirstPartyScenePackage = {
  id: 'joy.firstparty.lower-third-bar',
  name: 'Lower Third Bar',
  previewFocus: FOCUS_BOTTOM,
  manifest: sharedManifest('joy.firstparty.lower-third-bar'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Alex Morgan' },
    role: { type: 'string', label: 'Role', default: 'Creative Director' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 4);
    var slide = Math.round((1 - t) * 120);
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 64, right: 64, bottom: 220,
        fontFamily: 'Georgia, "Times New Roman", serif',
        transform: 'translateX(' + (-slide) + 'px)',
        opacity: t
      }
    },
      React.createElement('div', {
        style: {
          display: 'inline-block', background: v.accent, color: '#111',
          padding: '14px 28px', fontSize: 42, fontWeight: 700, letterSpacing: '0.02em'
        }
      }, v.name),
      React.createElement('div', {
        style: {
          marginTop: 8, display: 'inline-block', background: 'rgba(12,12,12,0.88)',
          color: '#f5f5f5', padding: '10px 24px', fontSize: 26,
          fontFamily: 'Helvetica, Arial, sans-serif'
        }
      }, v.role));
  };`,
};

const lowerThirdSplit: FirstPartyScenePackage = {
  id: 'joy.firstparty.lower-third-split',
  name: 'Lower Third Split',
  previewFocus: FOCUS_BOTTOM,
  manifest: sharedManifest('joy.firstparty.lower-third-split'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Sam Rivera' },
    role: { type: 'string', label: 'Role', default: 'Host' },
    accent: { type: 'color', label: 'Accent', default: '#2bb3a0' },
    secondary: { type: 'color', label: 'Secondary', default: '#1a1a1a' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 3.5);
    var widen = Math.round(t * 100);
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 48, bottom: 260, width: (420 + widen) + 'px',
        display: 'flex', fontFamily: 'Helvetica, Arial, sans-serif', opacity: t
      }
    },
      React.createElement('div', {
        style: { width: 18, background: v.accent, flexShrink: 0 }
      }),
      React.createElement('div', { style: { flex: 1 } },
        React.createElement('div', {
          style: { background: v.secondary, color: '#fff', padding: '16px 22px', fontSize: 36, fontWeight: 700 }
        }, v.name),
        React.createElement('div', {
          style: { background: v.accent, color: '#111', padding: '10px 22px', fontSize: 22 }
        }, v.role)));
  };`,
};

const titleCinematic: FirstPartyScenePackage = {
  id: 'joy.firstparty.title-cinematic',
  name: 'Title Cinematic',
  previewFocus: FOCUS_CENTER,
  manifest: sharedManifest('joy.firstparty.title-cinematic'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'OPENING NIGHT' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'A JOY Media Story' },
    accent: { type: 'color', label: 'Accent', default: '#f2e8d5' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var fade = Math.min(1, ctx.progress * 2.2);
    var rise = Math.round((1 - Math.min(1, ctx.progress * 2.5)) * 48);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Georgia, "Times New Roman", serif',
        color: v.accent, textAlign: 'center',
        opacity: fade, transform: 'translateY(' + rise + 'px)'
      }
    },
      React.createElement('div', {
        style: { width: 120, height: 2, background: v.accent, marginBottom: 28, opacity: fade }
      }),
      React.createElement('h1', {
        style: { margin: 0, fontSize: 72, letterSpacing: '0.18em', fontWeight: 500 }
      }, v.title),
      React.createElement('p', {
        style: {
          margin: '22px 0 0', fontSize: 28, letterSpacing: '0.08em',
          fontFamily: 'Helvetica, Arial, sans-serif', opacity: Math.min(1, ctx.progress * 3)
        }
      }, v.subtitle));
  };`,
};

const countdown: FirstPartyScenePackage = {
  id: 'joy.firstparty.countdown',
  name: 'Countdown',
  previewFocus: FOCUS_CENTER_WIDE,
  manifest: sharedManifest('joy.firstparty.countdown'),
  variableSchema: {
    from: { type: 'number', label: 'From', default: 5 },
    label: { type: 'string', label: 'Label', default: 'Starting in' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var from = Math.max(1, Math.floor(Number(v.from) || 5));
    var remaining = Math.max(1, Math.ceil(from * (1 - Math.min(0.999, ctx.progress))));
    var phase = (ctx.progress * from) % 1;
    var pulse = 0.85 + 0.15 * (phase < 0.5 ? phase * 2 : (1 - phase) * 2);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Helvetica, Arial, sans-serif', color: v.accent
      }
    },
      React.createElement('div', { style: { fontSize: 28, letterSpacing: '0.2em', opacity: 0.9 } }, v.label),
      React.createElement('div', {
        style: { fontSize: 180, fontWeight: 700, lineHeight: 1, marginTop: 12, transform: 'scale(' + pulse + ')' }
      }, String(remaining)));
  };`,
};

const captionCard: FirstPartyScenePackage = {
  id: 'joy.firstparty.caption-card',
  name: 'Caption Card',
  previewFocus: FOCUS_MID_CARD,
  manifest: sharedManifest('joy.firstparty.caption-card'),
  variableSchema: {
    quote: { type: 'string', label: 'Quote', default: 'Craft is continuity under pressure.' },
    attribution: { type: 'string', label: 'Attribution', default: '— Studio Notes' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 3);
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 96, right: 96, top: '38%',
        background: 'rgba(16,16,16,0.82)', color: '#f7f2ea',
        padding: '48px 56px', borderTop: '6px solid ' + v.accent,
        fontFamily: 'Georgia, "Times New Roman", serif',
        opacity: t, transform: 'translateY(' + Math.round((1 - t) * 36) + 'px)'
      }
    },
      React.createElement('p', { style: { margin: 0, fontSize: 40, lineHeight: 1.35 } }, v.quote),
      React.createElement('p', {
        style: {
          margin: '28px 0 0', fontSize: 22, color: v.accent,
          fontFamily: 'Helvetica, Arial, sans-serif', letterSpacing: '0.04em'
        }
      }, v.attribution));
  };`,
};

const endSlate: FirstPartyScenePackage = {
  id: 'joy.firstparty.end-slate',
  name: 'End Slate',
  previewFocus: FOCUS_CENTER,
  manifest: sharedManifest('joy.firstparty.end-slate'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'Thanks for watching' },
    cta: { type: 'string', label: 'CTA', default: 'Subscribe for more' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 2.5);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(10,10,10,' + (0.55 * t) + ')',
        color: '#faf7f2', fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t
      }
    },
      React.createElement('h1', {
        style: { margin: 0, fontSize: 56, fontWeight: 600, letterSpacing: '0.04em' }
      }, v.title),
      React.createElement('div', {
        style: {
          marginTop: 36, padding: '16px 36px', border: '2px solid ' + v.accent,
          color: v.accent, fontSize: 26, letterSpacing: '0.12em', textTransform: 'uppercase',
          transform: 'scale(' + (0.92 + 0.08 * t) + ')'
        }
      }, v.cta));
  };`,
};

/**
 * Re-authored from joy-wg-bot Super App hero copy (`client/index.js` +
 * `super-app.css`). Font spin + angle beat are driven by `ctx.progress` /
 * `ctx.random` — no wall-clock CSS, no remote webfonts (ADR-0006).
 */
const superAppHero: FirstPartyScenePackage = {
  id: 'joy.firstparty.super-app-hero',
  name: 'Super App Hero',
  previewFocus: FOCUS_HERO,
  manifest: sharedManifest('joy.firstparty.super-app-hero'),
  variableSchema: {
    kicker: { type: 'string', label: 'Kicker', default: 'JOY SUPER APP' },
    lead: { type: 'string', label: 'Lead', default: 'One place.' },
    every: { type: 'string', label: 'Every', default: 'Every' },
    joy: { type: 'string', label: 'Joy word', default: 'Joy' },
    quoteBefore: {
      type: 'string',
      label: 'Quote (before soul)',
      default: 'is the rebellion of a',
    },
    quoteSoul: { type: 'string', label: 'Soul word', default: 'soul' },
    quoteAfter: { type: 'string', label: 'Quote (after soul)', default: 'that' },
    quoteEm: {
      type: 'string',
      label: 'Emphasized end',
      default: 'refuses to go dark',
    },
    accent: { type: 'color', label: 'Accent', default: '#ff9340' },
    copy: { type: 'color', label: 'Copy', default: '#f5f7fa' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    var enter = Math.min(1, p * 3.2);
    var rise = Math.round((1 - enter) * 40);
    var fonts = [
      { family: 'Georgia, "Times New Roman", serif', weight: 700, tracking: '-0.02em', size: 1 },
      { family: 'Palatino, Georgia, serif', weight: 800, tracking: '-0.04em', size: 1.02 },
      { family: 'Helvetica, Arial, sans-serif', weight: 900, tracking: '0.01em', size: 0.96 },
      { family: 'Impact, Haettenschweiler, sans-serif', weight: 700, tracking: '-0.01em', size: 1.04 },
      { family: 'cursive', weight: 700, tracking: '-0.03em', size: 1.08 },
      { family: '"Comic Sans MS", "Segoe Print", cursive', weight: 700, tracking: '-0.02em', size: 1.02 },
      { family: 'Tahoma, Geneva, sans-serif', weight: 900, tracking: '-0.02em', size: 0.98 },
      { family: '"Trebuchet MS", Helvetica, sans-serif', weight: 800, tracking: '-0.03em', size: 1 }
    ];
    var spinEnd = 0.42;
    var beatEnd = 0.92;
    var fontIndex;
    var angle = 0;
    var bounce = 0;
    if (p < spinEnd) {
      fontIndex = Math.floor((p / spinEnd) * fonts.length) % fonts.length;
    } else {
      // Settle on the last spin face (client.js keeps one font for the angle beat).
      fontIndex = fonts.length - 1;
      var beat = Math.min(1, Math.max(0, (p - spinEnd) / (beatEnd - spinEnd)));
      if (beat < 0.07) { angle = 45 * (beat / 0.07); bounce = 0.12 * (beat / 0.07); }
      else if (beat < 0.14) { var u = (beat - 0.07) / 0.07; angle = 45 * (1 - u); bounce = 0.12 * (1 - u); }
      else if (beat < 0.24) { angle = -6; bounce = -0.025; }
      else if (beat < 0.34) { angle = 5; bounce = 0.02; }
      else if (beat < 0.44) { angle = -4; bounce = -0.018; }
      else if (beat < 0.54) { angle = 3; bounce = 0.014; }
      else if (beat < 0.64) { angle = -2.5; bounce = -0.01; }
      else if (beat < 0.74) { angle = 2; bounce = 0.008; }
      else if (beat < 0.84) { angle = -1.2; bounce = -0.004; }
      else if (beat < 0.92) { angle = 0.8; bounce = 0.002; }
      else { angle = 0; bounce = 0; }
      if (p >= beatEnd) { angle = 0; bounce = 0; }
    }
    var joyFont = fonts[fontIndex] || fonts[0];
    var quoteFade = Math.min(1, Math.max(0, (p - 0.12) * 2.4));
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        direction: 'ltr', textAlign: 'left', unicodeBidi: 'isolate',
        color: 'rgba(245,247,250,0.92)',
        fontFamily: 'Tahoma, system-ui, sans-serif',
        opacity: enter, transform: 'translateY(' + rise + 'px)'
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 96, top: 360, width: 720,
          zIndex: 2
        }
      },
        React.createElement('div', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 12,
            color: v.accent, fontSize: 22, fontWeight: 900,
            letterSpacing: '0.18em', lineHeight: 1, textTransform: 'uppercase'
          }
        },
          React.createElement('span', {
            style: {
              width: 28, height: 2, background: 'currentColor',
              boxShadow: '0 0 12px currentColor', display: 'inline-block'
            }
          }),
          v.kicker),
        React.createElement('h2', {
          style: {
            margin: '18px 0 48px', color: v.copy,
            fontSize: 92, lineHeight: 0.96, letterSpacing: '-0.055em',
            fontWeight: 800, height: 200, overflow: 'visible'
          }
        },
          v.lead,
          React.createElement('span', {
            style: {
              display: 'flex', alignItems: 'flex-start', gap: '0.18em',
              height: '0.98em', lineHeight: 0.96
            }
          },
            React.createElement('span', { style: { flex: '0 0 auto' } }, v.every),
            React.createElement('span', {
              style: {
                position: 'relative', flex: '0 0 3.3em', width: '3.3em',
                height: '1.6em', minHeight: 100, overflow: 'visible'
              }
            },
              React.createElement('span', {
                style: {
                  position: 'absolute', left: 0, top: -28,
                  display: 'inline-flex', alignItems: 'center',
                  color: v.accent, width: '2.55em', height: '1.25em',
                  minHeight: 100, overflow: 'hidden',
                  fontFamily: joyFont.family, fontSize: (1.28 * joyFont.size) + 'em',
                  fontWeight: joyFont.weight, letterSpacing: joyFont.tracking,
                  lineHeight: 0.9, transformOrigin: '52% 72%',
                  transform: 'rotate(' + angle + 'deg) translateY(' + bounce + 'em)'
                }
              }, v.joy)))),
        React.createElement('p', {
          style: {
            margin: 0, maxWidth: 620, opacity: quoteFade,
            color: 'rgba(226,232,240,0.78)',
            fontFamily: 'Helvetica, Arial, sans-serif',
            fontSize: 28, fontWeight: 400, lineHeight: 1.58, letterSpacing: '0.012em',
            textShadow: '0 2px 18px rgba(0,0,0,0.38)'
          }
        },
          React.createElement('span', { style: { color: '#fff', fontSize: '1.25em', fontWeight: 500 } }, '\\u201C'),
          React.createElement('strong', {
            style: {
              color: '#fff', fontFamily: 'Georgia, cursive',
              fontSize: '1.35em', fontWeight: 700, letterSpacing: '-0.025em'
            }
          }, v.joy),
          ' ',
          React.createElement('span', { style: { fontSize: '0.94em', letterSpacing: '0.01em' } }, v.quoteBefore),
          ' ',
          React.createElement('span', {
            style: {
              color: '#fff', fontFamily: 'cursive', fontSize: '1.18em', letterSpacing: '-0.015em'
            }
          }, v.quoteSoul),
          ' ',
          React.createElement('span', { style: { fontSize: '0.94em' } }, v.quoteAfter),
          ' ',
          React.createElement('em', {
            style: {
              color: '#fff', fontStyle: 'normal', fontFamily: 'Georgia, cursive',
              fontSize: '1.28em', letterSpacing: '0.012em'
            }
          }, v.quoteEm),
          React.createElement('span', { style: { color: '#fff', fontSize: '1.25em', fontWeight: 500 } }, '\\u201D'))));
  };`,
};

const newsTicker: FirstPartyScenePackage = {
  id: 'joy.firstparty.news-ticker',
  name: 'News Ticker',
  previewFocus: FOCUS_BOTTOM,
  manifest: sharedManifest('joy.firstparty.news-ticker'),
  variableSchema: {
    label: { type: 'string', label: 'Label', default: 'LIVE' },
    headline: {
      type: 'string',
      label: 'Headline',
      default: 'JOY Media · New scenes ship with keyframed previews',
    },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 4);
    var shift = Math.round(ctx.progress * -520);
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 0, right: 0, bottom: 180,
        display: 'flex', alignItems: 'stretch',
        fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'translateY(' + Math.round((1 - t) * 28) + 'px)'
      }
    },
      React.createElement('div', {
        style: {
          background: v.accent, color: '#111', padding: '14px 22px',
          fontSize: 26, fontWeight: 800, letterSpacing: '0.12em', flexShrink: 0
        }
      }, v.label),
      React.createElement('div', {
        style: {
          flex: 1, overflow: 'hidden', background: 'rgba(12,12,12,0.9)',
          color: '#f4f4f4', display: 'flex', alignItems: 'center'
        }
      },
        React.createElement('div', {
          style: {
            whiteSpace: 'nowrap', padding: '0 24px', fontSize: 28,
            transform: 'translateX(' + shift + 'px)'
          }
        }, v.headline + '   ·   ' + v.headline)));
  };`,
};

const socialBadge: FirstPartyScenePackage = {
  id: 'joy.firstparty.social-badge',
  name: 'Social Badge',
  previewFocus: FOCUS_TOP_RIGHT,
  manifest: sharedManifest('joy.firstparty.social-badge'),
  variableSchema: {
    handle: { type: 'string', label: 'Handle', default: '@joymedia' },
    platform: { type: 'string', label: 'Platform', default: 'Follow along' },
    accent: { type: 'color', label: 'Accent', default: '#7cc4ff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 3.5);
    var pop = 0.86 + 0.14 * t;
    return React.createElement('div', {
      style: {
        position: 'absolute', right: 72, top: 220,
        fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'scale(' + pop + ') translateX(' + Math.round((1 - t) * 40) + 'px)',
        transformOrigin: '100% 0%'
      }
    },
      React.createElement('div', {
        style: {
          background: 'rgba(16,16,16,0.9)', color: '#fff',
          border: '2px solid ' + v.accent, borderRadius: 999,
          padding: '18px 28px', display: 'flex', flexDirection: 'column', gap: 6
        }
      },
        React.createElement('span', {
          style: { fontSize: 34, fontWeight: 800, color: v.accent, letterSpacing: '0.02em' }
        }, v.handle),
        React.createElement('span', {
          style: { fontSize: 20, opacity: 0.85, letterSpacing: '0.06em', textTransform: 'uppercase' }
        }, v.platform)));
  };`,
};

const chapterMarker: FirstPartyScenePackage = {
  id: 'joy.firstparty.chapter-marker',
  name: 'Chapter Marker',
  previewFocus: FOCUS_CENTER_WIDE,
  manifest: sharedManifest('joy.firstparty.chapter-marker'),
  variableSchema: {
    chapter: { type: 'string', label: 'Chapter', default: '03' },
    title: { type: 'string', label: 'Title', default: 'The Reveal' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 2.8);
    var line = Math.round(t * 180);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Georgia, "Times New Roman", serif', color: '#f7f2ea',
        opacity: t
      }
    },
      React.createElement('div', {
        style: {
          fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 22,
          letterSpacing: '0.28em', color: v.accent, marginBottom: 18
        }
      }, 'CHAPTER'),
      React.createElement('div', {
        style: { fontSize: 120, fontWeight: 600, lineHeight: 1, letterSpacing: '0.04em' }
      }, v.chapter),
      React.createElement('div', {
        style: { width: line, height: 2, background: v.accent, margin: '28px 0' }
      }),
      React.createElement('div', {
        style: {
          fontSize: 36, letterSpacing: '0.08em',
          transform: 'translateY(' + Math.round((1 - t) * 24) + 'px)'
        }
      }, v.title));
  };`,
};

const scoreBug: FirstPartyScenePackage = {
  id: 'joy.firstparty.score-bug',
  name: 'Score Bug',
  previewFocus: FOCUS_TOP_LEFT,
  manifest: sharedManifest('joy.firstparty.score-bug'),
  variableSchema: {
    left: { type: 'string', label: 'Left', default: 'JOY' },
    right: { type: 'string', label: 'Right', default: 'STUDIO' },
    score: { type: 'string', label: 'Score', default: '2 — 1' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var t = Math.min(1, ctx.progress * 4);
    var phase = (ctx.progress * 6) % 1;
    var tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    var pulse = 1 + 0.04 * tri;
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 64, top: 160,
        display: 'flex', alignItems: 'stretch',
        fontFamily: 'Helvetica, Arial, sans-serif',
        opacity: t, transform: 'translateY(' + Math.round((1 - t) * -30) + 'px) scale(' + pulse + ')',
        transformOrigin: '0% 0%'
      }
    },
      React.createElement('div', {
        style: {
          background: v.accent, color: '#111', padding: '16px 20px',
          fontWeight: 800, fontSize: 28, letterSpacing: '0.06em'
        }
      }, v.left),
      React.createElement('div', {
        style: {
          background: 'rgba(12,12,12,0.92)', color: '#fff',
          padding: '16px 26px', fontSize: 30, fontWeight: 700, minWidth: 120, textAlign: 'center'
        }
      }, v.score),
      React.createElement('div', {
        style: {
          background: '#2a2a2e', color: '#f0f0f0', padding: '16px 20px',
          fontWeight: 800, fontSize: 28, letterSpacing: '0.06em'
        }
      }, v.right));
  };`,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Image + multi-part text family.
 *
 * Each scene pairs a visual anchor with 2–3 staggered copy parts. The anchor is
 * a self-contained inline-SVG data URL built inside the scene source, so it
 * needs no asset resolver (browser live thumbs pass empty assets) and stays
 * offline per ADR-0006. Every image frame also carries a solid
 * `backgroundColor`, because the preview/Monitor surface painter rasterizes
 * background colors and text only — a gradient-only block would vanish there.
 *
 * Motion is a pure function of `ctx.progress`: one cubic ease, one
 * `part(delay)` stagger helper, and a short outro fade.
 * ────────────────────────────────────────────────────────────────────────── */

const featurePortrait: FirstPartyScenePackage = {
  id: 'joy.firstparty.feature-portrait',
  name: 'Feature Portrait',
  previewFocus: FOCUS_PORTRAIT_BAND,
  manifest: sharedManifest('joy.firstparty.feature-portrait'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'Alex Morgan' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Creative Director' },
    meta: { type: 'string', label: 'Meta', default: 'JOY Media · Episode 04' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
    imageSide: { type: 'enum', label: 'Image side', default: 'left', options: ['left', 'right'] },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var frame = part(0);
    var a = part(0.09);
    var b = part(0.17);
    var c = part(0.25);
    var rule = part(0.13);
    var right = v.imageSide === 'right';
    var slide = right ? 1 : -1;
    var portrait = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 760">' +
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="0.65" y2="1">' +
          '<stop offset="0" stop-color="#3b4354"/><stop offset="1" stop-color="#0d0f15"/>' +
        '</linearGradient></defs>' +
        '<rect width="600" height="760" fill="url(#bg)"/>' +
        '<path d="M0 598 L600 450 L600 536 L0 684 Z" fill="' + v.accent + '" opacity="0.26"/>' +
        '<rect x="266" y="366" width="68" height="152" rx="34" fill="#e4dbcc"/>' +
        '<ellipse cx="300" cy="806" rx="252" ry="292" fill="#f1ebe0"/>' +
        '<circle cx="300" cy="286" r="128" fill="#f7f2e8"/>' +
        '<path d="M172 286 a128 128 0 0 1 256 0 z" fill="' + v.accent + '"/>' +
        '<circle cx="300" cy="286" r="128" fill="none" stroke="' + v.accent +
          '" stroke-opacity="0.5" stroke-width="6"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 72, right: 72, top: 620,
          display: 'flex', flexDirection: right ? 'row-reverse' : 'row',
          alignItems: 'flex-end', gap: 44
        }
      },
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 384, height: Math.round(480 * frame),
            overflow: 'hidden', backgroundColor: '#161922', borderRadius: 26,
            boxShadow: '0 26px 64px rgba(0,0,0,0.46)'
          }
        },
          React.createElement('img', {
            src: portrait, alt: '',
            style: { display: 'block', width: 384, height: 480, objectFit: 'cover' }
          })),
        React.createElement('div', {
          style: { flex: '1 1 auto', minWidth: 0, paddingBottom: 14 }
        },
          React.createElement('div', {
            style: {
              color: '#f7f8fb', fontSize: 58, fontWeight: '800',
              lineHeight: '1.02', letterSpacing: '-0.025em',
              opacity: a, transform: 'translateX(' + Math.round((1 - a) * 44 * slide) + 'px)',
              textShadow: '0 4px 22px rgba(0,0,0,0.55)'
            }
          }, v.title),
          React.createElement('div', {
            style: {
              width: Math.round(132 * rule), height: 6, margin: '20px 0 18px',
              backgroundColor: v.accent
            }
          }),
          React.createElement('div', {
            style: {
              color: v.accent, fontSize: 31, fontWeight: '600', letterSpacing: '0.01em',
              opacity: b, transform: 'translateX(' + Math.round((1 - b) * 36 * slide) + 'px)'
            }
          }, v.subtitle),
          React.createElement('div', {
            style: {
              display: 'inline-block', marginTop: 22, padding: '11px 20px',
              backgroundColor: 'rgba(14,16,21,0.78)',
              border: '2px solid rgba(247,248,251,0.22)',
              color: 'rgba(247,248,251,0.86)', fontSize: 21,
              letterSpacing: '0.16em', textTransform: 'uppercase',
              opacity: c, transform: 'translateY(' + Math.round((1 - c) * 20) + 'px)'
            }
          }, v.meta))));
  };`,
};

const storyBeat: FirstPartyScenePackage = {
  id: 'joy.firstparty.story-beat',
  name: 'Story Beat',
  previewFocus: FOCUS_STORY_COLUMN,
  manifest: sharedManifest('joy.firstparty.story-beat'),
  variableSchema: {
    kicker: { type: 'string', label: 'Kicker', default: 'Chapter Two' },
    headline: { type: 'string', label: 'Headline', default: 'The long way north' },
    body: {
      type: 'string',
      label: 'Body',
      default: 'Nine days of low light, high wind and very bad coffee.',
    },
    accent: { type: 'color', label: 'Accent', default: '#ff9340' },
    imageSide: { type: 'enum', label: 'Image side', default: 'right', options: ['left', 'right'] },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3)); }
    var outro = cl((0.97 - p) * 12);
    var art = part(0);
    var a = part(0.1);
    var b = part(0.18);
    var c = part(0.28);
    var bar = part(0.06);
    var right = v.imageSide !== 'left';
    var poster = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 800">' +
        '<defs><linearGradient id="sky" x1="0" y1="0" x2="0.2" y2="1">' +
          '<stop offset="0" stop-color="#22293a"/><stop offset="1" stop-color="#0b0d13"/>' +
        '</linearGradient></defs>' +
        '<rect width="620" height="800" fill="url(#sky)"/>' +
        '<circle cx="356" cy="286" r="132" fill="' + v.accent + '"/>' +
        '<path d="M0 470 L188 292 L352 470 Z" fill="#1d2431"/>' +
        '<path d="M236 470 L432 236 L620 470 Z" fill="#2b3446"/>' +
        '<rect y="470" width="620" height="330" fill="#0a0c11"/>' +
        '<rect y="466" width="620" height="5" fill="' + v.accent + '" opacity="0.55"/>' +
        '<rect x="64" y="556" width="200" height="4" fill="#ffffff" opacity="0.16"/>' +
        '<rect x="64" y="600" width="128" height="4" fill="#ffffff" opacity="0.1"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 76, right: 76, top: 560,
          display: 'flex', flexDirection: right ? 'row' : 'row-reverse',
          alignItems: 'center', gap: 48
        }
      },
        React.createElement('div', {
          style: { flex: '1 1 auto', minWidth: 0, display: 'flex', gap: 26 }
        },
          React.createElement('div', {
            style: {
              flex: '0 0 auto', width: 8, height: Math.round(300 * bar),
              backgroundColor: v.accent, marginTop: 8
            }
          }),
          React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            React.createElement('div', {
              style: {
                color: v.accent, fontSize: 22, fontWeight: '800',
                letterSpacing: '0.22em', textTransform: 'uppercase',
                opacity: a, transform: 'translateY(' + Math.round((1 - a) * -18) + 'px)'
              }
            }, v.kicker),
            React.createElement('div', {
              style: {
                marginTop: 20, color: '#faf7f2',
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 60, fontWeight: '600', lineHeight: '1.06',
                letterSpacing: '-0.015em',
                opacity: b, transform: 'translateY(' + Math.round((1 - b) * 30) + 'px)',
                textShadow: '0 4px 24px rgba(0,0,0,0.5)'
              }
            }, v.headline),
            React.createElement('div', {
              style: {
                marginTop: 22, maxWidth: 420, color: 'rgba(238,240,246,0.76)',
                fontSize: 26, lineHeight: '1.5',
                opacity: c, transform: 'translateY(' + Math.round((1 - c) * 22) + 'px)'
              }
            }, v.body))),
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 392, height: 512, overflow: 'hidden',
            backgroundColor: '#12151c', borderRadius: 22,
            boxShadow: '0 28px 70px rgba(0,0,0,0.5)',
            opacity: art,
            transform: 'translateX(' + Math.round((1 - art) * (right ? 70 : -70)) + 'px)'
          }
        },
          React.createElement('img', {
            src: poster, alt: '',
            style: {
              display: 'block', width: 392, height: 512, objectFit: 'cover',
              transform: 'scale(' + (1.08 - 0.08 * art) + ')'
            }
          }))));
  };`,
};

const avatarIntro: FirstPartyScenePackage = {
  id: 'joy.firstparty.avatar-intro',
  name: 'Avatar Intro',
  previewFocus: FOCUS_AVATAR_ROW,
  manifest: sharedManifest('joy.firstparty.avatar-intro'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Nadia Rahimi' },
    role: { type: 'string', label: 'Role', default: 'Sound Design' },
    handle: { type: 'string', label: 'Handle', default: '@joymedia' },
    accent: { type: 'color', label: 'Accent', default: '#7cc4ff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.4)); }
    var outro = cl((0.97 - p) * 12);
    var card = part(0);
    var a = part(0.12);
    var b = part(0.2);
    var c = part(0.28);
    // Settle overshoot: past 1.0 on the way in, then back to rest.
    var over = cl(card * 1.16);
    var pop = 0.84 + 0.16 * card + 0.05 * (over - card);
    var ring = Math.round(6 + 8 * card);
    var avatar = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
        '<defs><linearGradient id="av" x1="0.1" y1="0" x2="0.9" y2="1">' +
          '<stop offset="0" stop-color="#2c3444"/><stop offset="1" stop-color="#11141b"/>' +
        '</linearGradient></defs>' +
        '<rect width="400" height="400" fill="url(#av)"/>' +
        '<rect x="178" y="196" width="44" height="86" rx="22" fill="#e3d9c9"/>' +
        '<ellipse cx="200" cy="410" rx="146" ry="150" fill="#f1ebe0"/>' +
        '<circle cx="200" cy="164" r="76" fill="#f7f2e8"/>' +
        '<path d="M124 164 a76 76 0 0 1 152 0 z" fill="' + v.accent + '"/>' +
        '<circle cx="200" cy="200" r="188" fill="none" stroke="' + v.accent +
          '" stroke-opacity="0.35" stroke-width="10"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 88, right: 88, top: 800,
          display: 'flex', alignItems: 'center', gap: 34,
          padding: '32px 40px', borderRadius: 34,
          backgroundColor: 'rgba(12,14,19,0.84)',
          border: '2px solid rgba(247,248,251,0.14)',
          boxShadow: '0 30px 72px rgba(0,0,0,0.5)',
          opacity: card, transform: 'scale(' + pop + ')', transformOrigin: '10% 50%'
        }
      },
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 228, height: 228, borderRadius: '50%',
            overflow: 'hidden', backgroundColor: '#161a22',
            border: ring + 'px solid ' + v.accent
          }
        },
          React.createElement('img', {
            src: avatar, alt: '',
            style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
          })),
        React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          React.createElement('div', {
            style: {
              color: '#f8f9fc', fontSize: 50, fontWeight: '800', letterSpacing: '-0.02em',
              opacity: a, transform: 'translateX(' + Math.round((1 - a) * 32) + 'px)'
            }
          }, v.name),
          React.createElement('div', {
            style: {
              marginTop: 12, color: 'rgba(240,243,249,0.74)', fontSize: 27,
              letterSpacing: '0.02em',
              opacity: b, transform: 'translateX(' + Math.round((1 - b) * 26) + 'px)'
            }
          }, v.role),
          React.createElement('div', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 12, marginTop: 20,
              padding: '10px 20px', borderRadius: 999,
              backgroundColor: 'rgba(124,196,255,0.12)',
              border: '2px solid ' + v.accent,
              color: v.accent, fontSize: 23, fontWeight: '700', letterSpacing: '0.04em',
              opacity: c, transform: 'translateY(' + Math.round((1 - c) * 18) + 'px)'
            }
          },
            React.createElement('span', {
              style: {
                width: 12, height: 12, borderRadius: '50%', backgroundColor: v.accent,
                display: 'inline-block'
              }
            }),
            v.handle))));
  };`,
};

const posterReveal: FirstPartyScenePackage = {
  id: 'joy.firstparty.poster-reveal',
  name: 'Poster Reveal',
  previewFocus: FOCUS_POSTER,
  manifest: sharedManifest('joy.firstparty.poster-reveal'),
  variableSchema: {
    kicker: { type: 'string', label: 'Kicker', default: 'New Release' },
    title: { type: 'string', label: 'Title', default: 'Northern Light' },
    caption: {
      type: 'string',
      label: 'Caption',
      default: 'A JOY Media original · Out Friday',
    },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 2.8)); }
    var outro = cl((0.97 - p) * 12);
    var wipe = ease(cl(p * 2.2));
    var a = part(0.16);
    var b = part(0.24);
    var c = part(0.34);
    var veil = part(0.12);
    var art = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 960">' +
        '<defs><linearGradient id="night" x1="0.2" y1="0" x2="0.8" y2="1">' +
          '<stop offset="0" stop-color="#20293c"/><stop offset="0.55" stop-color="#0e1219"/>' +
          '<stop offset="1" stop-color="#05070b"/>' +
        '</linearGradient></defs>' +
        '<rect width="540" height="960" fill="url(#night)"/>' +
        '<circle cx="372" cy="238" r="118" fill="' + v.accent + '" opacity="0.92"/>' +
        '<circle cx="372" cy="238" r="176" fill="none" stroke="' + v.accent +
          '" stroke-opacity="0.22" stroke-width="3"/>' +
        '<path d="M0 648 L152 452 L306 648 Z" fill="#141a26"/>' +
        '<path d="M198 648 L378 386 L540 648 Z" fill="#1d2534"/>' +
        '<rect y="644" width="540" height="316" fill="#080a0f"/>' +
        '<rect x="72" y="712" width="396" height="3" fill="' + v.accent + '" opacity="0.3"/>' +
        '<rect x="72" y="756" width="228" height="3" fill="#ffffff" opacity="0.12"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 0, top: 0, width: 1080, height: 1920,
        overflow: 'hidden', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, top: 0, width: 1080,
          height: Math.round(1920 * wipe), overflow: 'hidden', backgroundColor: '#0b0e14'
        }
      },
        React.createElement('img', {
          src: art, alt: '',
          style: {
            display: 'block', width: 1080, height: 1920, objectFit: 'cover',
            transform: 'scale(' + (1.06 - 0.06 * wipe) + ')'
          }
        })),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: Math.round(860 * veil),
          backgroundColor: 'rgba(6,7,11,0.42)',
          backgroundImage: 'linear-gradient(to top, rgba(5,6,10,0.96), rgba(5,6,10,0))'
        }
      }),
      React.createElement('div', {
        style: { position: 'absolute', left: 88, right: 88, bottom: 300 }
      },
        React.createElement('div', {
          style: {
            display: 'inline-block', padding: '12px 22px',
            backgroundColor: v.accent, color: '#12140f', fontSize: 22, fontWeight: '800',
            letterSpacing: '0.2em', textTransform: 'uppercase',
            opacity: a, transform: 'translateY(' + Math.round((1 - a) * 26) + 'px)'
          }
        }, v.kicker),
        React.createElement('div', {
          style: {
            marginTop: 28, color: '#fbf8f3',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 92, fontWeight: '600', lineHeight: '1', letterSpacing: '-0.03em',
            opacity: b, transform: 'translateY(' + Math.round((1 - b) * 42) + 'px)',
            textShadow: '0 6px 30px rgba(0,0,0,0.6)'
          }
        }, v.title),
        React.createElement('div', {
          style: {
            marginTop: 26, color: 'rgba(238,241,247,0.8)', fontSize: 27,
            letterSpacing: '0.03em',
            opacity: c, transform: 'translateY(' + Math.round((1 - c) * 24) + 'px)'
          }
        }, v.caption)));
  };`,
};

const splitFrame: FirstPartyScenePackage = {
  id: 'joy.firstparty.split-frame',
  name: 'Split Frame',
  previewFocus: FOCUS_SPLIT,
  manifest: sharedManifest('joy.firstparty.split-frame'),
  variableSchema: {
    lineOne: { type: 'string', label: 'Line one', default: 'Signature Blend' },
    lineTwo: { type: 'string', label: 'Line two', default: 'Slow roasted, small batch' },
    lineThree: { type: 'string', label: 'Line three', default: 'From $24' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var panel = part(0);
    var lines = [v.lineOne, v.lineTwo, v.lineThree];
    var sizes = [52, 32, 27];
    var still = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 720">' +
        '<defs><linearGradient id="st" x1="0" y1="0" x2="0.5" y2="1">' +
          '<stop offset="0" stop-color="#2a3140"/><stop offset="1" stop-color="#0c0e14"/>' +
        '</linearGradient></defs>' +
        '<rect width="560" height="720" fill="url(#st)"/>' +
        '<ellipse cx="280" cy="566" rx="176" ry="34" fill="#000000" opacity="0.45"/>' +
        '<rect x="176" y="216" width="208" height="340" rx="28" fill="' + v.accent + '"/>' +
        '<rect x="176" y="216" width="208" height="112" rx="28" fill="#ffffff" opacity="0.16"/>' +
        '<rect x="214" y="164" width="132" height="60" rx="24" fill="#e8e2d6"/>' +
        '<circle cx="280" cy="404" r="46" fill="#0d1016" opacity="0.55"/>' +
        '<rect x="72" y="640" width="416" height="4" fill="#ffffff" opacity="0.12"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 0, top: 0, width: 1080, height: 1920,
        overflow: 'hidden', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: -60, top: 600, width: 560, height: 620,
          overflow: 'hidden', backgroundColor: '#12151d',
          transform: 'skewX(-7deg) translateX(' + Math.round((1 - panel) * -180) + 'px)',
          boxShadow: '0 30px 70px rgba(0,0,0,0.5)', opacity: panel
        }
      },
        React.createElement('img', {
          src: still, alt: '',
          style: {
            display: 'block', width: 660, height: 620, objectFit: 'cover',
            marginLeft: -50, transform: 'skewX(7deg)'
          }
        })),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 560, right: 72, top: 640, width: 448
        }
      },
        lines.map(function (line, index) {
          var show = part(0.1 + index * 0.09);
          var accentRow = index === 0;
          return React.createElement('div', {
            key: String(index),
            style: {
              display: 'flex', alignItems: 'center', gap: 18,
              marginBottom: index === 2 ? 0 : 24,
              opacity: show, transform: 'translateX(' + Math.round((1 - show) * 48) + 'px)'
            }
          },
            React.createElement('span', {
              style: {
                flex: '0 0 auto', width: accentRow ? 44 : 22, height: accentRow ? 8 : 4,
                backgroundColor: accentRow ? v.accent : 'rgba(247,248,251,0.35)'
              }
            }),
            React.createElement('span', {
              style: {
                color: accentRow ? '#f8f9fc' : 'rgba(240,243,249,0.82)',
                fontSize: sizes[index], fontWeight: accentRow ? '800' : '500',
                letterSpacing: accentRow ? '-0.02em' : '0.02em', lineHeight: '1.2',
                textShadow: '0 4px 20px rgba(0,0,0,0.5)'
              }
            }, line));
        })));
  };`,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Surface-treatment family: bevel, inner/outer glow, glass, gradient highlight.
 *
 * These lean on CSS the live scene iframe renders in full (gradients, blur,
 * inset shadows, gradient-clipped text). The offscreen surface painter used for
 * Monitor/export rasterizes background colors and text, so every treated block
 * keeps a solid `backgroundColor` underneath its gradient and every
 * gradient-filled headline keeps a solid `color` beneath
 * `WebkitTextFillColor: 'transparent'` — the effect is additive, never the only
 * thing holding the layout up.
 * ────────────────────────────────────────────────────────────────────────── */

/** Bevel: a lit top edge, a shaded bottom edge, and a grounded drop shadow. */
const glassCard: FirstPartyScenePackage = {
  id: 'joy.firstparty.glass-card',
  name: 'Glass Card',
  previewFocus: FOCUS_GLASS,
  manifest: sharedManifest('joy.firstparty.glass-card'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'Studio Session' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Mixing · Stage B' },
    meta: { type: 'string', label: 'Meta', default: 'Today · 18:00' },
    accent: { type: 'color', label: 'Accent', default: '#7cc4ff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var card = part(0);
    var a = part(0.12);
    var b = part(0.2);
    var c = part(0.28);
    var sheen = cl((p - 0.18) * 1.5);
    var thumb = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
        '<defs><linearGradient id="gc" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#39435a"/><stop offset="1" stop-color="#0d1016"/>' +
        '</linearGradient></defs>' +
        '<rect width="300" height="300" fill="url(#gc)"/>' +
        '<circle cx="150" cy="150" r="86" fill="none" stroke="' + v.accent +
          '" stroke-width="10" stroke-opacity="0.85"/>' +
        '<circle cx="150" cy="150" r="30" fill="' + v.accent + '"/>' +
        '<rect x="40" y="228" width="220" height="6" rx="3" fill="#ffffff" opacity="0.2"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 84, right: 84, top: 760,
          display: 'flex', alignItems: 'center', gap: 32,
          padding: '34px 38px', borderRadius: 36, overflow: 'hidden',
          backgroundColor: 'rgba(19,22,30,0.62)',
          backgroundImage:
            'linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02) 42%,' +
            ' rgba(255,255,255,0.09))',
          backdropFilter: 'blur(20px)',
          border: '2px solid rgba(255,255,255,0.18)',
          boxShadow:
            'inset 0 2px 0 rgba(255,255,255,0.4), inset 0 -3px 0 rgba(0,0,0,0.45),' +
            ' 0 34px 78px rgba(0,0,0,0.55)',
          opacity: card,
          filter: 'blur(' + ((1 - card) * 14) + 'px)',
          transform: 'translateY(' + Math.round((1 - card) * 54) + 'px)'
        }
      },
        React.createElement('div', {
          style: {
            position: 'absolute', top: -40, bottom: -40,
            left: Math.round(-380 + sheen * 1400), width: 200,
            backgroundImage:
              'linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,0.28),' +
              ' rgba(255,255,255,0))',
            opacity: sheen > 0 && sheen < 1 ? 0.9 : 0
          }
        }),
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 208, height: 208, borderRadius: 26, overflow: 'hidden',
            backgroundColor: '#141821',
            boxShadow:
              'inset 0 2px 0 rgba(255,255,255,0.28), 0 0 34px ' + v.accent + '55,' +
              ' 0 18px 40px rgba(0,0,0,0.5)'
          }
        },
          React.createElement('img', {
            src: thumb, alt: '',
            style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
          })),
        React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          React.createElement('div', {
            style: {
              color: '#f9fafd', fontSize: 48, fontWeight: '800', letterSpacing: '-0.02em',
              textShadow: '0 2px 0 rgba(0,0,0,0.5), 0 0 30px rgba(124,196,255,0.35)',
              opacity: a, transform: 'translateX(' + Math.round((1 - a) * 30) + 'px)'
            }
          }, v.title),
          React.createElement('div', {
            style: {
              marginTop: 12, color: v.accent, fontSize: 27, fontWeight: '600',
              letterSpacing: '0.02em', textShadow: '0 0 22px ' + v.accent + '88',
              opacity: b, transform: 'translateX(' + Math.round((1 - b) * 24) + 'px)'
            }
          }, v.subtitle),
          React.createElement('div', {
            style: {
              display: 'inline-block', marginTop: 18, padding: '9px 18px', borderRadius: 999,
              backgroundColor: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.25)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)',
              color: 'rgba(244,247,252,0.86)', fontSize: 21, letterSpacing: '0.12em',
              textTransform: 'uppercase',
              opacity: c, transform: 'translateY(' + Math.round((1 - c) * 16) + 'px)'
            }
          }, v.meta))));
  };`,
};

/** Outer + inner glow with a deterministic strike-up flicker. */
const neonSign: FirstPartyScenePackage = {
  id: 'joy.firstparty.neon-sign',
  name: 'Neon Sign',
  previewFocus: FOCUS_NEON,
  manifest: sharedManifest('joy.firstparty.neon-sign'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'LATE SHOW' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Doors at nine' },
    meta: { type: 'string', label: 'Meta', default: 'JOY MEDIA' },
    accent: { type: 'color', label: 'Accent', default: '#ff5cae' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.4)); }
    var outro = cl((0.97 - p) * 12);
    // Tube strike-up: three deterministic stutters before a steady burn.
    var step = Math.floor(cl(p / 0.3) * 9);
    var lit = p >= 0.3 ? 1 : (step === 1 || step === 4 || step === 5 ? 0.22 : 1);
    var burn = 0.55 + 0.45 * ease(cl((p - 0.28) * 2.6));
    var glow = lit * burn;
    var a = part(0.02);
    var b = part(0.34);
    var c = part(0.42);
    var frame = part(0);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          padding: '64px 72px', borderRadius: 28, textAlign: 'center',
          backgroundColor: 'rgba(10,8,14,0.82)',
          backgroundImage:
            'radial-gradient(120% 90% at 50% 0%, rgba(255,92,174,0.22), rgba(0,0,0,0) 62%)',
          border: '4px solid ' + v.accent,
          boxShadow:
            '0 0 ' + Math.round(26 * glow) + 'px ' + v.accent + ', inset 0 0 ' +
            Math.round(34 * glow) + 'px ' + v.accent + '66, 0 30px 70px rgba(0,0,0,0.6)',
          opacity: frame, transform: 'scale(' + (0.92 + 0.08 * frame) + ')'
        }
      },
        React.createElement('div', {
          style: {
            color: '#fff6fb', fontSize: 86, fontWeight: '800', letterSpacing: '0.08em',
            lineHeight: '1',
            textShadow:
              '0 0 8px #fff, 0 0 ' + Math.round(22 * glow) + 'px ' + v.accent + ', 0 0 ' +
              Math.round(56 * glow) + 'px ' + v.accent + ', 0 0 ' +
              Math.round(96 * glow) + 'px ' + v.accent,
            opacity: a * (0.35 + 0.65 * lit)
          }
        }, v.title),
        React.createElement('div', {
          style: {
            marginTop: 26, height: 3, backgroundColor: v.accent,
            boxShadow: '0 0 18px ' + v.accent,
            width: Math.round(320 * b), marginLeft: 'auto', marginRight: 'auto'
          }
        }),
        React.createElement('div', {
          style: {
            marginTop: 26, color: 'rgba(255,240,248,0.9)',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 34, fontStyle: 'italic', letterSpacing: '0.02em',
            textShadow: '0 0 20px ' + v.accent + '99',
            opacity: b, transform: 'translateY(' + Math.round((1 - b) * 18) + 'px)'
          }
        }, v.subtitle),
        React.createElement('div', {
          style: {
            marginTop: 22, color: v.accent, fontSize: 20, fontWeight: '800',
            letterSpacing: '0.36em', opacity: c
          }
        }, v.meta)));
  };`,
};

/** Metallic bevel: gradient-clipped text over an embossed plate. */
const chromeTitle: FirstPartyScenePackage = {
  id: 'joy.firstparty.chrome-title',
  name: 'Chrome Title',
  previewFocus: FOCUS_CHROME,
  manifest: sharedManifest('joy.firstparty.chrome-title'),
  variableSchema: {
    kicker: { type: 'string', label: 'Kicker', default: 'Season Finale' },
    title: { type: 'string', label: 'Title', default: 'OVERDRIVE' },
    meta: { type: 'string', label: 'Meta', default: 'Streaming now' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var plate = part(0);
    var a = part(0.1);
    var b = part(0.16);
    var c = part(0.26);
    // Highlight band travels across the metal as the plate settles.
    var shine = Math.round(-30 + ease(cl((p - 0.1) * 1.4)) * 160);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          width: 880, padding: '58px 56px', borderRadius: 22, textAlign: 'center',
          backgroundColor: '#1b1e26',
          backgroundImage:
            'linear-gradient(180deg, #333a49 0%, #171a22 46%, #0e1015 54%, #262b36 100%)',
          border: '2px solid rgba(255,255,255,0.22)',
          boxShadow:
            'inset 0 3px 0 rgba(255,255,255,0.45), inset 0 -4px 0 rgba(0,0,0,0.6),' +
            ' 0 36px 80px rgba(0,0,0,0.6)',
          opacity: plate,
          transform: 'perspective(1200px) rotateX(' + ((1 - plate) * 16) + 'deg) scale(' +
            (0.94 + 0.06 * plate) + ')'
        }
      },
        React.createElement('div', {
          style: {
            color: v.accent, fontSize: 22, fontWeight: '800', letterSpacing: '0.3em',
            textTransform: 'uppercase', textShadow: '0 2px 0 rgba(0,0,0,0.6)',
            opacity: a
          }
        }, v.kicker),
        React.createElement('div', {
          style: {
            marginTop: 22, fontSize: 104, fontWeight: '800', lineHeight: '1',
            letterSpacing: '-0.03em',
            color: '#e8edf6',
            backgroundImage:
              'linear-gradient(180deg, #ffffff 4%, #b9c3d4 34%, #6d7789 52%, #e6ecf6 68%,' +
              ' #8f99ab 100%)',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundPosition: shine + '% 50%',
            filter: 'drop-shadow(0 3px 0 rgba(0,0,0,0.55)) drop-shadow(0 14px 26px' +
              ' rgba(0,0,0,0.5))',
            opacity: b, transform: 'translateY(' + Math.round((1 - b) * 24) + 'px)'
          }
        }, v.title),
        React.createElement('div', {
          style: {
            margin: '26px auto 0', height: 6, width: Math.round(240 * b),
            backgroundColor: v.accent,
            backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.9), ' + v.accent + ')',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7), 0 0 22px ' + v.accent + '88'
          }
        }),
        React.createElement('div', {
          style: {
            marginTop: 24, color: 'rgba(232,237,246,0.78)', fontSize: 24,
            letterSpacing: '0.18em', textTransform: 'uppercase',
            textShadow: '0 1px 0 rgba(0,0,0,0.6)', opacity: c
          }
        }, v.meta)));
  };`,
};

/** Gradient highlight sweeping through the headline, driven by progress. */
const gradientSweep: FirstPartyScenePackage = {
  id: 'joy.firstparty.gradient-sweep',
  name: 'Gradient Sweep',
  previewFocus: FOCUS_SWEEP,
  manifest: sharedManifest('joy.firstparty.gradient-sweep'),
  variableSchema: {
    headline: { type: 'string', label: 'Headline', default: 'Made for the night shift' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'New tools for JOY Studio' },
    meta: { type: 'string', label: 'Meta', default: 'joyteam.ir' },
    accent: { type: 'color', label: 'Accent', default: '#ff9340' },
    glow: { type: 'color', label: 'Glow', default: '#7cc4ff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3)); }
    var outro = cl((0.97 - p) * 12);
    var a = part(0);
    var b = part(0.14);
    var c = part(0.24);
    var sweep = Math.round(160 - cl((p - 0.05) * 1.25) * 220);
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 88, right: 88, top: 700,
          padding: '46px 44px', borderRadius: 30,
          backgroundColor: 'rgba(11,13,18,0.72)',
          backgroundImage:
            'radial-gradient(140% 120% at 0% 0%, rgba(255,147,64,0.22), rgba(0,0,0,0) 58%),' +
            ' radial-gradient(120% 130% at 100% 100%, rgba(124,196,255,0.2), rgba(0,0,0,0) 60%)',
          border: '2px solid rgba(255,255,255,0.12)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 30px 74px rgba(0,0,0,0.55)'
        }
      },
        React.createElement('div', {
          style: {
            fontSize: 66, fontWeight: '800', lineHeight: '1.06', letterSpacing: '-0.03em',
            color: '#f7f9fd',
            backgroundImage:
              'linear-gradient(96deg, ' + v.accent + ' 0%, #ffffff 42%, ' + v.glow +
              ' 70%, ' + v.accent + ' 100%)',
            backgroundSize: '260% 100%',
            backgroundPosition: sweep + '% 50%',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            filter: 'drop-shadow(0 8px 26px rgba(0,0,0,0.55))',
            opacity: a, transform: 'translateY(' + Math.round((1 - a) * 30) + 'px)'
          }
        }, v.headline),
        React.createElement('div', {
          style: {
            marginTop: 24, height: 5, width: Math.round(300 * b), borderRadius: 3,
            backgroundColor: v.accent,
            backgroundImage: 'linear-gradient(90deg, ' + v.accent + ', ' + v.glow + ')',
            boxShadow: '0 0 24px ' + v.glow + '99'
          }
        }),
        React.createElement('div', {
          style: {
            marginTop: 22, color: 'rgba(238,242,249,0.82)', fontSize: 29, lineHeight: '1.45',
            opacity: b, transform: 'translateY(' + Math.round((1 - b) * 22) + 'px)'
          }
        }, v.subtitle),
        React.createElement('div', {
          style: {
            display: 'inline-block', marginTop: 24, padding: '10px 20px', borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.2)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3)',
            color: v.glow, fontSize: 21, fontWeight: '700', letterSpacing: '0.14em',
            textShadow: '0 0 18px ' + v.glow + '88',
            opacity: c
          }
        }, v.meta)));
  };`,
};

/** Three photo cards drop in with a rotation settle; caption rides underneath. */
const photoStack: FirstPartyScenePackage = {
  id: 'joy.firstparty.photo-stack',
  name: 'Photo Stack',
  previewFocus: FOCUS_STACK,
  manifest: sharedManifest('joy.firstparty.photo-stack'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'Field notes' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Three days on the coast' },
    meta: { type: 'string', label: 'Meta', default: 'Roll 04 · 35mm' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var cards = [
      { tone: '#3d4657', tilt: -9, left: 0, top: 40 },
      { tone: '#2b3444', tilt: 4, left: 168, top: 0 },
      { tone: '#1d2431', tilt: 12, left: 336, top: 54 }
    ];
    var a = part(0.3);
    var b = part(0.38);
    var c = part(0.46);
    function frameArt(tone) {
      return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
          '<rect width="300" height="300" fill="' + tone + '"/>' +
          '<circle cx="216" cy="86" r="46" fill="' + v.accent + '" opacity="0.9"/>' +
          '<path d="M0 232 L92 140 L172 232 Z" fill="#0f131b" opacity="0.85"/>' +
          '<path d="M126 232 L214 130 L300 232 Z" fill="#161c27" opacity="0.9"/>' +
          '<rect y="228" width="300" height="72" fill="#0a0d13"/>' +
        '</svg>');
    }
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: { position: 'absolute', left: 138, top: 560, width: 700, height: 460 }
      },
        cards.map(function (card, index) {
          var show = part(index * 0.09);
          var tilt = card.tilt * show;
          return React.createElement('div', {
            key: String(index),
            style: {
              position: 'absolute', left: card.left, top: card.top,
              width: 300, padding: '14px 14px 56px', borderRadius: 8,
              backgroundColor: '#f6f2ea',
              backgroundImage:
                'linear-gradient(160deg, #ffffff 0%, #f2ece1 52%, #ded6c8 100%)',
              boxShadow:
                'inset 0 2px 0 rgba(255,255,255,0.9), inset 0 -3px 0 rgba(0,0,0,0.12),' +
                ' 0 26px 58px rgba(0,0,0,0.55)',
              opacity: show,
              transform: 'rotate(' + tilt + 'deg) translateY(' +
                Math.round((1 - show) * -90) + 'px) scale(' + (0.9 + 0.1 * show) + ')'
            }
          },
            React.createElement('img', {
              src: frameArt(card.tone), alt: '',
              style: { display: 'block', width: 272, height: 272, objectFit: 'cover' }
            }),
            React.createElement('div', {
              style: {
                marginTop: 12, color: '#4a4438', fontSize: 19,
                fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic'
              }
            }, v.meta));
        })),
      React.createElement('div', {
        style: { position: 'absolute', left: 138, right: 138, top: 1090 }
      },
        React.createElement('div', {
          style: {
            color: '#f8f9fc', fontSize: 56, fontWeight: '800', letterSpacing: '-0.02em',
            textShadow: '0 6px 26px rgba(0,0,0,0.6)',
            opacity: a, transform: 'translateY(' + Math.round((1 - a) * 28) + 'px)'
          }
        }, v.title),
        React.createElement('div', {
          style: {
            marginTop: 16, height: 6, width: Math.round(120 * b), backgroundColor: v.accent,
            boxShadow: '0 0 22px ' + v.accent + '99'
          }
        }),
        React.createElement('div', {
          style: {
            marginTop: 18, color: 'rgba(238,242,249,0.8)', fontSize: 29,
            opacity: c, transform: 'translateY(' + Math.round((1 - c) * 20) + 'px)'
          }
        }, v.subtitle)));
  };`,
};

/** Radial spotlight opens on a serif pull quote; avatar + attribution follow. */
const spotlightQuote: FirstPartyScenePackage = {
  id: 'joy.firstparty.spotlight-quote',
  name: 'Spotlight Quote',
  previewFocus: FOCUS_QUOTE,
  manifest: sharedManifest('joy.firstparty.spotlight-quote'),
  variableSchema: {
    quote: {
      type: 'string',
      label: 'Quote',
      default: 'We shipped it the night the power went out.',
    },
    name: { type: 'string', label: 'Name', default: 'Nadia Rahimi' },
    role: { type: 'string', label: 'Role', default: 'Lead Engineer' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3)); }
    var outro = cl((0.97 - p) * 12);
    var beam = ease(cl(p * 1.9));
    var a = part(0.14);
    var b = part(0.3);
    var c = part(0.38);
    var avatar = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
        '<rect width="240" height="240" fill="#171b24"/>' +
        '<rect x="104" y="112" width="32" height="60" rx="16" fill="#e2d8c8"/>' +
        '<ellipse cx="120" cy="248" rx="90" ry="94" fill="#f0eae0"/>' +
        '<circle cx="120" cy="96" r="46" fill="#f6f1e7"/>' +
        '<path d="M74 96 a46 46 0 0 1 92 0 z" fill="' + v.accent + '"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          backgroundColor: 'rgba(6,7,11,' + (0.62 * beam) + ')',
          backgroundImage:
            'radial-gradient(' + Math.round(30 + 46 * beam) + '% ' +
            Math.round(22 + 30 * beam) + '% at 50% 44%, rgba(255,247,230,0.22),' +
            ' rgba(4,5,8,0.88) 72%)'
        }
      }),
      React.createElement('div', {
        style: { position: 'absolute', left: 108, right: 108, top: 640 }
      },
        React.createElement('div', {
          style: {
            color: v.accent, fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 120, lineHeight: '0.7', opacity: a * 0.9,
            textShadow: '0 0 40px ' + v.accent + '66'
          }
        }, '“'),
        React.createElement('div', {
          style: {
            marginTop: 12, color: '#fbf8f2',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 62, lineHeight: '1.24', letterSpacing: '-0.015em',
            textShadow: '0 6px 34px rgba(0,0,0,0.7)',
            opacity: a, transform: 'translateY(' + Math.round((1 - a) * 30) + 'px)'
          }
        }, v.quote),
        React.createElement('div', {
          style: {
            marginTop: 42, display: 'flex', alignItems: 'center', gap: 22,
            opacity: b, transform: 'translateY(' + Math.round((1 - b) * 24) + 'px)'
          }
        },
          React.createElement('div', {
            style: {
              flex: '0 0 auto', width: 116, height: 116, borderRadius: '50%',
              overflow: 'hidden', backgroundColor: '#171b24',
              border: '4px solid ' + v.accent,
              boxShadow: '0 0 30px ' + v.accent + '77, inset 0 2px 0 rgba(255,255,255,0.3)'
            }
          },
            React.createElement('img', {
              src: avatar, alt: '',
              style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
            })),
          React.createElement('div', null,
            React.createElement('div', {
              style: { color: '#f8f9fc', fontSize: 34, fontWeight: '800' }
            }, v.name),
            React.createElement('div', {
              style: {
                marginTop: 8, color: v.accent, fontSize: 23, letterSpacing: '0.16em',
                textTransform: 'uppercase', opacity: c
              }
            }, v.role)))));
  };`,
};

/** Perforated stub with notches, bevel plate and three data lines. */
const ticketStub: FirstPartyScenePackage = {
  id: 'joy.firstparty.ticket-stub',
  name: 'Ticket Stub',
  previewFocus: FOCUS_TICKET,
  manifest: sharedManifest('joy.firstparty.ticket-stub'),
  variableSchema: {
    event: { type: 'string', label: 'Event', default: 'JOY Live' },
    date: { type: 'string', label: 'Date', default: 'Fri 12 Sep · 21:00' },
    seat: { type: 'string', label: 'Seat', default: 'Row C · Seat 14' },
    accent: { type: 'color', label: 'Accent', default: '#ff9340' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var ticket = part(0);
    var a = part(0.14);
    var b = part(0.22);
    var c = part(0.3);
    var stubArt = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320">' +
        '<rect width="240" height="320" fill="#12151d"/>' +
        '<circle cx="120" cy="120" r="62" fill="' + v.accent + '" opacity="0.9"/>' +
        '<path d="M40 230 L104 158 L160 230 Z" fill="#0a0d13"/>' +
        '<rect x="36" y="256" width="168" height="8" rx="4" fill="#ffffff" opacity="0.22"/>' +
        '<rect x="36" y="276" width="112" height="8" rx="4" fill="#ffffff" opacity="0.12"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 76, right: 76, top: 780,
          display: 'flex', alignItems: 'stretch', borderRadius: 26, overflow: 'hidden',
          backgroundColor: '#f4efe6',
          backgroundImage: 'linear-gradient(180deg, #fffdf8 0%, #efe8db 62%, #ddd3c3 100%)',
          boxShadow:
            'inset 0 3px 0 rgba(255,255,255,0.9), inset 0 -4px 0 rgba(0,0,0,0.16),' +
            ' 0 34px 78px rgba(0,0,0,0.55)',
          opacity: ticket,
          transform: 'rotate(' + ((1 - ticket) * -3) + 'deg) translateY(' +
            Math.round((1 - ticket) * 60) + 'px)'
        }
      },
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 244, backgroundColor: '#12151d', overflow: 'hidden'
          }
        },
          React.createElement('img', {
            src: stubArt, alt: '',
            style: { display: 'block', width: 244, height: '100%', objectFit: 'cover' }
          })),
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 4, backgroundColor: 'rgba(0,0,0,0.18)',
            backgroundImage:
              'repeating-linear-gradient(180deg, rgba(0,0,0,0.4) 0 14px,' +
              ' rgba(0,0,0,0) 14px 28px)'
          }
        }),
        React.createElement('div', {
          style: { flex: '1 1 auto', minWidth: 0, padding: '38px 40px' }
        },
          React.createElement('div', {
            style: {
              display: 'inline-block', padding: '8px 16px',
              backgroundColor: v.accent, color: '#1a1206',
              fontSize: 19, fontWeight: '800', letterSpacing: '0.2em',
              textTransform: 'uppercase',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
              opacity: a
            }
          }, 'Admit one'),
          React.createElement('div', {
            style: {
              marginTop: 20, color: '#191b21', fontSize: 54, fontWeight: '800',
              letterSpacing: '-0.02em', textShadow: '0 1px 0 rgba(255,255,255,0.8)',
              opacity: a, transform: 'translateX(' + Math.round((1 - a) * 28) + 'px)'
            }
          }, v.event),
          React.createElement('div', {
            style: {
              marginTop: 16, color: '#4a4d57', fontSize: 27, fontWeight: '600',
              opacity: b, transform: 'translateX(' + Math.round((1 - b) * 22) + 'px)'
            }
          }, v.date),
          React.createElement('div', {
            style: {
              marginTop: 12, color: '#6c6f7a', fontSize: 23, letterSpacing: '0.1em',
              textTransform: 'uppercase',
              opacity: c, transform: 'translateX(' + Math.round((1 - c) * 18) + 'px)'
            }
          }, v.seat))));
  };`,
};

/** Layered aurora gradients drift with progress behind an image + copy row. */
const auroraPanel: FirstPartyScenePackage = {
  id: 'joy.firstparty.aurora-panel',
  name: 'Aurora Panel',
  previewFocus: FOCUS_AURORA,
  manifest: sharedManifest('joy.firstparty.aurora-panel'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'Aurora' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Ambient sessions, vol. 3' },
    meta: { type: 'string', label: 'Meta', default: '12 tracks · 48 min' },
    accent: { type: 'color', label: 'Accent', default: '#7cc4ff' },
    glow: { type: 'color', label: 'Glow', default: '#b57cff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3)); }
    var outro = cl((0.97 - p) * 12);
    var panel = part(0);
    var a = part(0.14);
    var b = part(0.22);
    var c = part(0.3);
    var drift = Math.round(p * 46);
    var cover = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">' +
        '<defs><linearGradient id="au" x1="0" y1="1" x2="1" y2="0">' +
          '<stop offset="0" stop-color="#101528"/>' +
          '<stop offset="0.55" stop-color="' + v.glow + '"/>' +
          '<stop offset="1" stop-color="' + v.accent + '"/>' +
        '</linearGradient></defs>' +
        '<rect width="320" height="320" fill="#0b0e18"/>' +
        '<path d="M0 232 C 80 150 150 268 220 172 C 262 116 300 132 320 108 L320 320 L0 320 Z"' +
          ' fill="url(#au)" opacity="0.85"/>' +
        '<circle cx="238" cy="80" r="34" fill="#ffffff" opacity="0.9"/>' +
        '<circle cx="238" cy="80" r="58" fill="none" stroke="#ffffff" stroke-opacity="0.25"' +
          ' stroke-width="3"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', position: 'relative',
        fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 80, right: 80, top: 720,
          display: 'flex', alignItems: 'center', gap: 34,
          padding: '36px 40px', borderRadius: 34, overflow: 'hidden',
          backgroundColor: 'rgba(10,12,22,0.86)',
          backgroundImage:
            'radial-gradient(120% 140% at ' + (14 + drift) + '% 0%, rgba(124,196,255,0.35),' +
            ' rgba(0,0,0,0) 58%), radial-gradient(120% 140% at ' + (92 - drift) +
            '% 110%, rgba(181,124,255,0.34), rgba(0,0,0,0) 60%)',
          border: '2px solid rgba(255,255,255,0.14)',
          boxShadow:
            'inset 0 2px 0 rgba(255,255,255,0.3), 0 0 60px rgba(124,196,255,0.18),' +
            ' 0 34px 78px rgba(0,0,0,0.55)',
          opacity: panel, transform: 'translateY(' + Math.round((1 - panel) * 48) + 'px)'
        }
      },
        React.createElement('div', {
          style: {
            flex: '0 0 auto', width: 236, height: 236, borderRadius: 22, overflow: 'hidden',
            backgroundColor: '#0b0e18',
            boxShadow: '0 0 40px ' + v.glow + '66, inset 0 2px 0 rgba(255,255,255,0.24)'
          }
        },
          React.createElement('img', {
            src: cover, alt: '',
            style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
          })),
        React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          React.createElement('div', {
            style: {
              fontSize: 58, fontWeight: '800', letterSpacing: '-0.03em', lineHeight: '1.02',
              color: '#f6f8ff',
              backgroundImage: 'linear-gradient(92deg, #ffffff, ' + v.accent + ' 58%, ' +
                v.glow + ')',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              filter: 'drop-shadow(0 6px 22px rgba(0,0,0,0.55))',
              opacity: a, transform: 'translateX(' + Math.round((1 - a) * 30) + 'px)'
            }
          }, v.title),
          React.createElement('div', {
            style: {
              marginTop: 14, color: 'rgba(236,240,250,0.84)', fontSize: 28,
              opacity: b, transform: 'translateX(' + Math.round((1 - b) * 24) + 'px)'
            }
          }, v.subtitle),
          React.createElement('div', {
            style: {
              display: 'inline-block', marginTop: 20, padding: '9px 18px', borderRadius: 999,
              backgroundColor: 'rgba(124,196,255,0.14)',
              border: '1px solid rgba(124,196,255,0.5)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.32), 0 0 22px rgba(124,196,255,0.35)',
              color: v.accent, fontSize: 21, fontWeight: '700', letterSpacing: '0.12em',
              opacity: c
            }
          }, v.meta))));
  };`,
};

/** Full-bleed cover art, gradient masthead, two cover lines. */
const magazineCover: FirstPartyScenePackage = {
  id: 'joy.firstparty.magazine-cover',
  name: 'Magazine Cover',
  previewFocus: FOCUS_MAGAZINE,
  manifest: sharedManifest('joy.firstparty.magazine-cover'),
  variableSchema: {
    masthead: { type: 'string', label: 'Masthead', default: 'JOY' },
    headline: { type: 'string', label: 'Headline', default: 'The comeback issue' },
    standfirst: {
      type: 'string',
      label: 'Standfirst',
      default: 'Nine studios, one very long night',
    },
    issue: { type: 'string', label: 'Issue', default: 'No. 04 · Autumn' },
    accent: { type: 'color', label: 'Accent', default: '#ff9340' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3)); }
    var outro = cl((0.97 - p) * 12);
    var art = ease(cl(p * 2));
    var a = part(0.1);
    var b = part(0.2);
    var c = part(0.28);
    var d = part(0.36);
    var cover = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 960">' +
        '<defs><linearGradient id="mg" x1="0.2" y1="0" x2="0.9" y2="1">' +
          '<stop offset="0" stop-color="#2e3546"/><stop offset="1" stop-color="#0a0c11"/>' +
        '</linearGradient></defs>' +
        '<rect width="540" height="960" fill="url(#mg)"/>' +
        '<circle cx="424" cy="172" r="84" fill="' + v.accent + '" opacity="0.4"/>' +
        '<circle cx="120" cy="262" r="46" fill="#ffffff" opacity="0.06"/>' +
        '<rect x="250" y="420" width="52" height="96" rx="26" fill="#cfc5b3"/>' +
        '<ellipse cx="276" cy="616" rx="166" ry="130" fill="#ded5c5"/>' +
        '<circle cx="276" cy="372" r="74" fill="#efe8dc"/>' +
        '<path d="M202 372 a74 74 0 0 1 148 0 z" fill="#171c26"/>' +
        '<path d="M0 566 L540 498 L540 538 L0 606 Z" fill="' + v.accent + '" opacity="0.3"/>' +
        '<rect y="542" width="540" height="418" fill="#070910" opacity="0.62"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        position: 'absolute', left: 0, top: 0, width: 1080, height: 1920,
        overflow: 'hidden', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, top: 0, width: 1080, height: 1920,
          overflow: 'hidden', backgroundColor: '#0b0e14', opacity: art
        }
      },
        React.createElement('img', {
          src: cover, alt: '',
          style: {
            display: 'block', width: 1080, height: 1920, objectFit: 'cover',
            transform: 'scale(' + (1.08 - 0.08 * art) + ')'
          }
        })),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, right: 0, top: 0, height: 620,
          backgroundColor: 'rgba(6,7,11,0.25)',
          backgroundImage: 'linear-gradient(to bottom, rgba(5,6,10,0.85), rgba(5,6,10,0))'
        }
      }),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 0, right: 0, bottom: 0, height: 900,
          backgroundColor: 'rgba(6,7,11,0.3)',
          backgroundImage: 'linear-gradient(to top, rgba(5,6,10,0.94), rgba(5,6,10,0))'
        }
      }),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 72, right: 72, top: 168, textAlign: 'center',
          fontSize: 210, fontWeight: '800', lineHeight: '0.86', letterSpacing: '-0.06em',
          color: '#fdf9f2',
          backgroundImage:
            'linear-gradient(180deg, #ffffff 10%, ' + v.accent + ' 62%, #b96a1e 100%)',
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          filter: 'drop-shadow(0 8px 30px rgba(0,0,0,0.6))',
          opacity: a, transform: 'scale(' + (0.94 + 0.06 * a) + ')'
        }
      }, v.masthead),
      React.createElement('div', {
        style: {
          position: 'absolute', left: 84, right: 84, bottom: 380
        }
      },
        React.createElement('div', {
          style: {
            display: 'inline-block', padding: '10px 20px', backgroundColor: v.accent,
            color: '#181004', fontSize: 20, fontWeight: '800', letterSpacing: '0.22em',
            textTransform: 'uppercase',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 0 26px ' + v.accent + '77',
            opacity: b
          }
        }, v.issue),
        React.createElement('div', {
          style: {
            marginTop: 26, color: '#fbf8f3',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 78, fontWeight: '600', lineHeight: '1.04', letterSpacing: '-0.03em',
            textShadow: '0 6px 30px rgba(0,0,0,0.65)',
            opacity: c, transform: 'translateY(' + Math.round((1 - c) * 36) + 'px)'
          }
        }, v.headline),
        React.createElement('div', {
          style: {
            marginTop: 22, paddingLeft: 22, borderLeft: '6px solid ' + v.accent,
            color: 'rgba(240,243,249,0.82)', fontSize: 28, lineHeight: '1.42',
            opacity: d, transform: 'translateY(' + Math.round((1 - d) * 24) + 'px)'
          }
        }, v.standfirst)));
  };`,
};

/** Holographic bevelled badge: shifting gradient plate, avatar, three lines. */
const holoBadge: FirstPartyScenePackage = {
  id: 'joy.firstparty.holo-badge',
  name: 'Holo Badge',
  previewFocus: FOCUS_BADGE,
  manifest: sharedManifest('joy.firstparty.holo-badge'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Alex Morgan' },
    role: { type: 'string', label: 'Role', default: 'Creative Director' },
    handle: { type: 'string', label: 'Handle', default: 'JOY MEDIA · CREW' },
    accent: { type: 'color', label: 'Accent', default: '#b57cff' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    var p = ctx.progress;
    function cl(x) { return Math.min(1, Math.max(0, x)); }
    function ease(x) { var u = 1 - x; return 1 - u * u * u; }
    function part(delay) { return ease(cl((p - delay) * 3.2)); }
    var outro = cl((0.97 - p) * 12);
    var badge = part(0);
    var a = part(0.16);
    var b = part(0.24);
    var c = part(0.32);
    var hue = Math.round(p * 120);
    var tilt = (1 - badge) * 14;
    var portrait = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 300">' +
        '<rect width="260" height="300" fill="#151824"/>' +
        '<rect x="112" y="140" width="36" height="70" rx="18" fill="#e2d8c8"/>' +
        '<ellipse cx="130" cy="330" rx="112" ry="118" fill="#f0eae0"/>' +
        '<circle cx="130" cy="120" r="56" fill="#f6f1e7"/>' +
        '<path d="M74 120 a56 56 0 0 1 112 0 z" fill="' + v.accent + '"/>' +
      '</svg>');
    return React.createElement('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'Helvetica, Arial, sans-serif', opacity: outro
      }
    },
      React.createElement('div', {
        style: {
          width: 820, padding: 6, borderRadius: 38,
          backgroundColor: '#2a2140',
          backgroundImage:
            'linear-gradient(' + (110 + hue) + 'deg, #7cc4ff, #b57cff 28%, #ff5cae 52%,' +
            ' #ffd36e 74%, #7cc4ff 100%)',
          boxShadow:
            '0 0 54px rgba(181,124,255,0.42), 0 34px 80px rgba(0,0,0,0.58),' +
            ' inset 0 2px 0 rgba(255,255,255,0.5)',
          opacity: badge,
          transform: 'perspective(1400px) rotateY(' + tilt + 'deg) scale(' +
            (0.9 + 0.1 * badge) + ')'
        }
      },
        React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 32,
            padding: '34px 38px', borderRadius: 32,
            backgroundColor: '#12141d',
            backgroundImage:
              'linear-gradient(160deg, rgba(255,255,255,0.12), rgba(255,255,255,0) 46%)',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,0.22), inset 0 -3px 0 rgba(0,0,0,0.6)'
          }
        },
          React.createElement('div', {
            style: {
              flex: '0 0 auto', width: 196, height: 226, borderRadius: 22, overflow: 'hidden',
              backgroundColor: '#151824',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,0.24), 0 0 34px ' + v.accent + '66'
            }
          },
            React.createElement('img', {
              src: portrait, alt: '',
              style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
            })),
          React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            React.createElement('div', {
              style: {
                color: '#fafbff', fontSize: 52, fontWeight: '800', letterSpacing: '-0.025em',
                textShadow: '0 2px 0 rgba(0,0,0,0.6), 0 0 34px rgba(181,124,255,0.45)',
                opacity: a, transform: 'translateX(' + Math.round((1 - a) * 30) + 'px)'
              }
            }, v.name),
            React.createElement('div', {
              style: {
                marginTop: 14, fontSize: 28, fontWeight: '700', letterSpacing: '0.01em',
                color: '#e9dcff',
                backgroundImage: 'linear-gradient(92deg, #7cc4ff, ' + v.accent + ', #ff5cae)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                opacity: b, transform: 'translateX(' + Math.round((1 - b) * 24) + 'px)'
              }
            }, v.role),
            React.createElement('div', {
              style: {
                marginTop: 22, paddingTop: 18,
                borderTop: '1px solid rgba(255,255,255,0.16)',
                color: 'rgba(236,238,248,0.7)', fontSize: 20, fontWeight: '700',
                letterSpacing: '0.28em', opacity: c
              }
            }, v.handle)))));
  };`,
};

export const FIRST_PARTY_SCENES: readonly FirstPartyScenePackage[] = [
  title,
  productCard,
  lowerThird,
  dataList,
  lowerThirdBar,
  lowerThirdSplit,
  titleCinematic,
  countdown,
  captionCard,
  endSlate,
  superAppHero,
  newsTicker,
  socialBadge,
  chapterMarker,
  scoreBug,
  featurePortrait,
  storyBeat,
  avatarIntro,
  posterReveal,
  splitFrame,
  glassCard,
  neonSign,
  chromeTitle,
  gradientSweep,
  photoStack,
  spotlightQuote,
  ticketStub,
  auroraPanel,
  magazineCover,
  holoBadge,
];

export function findFirstPartyScene(id: string): FirstPartyScenePackage | undefined {
  return FIRST_PARTY_SCENES.find((scene) => scene.id === id);
}

/**
 * Resolves a scene in a nested composition. Parent/template values flow inward,
 * while the concrete scene instance wins for fields it explicitly overrides.
 */
export function resolveFirstPartySceneInstance(
  sceneId: string,
  instanceVariables: Readonly<Record<string, unknown>> = {},
  inheritedVariables: Readonly<Record<string, unknown>> = {},
): ResolvedSceneInstance | undefined {
  const scene = findFirstPartyScene(sceneId);
  if (scene === undefined) return undefined;
  const resolved = resolveSceneVariables(scene.variableSchema, {
    ...inheritedVariables,
    ...instanceVariables,
  });
  return { scene, variables: resolved.values };
}
