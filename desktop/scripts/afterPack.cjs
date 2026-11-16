/* electron-builder afterPack: ad-hoc sign the macOS bundle as a floor.
 *
 * Without a Developer ID certificate, electron-builder leaves the Electron
 * binary's original linker signature, which is invalid once the bundle is
 * renamed; macOS then calls the app "damaged". An ad-hoc signature (identity
 * "-") is valid, so macOS shows the ordinary prompt for an app from an
 * unidentified developer instead. With a real certificate, electron-builder
 * signs again over this (with --force) and notarizes.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
};
