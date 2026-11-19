/* electron-builder configuration for chatmany (com.publikhq.chatmany).
 *
 * Two signing paths, chosen by the CI workflow (.github/workflows/desktop-build.yml):
 *
 *   - Signed and notarized: the workflow imports the Developer ID certificate
 *     (secrets CSC_LINK, CSC_KEY_PASSWORD) into its own keychain together with
 *     Apple's intermediates and sets MAC_SIGN=1. electron-builder then signs
 *     with the hardened runtime and the entitlements in build-resources/, and
 *     notarizes when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID
 *     are set. Team ID R5R3ZS54LV.
 *
 *   - Unsigned: without the certificate the app is ad-hoc signed (afterPack
 *     floor), so macOS shows the ordinary "unidentified developer" prompt and
 *     never "damaged". The workflow's job summary says which path ran.
 *
 * The publik app token (secret PUBLIK_APP_TOKEN) is written into the packaged
 * package.json (`publik.appToken`) and read by the main process. A build
 * without it still builds; the app then shows "cannot sign in".
 *
 * Updates (publik-updater.cjs, docs/updates.md): `publish` is publik's signed
 * update feed for the listing chatmany. With `--publish never` nothing is
 * uploaded; electron-builder writes resources/app-update.yml into the app, and
 * its own unsigned latest*.yml and .blockmap files into release/. Those are NOT
 * the feed: never put them on a release (scripts/publik-update-feed.cjs makes it).
 * The mac zips are what Squirrel.Mac installs an update from; the dmgs stay
 * the files people download.
 */
const hasCert = process.env.MAC_SIGN === "1";
const canNotarize = hasCert && !!process.env.APPLE_ID && !!process.env.APPLE_APP_SPECIFIC_PASSWORD && !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.publikhq.chatmany",
  productName: "chatmany",
  copyright: "Copyright © publik",
  publish: { provider: "generic", url: "https://publikhq.com/api/updates/chatmany/" },
  files: ["dist/renderer/**", "dist-electron/**", "!**/*.map"],
  extraMetadata: {
    main: "dist-electron/main.cjs",
    publik: { appToken: process.env.PUBLIK_APP_TOKEN || null },
  },
  asar: true,
  afterPack: "./scripts/afterPack.cjs",
  directories: { output: "release", buildResources: "build-resources" },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.social-networking",
    artifactName: "chatmany-${version}-mac-${arch}.${ext}",
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    notarize: canNotarize,
    minimumSystemVersion: "12.0",
  },
  dmg: { title: "chatmany ${version}" },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "chatmany-${version}-windows-x64-setup.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "chatmany",
    uninstallDisplayName: "chatmany",
  },
};
