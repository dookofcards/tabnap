// End-to-end tests against a real Chrome with the extension loaded.
//
// Unit tests (vitest) cover pure logic; this covers everything that needs the
// actual chrome.* APIs: tab discard, storage round-trips, service-worker
// messaging. Run: npm run build && node tools/e2e.mjs
//
// Tests run inside the options page, which shares the extension origin and
// service worker with the real thing, so chrome.* behaves exactly as shipped.
import { chromium } from "playwright";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root = process.cwd();
const dist = path.join(root, "dist");
const profile = path.join(root, ".e2e-profile");

const tests = [];
/**
 * opts.liveExtPay marks tests that talk to ExtensionPay's live API (in test
 * mode — an unpacked install always gets a test-mode key). Plain CI skips
 * them: running them on every push would mint a throwaway user record per
 * build and fail whenever a third party has a bad day. The release workflow
 * sets RUN_PAYMENT_E2E=1, which runs them and turns "can't run" into a
 * failure, so a release can never ship on a silently skipped payment test.
 */
export const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const inCi = process.env.CI !== undefined && process.env.CI !== "";
const requirePayment = process.env.RUN_PAYMENT_E2E === "1";
const runLive = !inCi || requirePayment;

/** Thrown by a test that cannot run here; counted as skipped, not passed. */
class Skip extends Error {}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}


// --- raw Chrome for the tab-discard tests ---
//
// Discarding a tab that Playwright is attached to intermittently crashes
// Chrome (SEGV right after chrome.tabs.discard, reproducible on the CI
// runner and without any TabNap code involved; plain Chrome driven over CDP
// does not crash). So the tests that really discard tabs run in a second
// Chrome launched directly and driven over raw CDP, attached only to the
// extension's own service worker and options page, never to the web tabs.
// Everything else (UI, payment, manifest) stays on Playwright.

/** Minimal CDP session over WebSocket: call(), evaluate(), events. */
class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else this.events.push(m);
    };
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 120_000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Runs fn(arg) in the target and returns its JSON-serialisable result. */
  async eval(fn, arg) {
    const expression = `(${fn})(${JSON.stringify(arg ?? null)})`;
    const res = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }
  close() {
    this.ws.close();
  }
}

// The optional "tabs" permission (tab addresses) can only be granted through
// a Chrome prompt, which automation can't click. Tests of address-dependent
// behaviour (protected sites, per-site timers) therefore run against a copy
// of the built dist/ that is identical except that its manifest moves the
// optional permissions into `permissions`, i.e. the state after a user clicks
// Allow. Everything else runs against the exact shipped build, which has no
// tab access.
const distGranted = path.join(root, ".e2e-dist-granted");
async function grantedCopy() {
  await rm(distGranted, { recursive: true, force: true });
  await cp(dist, distGranted, { recursive: true });
  const file = path.join(distGranted, "manifest.json");
  const m = JSON.parse(await readFile(file, "utf8"));
  m.permissions = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];
  delete m.optional_permissions;
  await writeFile(file, JSON.stringify(m, null, 2));
  return distGranted;
}

