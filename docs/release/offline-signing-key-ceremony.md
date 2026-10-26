# Offline release signing key: ceremony and custody (decision D2)

Status: procedure for the owner. Nothing here has been run for the real key. Until the owner runs it, the pinned key list
in `packages/release-trust/src/release-key.ts` stays empty, and every update check and every `update verify` refuses with
`release-key-unconfigured`. That is the designed, fail-closed state.

## What the key does, and what it never does

- It signs `release-manifest.json` for each published release. The app and `joy-media update verify` accept a manifest only
  when a pinned public key verifies its signature over the exact bytes.
- It is never used for development, CI or tests. Those use keys labelled `development-…`, which no build pins.
- Its private half never enters this repository, CI logs or secrets, receipts, gbrain, chat, screenshots or a networked
  machine. Only the **public** PEM and its **fingerprint** are shared, because the public half is meant to be pinned.

## Before you start

1. Use a computer that stays offline for the whole ceremony: Wi-Fi and Ethernet off, no sync client running. Use Node 24.
2. Copy one file onto it: `tooling/release/src/sign-release-manifest.mjs`. It imports only Node built-in modules, so it needs
   no install. Check its SHA-256 against the copy in the signed commit before you trust it.
3. Prepare an encrypted USB stick (for example BitLocker To Go). Its contents are the only place the key is ever written.
4. Choose a passphrase of at least 16 characters, and store it in your password manager. Write it into a file named
   `passphrase.txt` on the **offline** machine only. Delete that file after the last signing run.

## Generate the key (once)

Run from the folder that holds the script, with the passphrase file and an output folder on the USB stick:

```bash
node sign-release-manifest.mjs keygen --purpose release --out-dir E:\joy-release-key --passphrase-file passphrase.txt
```

The command prints a JSON record: `keyId`, `fingerprint`, `purpose: "release"`. It writes three files named after the key id:
`release-<id>.private.pem` (encrypted), `release-<id>.public.pem`, and `release-<id>.key.json`. It never overwrites a file.

Then check the fingerprint against the record:

```bash
node sign-release-manifest.mjs fingerprint --pub E:\joy-release-key\release-<id>.public.pem
```

## Keep two backups, in two places

- Copy the encrypted private PEM to a second encrypted stick, and store it somewhere physically separate (a safe).
- Keep the passphrase in the password manager, and in a sealed paper copy in the same safe as the second stick.
- Record only the **fingerprint** and the key id in the release receipt. Never record the passphrase, the PEM or any part of them.
- Then delete `passphrase.txt` from the offline machine.

## Pin the public key (a reviewed change, not a secret)

Add the **public** PEM to `PINNED_RELEASE_PUBLIC_KEYS_PEM` in `packages/release-trust/src/release-key.ts`, with the fingerprint
in the comment. That pull request changes what every build trusts, so it needs your review and approval like any release-policy change.
The policy and key tests in `packages/release-trust/src/policy.test.ts` must still pass.

## Sign a release (offline, each time)

1. Build `release-manifest.json` for the exact release candidate. Its files, sizes and SHA-256 digests come from the release build.
2. Put the USB stick in, and make a copy of the manifest on the offline machine.
3. Sign the exact bytes:

   ```bash
   node sign-release-manifest.mjs sign --manifest release-manifest.json --key E:\joy-release-key\release-<id>.private.pem --passphrase-file passphrase.txt --out release-manifest.json.sig
   ```

4. Verify it with the public key, still offline:

   ```bash
   node sign-release-manifest.mjs verify --manifest release-manifest.json --sig release-manifest.json.sig --pub E:\joy-release-key\release-<id>.public.pem
   ```

5. Publish `release-manifest.json` and `release-manifest.json.sig` as release assets. Afterwards, verify once more from a trusted
   machine with the shipped CLI: `joy-media update verify`. Delete `passphrase.txt` from the offline machine.

## Rotation

Generate a second key with the same procedure, and pin both public keys in one reviewed change. Then sign a manifest with the
**old** key that announces the new key. Retire the old key only after that release is out. Old signatures stay valid for the
releases they signed.

## Loss or compromise

- **Lost private key, passphrase intact:** restore from the second backup. Nothing changes for users.
- **Lost key, no backup:** no updater path until a new key is pinned. Manual installation of a signed release still works.
  Publish the new key in a reviewed change and tell users in the release notes.
- **Suspected leak:** stop signing with that key. Pin a new key, and publish a manifest signed with the old key that
  announces it. Treat every manifest signed after the suspected leak as untrusted until you have checked it by hand.

## Never

- Commit the private PEM, the passphrase, or a file that contains either. Never paste them into chat, CI, a receipt or gbrain.
- Sign on a computer that is connected to a network.
- Pin a development key. Development keys are named `development-…` and their records say `notForRelease`.
- Share the passphrase file. Delete it after each session.
