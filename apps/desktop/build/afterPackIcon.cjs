// electron-builder afterPack hook: bake the macOS 26+ Liquid Glass icon.
//
// electron-builder 26.x converts build/icon.png into a legacy .icns (used by the
// app + older macOS). On Tahoe (macOS 26) and later the system instead reads a
// compiled asset catalog (Assets.car) referenced by CFBundleIconName, which is
// what gives the icon real Liquid Glass treatment. We compile build/icon.icon
// with `actool` (ships with Xcode 26+) and wire it into the bundle here.
//
// If actool / Xcode isn't available, we warn and leave the .icns in place so the
// build still succeeds (the icon just won't get the dynamic glass rendering).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ICON_NAME = "icon"; // matches icon.icon -> CFBundleIconName "icon"

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  installLiquidGlassIcon(context);
  // Sign last: the icon step above mutates the bundle (Assets.car + Info.plist),
  // which would invalidate any earlier signature.
  adhocSign(context);
};

// Ad-hoc sign the .app so macOS Gatekeeper does not reject it as "damaged" on
// Apple Silicon. This is not Developer ID signing — downloaded copies still need
// the quarantine flag cleared (right-click → Open, or `xattr -cr`) — but it stops
// the hard "damaged and can't be opened" failure for unsigned arm64 bundles.
function adhocSign(context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  try {
    run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
    run("codesign", ["--verify", "--deep", "--strict", appPath]);
    console.log(`[sign] ad-hoc signed ${path.basename(appPath)}`);
  } catch (err) {
    console.warn(`[sign] ad-hoc signing failed: ${err.message}\n${err.stderr || ""}`);
  }
}

function installLiquidGlassIcon(context) {
  const iconSrc = path.join(__dirname, "icon.icon");
  if (!fs.existsSync(iconSrc)) {
    console.warn(`[icon] ${iconSrc} not found — skipping Liquid Glass icon.`);
    return;
  }

  let actool;
  try {
    actool = run("xcrun", ["--find", "actool"]);
  } catch {
    console.warn(
      "[icon] actool not found (needs full Xcode 26+, not just Command Line Tools). " +
        "Shipping the .icns fallback only — no Liquid Glass rendering on macOS 26+."
    );
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(context.appOutDir, appName, "Contents", "Resources");
  const infoPlist = path.join(context.appOutDir, appName, "Contents", "Info.plist");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dinorip-icon-"));
  const partialPlist = path.join(tmp, "assetcatalog_generated_info.plist");

  try {
    run(actool, [
      iconSrc,
      "--app-icon", ICON_NAME,
      "--compile", tmp,
      "--output-partial-info-plist", partialPlist,
      "--platform", "macosx",
      "--minimum-deployment-target", "26.0",
      "--target-device", "mac",
      "--errors", "--warnings"
    ]);

    const car = path.join(tmp, "Assets.car");
    if (!fs.existsSync(car)) throw new Error("actool produced no Assets.car");
    fs.copyFileSync(car, path.join(resourcesDir, "Assets.car"));

    // Point the bundle at the compiled icon asset for Tahoe+.
    const plistBuddy = "/usr/libexec/PlistBuddy";
    try {
      run(plistBuddy, ["-c", `Set :CFBundleIconName ${ICON_NAME}`, infoPlist]);
    } catch {
      run(plistBuddy, ["-c", `Add :CFBundleIconName string ${ICON_NAME}`, infoPlist]);
    }

    console.log(`[icon] Liquid Glass icon installed (Assets.car + CFBundleIconName=${ICON_NAME}).`);
  } catch (err) {
    console.warn(`[icon] Failed to build Liquid Glass icon: ${err.message}\n${err.stderr || ""}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
