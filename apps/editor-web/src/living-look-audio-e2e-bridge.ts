/**
 * Test-only re-export barrel so an e2e `page.evaluate` can reach the audio-bake
 * chain through a single app-source module path (Vite resolves the workspace
 * package for us). Not imported by production code.
 */
export { bakeLookFromAudio } from './living-look-audio.js';
export { compileLook, musicPulse, sampleCurve } from '@joy-media/motion-core';
