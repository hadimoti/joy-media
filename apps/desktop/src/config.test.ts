import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, loadConfig, saveConfig } from './config.js';

describe('desktop configuration', () => {
  it('round-trips only the non-secret allowlisted settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-desktop-config-'));
    const path = configPath(root);
    saveConfig(path, { apiUrl: 'https://media.example.test', ffmpegPath: 'C:\\tools\\ffmpeg.exe' });
    expect(loadConfig(path)).toEqual({
      apiUrl: 'https://media.example.test',
      ffmpegPath: 'C:\\tools\\ffmpeg.exe',
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('token');
  });

  it('fails closed for credentials in API URLs and unknown keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-desktop-config-'));
    const path = join(root, 'config.json');
    expect(() =>
      saveConfig(path, { apiUrl: 'https://user:password@media.example.test' }),
    ).toThrow();
    writeFileSync(path, JSON.stringify({ apiUrl: 'https://media.example.test', token: 'secret' }));
    expect(loadConfig(path)).toEqual({ apiUrl: '' });
  });
});
