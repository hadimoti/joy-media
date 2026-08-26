import { describe, expect, it } from 'vitest';
import { WorkerController } from './lifecycle.js';

describe('worker lifecycle', () => {
  it('refuses startup when the API URL is missing, before spawning a Worker', async () => {
    const controller = new WorkerController({
      config: {
        apiUrl: '',
        ffmpegPath: 'C:\\missing\\ffmpeg.exe',
        ffprobePath: 'C:\\missing\\ffprobe.exe',
      },
      userDataPath: 'C:\\joy-media-test',
      platform: 'win32',
    });
    expect(controller.status().state).toBe('stopped');
    const status = await controller.start();
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/API URL is required/);
  });

  it('refuses startup when required media tools are unavailable', async () => {
    const controller = new WorkerController({
      config: {
        apiUrl: 'https://media.example.test',
        ffmpegPath: 'C:\\missing\\ffmpeg.exe',
        ffprobePath: 'C:\\missing\\ffprobe.exe',
      },
      userDataPath: 'C:\\joy-media-test',
      platform: 'win32',
    });
    const status = await controller.start();
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/FFmpeg and ffprobe/);
  });
});
