/**
 * Build the Claude Cream app icon (warm cream tile, terracotta ring + play mark).
 * Outputs designs/icons/app-icon.png (+ tray + nav).
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "designs", "icons");
fs.mkdirSync(outDir, { recursive: true });

// Claude Cream palette (matches src/renderer/src/scss/globals.scss)
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#faf9f5"/>
      <stop offset="100%" stop-color="#f0ede1"/>
    </linearGradient>
  </defs>
  <!-- Transparent canvas; only the rounded tile is painted -->
  <rect x="48" y="48" width="928" height="928" rx="220" ry="220" fill="url(#face)"/>
  <!-- Soft edge so the mark reads against similarly light surfaces -->
  <rect x="48" y="48" width="928" height="928" rx="220" ry="220"
        fill="none" stroke="#30302a" stroke-width="6" opacity="0.11"/>
  <!-- Terracotta ring -->
  <circle cx="512" cy="512" r="300" fill="none" stroke="#d97757" stroke-width="26" opacity="0.92"/>
  <!-- Play triangle -->
  <path d="M402 300 L402 724 L748 512 Z" fill="#d97757"/>
</svg>`;

async function main() {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const master = path.join(outDir, "app-icon.png");
  await sharp(png).png().toFile(master);

  // Tray: same terracotta glyph on the cream tile, scaled down
  const traySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#faf9f5"/>
      <stop offset="100%" stop-color="#f0ede1"/>
    </linearGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="220" ry="220" fill="url(#face)"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="#d97757" stroke-width="26" opacity="0.92"/>
  <path d="M402 300 L402 724 L748 512 Z" fill="#d97757"/>
</svg>`;
  await sharp(Buffer.from(traySvg))
    .png()
    .toFile(path.join(outDir, "tray-icon.png"));

  // Nav mark = same master
  await sharp(png)
    .resize(256, 256)
    .png()
    .toFile(path.join(outDir, "nav-mark.png"));

  console.log(
    "[generate-app-icon-svg] wrote transparent icons to designs/icons/"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
