import { posix, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_FIELDS,
  READ_ONLY_COMMANDS,
  assertReadOnlyCommand,
  collectGpuInventory,
  isInsideRepository,
  parseAdapters,
  parseAppGpuPreference,
  parseExploitProtection,
  parseGpuScheduling,
  parseOsBuild,
  parseRunningOverlays,
  redactInventory,
  vendorOf,
} from './gpu-inventory.js';

/** Answers each fixed query the way Windows PowerShell prints it on a PC with one NVIDIA adapter. */
function answer(command: string): string {
  if (command.includes('Win32_OperatingSystem')) {
    return '{"Caption":"Microsoft Windows 11 Pro","Version":"10.0.26300"}';
  }
  if (command.includes('Win32_VideoController')) {
    return '{"Name":"NVIDIA GeForce RTX 5070 Ti","DriverVersion":"32.0.15.1742"}';
  }
  if (command.includes('HwSchedMode')) return '2\n';
  if (command.includes('UserGpuPreferences')) return '"GpuPreference=2;"';
  if (command.includes('Get-ProcessMitigation')) return '{"CFG":{"Enable":"NOTSET"}}';
  if (command.includes('Get-Process')) return '["explorer","Discord"]';
  throw new Error(`unexpected command: ${command}`);
}

describe('GPU inventory parsers', () => {
  it('names the vendor from the marketing name', () => {
    expect(vendorOf('NVIDIA GeForce RTX 5070 Ti')).toBe('NVIDIA');
    expect(vendorOf('AMD Radeon RX 7900 XT')).toBe('AMD');
    expect(vendorOf('Intel(R) UHD Graphics 770')).toBe('Intel');
    expect(vendorOf('Microsoft Basic Display Adapter')).toBe('Other');
  });

  it('reads the OS caption and version without the Microsoft prefix', () => {
    expect(parseOsBuild('{"Caption":"Microsoft Windows 11 Pro","Version":"10.0.26300"}')).toBe(
      'Windows 11 Pro 10.0.26300',
    );
    expect(parseOsBuild('')).toBe('');
  });

  it('lists each adapter with its driver, for one controller or several', () => {
    expect(
      parseAdapters('{"Name":"NVIDIA GeForce RTX 5070 Ti","DriverVersion":"32.0.15.1742"}'),
    ).toEqual([
      { name: 'NVIDIA GeForce RTX 5070 Ti', driverVersion: '32.0.15.1742', vendor: 'NVIDIA' },
    ]);
    const several = parseAdapters(
      '[{"Name":"Intel(R) UHD Graphics 770","DriverVersion":"31.0.101.5590"},{"Name":"","DriverVersion":"x"}]',
    );
    expect(several.map((adapter) => adapter.vendor)).toEqual(['Intel']);
  });

  it('reports the HAGS registry value as read, and says when it is not set', () => {
    expect(parseGpuScheduling('2\n')).toBe('HwSchedMode=2');
    expect(parseGpuScheduling('')).toBe('not set');
  });

  it('names the per-app GPU preference from its registry value', () => {
    expect(parseAppGpuPreference('"GpuPreference=2;"')).toBe('high performance');
    expect(parseAppGpuPreference('"GpuPreference=1;"')).toBe('power saving');
    expect(parseAppGpuPreference('"Other=1"')).toBe('unrecognised');
    expect(parseAppGpuPreference('')).toBe('not set');
  });

  it('keeps the scalar mitigation settings, flattened, and drops lists', () => {
    expect(
      parseExploitProtection(
        '{"CFG":{"Enable":"NOTSET","SuppressExports":"NOTSET"},"ASLR":{"ForceRelocateImages":"ON"},"Dropped":[1,2]}',
      ),
    ).toEqual({
      'CFG.Enable': 'NOTSET',
      'CFG.SuppressExports': 'NOTSET',
      'ASLR.ForceRelocateImages': 'ON',
    });
  });

  it('says so when the image has no per-image mitigation overrides', () => {
    expect(parseExploitProtection('')).toEqual({
      perImagePolicy: 'none set; system defaults apply',
    });
  });

  it('names only the known overlay programs that are running', () => {
    expect(parseRunningOverlays('["explorer","Discord","nvsphelper64"]')).toEqual([
      'Discord',
      'nvsphelper64',
    ]);
    expect(parseRunningOverlays('["explorer"]')).toEqual([]);
  });
});

describe('read-only guard', () => {
  it('accepts every fixed inventory query', () => {
    for (const command of Object.values(READ_ONLY_COMMANDS)) {
      expect(() => assertReadOnlyCommand(command)).not.toThrow();
    }
  });

  it('refuses a command that changes state or writes a file (negative control)', () => {
    expect(() =>
      assertReadOnlyCommand(
        "Set-ItemProperty -Path 'HKCU:\\Software\\Example' -Name Value -Value 1",
      ),
    ).toThrow(/read-only/);
    expect(() => assertReadOnlyCommand('Get-Process | Out-File C:\\temp\\processes.txt')).toThrow(
      /read-only/,
    );
    expect(() => assertReadOnlyCommand('Get-Process > processes.txt')).toThrow(/read-only/);
    expect(() => assertReadOnlyCommand('Start-Process joy-media.exe')).toThrow(/read-only/);
  });
});

