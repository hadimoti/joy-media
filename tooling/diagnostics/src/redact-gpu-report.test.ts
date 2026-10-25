import { describe, expect, it } from 'vitest';
import { GPU_REPORT_FIELDS, redactGpuReport, scrubText } from './redact-gpu-report.js';

const OPTIONS = { sensitive: ['Alice Example', 'DESKTOP-EXAMPLE'] };

const report = {
  vendor: 'NVIDIA',
  gpuModel: 'NVIDIA GeForce RTX 5070 Ti',
  driverVersion: '617.42',
  osBuild: 'Windows 11 Pro 10.0.26300',
  electronVersion: '44.3.0',
  chromiumVersion: '150.0.0.0',
  angleBackend: 'd3d11',
  featureStatus: { videoEncodeAccelerator: 'enabled', webgl: 'enabled_on' },
  exceptionCode: '0xC0000409',
  exceptionSubcode: '0x7',
  faultingModule: 'nvEncodeAPI64.dll+0x1A2B3',
  faultingOffset: '0x1A2B3',
  topChromiumFrames: [
    'media::MediaFoundationVideoEncodeAccelerator::Encode',
    'C:\\Users\\Alice Example\\AppData\\Local\\joy\\a.dll',
  ],
  userName: 'Alice Example',
  hostName: 'DESKTOP-EXAMPLE',
  adapterLuid: '0x00000000:0x0000B1C2',
  serialNumber: 'SN4R5T6Y7U8I9',
  ipAddress: '192.168.1.42',
  profilePath: '\\\\fileserver\\share\\Alice Example\\profile',
};

describe('redactGpuReport', () => {
  it('keeps only the allowlisted fields', () => {
    const redacted = redactGpuReport(report, OPTIONS);
    expect(Object.keys(redacted).sort()).toEqual(
      GPU_REPORT_FIELDS.filter((field) => field in report).sort(),
    );
    expect(redacted).not.toHaveProperty('userName');
    expect(redacted).not.toHaveProperty('adapterLuid');
  });

  it('keeps the diagnostic values that the diagnosis needs', () => {
    const redacted = redactGpuReport(report, OPTIONS);
    expect(redacted).toMatchObject({
      vendor: 'NVIDIA',
      gpuModel: 'NVIDIA GeForce RTX 5070 Ti',
      driverVersion: '617.42',
      exceptionCode: '0xC0000409',
      exceptionSubcode: '0x7',
      featureStatus: { videoEncodeAccelerator: 'enabled', webgl: 'enabled_on' },
    });
  });

  it('leaks none of the identifying values this PC knows about', () => {
    const text = JSON.stringify(redactGpuReport(report, OPTIONS));
    for (const value of [
      'Alice Example',
      'DESKTOP-EXAMPLE',
      'C:\\Users',
      'fileserver',
      '192.168.1.42',
      'B1C2',
      'SN4R5T6Y7U8I9',
    ]) {
      expect(text, value).not.toContain(value);
    }
  });

  it('removes the sensitive literals and the scrubbed patterns from kept strings', () => {
    const redacted = redactGpuReport(report, OPTIONS);
    expect(redacted.topChromiumFrames).toEqual([
      'media::MediaFoundationVideoEncodeAccelerator::Encode',
      '<path>',
    ]);
  });

  it('does not change the input report (negative control: the source is not mutated)', () => {
    const copy = JSON.parse(JSON.stringify(report));
    redactGpuReport(report, OPTIONS);
    expect(report).toEqual(copy);
  });
});

describe('scrubText', () => {
  it('keeps exception codes, which are eight hex digits, but scrubs a 64-bit LUID', () => {
    expect(scrubText('0xC0000409', { sensitive: [] })).toBe('0xC0000409');
    expect(scrubText('0x00000000:0x0000B1C2', { sensitive: [] })).toBe('<luid>');
  });

  it('matches sensitive literals regardless of case, and treats them as text, not patterns', () => {
    expect(scrubText('user alice.example', { sensitive: ['ALICE.EXAMPLE'] })).toBe(
      'user <redacted>',
    );
    expect(scrubText('a+b (x)', { sensitive: ['a+b (x)'] })).toBe('<redacted>');
  });
});
