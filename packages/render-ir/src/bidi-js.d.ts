declare module 'bidi-js' {
  interface BidiEmbeddingResult {
    readonly levels: Uint8Array;
    readonly paragraphs: readonly {
      readonly start: number;
      readonly end: number;
      readonly level: number;
    }[];
  }

  interface BidiProcessor {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): BidiEmbeddingResult;
    getReorderSegments(
      text: string,
      embeddingLevels: BidiEmbeddingResult,
      start?: number,
      end?: number,
    ): readonly (readonly [number, number])[];
    getMirroredCharactersMap(
      text: string,
      levels: Uint8Array,
      start?: number,
      end?: number,
    ): ReadonlyMap<number, string>;
  }

  const bidiFactory: () => BidiProcessor;
  export default bidiFactory;
}