describe('collectGpuInventory', () => {
  it('runs only the fixed queries and keeps the parsed answers', () => {
    const seen: string[] = [];
    const inventory = collectGpuInventory((command) => {
      seen.push(command);
      return answer(command);
    }, new Date('2026-10-25T20:00:00.000Z'));
    expect(seen).toHaveLength(Object.keys(READ_ONLY_COMMANDS).length);
    expect(inventory).toMatchObject({
      capturedAt: '2026-10-25T20:00:00.000Z',
      osBuild: 'Windows 11 Pro 10.0.26300',
      gpuScheduling: 'HwSchedMode=2',
      appGpuPreference: 'high performance',
      runningOverlays: ['Discord'],
    });
    expect(inventory.adapters).toEqual([
      { name: 'NVIDIA GeForce RTX 5070 Ti', driverVersion: '32.0.15.1742', vendor: 'NVIDIA' },
    ]);
  });
});

describe('redactInventory', () => {
  it('keeps only the inventory fields, and removes names, paths and raw lists', () => {
    const raw = {
      capturedAt: '2026-10-25T20:00:00.000Z',
      osBuild: 'Windows 11 Pro 10.0.26300 at C:\\Users\\Alice Example',
      adapters: [
        {
          name: 'NVIDIA GeForce RTX 5070 Ti',
          driverVersion: '32.0.15.1742',
          vendor: 'NVIDIA',
          note: 'DESKTOP-EXAMPLE',
        },
      ],
      gpuScheduling: 'HwSchedMode=2',
      appGpuPreference: 'high performance',
      exploitProtection: {},
      runningOverlays: ['Discord'],
      rawProcessList: ['Alice Example'],
      userName: 'Alice Example',
    };
    const redacted = redactInventory(raw, ['Alice Example', 'DESKTOP-EXAMPLE']);
    expect(Object.keys(redacted).sort()).toEqual([...INVENTORY_FIELDS].sort());
    const text = JSON.stringify(redacted);
    for (const value of [
      'Alice Example',
      'DESKTOP-EXAMPLE',
      'C:\\Users',
      'rawProcessList',
      'userName',
    ]) {
      expect(text, value).not.toContain(value);
    }
    expect(redacted.adapters).toEqual([
      {
        name: 'NVIDIA GeForce RTX 5070 Ti',
        driverVersion: '32.0.15.1742',
        vendor: 'NVIDIA',
        note: '<redacted>',
      },
    ]);
  });
});

describe('isInsideRepository', () => {
  // Each case names the rules it follows, so the result does not depend on the host that runs the suite.
  it('treats the repository and anything under it as inside, and sibling folders as outside', () => {
    expect(isInsideRepository('C:\\repo\\out\\inventory.json', 'C:\\repo', win32)).toBe(true);
    expect(isInsideRepository('C:\\repo-other\\inventory.json', 'C:\\repo', win32)).toBe(false);
    expect(isInsideRepository('D:\\inventory.json', 'C:\\repo', win32)).toBe(false);
  });

  it('applies the same segment boundaries to POSIX paths', () => {
    expect(isInsideRepository('/repo', '/repo', posix)).toBe(true);
    expect(isInsideRepository('/repo/out/inventory.json', '/repo', posix)).toBe(true);
    expect(isInsideRepository('/repo-other/inventory.json', '/repo', posix)).toBe(false);
    expect(isInsideRepository('/inventory.json', '/repo', posix)).toBe(false);
  });

  it('resolves parent references before deciding, on both platforms', () => {
    expect(isInsideRepository('/repo/../repo-other/x.json', '/repo', posix)).toBe(false);
    expect(isInsideRepository('/repo/out/../x.json', '/repo', posix)).toBe(true);
    expect(isInsideRepository('C:\\repo\\..\\x.json', 'C:\\repo', win32)).toBe(false);
    expect(isInsideRepository('C:\\repo\\out\\..\\x.json', 'C:\\repo', win32)).toBe(true);
  });

  it('follows each platform for case: Windows folders ignore it, POSIX folders do not', () => {
    expect(isInsideRepository('C:\\REPO\\out\\x.json', 'c:\\repo', win32)).toBe(true);
    expect(isInsideRepository('/REPO/out/x.json', '/repo', posix)).toBe(false);
  });

  it('keeps names that only begin with two dots inside the repository', () => {
    expect(isInsideRepository('/repo/..cache/x.json', '/repo', posix)).toBe(true);
    expect(isInsideRepository('C:\\repo\\..cache\\x.json', 'C:\\repo', win32)).toBe(true);
  });

  it('treats a trailing separator on the repository as the same folder', () => {
    expect(isInsideRepository('C:\\repo\\out\\x.json', 'C:\\repo\\', win32)).toBe(true);
    expect(isInsideRepository('/repo/out/x.json', '/repo/', posix)).toBe(true);
  });

  it('compares relative paths against the same working folder', () => {
    expect(isInsideRepository('repo/out/x.json', 'repo', posix)).toBe(true);
    expect(isInsideRepository('out/x.json', 'repo', posix)).toBe(false);
  });

  it('uses the host rules when none are passed', () => {
    expect(isInsideRepository(resolve('repo', 'x.json'), resolve('repo'))).toBe(true);
    expect(isInsideRepository(resolve('repo-other', 'x.json'), resolve('repo'))).toBe(false);
  });
});
