// Captures fixed-size marketing tiles from HTML by screenshotting the
// element itself, so a 440x280 div yields exactly a 440x280 PNG.
// `scale` renders at that device pixel ratio — use it where a platform wants
// high-resolution artwork rather than exact dimensions.
// Run: node tools/capture-tiles.mjs
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const TILES = [
  // Chrome Web Store requires these exact pixel sizes — keep scale at 1.
  { file: "tools/promo.html", sel: "#tile-small", out: "store-assets/promo-440x280.png" },
  { file: "tools/promo.html", sel: "#tile-marquee", out: "store-assets/promo-1400x560.png" },
  { file: "tools/promo.html", sel: "#tile-social", out: "store-assets/github-social-1280x640.png" },
];

const browser = await chromium.launch();
try {
  for (const { file, sel, out, scale = 1 } of TILES) {
    await mkdir(path.dirname(out), { recursive: true });
    const page = await browser.newPage({
      viewport: { width: 1700, height: 900 },
      deviceScaleFactor: scale,
    });
    await page.goto(`file:///${path.resolve(file).replace(/\\/g, "/")}`);
    await page.waitForTimeout(200);
    // locator.screenshot() rounds a fractional top offset outward, which made
    // 440x280 come out as 440x281 — and the store rejects anything inexact.
    // Clip to the element's integer layout size at a rounded origin instead.
    const clip = await page.locator(sel).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
    });
    await page.screenshot({ path: out, clip, fullPage: true });
    await page.close();
    const png = await readFile(out);
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const want = [clip.width * scale, clip.height * scale];
    if (size[0] !== want[0] || size[1] !== want[1]) {
      throw new Error(`${out} is ${size.join("x")}, expected ${want.join("x")}`);
    }
    console.log(`wrote ${out}${scale > 1 ? ` (${scale}x)` : ""}`);
  }
} finally {
  await browser.close();
}
