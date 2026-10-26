// Development check for the packaged caption face (plan L3). On a Windows host it runs the packaged CLI, from the standalone
// folder, on a caption project in two layouts:
//   1. healthy: the canonical Noto Sans Arabic face is intact, so the plan is prepared (exit 0, a plan file is written);
//   2. corrupted: the packaged libass face for Arabic 400 is replaced with bytes that do not match its pinned digest, so the
//      CLI refuses with SETUP_REQUIRED (kind canonical-caption-face-unavailable), exit 1, and writes no plan.
// The work copy is hard-linked from the packaged folder. The corrupted face is a new file in the copy, so the original is never
// written, and the script checks the original's digest against the libass manifest before it exits.
//
// Usage (Windows only):
//   node tooling/fonts/packaged-caption-refusal.mjs --packaged <standalone folder> --ffmpeg <ffmpeg.exe> --ffprobe <ffprobe.exe>
//     --source <media file> --work <empty folder outside the repository>
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FACE_RELATIVE = join(
  'resources',
  'app',
  'cli',
  'fonts',
  'noto-sans-arabic',
  'libass',
  'fonts',
  'noto-sans-arabic-arabic-400-normal.ttf',
);
const MANIFEST_RELATIVE = join(
  'resources',
  'app',
  'cli',
  'fonts',
  'noto-sans-arabic',
  'libass',
  'manifest.json',
);
const FACE_NAME = 'noto-sans-arabic-arabic-400-normal.ttf';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    options[key.slice(2)] = value;
  }
  for (const name of ['packaged', 'ffmpeg', 'ffprobe', 'source', 'work']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  return options;
}

function sha256(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

// Hard-links every file of the packaged folder into the work folder. A file that cannot be linked is copied instead.
function linkTree(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      linkTree(from, to);
    } else if (entry.isFile()) {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }
}

// Runs the packaged launcher through cmd.exe, so the .cmd wrapper behaves as it does for a user.
function runPackagedCli(launcher, args, env) {
  const command = [
    `"${launcher}"`,
    ...args.map((arg) => (/\s/u.test(arg) ? `"${arg}"` : arg)),
  ].join(' ');
  // cmd /s strips one pair of outer quotes, so the command is wrapped once more to keep the launcher's own quotes.
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    timeout: 600_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function projectDocument(sourcePath) {
  const id = 'persian-caption-face-contract';
  return {
    schemaVersion: 1,
    title: 'Hand written project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Main Composition',
        width: 1080,
        height: 1920,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            family: 'visual',
            name: 'video-1',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'picture',
                kind: 'video',
                assetId: sourcePath,
                startUs: 0,
                durationUs: 1_000_000,
                sourceInUs: 0,
              },
            ],
          },
          {
            id: 'caption-1',
            kind: 'caption',
            family: 'caption',
            name: 'Persian captions',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'persian-line',
                kind: 'caption',
                startUs: 0,
                durationUs: 1_000_000,
                captionDocumentId: 'persian-subtitles',
              },
            ],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {
      'persian-subtitles': {
        id: 'persian-subtitles',
        language: 'fa',
        direction: 'rtl',
        speakers: [],
        words: { greeting: { id: 'greeting', text: 'سلام دنیا', startUs: 0, endUs: 1_000_000 } },
        segments: [{ id: 'greeting-line', startUs: 0, endUs: 1_000_000, wordIds: ['greeting'] }],
      },
    },
    pluginData: {},
    id,
  };
}

function refusalKind(stdout) {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim().startsWith('{')) continue;
    const event = JSON.parse(line);
    if (event.type !== 'error' || event.code !== 'SETUP_REQUIRED') continue;
    const message = String(event.message);
    return JSON.parse(message.slice(message.indexOf('{'))).kind;
  }
  return undefined;
}

function main(argv) {
  if (process.platform !== 'win32')
    throw new Error('The packaged caption check runs on Windows only.');
  const options = parseArgs(argv);
  const packaged = resolve(options.packaged);
  const work = resolve(options.work);
  const originalFace = join(packaged, FACE_RELATIVE);
  const manifest = JSON.parse(readFileSync(join(packaged, MANIFEST_RELATIVE), 'utf8'));
  const pinned = manifest.files.find(
    (file) => file.file === FACE_NAME && file.subset === 'arabic' && file.weight === 400,
  );
  if (!pinned) throw new Error(`The libass manifest has no entry for ${FACE_NAME}.`);
  if (sha256(originalFace) !== pinned.sha256)
    throw new Error('The packaged face does not match its pinned digest before the check.');

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  linkTree(packaged, app);

  const sourcePath = resolve(options.source).replace(/\\/gu, '/');
  const projectPath = join(work, 'project.json');
  const operationsPath = join(work, 'operations.json');
  writeFileSync(projectPath, `${JSON.stringify(projectDocument(sourcePath), null, 2)}\n`, 'utf8');
  writeFileSync(
    operationsPath,
    `${JSON.stringify({ schemaVersion: 1, operations: [] }, null, 2)}\n`,
    'utf8',
  );
  const launcher = join(app, 'bin', 'joy-media.cmd');
  const env = {
    JOY_MEDIA_FFMPEG: resolve(options.ffmpeg),
    JOY_MEDIA_FFPROBE: resolve(options.ffprobe),
  };

  const healthyPlan = join(work, 'plan-healthy.json');
  const healthy = runPackagedCli(
    launcher,
    [
      'plan',
      'prepare',
      operationsPath,
      '--project',
      projectPath,
      '--output',
      healthyPlan,
      '--json',
    ],
    env,
  );
  const healthyOk =
    healthy.status === 0 && existsSync(healthyPlan) && statSync(healthyPlan).size > 0;

  // Replace the copy's face with bytes of the same length that do not match the pinned digest. unlink first, so the
  // hard link to the original is removed and the original file is never written.
  const copyFace = join(app, FACE_RELATIVE);
  const size = statSync(copyFace).size;
  unlinkSync(copyFace);
  writeFileSync(copyFace, randomBytes(size));
  const corruptPlan = join(work, 'plan-corrupted.json');
  const corrupted = runPackagedCli(
    launcher,
    [
      'plan',
      'prepare',
      operationsPath,
      '--project',
      projectPath,
      '--output',
      corruptPlan,
      '--json',
    ],
    env,
  );
  const kind = refusalKind(corrupted.stdout);
  const corruptedOk =
    corrupted.status === 1 &&
    kind === 'canonical-caption-face-unavailable' &&
    !existsSync(corruptPlan);

  const originalUnchanged = sha256(originalFace) === pinned.sha256;
  const summary = {
    healthy: { exitCode: healthy.status, planWritten: existsSync(healthyPlan), passed: healthyOk },
    corrupted: {
      exitCode: corrupted.status,
      refusalKind: kind ?? null,
      planWritten: existsSync(corruptPlan),
      passed: corruptedOk,
    },
    originalFaceUnchanged: originalUnchanged,
    passed: healthyOk && corruptedOk && originalUnchanged,
    workFolderRelative: relative(process.cwd(), work),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.passed ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