async function launchRaw(extDir = dist, label = "raw") {
  const ourName = JSON.parse(await readFile(path.join(extDir, "manifest.json"), "utf8")).name;
  const dir = path.join(root, `.e2e-${label}-profile`);
  await rm(dir, { recursive: true, force: true });
  const child = spawn(chromium.executablePath(), [
    "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${dir}`, "--remote-debugging-port=0",
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 200));
    port = (await readFile(portFile, "utf8").catch(() => "")).split("\n")[0] || undefined;
  }
  if (!port) throw new Error("raw Chrome did not start");
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const find = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const t = (await list()).find(pred);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("target not found");
  };
  // Chrome also runs built-in component extensions, so pick ours by manifest
  // name rather than taking the first service worker.
  let swTarget;
  for (let i = 0; i < 50 && !swTarget; i++) {
    for (const t of (await list()).filter((x) => x.type === "service_worker")) {
      const probe = await Cdp.open(t.webSocketDebuggerUrl);
      const name = await probe.eval(() => chrome.runtime.getManifest().name).catch(() => "");
      probe.close();
      if (name === ourName) swTarget = t;
    }
    if (!swTarget) await new Promise((r) => setTimeout(r, 200));
  }
  if (!swTarget) throw new Error("TabNap service worker not found in raw Chrome");
  const extId = new URL(swTarget.url).host;
  const sw = await Cdp.open(swTarget.webSocketDebuggerUrl);
  await sw.eval((u) => chrome.tabs.create({ url: u, active: true }), `chrome-extension://${extId}/options/options.html`);
  const pageTarget = await find((t) => t.type === "page" && t.url.endsWith("/options/options.html"));
  const page = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  return {
    sw, page, extId, find,
    async close() {
      sw.close();
      page.close();
      child.kill();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// --- helpers for tests that run in the raw Chrome (ctx.raw) ---

/** Opens one background tab per host (…localhost is loopback), runs fn(ids), closes them. */
async function withTabs(raw, url, hosts, fn, { pinned = [] } = {}) {
  let ids = [];
  try {
    ids = await raw.page.eval(async (urls) => {
      const out = [];
      for (const u of urls) out.push((await chrome.tabs.create({ url: u, active: false })).id);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const tabs = await Promise.all(out.map((id) => chrome.tabs.get(id)));
        if (tabs.every((t) => t.status === "complete")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    }, hosts.map((h) => url(h)));
    for (const host of pinned) {
      await raw.page.eval((i) => chrome.tabs.update(i, { pinned: true }).then(() => true), ids[hosts.indexOf(host)]);
    }
    // Keep the options tab active so every fixture tab is a background tab.
    // getCurrent() works with or without tab-address access.
    await raw.page.eval(async () => {
      const t = await chrome.tabs.getCurrent();
      await chrome.tabs.update(t.id, { active: true });
      return true;
    });
    return await fn(ids);
  } finally {
    await raw.page.eval((list) => chrome.tabs.remove(list).then(() => true, () => false), ids).catch(() => {});
  }
}

const activate = (raw, id) => raw.page.eval((i) => chrome.tabs.update(i, { active: true }).then(() => true), id);
const sweepMsg = (raw, type) => raw.page.eval((t) => chrome.runtime.sendMessage({ type: t }), type);

/** Same fixture tabs, for the shipped build where tab addresses are hidden. */
const withTabsHidden = withTabs;
/** [discarded] per tab id, in order. Needs no tab-address access. */
const sleepMapById = (raw, ids) =>
  raw.page.eval(async (list) => Promise.all(list.map(async (id) => (await chrome.tabs.get(id)).discarded)), ids);

/** { host: discarded } for every http tab (needs tab access). */
const sleepMap = (raw) =>
  raw.page.eval(async () =>
    Object.fromEntries(
      (await chrome.tabs.query({}))
        .filter((t) => t.url?.startsWith("http"))
        .map((t) => [new URL(t.url).hostname, t.discarded]),
    ));

const setSettings = (target, patch) =>
  target.eval(async (p) => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({ settings: { ...settings, ...p } });
    return true;
  }, patch);

const setPro = (target, active) =>
  target.eval(async (a) => {
    await chrome.storage.local.set({ proEntitlement: { active: a, checkedAt: Date.now() } });
    return true;
  }, active);

/** Playwright pages expose evaluate(); give them the same eval() as Cdp. */
const pwTarget = (page) => ({
  eval: (fn, arg) => page.evaluate(fn, arg),
});

// --- build sanity ---

test("manifest version matches package.json", async ({ page, pkgVersion }) => {
  const version = await page.evaluate(() => chrome.runtime.getManifest().version);
  assert(version === pkgVersion, `manifest ${version} !== package ${pkgVersion}`);
});

test("declared permissions have not silently grown", async ({ page }) => {
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  // `tabs` is optional: requested only when the user first protects a site
  // (Chrome Web Store rejected 1.0.0 for requesting it up front).
  assert(
    JSON.stringify(manifest.permissions) === JSON.stringify(["storage", "alarms"]),
    `permissions changed: ${JSON.stringify(manifest.permissions)}`,
  );
  assert(
    JSON.stringify(manifest.optional_permissions) === JSON.stringify(["tabs"]),
    `optional permissions changed: ${JSON.stringify(manifest.optional_permissions)}`,
  );
  assert(manifest.host_permissions === undefined, "host permissions appeared");
  const granted = await page.evaluate(() => chrome.permissions.contains({ permissions: ["tabs"] }));
  assert(granted === false, "the shipped build starts with tab access it never asked for");
});

// --- Without tab access (the shipped build; nobody has clicked Allow) ---

test("no tab access: Sleep other tabs still works", async ({ raw, url }) => {
  const access = await raw.page.eval(() => chrome.permissions.contains({ permissions: ["tabs"] }));
  assert(access === false, "raw shipped build unexpectedly has tab access");
  const map = await withTabsHidden(raw, url, ["h1.localhost", "h2.localhost", "h3.localhost"], async (ids) => {
    await activate(raw, ids[2]);
    const r = await sweepMsg(raw, "sleepOthers");
    assert(r.slept >= 2, `expected the 2 background tabs to sleep, got ${r.slept}`);
    return sleepMapById(raw, ids);
  });
  assert(map[0] === true && map[1] === true, `background tabs stayed awake: ${JSON.stringify(map)}`);
  assert(map[2] === false, "the active tab was put to sleep");
}, { raw: true });

test("no tab access: with protected sites set, TabNap leaves tabs awake rather than guess", async ({ raw, url }) => {
  await setSettings(raw.page, { protectedSites: ["safe.localhost"] });
  const map = await withTabsHidden(raw, url, ["safe.localhost", "other.localhost"], async (ids) => {
    const r = await sweepMsg(raw, "sleepOthers");
    assert(r.slept === 0, `slept ${r.slept} tab(s) it couldn't check against the protected list`);
    return sleepMapById(raw, ids);
  });
  assert(map.every((d) => d === false), `a tab slept: ${JSON.stringify(map)}`);
}, { raw: true });

test("no tab access: options asks before protecting a site, and declining adds nothing", async ({ page }) => {
  await page.reload();
  await page.evaluate(() => { chrome.permissions.request = async () => false; });
  await page.fill("#protect-input", "decline.com");
  await page.click("#protect-form button");
  await page.waitForTimeout(300);
  const err = await page.locator("#protect-error").innerText();
  assert(/tab addresses/i.test(err), `no explanation shown: "${err}"`);
  const stored = await page.evaluate(async () => (await chrome.storage.sync.get("settings")).settings?.protectedSites ?? []);
  assert(stored.length === 0, `a site was stored without access: ${JSON.stringify(stored)}`);
});

test("no tab access: options shows an Allow notice while site rules are on hold", async ({ page }) => {
  await setSettings(pwTarget(page), { protectedSites: ["held.com"] });
  await page.reload();
  await page.waitForTimeout(300);
  const visible = await page.evaluate(() => !document.getElementById("tab-access-note").hidden);
  assert(visible, "no notice that protected sites are on hold");
});

// --- Free core (real tab discards, raw Chrome) ---

test("free: Sleep other tabs puts background tabs to sleep, never the active one", async ({ raw, url }) => {
  const hosts = ["f1.localhost", "f2.localhost", "f3.localhost"];
  const map = await withTabs(raw, url, hosts, async (ids) => {
    await activate(raw, ids[2]); // f3 is the tab the user is looking at
    const r = await sweepMsg(raw, "sleepOthers");
    assert(r.slept === 2, `expected 2 slept, got ${r.slept}`);
    return sleepMap(raw);
  });
  assert(map["f1.localhost"] === true && map["f2.localhost"] === true, `background tabs awake: ${JSON.stringify(map)}`);
  assert(map["f3.localhost"] === false, "the active tab was put to sleep");
}, { raw: true, tabAccess: "granted" });

test("free: protected sites, pinned tabs and extension pages stay awake", async ({ raw, url }) => {
  await setSettings(raw.page, { protectedSites: ["keep.localhost"] });
  const hosts = ["keep.localhost", "pin.localhost", "plain.localhost"];
  const map = await withTabs(raw, url, hosts, async () => {
    await sweepMsg(raw, "sleepOthers");
    return sleepMap(raw);
  }, { pinned: ["pin.localhost"] });
  assert(map["keep.localhost"] === false, "protected site slept");
  assert(map["pin.localhost"] === false, "pinned tab slept");
  assert(map["plain.localhost"] === true, "plain tab stayed awake");
  const extAwake = await raw.page.eval(async () => (await chrome.tabs.query({})).filter((t) => t.url.startsWith("chrome-extension://")).every((t) => !t.discarded));
  assert(extAwake, "an extension page was put to sleep");
}, { raw: true, tabAccess: "granted" });

test("free: only five protected sites are enforced", async ({ raw, url }) => {
  const hosts = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"].map((h) => `${h}.localhost`);
  await setSettings(raw.page, { protectedSites: hosts });
  const map = await withTabs(raw, url, hosts, async () => {
    await sweepMsg(raw, "sleepOthers");
    return sleepMap(raw);
  });
  for (const h of hosts.slice(0, 5)) assert(map[h] === false, `${h} should be protected on Free`);
  for (const h of hosts.slice(5)) assert(map[h] === true, `${h} is beyond the Free limit and should sleep`);
}, { raw: true, tabAccess: "granted" });

test("pro: unlimited protected sites really stay awake", async ({ raw, url }) => {
  await setPro(raw.page, true);
  const hosts = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"].map((h) => `${h}.localhost`);
  await setSettings(raw.page, { protectedSites: hosts });
  const map = await withTabs(raw, url, hosts, async () => {
    await sweepMsg(raw, "sleepOthers");
    return sleepMap(raw);
  });
  for (const h of hosts) assert(map[h] === false, `${h} slept despite Pro protection`);
}, { raw: true, tabAccess: "granted" });

// One 62 s wait serves every idle-timer scenario, run as phases on the same
// four tabs with different settings.
test("idle timer: fresh tabs are left alone, then pause, threshold, Free and Pro rules behave", async ({ raw, url }) => {
  await setSettings(raw.page, {
    idleMinutes: 1,
    protectedSites: ["idle-keep.localhost"],
    siteTimeouts: [{ host: "idle-slow.localhost", minutes: 120 }],
  });
  const hosts = ["idle-a.localhost", "idle-keep.localhost", "idle-slow.localhost"];
  await withTabs(raw, url, hosts, async () => {
    await setPro(raw.page, true);
    await sweepMsg(raw, "runSweep");
    const fresh = await sleepMap(raw);
    assert(Object.values(fresh).every((d) => d === false), `a brand-new tab was slept: ${JSON.stringify(fresh)}`);

    await new Promise((r) => setTimeout(r, 62_000));

    await setSettings(raw.page, { paused: true });
    await sweepMsg(raw, "runSweep");
    let m = await sleepMap(raw);
    assert(Object.values(m).every((d) => d === false), `slept while paused: ${JSON.stringify(m)}`);

    await setSettings(raw.page, { paused: false, minOpenTabs: 500 });
    await sweepMsg(raw, "runSweep");
    m = await sleepMap(raw);
    assert(Object.values(m).every((d) => d === false), `slept below the Pro tab-count threshold: ${JSON.stringify(m)}`);

    await setSettings(raw.page, { minOpenTabs: 0 });
    await sweepMsg(raw, "runSweep");
    m = await sleepMap(raw);
    assert(m["idle-a.localhost"] === true, "idle tab was not put to sleep");
    assert(m["idle-keep.localhost"] === false, "protected idle tab slept");
    assert(m["idle-slow.localhost"] === false, "Pro per-site timer was ignored");

    await setPro(raw.page, false);
    await sweepMsg(raw, "runSweep");
    m = await sleepMap(raw);
    assert(m["idle-slow.localhost"] === true, "per-site timer still applied after losing Pro");
    assert(m["idle-keep.localhost"] === false, "protected idle tab slept on Free");
  });
}, { raw: true, tabAccess: "granted" });

test("free: popup shows the sleeping count and its button works", async ({ raw, url }) => {
  await withTabs(raw, url, ["pop-a.localhost", "pop-b.localhost"], async () => {
    const popupTarget = await raw.sw.eval((u) => chrome.tabs.create({ url: u, active: false }).then((t) => t.id), `chrome-extension://${raw.extId}/popup/popup.html`);
    const target = await raw.find((t) => t.type === "page" && t.url.endsWith("/popup/popup.html"));
    const popup = await Cdp.open(target.webSocketDebuggerUrl);
    try {
      await new Promise((r) => setTimeout(r, 1000)); // let popup.js attach its handlers
      await popup.eval(() => document.getElementById("btn-sleep").click());
      await new Promise((r) => setTimeout(r, 1000));
      const out = await popup.eval(() => ({
        count: Number(document.getElementById("sleeping-count").textContent),
        msg: document.getElementById("feedback").textContent,
      }));
      assert(out.count >= 2, `popup shows ${out.count} sleeping`);
      assert(out.msg.includes("to sleep"), `no confirmation: "${out.msg}"`);
    } finally {
      popup.close();
      await raw.sw.eval((i) => chrome.tabs.remove(i).then(() => true), popupTarget);
    }
  });
}, { raw: true });

// --- Free and Pro through the real options UI (Playwright) ---

test("free: the options page refuses a sixth protected site and explains why", async ({ page }) => {
  await setSettings(pwTarget(page), { protectedSites: ["a.com", "b.com", "c.com", "d.com", "e.com"] });
  await page.reload();
  // Stand-in for the user clicking Allow on the tab-address prompt.
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  await page.fill("#protect-input", "six.com");
  await page.click("#protect-form button");
  await page.waitForTimeout(300);
  const err = await page.locator("#protect-error").innerText();
  assert(err.includes("Free tier"), `no explanation shown: "${err}"`);
  const stored = await page.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.protectedSites.length);
  assert(stored === 5, `sixth site was stored (${stored})`);
});

test("pro: options fields are locked and explained without an entitlement", async ({ page }) => {
  await page.reload();
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    disabled: document.getElementById("pro-fields").disabled,
    lockedHidden: document.getElementById("pro-locked").hidden,
    badgeHidden: document.getElementById("pro-badge").hidden,
  }));
  assert(state.disabled, "Pro fields are usable without Pro");
  assert(!state.lockedHidden, "no explanation of the locked state");
  assert(state.badgeHidden, "Unlocked badge shown on Free");
});

