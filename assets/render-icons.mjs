// Renders assets/logo.svg into every raster size the app icons need.
//   node render.mjs <path/to/logo.svg> <outdir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [svgPath, outDir] = process.argv.slice(2);
const svg = fs.readFileSync(svgPath, "utf8");
const svgUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
fs.mkdirSync(path.join(outDir, "full"), { recursive: true });
fs.mkdirSync(path.join(outDir, "mac"), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

async function shot(html, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${html}</body></html>`,
  );
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: file, omitBackground: true });
}

// Full-bleed tile: Windows, Linux, favicon, README.
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await shot(`<img src="${svgUri}" width="${s}" height="${s}" style="display:block">`, s,
    path.join(outDir, "full", `${s}.png`));
}

// macOS: Apple's icon grid puts the tile at ~80% of the canvas with a soft
// drop shadow, so it sits right next to other Dock/Finder icons.
for (const s of [16, 32, 64, 128, 256, 512, 1024]) {
  const inner = Math.round(s * 0.805);
  const pad = Math.round((s - inner) / 2);
  const blur = Math.max(1, Math.round(s * 0.012));
  const dy = Math.max(1, Math.round(s * 0.01));
  await shot(
    `<img src="${svgUri}" width="${inner}" height="${inner}"
       style="display:block;margin:${pad}px 0 0 ${pad}px;filter:drop-shadow(0 ${dy}px ${blur}px rgba(0,0,0,.45))">`,
    s, path.join(outDir, "mac", `${s}.png`));
}

await browser.close();
console.log("rendered to", outDir);
