/**
 * Generate Claude Cream NSIS installer sidebar + portable splash BMPs.
 *
 * Outputs:
 *   build/installerSidebar.bmp  (328×628)
 *   build/splash.bmp            (480×300)
 *
 * Usage: node scripts/generate-installer-assets.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const iconCandidates = [
  path.join(root, "designs", "icons", "app-icon.png"),
  path.join(root, "resources", "icon.png"),
  path.join(root, "build", "icon.png"),
];

async function loadIcon() {
  const src = iconCandidates.find((p) => fs.existsSync(p));
  if (!src) throw new Error("No app icon found for installer art");
  return sharp(src).resize(180, 180, { fit: "cover" }).png().toBuffer();
}

function svgSidebar(iconDataUrl) {
  return `
<svg width="328" height="628" viewBox="0 0 328 628" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#faf9f5"/>
      <stop offset="55%" stop-color="#f5f4ee"/>
      <stop offset="100%" stop-color="#eae6d8"/>
    </linearGradient>
  </defs>
  <rect width="328" height="628" fill="url(#bg)"/>
  <circle cx="280" cy="40" r="120" fill="#d97757" fill-opacity="0.07"/>
  <circle cx="30" cy="580" r="100" fill="#d97757" fill-opacity="0.055"/>
  <image href="${iconDataUrl}" x="74" y="160" width="180" height="180" preserveAspectRatio="xMidYMid meet" />
  <text x="164" y="390" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="26" font-weight="700" fill="#30302a">Game Launcher</text>
  <text x="164" y="422" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="13" font-weight="500" fill="#6b6558">by Lê Quân</text>
  <rect x="124" y="448" width="80" height="2" rx="1" fill="#948c7c" fill-opacity="0.6"/>
</svg>`;
}

function svgSplash(iconDataUrl) {
  return `
<svg width="480" height="300" viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#faf9f5"/>
      <stop offset="100%" stop-color="#eae6d8"/>
    </linearGradient>
  </defs>
  <rect width="480" height="300" fill="url(#bg)"/>
  <circle cx="420" cy="30" r="90" fill="#d97757" fill-opacity="0.07"/>
  <circle cx="35" cy="285" r="70" fill="#d97757" fill-opacity="0.055"/>
  <image href="${iconDataUrl}" x="180" y="54" width="120" height="120" />
  <text x="240" y="210" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="24" font-weight="700" fill="#30302a">Game Launcher</text>
  <text x="240" y="236" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="12" fill="#948c7c">Starting…</text>
</svg>`;
}

function pngToBmp(pngPath, bmpPath) {
  // Use PowerShell System.Drawing for true BMP (NSIS requires BMP)
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap $img.Width, $img.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(250,249,245))
$g.DrawImage($img, 0, 0, $img.Width, $img.Height)
$bmp.Save('${bmpPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()
`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    stdio: "inherit",
  });
}

async function main() {
  const iconPng = await loadIcon();
  const iconDataUrl = `data:image/png;base64,${iconPng.toString("base64")}`;

  const tmpDir = path.join(root, "build", ".tmp-installer-art");
  fs.mkdirSync(tmpDir, { recursive: true });

  const sidebarPng = path.join(tmpDir, "sidebar.png");
  const splashPng = path.join(tmpDir, "splash.png");
  const sidebarBmp = path.join(root, "build", "installerSidebar.bmp");
  const splashBmp = path.join(root, "build", "splash.bmp");

  await sharp(Buffer.from(svgSidebar(iconDataUrl)))
    .png()
    .toFile(sidebarPng);
  await sharp(Buffer.from(svgSplash(iconDataUrl)))
    .png()
    .toFile(splashPng);

  pngToBmp(sidebarPng, sidebarBmp);
  pngToBmp(splashPng, splashBmp);

  // cleanup temp
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log("[installer-assets] wrote:");
  console.log(
    " ",
    path.relative(root, sidebarBmp),
    fs.statSync(sidebarBmp).size
  );
  console.log(" ", path.relative(root, splashBmp), fs.statSync(splashBmp).size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
