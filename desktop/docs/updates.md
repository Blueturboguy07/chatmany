# Updates

chatmany updates itself on macOS and Windows. The code is `publik-updater.cjs` (the Electron part) and
`publik-update-verify.cjs` (the signature check). Both files are the same in every publik Electron app
(copied unchanged from the publik updater template, Blueturboguy07/surfcam). `src/main/main.ts` starts them;
`scripts/build-main.mjs` bundles them into `dist-electron/main.cjs`. `electron-updater` and `blakejs` are the
app's only runtime dependencies (`package.json` › `dependencies`), packed into `app.asar`.

## How it works

1. The app asks `https://publikhq.com/api/updates/chatmany-mann/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch, every 24 hours and when you click **Check for Updates…** (macOS: the chatmany menu;
   Windows: Help, which shows when you press Alt).
2. The app verifies the signature with the publik update public key, which is in `publik-update-verify.cjs`.
   If the signature is missing or wrong, the app stops there. It downloads nothing.
3. The feed must name this app (`publikApp: chatmany-mann`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names, in the background. It refuses the file if its
   sha512 is not the one in the signed feed. Windows downloads the NSIS installer. macOS downloads the zip
   of its own architecture (Apple silicon: `-mac-arm64.zip`; Intel: `-mac-x64.zip`), and Squirrel.Mac also
   refuses an app that does not satisfy the code signature of the running app (same bundle ID
   `com.publikhq.chatmany`, same Developer ID, team R5R3ZS54LV). The publik key in the Keychain stays
   readable.
5. The app asks: "chatmany X is ready to install. Restart now?" **Later** installs the update when you quit.
   The app never restarts by itself.

A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks; the CI workflows set it. The smoke test
mode (`--smoke-test`) starts no updater at all: it may talk only to its fake publik.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/chatmany-mann/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/chatmany-mann/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/chatmany-mann/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/chatmany-mann/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The feed lists ABSOLUTE GitHub asset URLs. The app downloads the installer from GitHub, not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.

A mac feed file looks like this (`scripts/publik-update-feed.cjs` makes it; the zips come first):

```yaml
version: '0.1.2'
publikApp: 'chatmany-mann'
files:
  - url: 'https://github.com/Blueturboguy07/chatmany/releases/download/desktop-v0.1.2/chatmany-0.1.2-mac-arm64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/chatmany/releases/download/desktop-v0.1.2/chatmany-0.1.2-mac-x64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: '…/chatmany-0.1.2-mac-arm64.dmg'
    …
  - url: '…/chatmany-0.1.2-mac-x64.dmg'
    …
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

The `.sig` file is a minisign signature of the feed file (`tauri signer sign`, `minisign -S` or
`minisign -S -l`; the trusted comment must name the file, which these tools do by default).

## How a release is built today

- `.github/workflows/desktop-build.yml` (on a push to `desktop-app`) tests the app, builds the Windows
  installer (unsigned, with the publik app token) and the mac dmgs and zips (arm64 and x64), and smoke-tests
  each built app. Without the `CSC_LINK` / `CSC_KEY_PASSWORD` secrets (not set today) the mac apps are only
  ad-hoc signed: they are NOT release files.
- The mac release files are signed on the maintainer's Mac with the Developer ID certificate in its
  keychain (team R5R3ZS54LV), notarized through publik's `notarize-artifact.yml`, and stapled.
- The files go on a GitHub release with a `desktop-vX.Y.Z` tag. `desktop-release-smoke.yml` then tests the
  downloaded release files.

## Cut a release with updates

One command, on the maintainer's Mac (it holds the Developer ID certificate, the notarytool profile `publik`
and the publik update key in its keychain):

```sh
git checkout desktop-app
desktop/scripts/publik-release.sh X.Y.Z --notes-file notes.md
```

`notes.md` holds the lines that say what is new. The script does every step and stops at the first failed check
(the release then stays a draft; run the same command again to resume):

1. Sets the version (`package.json`, `package-lock.json`, `APP_VERSION` in `src/main/publik.ts`, `version` in
   `src/preload/preload.ts`), commits and pushes to `desktop-app`.
2. Waits for `desktop-build.yml` on that commit (tests, both mac apps, the Windows installer, smoke tests).
3. Makes a draft release `desktop-vX.Y.Z`.
4. Signs each mac app with the Developer ID, notarizes it, staples it, makes the update zip from the stapled app
   and the dmg (signed, notarized, stapled).
5. Takes the Windows installer of the same CI run and checks it against CI's record of the publik app token.
6. Writes `latest.yml` and `latest-mac.yml` and signs them with the update key from the keychain.
7. Downloads every file back from the draft and checks it (signatures, hashes, versions, Gatekeeper, the app token).
8. Publishes the release. publik takes it in at its next daily intake (10:00 UTC).

`--no-publish` stops after step 7. `.github/workflows/desktop-update-feed.yml` stays as a repair tool: it makes
the feed files of an existing release again (`-f tag=desktop-vX.Y.Z`, **force** after a file was replaced).

Note: apps of version 0.1.1 and older have no updater. Their users must install the first version with the
updater by hand; updates work from that version on.

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset desktop-vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`,
   `latest-mac.yml.sig`). Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER version, with its feed. Apps that installed the bad version
   update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key to `PUBLIK_UPDATE_PUBLIC_KEYS`, next to the old key. Release that version, signed
   with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

On Windows the installer is not code-signed, so the update key is the only protection there. On macOS,
Squirrel.Mac still requires the Developer ID signature.

## Test builds and the proof

`.github/workflows/desktop-updater-proof.yml` proves the updater on GitHub's macOS (Apple silicon and Intel)
and Windows runners. It builds two test versions, N and N+1, with `"publikUpdaterTest": true` in
`package.json` and WITHOUT the publik app token. Only a test build reads these environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/chatmany-mann/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

In the test hook the app opens no window and starts no publik sign-in and no Instagram call; the proof also
points publikhq.com, Instagram and Facebook at 127.0.0.1 on the runner. Test versions are `0.0.0-updtest.*`:
a test feed that the real key signs is never newer than a real release. The proof puts N+1 on a prerelease
with a `desktop-v0.0.0-updtest.*` tag and deletes it at the end. The mac test builds are signed with an
identity made on the runner, so the proof does not cover Developer ID signing or notarization.
