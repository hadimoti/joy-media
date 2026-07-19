/** Small deterministic social-edit fixture shared by timeline, playback, and export tests. */
export interface ReferenceProject {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly durationUs: number;
  readonly formats: readonly { readonly width: number; readonly height: number }[];
}
export const REFERENCE_PROJECT: ReferenceProject = {
  id: 'golden-social-edit',
  revision: 1,
  title: 'Golden social edit',
  durationUs: 1_000_000,
  formats: [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ],
};