test("pro: with an entitlement the fields unlock and rules can be saved", async ({ page }) => {
  await setPro(pwTarget(page), true);
  await page.reload();
  // Stand-in for the user clicking Allow on the tab-address prompt.
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  await page.waitForTimeout(300);
  assert(!(await page.evaluate(() => document.getElementById("pro-fields").disabled)), "still locked with Pro");
  await page.fill("#timeout-host", "docs.example.com");
  await page.fill("#timeout-minutes", "120");
  await page.click("#timeout-form button");
  await page.fill("#min-tabs", "8");
  await page.locator("#min-tabs").dispatchEvent("change");
  await page.waitForTimeout(400);
  const s = await page.evaluate(async () => (await chrome.storage.sync.get("settings")).settings);
  assert(JSON.stringify(s.siteTimeouts) === JSON.stringify([{ host: "docs.example.com", minutes: 120 }]), `timer not saved: ${JSON.stringify(s.siteTimeouts)}`);
  assert(s.minOpenTabs === 8, `threshold not saved: ${s.minOpenTabs}`);
});

test("pro: a sixth protected site can be added with an entitlement", async ({ page }) => {
  await setPro(pwTarget(page), true);
  await setSettings(pwTarget(page), { protectedSites: ["a.com", "b.com", "c.com", "d.com", "e.com"] });
  await page.reload();
  // Stand-in for the user clicking Allow on the tab-address prompt.
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  await page.fill("#protect-input", "six.com");
  await page.click("#protect-form button");
  await page.waitForTimeout(400);
  const stored = await page.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.protectedSites);
  assert(stored.length === 6, `expected 6 protected sites, got ${JSON.stringify(stored)}`);
});

