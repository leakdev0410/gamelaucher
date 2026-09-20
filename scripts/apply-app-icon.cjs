/**
 * Builds Claude Cream app icons into resources/ and build/.
 *
 * Sources (first found wins for master):
 *   designs/icons/app-icon.png
 *   designs/app-icon-soft-graphite.png
 *   designs/app-icon-512.png
 *
 * Tray: same master app icon (scaled for tray sizes) — stays in sync with the app.
 *
 * Usage: node scripts/apply-app-icon.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const root = path.resolve(__dirname, "..");

const masterCandidates = [
  path.join(root, "designs", "icons", "app-icon.png"),
  path.join(root, "designs", "app-icon-soft-graphite.png"),
  path.join(root, "designs", "app-icon-512.png"),
  path.join(root, "designs", "app-icon-soft-graphite-master.jpg"),
];

const navCandidates = [
  // Always prefer the current master app icon so nav/tray stay in sync
  path.join(root, "designs", "icons", "app-icon.png"),
  path.join(root, "designs", "icons", "nav-mark.png"),
];

async function loadMaster(candidates) {
  const source = candidates.find((p) => fs.existsSync(p));
  if (!source) return null;
  const buf = await sharp(source)
    .resize(1024, 1024, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  return { source, buf };
}

async function main() {
  const master = await loadMaster(masterCandidates);
  if (!master) {
    console.error("[apply-app-icon] no master icon found");
    process.exit(1);
  }
  console.log("[apply-app-icon] master:", path.relative(root, master.source));

  const out = {
    resourcesIcon: path.join(root, "resources", "icon.png"),
    resourcesTray: path.join(root, "resources", "tray-icon.png"),
    buildPng: path.join(root, "build", "icon.png"),
    build512: path.join(root, "build", "icons", "512x512.png"),
    buildIco: path.join(root, "build", "icon.ico"),
    rendererNav: path.join(
      root,
      "src",
      "renderer",
      "src",
      "assets",
      "app-icon.png"
    ),
    designsMaster: path.join(root, "designs", "icons", "app-icon.png"),
  };

  fs.mkdirSync(path.dirname(out.build512), { recursive: true });
  fs.mkdirSync(path.dirname(out.designsMaster), { recursive: true });
  fs.mkdirSync(path.dirname(out.rendererNav), { recursive: true });

  await sharp(master.buf).resize(512, 512).png().toFile(out.resourcesIcon);
  await sharp(master.buf).resize(512, 512).png().toFile(out.buildPng);
  await sharp(master.buf).resize(512, 512).png().toFile(out.build512);
  await sharp(master.buf).resize(512, 512).png().toFile(out.designsMaster);

  const nav = await loadMaster(navCandidates);
  await sharp((nav || master).buf)
    .resize(128, 128)
    .png()
    .toFile(out.rendererNav);

  // Tray = same app icon (master), sized for Windows/macOS tray
  console.log("[apply-app-icon] tray: same as master app icon");
  await sharp(master.buf)
    .resize(32, 32, {
      fit: "cover",
      position: "centre",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toFile(out.resourcesTray);

  await sharp(master.buf)
    .resize(64, 64, {
      fit: "cover",
      position: "centre",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toFile(path.join(root, "designs", "icons", "tray-icon.png"));

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = await Promise.all(
    icoSizes.map((size) =>
      sharp(master.buf).resize(size, size).png().toBuffer()
    )
  );
  fs.writeFileSync(out.buildIco, await pngToIco(icoPngs));

  console.log("[apply-app-icon] wrote:");
  for (const [k, p] of Object.entries(out)) {
    if (fs.existsSync(p)) {
      console.log(
        `  ${k}: ${path.relative(root, p)} (${fs.statSync(p).size} B)`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
