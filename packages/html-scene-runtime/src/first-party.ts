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
  | 'joy.firstparty.score-bug';

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