// --- phase 6: payment stays unreachable until asked for ---

test("content scripts only ever run on extensionpay.com", async ({ page }) => {
  // Two things guarded here. While payment is unconfigured there should be no
  // content script at all — declaring access the extension never uses is not
  // something a privacy extension gets to do. And once it is configured, the
  // match must stay narrow: the upstream ExtPay sample injects its script
  // into every http(s) page, which would be indefensible.
  const scripts = await page.evaluate(
    () => chrome.runtime.getManifest().content_scripts,
  );
  if (scripts === undefined) return;
  assert(scripts.length === 1, `expected 1 content script, got ${scripts.length}`);
  assert(
    JSON.stringify(scripts[0].matches) === JSON.stringify(["https://extensionpay.com/*"]),
    `content script matches too much: ${JSON.stringify(scripts[0].matches)}`,
  );
});

test("no payment code ships while payment is unconfigured", async ({ page }) => {
  const present = await page.evaluate(async () => {
    const response = await fetch(chrome.runtime.getURL("extpay/ExtPay.js")).catch(
      () => null,
    );
    return response !== null && response.ok;
  });
  const configured = await page.evaluate(
    () => chrome.runtime.getManifest().content_scripts !== undefined,
  );
  assert(
    present === configured,
    present
      ? "the AGPL payment library shipped in a build with no payment flow"
      : "payment is configured but the library is missing from the build",
  );
});

