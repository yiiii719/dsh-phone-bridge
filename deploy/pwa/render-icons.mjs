// Render the PWA icon set from DSH's own favicon.
//
//   node render-icons.mjs /path/to/favicon.svg ./icons
//
// The favicon ships with @deepseek-ai/dsh-web-frontend (MIT) at
//   node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg
// Chrome does the rasterizing, so there is no image library to install.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [, , svgPath, outDirArg] = process.argv;
if (!svgPath) {
  console.error("usage: node render-icons.mjs <favicon.svg> [outDir]");
  process.exit(1);
}
const outDir = outDirArg || "./icons";
fs.mkdirSync(outDir, { recursive: true });
const svg = fs.readFileSync(svgPath, "utf8").replace(/<\?xml[^>]*\?>/, "");

// regular icons keep transparency; the maskable one needs a solid background
// and the logo inside the 80% safe zone; iOS wants a square PNG too.
const targets = [
  { file: "icon-192.png", size: 192, pad: 0.08, bg: null, inner: 1.0 },
  { file: "icon-512.png", size: 512, pad: 0.08, bg: null, inner: 1.0 },
  { file: "icon-maskable-512.png", size: 512, pad: 0, bg: "#ffffff", inner: 0.6 },
  { file: "apple-touch-icon.png", size: 180, pad: 0.06, bg: "#ffffff", inner: 1.0 },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

for (const t of targets) {
  const inner = Math.round(t.size * t.inner * (1 - t.pad * 2));
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
       html,body{margin:0;width:${t.size}px;height:${t.size}px;background:${t.bg ?? "transparent"}}
       .w{width:${t.size}px;height:${t.size}px;display:flex;align-items:center;justify-content:center}
       svg{width:${inner}px;height:${inner}px;display:block}
     </style><div class="w">${svg}</div>`,
    { waitUntil: "load" }
  );
  const file = path.join(outDir, t.file);
  await page.screenshot({ path: file, omitBackground: t.bg === null });
  console.log(`${t.file}  ${t.size}x${t.size}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}

await browser.close();
