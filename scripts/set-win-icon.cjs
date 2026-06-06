// Applies the app icon to the built Windows exe using rcedit.
//
// electron-builder's `signAndEditExecutable` is disabled in electron-builder.yml
// because enabling it pulls the winCodeSign package, whose darwin symlinks fail
// to extract on Windows without admin/Developer Mode. As a result electron-builder
// never edits the exe, so gamelaucher.exe keeps the default Electron icon.
// This post-build step applies the real icon with the bundled rcedit instead.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

if (process.platform !== "win32") process.exit(0);

const root = path.resolve(__dirname, "..");
const rcedit = path.join(root, "build", "rcedit-x64.exe");
const icon = path.join(root, "build", "icon.ico");
const exe = path.join(root, "dist", "win-unpacked", "gamelaucher.exe");

for (const [label, file] of [
  ["rcedit", rcedit],
  ["icon", icon],
  ["exe", exe],
]) {
  if (!fs.existsSync(file)) {
    console.warn(`[set-win-icon] skip: ${label} not found at ${file}`);
    process.exit(0);
  }
}

execFileSync(rcedit, [exe, "--set-icon", icon], { stdio: "inherit" });
console.log("[set-win-icon] icon applied to", exe);