test("the payment library loads iff payment is configured", async ({
  page,
  worker,
}) => {
  // MV3 only permits importScripts() during the worker's initial evaluation,
  // so this has to happen at startup. An earlier version loaded it lazily on
  // click, which silently failed with ERR_FAILED and made Upgrade a no-op.
  const configured = await page.evaluate(
    () => chrome.runtime.getManifest().content_scripts !== undefined,
  );
  const loaded = await worker.evaluate(() => typeof self.ExtPay !== "undefined");
  assert(
    loaded === configured,
    loaded
      ? "payment library loaded in a build with no payment flow"
      : "payment library failed to load — Upgrade would silently do nothing",
  );
});

test("beginUpgrade actually opens a checkout when configured", async ({
  page,
  context,
}) => {
  const configured = await page.evaluate(
    () => chrome.runtime.getManifest().content_scripts !== undefined,
  );
  const response = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "beginUpgrade" }),
  );
  if (!configured) {
    assert(response.started === false, "unconfigured build reported a start");
    return;
  }
  assert(response.started === true, "Upgrade reported failure");
  // Confirm a real checkout tab appeared, not just a truthy return value.
  await page.waitForTimeout(4000);
  const checkout = context
    .pages()
    .find((p) => p.url().includes("extensionpay.com"));
  assert(checkout !== undefined, "no checkout page opened");
  assert(
    checkout.url().includes("/choose-plan"),
    `unexpected checkout url: ${checkout.url()}`,
  );
  await checkout.close();
}, { liveExtPay: true });

