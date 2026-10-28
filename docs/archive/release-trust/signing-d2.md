> Archived 2026-10-28. Signed updates were cancelled (D3 = B, ADR-0043).

# Owner checklist: release signing key ceremony (D2)

Owner-only. Do the key steps on a computer that stays offline, with you present. Engineering does the online steps first.
Nothing here publishes a release. Publishing is decided in `release-authorization.md`.

The procedure and the reasons for it are in `docs/release/offline-signing-key-ceremony.md`. This file gives the order, the
checks, and what has already been verified.

## What this decides

1. The release public key that the shipped app and `joy-media update verify` trust. It goes into
   `PINNED_RELEASE_PUBLIC_KEYS_PEM` in `packages/release-trust/src/release-key.ts`. The list is empty today, so every update
   check refuses with `release-key-unconfigured`. That is the designed state until the key is pinned.
2. Whether a minimum supported version is set (`--min-supported`). Setting one forces older installs to update. The default
   is no minimum.

## Decided by the owner (2026-10-28): the ceremony runs before the candidate is frozen

The public key is compiled into every build, and a build verifies only the updates signed by the keys it pins. So the pin
belongs to the release candidate itself. The current candidate (`6a307ea9…`, run 40580654500) has no pin, so no shipped build of
it can verify a signed update. Order: the owner runs steps 2 and 3 offline; engineering opens the pin change (step 4); the next
candidate is frozen only after that change is in its tree. This decision freezes, dispatches and publishes nothing.

## Already verified (2026-10-28)

These checks used throwaway keys in a temporary folder. They prove the chain, not your key.

- The owner's commands (`keygen`, `sign`, `verify`) produce a manifest that the verifier functions used by
  `joy-media update check` and `joy-media update verify` accept. They refuse a changed manifest, a changed file, a signature
  from another key, and an empty key list. Test: `tooling/release/src/release-manifest-ceremony.test.ts` (3 of 3).
- The manifest builder writes the schema the verifier accepts: `tooling/release/src/build-release-manifest.mjs`
  (`build-release-manifest.test.ts`, 11 of 11).
- The packager's `joy-media-release-manifest.json` is not the update manifest. It has another name and another schema. Do not
  publish it as `release-manifest.json`.

## Open before you start

1. **Server-side release key.** `apps/api/src/release-signing.ts` defines a second release signing key on the account server,
   read from the credential `joy-media-release-signing-key`. Nothing in the desktop app or the CLI trusts it today. The
   ceremony promises that no release private key sits on a networked machine, so decide this. Only you can check whether the
   credential exists on the server. If it does, remove it or document why it stays.
2. **Stale desktop note.** `apps/desktop/README.md`, section "Auto-update policy check (wave 7)", describes the server-side
   scheme. The shipped code uses the GitHub manifest scheme in this file. Engineering corrects the note. Do not rely on it.

## Steps

### 1. Build the manifest (engineering, online, no key)

Use the release folder of the frozen candidate. It must contain `joy-media-setup.exe` and `joy-media-windows-x64-v1.0.3.zip`.
Check each file's SHA-256 against its line in `SHA256SUMS.txt` in the same folder. Stop if one differs.

```bash
node tooling/release/src/build-release-manifest.mjs --release-dir <release-folder> --version 1.0.3 --channel stable --issued-at <UTC time, for example 2026-10-28T12:00:00Z> --file joy-media-setup.exe --file joy-media-windows-x64-v1.0.3.zip --out <release-folder>/release-manifest.json
```

Add `--min-supported <version>` only if you decided it under "What this decides". The tool refuses to overwrite its output. A
second build needs a new file name, or a deliberate delete by you.

The report lists the manifest's SHA-256. Record it. Copy `release-manifest.json` to the offline machine.

### 2. Prepare the offline machine (owner)

- Use Node 24. Turn Wi-Fi and Ethernet off, and stop any sync client.
- Copy `tooling/release/src/sign-release-manifest.mjs` onto the machine. Its SHA-256 must be
  `9f7e9c0e1adcfe1b1dfde2fda52bf839c1f26689a6358efaee08a5b6947606ac`, the value for that file at commit `2784db83`. The file has
  not changed since commit `83a847cb`. If engineering later gives you another value, check against that value instead:

