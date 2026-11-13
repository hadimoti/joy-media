import { describe, expect, it } from 'vitest';
import {
  prepareVideoCancel,
  prepareVideoCreate,
  prepareVideoFile,
  prepareVideoQuery,
  readVideoCreate,
  readVideoFile,
  readVideoStatus,
} from './minimax-video.js';

// The request and reply shapes the master-plan facts P6 to P8 describe. They are documented shapes, not replies recorded
// from a live call (T-C10 records the first live reply).
const KEY = 'not-a-real-key-for-tests';
const INPUT = { baseUrl: 'https://api.minimax.io/v1', apiKey: KEY, prompt: 'a slow pan' };

describe('MiniMax video requests', () => {
  it('creates on the current route at the origin with /v2, using the cheapest H3 model', () => {
    const call = prepareVideoCreate('current', INPUT);

    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.minimax.io/v2/video_generation');
    expect(JSON.parse(call.body ?? '')).toEqual({
      model: 'MiniMax-H3-Lite',
      prompt: 'a slow pan',
      resolution: '480P',
      duration: 4,
    });
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).not.toContain(KEY);
  });

  it('creates on the legacy route under /v1 with the Hailuo model', () => {
    const call = prepareVideoCreate('legacy', INPUT);

    expect(call.url).toBe('https://api.minimax.io/v1/video_generation');
    expect(JSON.parse(call.body ?? '')).toMatchObject({
      model: 'MiniMax-Hailuo-02',
      resolution: '512P',
      duration: 6,
    });
  });

  it('queries the current route by task id in the path', () => {
    const call = prepareVideoQuery('current', { ...INPUT, taskId: 'task-1' });

    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.minimax.io/v2/query/video_generation/task-1');
    expect(call.body).toBeUndefined();
  });

  it('queries the legacy route by task id in the query string, with the id encoded', () => {
    const call = prepareVideoQuery('legacy', { ...INPUT, taskId: 'task-1' });

    expect(call.url).toBe('https://api.minimax.io/v1/query/video_generation?task_id=task-1');
  });

  it('cancels with DELETE on the current route', () => {
    const call = prepareVideoCancel({ ...INPUT, taskId: 'task-1' });

    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('https://api.minimax.io/v2/video_generation/task-1');
  });

  it('retrieves the file by file id', () => {
    const call = prepareVideoFile({ ...INPUT, fileId: 'file-9' });

    expect(call.url).toBe('https://api.minimax.io/v1/files/retrieve?file_id=file-9');
  });

  it('keeps the origin of the China region', () => {
    const call = prepareVideoCreate('current', { ...INPUT, baseUrl: 'https://api.minimax.cn/v1' });

    expect(call.url).toBe('https://api.minimax.cn/v2/video_generation');
  });
});

describe('MiniMax video replies', () => {
  it('reads a task id from a create reply', () => {
    expect(readVideoCreate(JSON.stringify({ task_id: 'task-1' }))).toEqual({
      ok: true,
      data: { taskId: 'task-1' },
    });
  });

  it('refuses a task id that is not safe in a URL path', () => {
    expect(readVideoCreate(JSON.stringify({ task_id: 'a/../b' }))).toMatchObject({
      ok: false,
      code: 'RESPONSE_INVALID',
    });
    expect(readVideoCreate(JSON.stringify({}))).toMatchObject({
      ok: false,
      code: 'RESPONSE_INVALID',
    });
  });

  it('reads a finished status with its file id', () => {
    expect(readVideoStatus(JSON.stringify({ status: 'succeeded', file_id: 'file-9' }))).toEqual({
      ok: true,
      data: { status: 'succeeded', fileId: 'file-9' },
    });
  });

  it('reads a running status without a file id', () => {
    expect(readVideoStatus(JSON.stringify({ status: 'running' }))).toEqual({
      ok: true,
      data: { status: 'running' },
    });
  });

  it('reads the legacy status words', () => {
    expect(readVideoStatus(JSON.stringify({ status: 'Queueing' }))).toMatchObject({
      ok: true,
      data: { status: 'queued' },
    });
    expect(readVideoStatus(JSON.stringify({ status: 'Success', file_id: 'file-2' }))).toMatchObject(
      {
        ok: true,
        data: { status: 'succeeded', fileId: 'file-2' },
      },
    );
  });

  it('refuses a status it does not know', () => {
    expect(readVideoStatus(JSON.stringify({ status: 'exploded' }))).toMatchObject({
      ok: false,
      code: 'RESPONSE_INVALID',
    });
  });

  it('reads an HTTPS download link from a file reply', () => {
    const reply = JSON.stringify({ file: { download_url: 'https://files.example.test/v.mp4' } });

    expect(readVideoFile(reply)).toEqual({
      ok: true,
      data: { downloadUrl: 'https://files.example.test/v.mp4' },
    });
  });

  it('refuses a download link that is not HTTPS', () => {
    const reply = JSON.stringify({ file: { download_url: 'http://files.example.test/v.mp4' } });

    expect(readVideoFile(reply)).toMatchObject({ ok: false, code: 'RESPONSE_INVALID' });
  });
});