/** Visible-or-not within a short wait, without failing the test. */
const shows = (locator, timeout = 3000) =>
  locator.first().waitFor({ state: "visible", timeout }).then(() => true, () => false);

/**
 * First visible match for `selector` in the page or any of its frames.
 * Stripe's newer Checkout renders the card form inside a js.stripe.com
 * iframe, so searching only the top document finds nothing.
 */
async function inAnyFrame(p, selector, timeout) {
  const deadline = Date.now() + timeout;
  do {
    for (const frame of p.frames()) {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await p.waitForTimeout(500);
  } while (Date.now() < deadline);
  return undefined;
}

async function fillIn(p, selector, value, { required = true, timeout = 20_000 } = {}) {
  const loc = await inAnyFrame(p, selector, required ? timeout : 2000);
  if (loc) await loc.fill(value);
  else if (required) throw new Error(`Stripe field not found: ${selector}`);
}

/**
 * Fills Stripe's hosted Checkout with the 4242 test card. Fields are found
 * by their standard autocomplete tokens, in whichever frame holds them.
 * Optional fields (email, accordion, name, postal code) depend on account
 * settings and the runner's country, so each is filled only if shown.
 */
async function fillStripeCheckout(p) {
  await p.waitForLoadState("networkidle").catch(() => {});
  await fillIn(p, 'input[autocomplete="email"], #email', `e2e+${Date.now()}@example.com`, { required: false });
  const cardMethod = await inAnyFrame(
    p, '[data-testid="card-accordion-item-button"], button[value="card"], [data-value="card"]', 2000);
  if (cardMethod) await cardMethod.click();
  await fillIn(p, 'input[autocomplete="cc-number"], input[name="number"], #cardNumber', "4242424242424242");
  await fillIn(p, 'input[autocomplete="cc-exp"], input[name="expiry"], #cardExpiry', "12 / 34");
  await fillIn(p, 'input[autocomplete="cc-csc"], input[name="cvc"], #cardCvc', "123");
  await fillIn(p, 'input[autocomplete="cc-name"], #billingName', "E2E Test", { required: false });
  await fillIn(p, 'input[autocomplete="postal-code"], input[name="postalCode"], #billingPostalCode', "10001", { required: false });
  const submit = await inAnyFrame(
    p, '[data-testid="hosted-payment-submit-button"], button[type="submit"]', 10_000);
  if (!submit) throw new Error("Stripe submit button not found");
  await submit.click();
}

/**
 * On failure: log form *structure* only — tags, names, types, autocomplete
 * tokens, per frame. Never page text, labels, values or screenshots: this
 * repo's CI logs are public, and Stripe pages show the merchant's legal name.
 */
async function dumpPage(p, label) {
  try {
    const frames = [];
    for (const frame of p.frames()) {
      const url = new URL(frame.url());
      const fields = await frame.evaluate(() =>
        [...document.querySelectorAll("input,select,button")].map((e) =>
          [e.tagName, e.name, e.type, e.getAttribute("autocomplete"),
            e.getAttribute("data-testid"), e.offsetParent !== null ? "visible" : "hidden"]
            .filter(Boolean).join("|")),
      ).catch(() => ["(unreadable)"]);
      frames.push({ frame: `${url.host}${url.pathname.slice(0, 50)}`, fields });
    }
    console.log(`\n--- ${label} form structure ---\n${JSON.stringify(frames, null, 2)}\n---`);
  } catch (e) {
    console.log(`(form dump failed: ${e.message})`);
  }
}

// The whole paid path as a customer walks it: Upgrade → ExtensionPay →
// Stripe Checkout → back → Pro actually changes what gets swept. Test mode
// only: it refuses to type a card anywhere that isn't a Stripe *test* session.
test("a test-mode purchase unlocks pro end to end", async ({ page, context }) => {
  const configured = await page.evaluate(
    () => chrome.runtime.getManifest().content_scripts !== undefined,
  );
  const password = process.env.EXTPAY_DEV_PASSWORD;
  if (!configured || !password) {
    const why = !configured ? "payment is not configured" : "EXTPAY_DEV_PASSWORD is not set";
    if (requirePayment) throw new Error(`${why}; the release gate requires a real test-mode purchase`);
    throw new Skip(why);
  }

  const proActive = () =>
    page.evaluate(async () =>
      (await chrome.storage.local.get("proEntitlement")).proEntitlement?.active === true);
  assert(!(await proActive()), "already pro before paying");

  const opened = context.waitForEvent("page", {
    predicate: (p) => p.url().includes("extensionpay.com"),
    timeout: 20_000,
  });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "beginUpgrade" }));
  const checkout = await opened;
  await checkout.waitForLoadState("networkidle");
  assert(
    (await checkout.title()).includes("test mode"),
    "ExtensionPay is not in test mode; refusing to continue",
  );

  // First (and for TabNap, only) priced plan, e.g. "$9 Lifetime".
  await checkout.locator("button").filter({ hasText: /\$\d/ }).first().click();
  await checkout.locator('input[name="password"]').fill(password);
  await checkout.getByRole("button", { name: /test payment page/i }).click();
  await checkout.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  assert(
    checkout.url().includes("cs_test_"),
    `not a Stripe test session (${new URL(checkout.url()).pathname}); refusing to enter a card`,
  );

  try {
    await fillStripeCheckout(checkout);
  } catch (error) {
    await dumpPage(checkout, "stripe-checkout");
    throw error;
  }

  // onPaid arrives via the content script on extensionpay.com's success page.
  const deadline = Date.now() + 90_000;
  while (!(await proActive())) {
    if (Date.now() > deadline) {
      throw new Error(`paid, but Pro never unlocked (checkout ended at ${checkout.url()})`);
    }
    await page.waitForTimeout(2000);
  }
  await checkout.close().catch(() => {});

  // Entitlement alone isn't the point: a Pro feature must now behave as Pro.
  await page.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({
      settings: { ...settings, protectedSites: ["a.com", "b.com", "c.com", "d.com", "e.com"] },
    });
  });
  await page.reload();
  await page.fill("#protect-input", "six.com");
  await page.click("#protect-form button");
  await page.waitForTimeout(500);
  const sites = await page.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.protectedSites);
  assert(sites.length === 6, `after purchase the sixth protected site should be accepted: ${JSON.stringify(sites)}`);
}, { liveExtPay: true });