```powershell
Get-FileHash .\sign-release-manifest.mjs -Algorithm SHA256
```

- Prepare an encrypted USB stick (BitLocker To Go or similar). The key files are written only there.
- Choose a passphrase of at least 16 characters, and store it in your password manager. Write it to `passphrase.txt` in the
  script folder, on the offline machine only. Delete that file after the last signing run.

### 3. Generate the release key (owner, once)

```powershell
node .\sign-release-manifest.mjs keygen --purpose release --out-dir E:\joy-release-key --passphrase-file .\passphrase.txt
```

The command prints `keyId`, `fingerprint` and `purpose`. It writes `<keyId>.private.pem` (encrypted), `<keyId>.public.pem` and
`<keyId>.key.json` into that folder. It never overwrites a file. The key id has the form `release-` followed by 16 hex
characters.

Check the fingerprint against the printed record:

```powershell
node .\sign-release-manifest.mjs fingerprint --pub E:\joy-release-key\<keyId>.public.pem
```

The two values must be equal. Record the key id and the fingerprint. Never record the passphrase or any part of the private
key. Keep the two backups the ceremony document describes, in two places.

Keep the script on the offline machine's own drive, in a folder such as `C:\joy-sign\`, and the key folder on the USB stick. The
tool refuses a key folder inside the folder three levels above the script's folder. At the drive root, that means the whole
drive. If the tool refuses the key folder with "must be outside this checkout", stop and tell engineering. Do not change the path
to get around the check.

Send engineering the public PEM text, the key id and the fingerprint. Send nothing else from the key folder. Never send the private
PEM, the passphrase, or a file that contains either.

### 4. Pin the public key (engineering edits, you approve)

Engineering opens a pull request that adds the public PEM to `PINNED_RELEASE_PUBLIC_KEYS_PEM` in
`packages/release-trust/src/release-key.ts`, with the fingerprint in a comment. The tests in
`packages/release-trust/src/policy.test.ts` must still pass. Pinning changes what every build trusts, so the pin and any merge
to `main` need your approval.

### 5. Sign the manifest (owner, offline)

```powershell
node .\sign-release-manifest.mjs sign --manifest .\release-manifest.json --key E:\joy-release-key\<keyId>.private.pem --passphrase-file .\passphrase.txt --out .\release-manifest.json.sig
node .\sign-release-manifest.mjs verify --manifest .\release-manifest.json --sig .\release-manifest.json.sig --pub E:\joy-release-key\<keyId>.public.pem
```

`sign` never overwrites its output. `verify` must print `signature verified`. If it prints `signature REFUSED`, stop and do not
publish.

### 6. Publish (not yet authorized)

Publishing adds two assets to the latest release of the public release repository: `release-manifest.json` and
`release-manifest.json.sig`, with exactly these names. The app downloads them from the `releases/latest` location, so the
release they sit on must be the release they describe. Publishing needs your explicit approval in `release-authorization.md`.

### 7. Verify after publishing

From a build that pins the key:

```powershell
joy-media update check
joy-media update verify <downloaded joy-media-setup.exe>
```

`update verify` reads `release-manifest.json` and `release-manifest.json.sig` from the folder of the file. It must report
`verified`. Record the result.

## Rotation, loss and suspected leak

Follow `docs/release/offline-signing-key-ceremony.md`. Do not improvise these cases.

## Never

- Commit or paste the private PEM, the passphrase, or a file that contains either.
- Sign on a computer that is connected to a network.
- Pin a `development-…` key. Development keys are marked `notForRelease`.
- Publish the packager's `joy-media-release-manifest.json` as the update manifest.
- Publish a manifest signed by a key you have not recorded.

## Result record (send to engineering)

| Item                       | Value   |
| -------------------------- | ------- |
| Candidate commit           |         |
| Manifest SHA-256           |         |
| Key id                     |         |
| Key fingerprint            |         |
| Pin change (pull request)  |         |
| Signature verified offline |         |
| Published                  | not yet |
| Verified after publishing  |         |
