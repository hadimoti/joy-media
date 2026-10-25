/** A verified browser font face selected for a transient paint request. */
export interface FontFaceDescriptorV1 {
  readonly family: string;
  readonly weight: number;
  readonly subset: string;
  readonly sha256: string;
  readonly length: number;
}

export interface ScenePaintRectV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly colour: string;
  readonly opacity: number;
}

export interface ScenePaintFaceRefV1 {
  readonly family: string;
  readonly weight: number;
  readonly subset: string;
}

export interface ScenePaintLineV1 {
  readonly text: string;
  /** Canvas font shorthand, including weight, size and family. */
  readonly font: string;
  readonly colour: string;
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly align: 'left' | 'center' | 'right';
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly opacity: number;
  readonly face: ScenePaintFaceRefV1;
}

/** Transient, browser-safe paint transport; this is not a persisted document field. */
export interface ScenePaintFrameV1 {
  readonly width: number;
  readonly height: number;
  readonly background?: string;
  readonly rects: readonly ScenePaintRectV1[];
  readonly lines: readonly ScenePaintLineV1[];
  readonly fonts: readonly FontFaceDescriptorV1[];
}