test("a free user's session makes no external network requests", async ({ raw, url }) => {
  // Watch the service worker and the extension page while tabs really sleep.
  // Only the test's own loopback fixture pages may appear.
  const external = [];
  const watched = [raw.sw, raw.page];
  for (const t of watched) await t.call("Network.enable");
  await raw.page.eval(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    return true;
  });
  await setSettings(raw.page, { protectedSites: ["net-keep.localhost"] });
  await withTabs(raw, url, ["net-a.localhost", "net-keep.localhost"], async () => {
    await sweepMsg(raw, "sleepOthers");
    await sweepMsg(raw, "runSweep");
    await new Promise((r) => setTimeout(r, 1500));
  });
  for (const t of watched) {
    for (const e of t.events) {
      if (e.method !== "Network.requestWillBeSent") continue;
      const u = e.params.request.url;
      if (u.startsWith(`chrome-extension://${raw.extId}`) || u.startsWith("data:")) continue;
      external.push(u);
    }
  }
  assert(
    external.length === 0,
    `made ${external.length} external request(s): ${external.slice(0, 5).join(", ")}`,
  );
}, { raw: true });

test("the upgrade offer matches whether payment is configured", async ({ page }) => {
  await page.reload();
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    hidden: document.getElementById("btn-upgrade").hidden,
    locked: document.getElementById("pro-locked").textContent,
    configured: chrome.runtime.getManifest().content_scripts !== undefined,
  }));
  if (state.configured) {
    assert(!state.hidden, "payment is configured but no upgrade was offered");
  } else {
    // Offering to take money through a flow that cannot complete is worse
    // than not offering at all.
    assert(state.hidden, "offered a purchase through a flow that cannot complete");
    assert(
      state.locked.includes("coming soon"),
      `unexpected locked copy: "${state.locked}"`,
    );
  }
});

