// Applies the app icon to the built Windows exe using rcedit.
//
// electron-builder's `signAndEditExecutable` is disabled in electron-builder.yml
// because enabling it pulls the winCodeSign package, whose darwin symlinks fail
// to extract on Windows without admin/Developer Mode. As a result electron-builder
// never edits the exe, so gamelaucher.exe keeps the default Electron icon.
// This hook applies the real icon with the bundled rcedit after pack, before
// NSIS/portable artifacts are created.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const rcedit = path.join(root, "build", "rcedit-x64.exe");
const icon = path.join(root, "build", "icon.ico");

function applyIcon(exe) {
  if (process.platform !== "win32") return;

  for (const [label, file] of [
    ["rcedit", rcedit],
    ["icon", icon],
    ["exe", exe],
  ]) {
    if (!fs.existsSync(file)) {
      console.warn(`[set-win-icon] skip: ${label} not found at ${file}`);
      return;
    }
  }

  execFileSync(rcedit, [exe, "--set-icon", icon], { stdio: "inherit" });
  console.log("[set-win-icon] icon applied to", exe);
}

module.exports = async function setWinIconAfterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const executableName =
    context.packager.platformSpecificBuildOptions.executableName ||
    context.packager.appInfo.productFilename ||
    context.packager.appInfo.sanitizedName;

  applyIcon(path.join(context.appOutDir, `${executableName}.exe`));
};

if (require.main === module) {
  applyIcon(
    process.argv[2] ||
      path.join(root, "dist", "win-unpacked", "gamelaucher.exe")
  );
}
