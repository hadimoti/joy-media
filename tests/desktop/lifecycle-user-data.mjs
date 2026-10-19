import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, safeStorage } from 'electron';
import { createElectronSecretStore } from '../../apps/desktop/dist/main/secrets/electron-secret-store.js';
import { LocalDatabase } from '../../apps/desktop/dist/store/local-database.js';

const SETTING_KEY = 'lifecycle.fixture.setting';
const SETTING_VALUE = 'preserve-through-update';
const SECRET_HANDLE = 'lifecycle.synthetic-provider-key';
const SYNTHETIC_SECRET = 'joy-media-lifecycle-synthetic-key-v1';
const CATALOG = {
  schemaVersion: 1,
  assets: [{ id: 'fixture-asset', kind: 'image', name: 'Lifecycle fixture' }],
};

const mode = process.argv.at(-1);
const userDataArgument = process.argv.find((argument) => argument.startsWith('--user-data-dir='));
assert.ok(mode === 'seed' || mode === 'verify', 'Mode must be seed or verify.');
assert.ok(userDataArgument, 'An explicit Electron user-data directory is required.');
const userDataDirectory = resolve(userDataArgument.slice('--user-data-dir='.length));
app.setName('JOY Media Lifecycle Fixture');
app.setPath('userData', userDataDirectory);

async function run() {
  await app.whenReady();
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'DPAPI-backed safeStorage is required.');
  mkdirSync(userDataDirectory, { recursive: true });

  const libraryDirectory = join(userDataDirectory, 'Asset Library فارسی');
  const catalogPath = join(libraryDirectory, 'catalog.json');
  const directCiphertextPath = join(userDataDirectory, 'safe-storage-lifecycle-fixture.bin');
  const database = new LocalDatabase({
    filePath: join(userDataDirectory, 'joy-media.sqlite3'),
  });
  const secretStore = createElectronSecretStore(database, safeStorage);
  try {
    if (mode === 'seed') {
      mkdirSync(libraryDirectory, { recursive: true });
      writeFileSync(catalogPath, `${JSON.stringify(CATALOG, null, 2)}\n`, 'utf8');
      database.setSetting(SETTING_KEY, SETTING_VALUE);
      database.setAssetLibraryDirectory(libraryDirectory);
      await secretStore.set(SECRET_HANDLE, SYNTHETIC_SECRET);
      assert.equal((await secretStore.get(SECRET_HANDLE)) ?? '', SYNTHETIC_SECRET);
      const directCiphertext = safeStorage.encryptString(SYNTHETIC_SECRET);
      writeFileSync(directCiphertextPath, directCiphertext);
      const ciphertextBase64 = database.getSecretCiphertext(SECRET_HANDLE);
      assert.ok(ciphertextBase64, 'The synthetic secret ciphertext must be persisted.');
      process.stdout.write(
        `${JSON.stringify({
          result: 'seeded',
          encryptionAvailable: true,
          appName: app.getName(),
          ciphertextSha256: createHash('sha256').update(ciphertextBase64).digest('hex'),
          directCiphertextSha256: createHash('sha256').update(directCiphertext).digest('hex'),
        })}\n`,
      );
      return;
    }

    assert.equal(database.getSetting(SETTING_KEY), SETTING_VALUE);
    assert.equal(database.getAssetLibraryDirectory(), libraryDirectory);
    assert.equal(readFileSync(catalogPath, 'utf8'), `${JSON.stringify(CATALOG, null, 2)}\n`);
    const directCiphertext = readFileSync(directCiphertextPath);
    assert.equal(
      safeStorage.decryptString(directCiphertext),
      SYNTHETIC_SECRET,
      'Electron must decrypt raw DPAPI ciphertext persisted by the preceding process.',
    );
    const ciphertextBase64 = database.getSecretCiphertext(SECRET_HANDLE);
    assert.ok(ciphertextBase64, 'The persisted synthetic secret ciphertext must be present.');
    assert.equal(
      safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64')),
      SYNTHETIC_SECRET,
      'Electron must decrypt the exact ciphertext persisted by the preceding process.',
    );
    assert.equal((await secretStore.get(SECRET_HANDLE)) ?? '', SYNTHETIC_SECRET);
    process.stdout.write(
      `${JSON.stringify({
        result: 'verified',
        appName: app.getName(),
        ciphertextSha256: createHash('sha256').update(ciphertextBase64).digest('hex'),
        directCiphertextSha256: createHash('sha256').update(directCiphertext).digest('hex'),
        settingValue: SETTING_VALUE,
        libraryExists: true,
        libraryCatalogPresent: true,
        syntheticSecretSha256: createHash('sha256').update(SYNTHETIC_SECRET).digest('hex'),
      })}\n`,
    );
  } finally {
    database.close();
  }
}

run()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(
      `lifecycle user-data ${mode} failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    app.exit(1);
  });