// --- runner ---

export async function run() {
  const pkgVersion = JSON.parse(await readFile("package.json", "utf8")).version;

  await rm(profile, { recursive: true, force: true });
  // Local fixture site: <anything>.localhost resolves to loopback in Chrome.
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>${req.headers.host}</title><h1>${req.headers.host}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = (host) => `http://${host}:${server.address().port}/`;
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1000, height: 800 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  });

  const failures = [];
  const skipped = [];
  const rawChromes = {}; // "shipped" (no tab access) and "granted"
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extId = new URL(worker.url()).host;
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await page.goto(`chrome-extension://${extId}/options/options.html`);

    const ctx = { page, context, extId, worker, pkgVersion, url, raw: undefined };
    for (const { name, fn, liveExtPay, raw, tabAccess } of tests) {
      if (liveExtPay && !runLive) {
        skipped.push(name);
        console.log(`  SKIP  ${name} (hits ExtensionPay's live API)`);
        continue;
      }
      try {
        // Each test starts from a clean slate so ordering never matters.
        const reset = async () => {
          await chrome.storage.local.clear();
          await chrome.storage.sync.clear();
          if (chrome.storage.session) await chrome.storage.session.clear();
          return true;
        };
        await page.evaluate(reset);
        if (raw) {
          const variant = tabAccess === "granted" ? "granted" : "shipped";
          rawChromes[variant] ??= variant === "granted"
            ? await launchRaw(await grantedCopy(), "raw-granted")
            : await launchRaw(dist, "raw");
          await rawChromes[variant].page.eval(reset);
          ctx.raw = rawChromes[variant];
        }
        await fn(ctx);
        console.log(`  PASS  ${name}`);
      } catch (error) {
        if (error instanceof Skip) {
          skipped.push(name);
          console.log(`  SKIP  ${name} (${error.message})`);
          continue;
        }
        failures.push({ name, error });
        console.log(`  FAIL  ${name}\n        ${error.message}`);
      }
    }
    if (consoleErrors.length) {
      console.log("\n  console errors:");
      for (const e of consoleErrors) console.log(`    ${e}`);
    }
  } finally {
    for (const r of Object.values(rawChromes)) await r.close();
    await rm(distGranted, { recursive: true, force: true });
    await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
  }

  const ran = tests.length - skipped.length;
  console.log(
    `\n${ran - failures.length}/${ran} e2e tests passed` +
      (skipped.length ? ` (${skipped.length} skipped)` : ""),
  );
  // The release job refuses to publish unless this file says this exact
  // version ran every test, skipped none, and failed none.
  if (process.env.E2E_RESULTS) {
    await writeFile(process.env.E2E_RESULTS, `${JSON.stringify({
      version: pkgVersion,
      total: tests.length,
      passed: ran - failures.length,
      failed: failures.map((f) => f.name),
      skipped,
    }, null, 2)}\n`);
  }
  if (failures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await run();
