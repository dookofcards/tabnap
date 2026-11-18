// Build script: bundles TS with esbuild, generates manifest.json from the
// template + shared constants, and copies static assets into dist/.
// --prod additionally minifies and zips dist/ into a store-ready
// tabnap-v<version>.zip in the project root.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { zipDirectory } from "./tools/zip.mjs";
import {
  EXTENSION_NAME,
  EXTENSION_DESCRIPTION,
  paymentConfigured,
} from "./src/shared/constants.ts";

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--prod");
const dist = "dist";

async function buildManifest() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const template = await readFile("src/manifest.template.json", "utf8");
  const manifest = template
    .replaceAll("__EXTENSION_NAME__", EXTENSION_NAME)
    .replaceAll("__EXTENSION_DESCRIPTION__", EXTENSION_DESCRIPTION)
    .replaceAll("__VERSION__", pkg.version);
  const parsed = JSON.parse(manifest); // fail the build on malformed output
  // Until an ExtensionPay account exists, the payment content script would
  // declare access the extension never uses. Ship what is actually true.
  if (!paymentConfigured()) delete parsed.content_scripts;
  await writeFile(`${dist}/manifest.json`, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function copyStatic() {
  await cp("src/popup/popup.html", `${dist}/popup/popup.html`);
  await cp("src/popup/popup.css", `${dist}/popup/popup.css`);
  await cp("src/options/options.html", `${dist}/options/options.html`);
  await cp("src/options/options.css", `${dist}/options/options.css`);
  
  
  await cp("src/icons", `${dist}/icons`, { recursive: true });
  // ExtPay ships as a discrete, unmodified file rather than being bundled:
  // it is AGPLv3 (TabNap is MIT), and keeping it separate means the
  // service worker only pulls it in via importScripts after the user has
  // actually started a purchase. See src/background/payment.ts.
  if (paymentConfigured()) {
    await mkdir(`${dist}/extpay`, { recursive: true });
    await cp("node_modules/extpay/dist/ExtPay.js", `${dist}/extpay/ExtPay.js`);
  }
}

const bundleOptions = {
  entryPoints: [
    { in: "src/background/serviceWorker.ts", out: "background" },
    { in: "src/popup/popup.ts", out: "popup/popup" },
    { in: "src/options/options.ts", out: "options/options" },

  ],
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: prod,
  logLevel: "info",
};

async function makeZip(version) {
  const zipName = `tabnap-v${version}.zip`;
  const files = await zipDirectory(dist, zipName);
  return { zipName, count: files.length };
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await buildManifest();
await copyStatic();

if (watch) {
  const ctx = await esbuild.context(bundleOptions);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(bundleOptions);
  console.log(`built ${EXTENSION_NAME} into ${dist}/`);
  if (prod) {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const { zipName, count } = await makeZip(pkg.version);
    console.log(`packaged store-ready ${zipName} (${count} files)`);
  }
}
