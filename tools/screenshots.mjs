// Automated store screenshots (run: npm run build && node tools/screenshots.mjs).
// Launches real Chrome with the extension loaded and captures five 1280x800
// PNGs into store-assets/. The extension is staged from a COPY of dist/: the
// shipped build is never modified. The staging adds a screenshot-only popup
// harness (backdrop + iframe) and seeds storage. All UI shown is the real
// shipped code. Nothing here discards tabs, so Playwright stays stable.
import { chromium } from "playwright";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const stageDir = path.join(root, ".stage-ext");
const profileDir = path.join(root, ".stage-profile");
const outDir = path.join(root, "store-assets");

await rm(stageDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });
await cp(path.join(root, "dist"), stageDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const popupHtml = await readFile(path.join(stageDir, "popup", "popup.html"), "utf8");
await writeFile(
  path.join(stageDir, "popup", "popup-stage.html"),
  popupHtml.replace(
    '<script src="popup.js"></script>',
    '<script src="stage-mock.js"></script><script src="popup.js"></script>',
  ),
);
// Screenshot harness only: pretend a few tabs are asleep and a real site is active.
await writeFile(
  path.join(stageDir, "popup", "stage-mock.js"),
  `const fakeTab = { id: 999, url: "https://www.nytimes.com/section/world", active: true };
const origQuery = chrome.tabs.query.bind(chrome.tabs);
chrome.tabs.query = (info) => {
  if (info && info.discarded) return Promise.resolve(Array.from({ length: 14 }, (_, i) => ({ id: i })));
  if (info && info.active) return Promise.resolve([fakeTab]);
  return origQuery(info);
};
`,
);
const frame = (headline, src, w, h) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; height:100vh; display:flex; flex-direction:column; gap:26px;
    align-items:center; justify-content:center;
    background:linear-gradient(135deg,#4f46e5,#1e1b4b); font-family:system-ui,sans-serif; }
  h1 { color:#fff; font-size:29px; margin:0; font-weight:800; letter-spacing:-.5px;
    text-align:center; max-width:900px; }
  .shot { box-shadow:0 24px 80px rgba(0,0,0,.45); border-radius:12px; overflow:hidden; }
  iframe { width:${w}px; height:${h}px; border:none; background:#fff; display:block; }
  </style></head><body><h1>${headline}</h1>
  <div class="shot"><iframe src="${src}"></iframe></div></body></html>`;
await writeFile(
  path.join(stageDir, "stage-frame.html"),
  frame("14 tabs asleep. One click to sleep the rest.", "popup/popup-stage.html", 320, 440),
);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${stageDir}`, `--load-extension=${stageDir}`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  const extUrl = (p) => `chrome-extension://${extId}/${p}`;
  const page = await context.newPage();
  const shot = (name) => page.screenshot({ path: path.join(outDir, name) });
  const scrollTo = async (selector) => {
    await page.evaluate((sel) => {
      document.querySelector(sel).scrollIntoView({ block: "start" });
      window.scrollBy(0, -24);
    }, selector);
    await page.waitForTimeout(300);
  };

  const seed = (pro) =>
    page.evaluate(async (isPro) => {
      await chrome.storage.sync.set({
        settings: {
          idleMinutes: 20,
          paused: false,
          skipPinned: true,
          skipAudible: true,
          skipGrouped: false,
          protectedSites: ["mail.google.com", "calendar.google.com", "docs.google.com"],
          siteTimeouts: isPro
            ? [{ host: "news.ycombinator.com", minutes: 5 }, { host: "figma.com", minutes: 90 }]
            : [],
          minOpenTabs: isPro ? 12 : 0,
        },
      });
      await chrome.storage.local.set({
        stats: { slept: 1284 },
        proEntitlement: { active: isPro, checkedAt: Date.now() },
      });
    }, pro);

  await page.goto(extUrl("options/options.html"));

  // 1. Core settings (Free)
  await seed(false);
  await page.reload();
  await page.waitForTimeout(500);
  await shot("screenshot-1-settings.png");

  // 2. Protected sites
  await scrollTo("h2:nth-of-type(1) ~ section, section:nth-of-type(2)");
  await shot("screenshot-2-protected-sites.png");

  // 3. Pro locked and explained
  await scrollTo("#pro-section");
  await shot("screenshot-3-pro-locked.png");

  // 4. Popup
  await page.goto(extUrl("stage-frame.html"));
  await page.waitForTimeout(800);
  await shot("screenshot-4-popup.png");

  // 5. Pro unlocked (per-site timers + tab-count threshold)
  await page.goto(extUrl("options/options.html"));
  await seed(true);
  await page.reload();
  await page.waitForTimeout(500);
  await scrollTo("#pro-section");
  await shot("screenshot-5-pro-unlocked.png");
} finally {
  await context.close();
}

await rm(stageDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });
console.log(`screenshots written to ${outDir}`);
