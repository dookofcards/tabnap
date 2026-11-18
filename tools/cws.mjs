// Chrome Web Store API V2 client — no dependencies, so it can be copied into
// any of the maintainer's extensions unchanged.
//
//   node tools/cws.mjs status [--out status.json]
//   node tools/cws.mjs release --zip <file> --results <e2e-results.json> [--dry-run]
//
// Env:
//   CWS_SERVICE_ACCOUNT_KEY       service-account JSON (GitHub secret), or
//   CWS_SERVICE_ACCOUNT_KEY_FILE  path to that JSON (local use)
//   CWS_PUBLISHER_ID              Developer Dashboard → Publisher → Settings
//   CWS_EXTENSION_ID              store item ID
//
// --dry-run authenticates, reads the live status, and runs every check that
// precedes an upload, then stops. It never uploads or publishes.
import { createSign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function env(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

async function loadKey() {
  const raw = process.env.CWS_SERVICE_ACCOUNT_KEY
    ?? (process.env.CWS_SERVICE_ACCOUNT_KEY_FILE
      ? await readFile(process.env.CWS_SERVICE_ACCOUNT_KEY_FILE, "utf8")
      : fail("set CWS_SERVICE_ACCOUNT_KEY or CWS_SERVICE_ACCOUNT_KEY_FILE"));
  const key = JSON.parse(raw);
  if (key.type !== "service_account") fail("key is not a service-account key");
  return key;
}

const b64url = (data) => Buffer.from(data).toString("base64url");

/** Service-account JWT → OAuth access token (RFC 7523), no SDK needed. */
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(key.private_key, "base64url");
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) fail(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function call(token, method, path, body, contentType) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404
      ? " (is the service account added under Account in the Developer Dashboard, and the publisher ID right?)"
      : "";
    fail(`${method} ${path} → ${res.status}: ${json.error?.message ?? text}${hint}`);
  }
  return json;
}

/** a > b for dotted numeric versions (Chrome's manifest version format). */
function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Reads manifest.json straight out of the zip, so we check what ships. */
function manifestFromZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) fail("not a zip file");
  let p = zip.readUInt32LE(eocd + 16);
  const count = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === "manifest.json") {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return JSON.parse((method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  fail("zip has no manifest.json at its root");
}

const versionOf = (rev) => rev?.distributionChannels?.[0]?.crxVersion;

function describe(status) {
  const pub = status.publishedItemRevisionStatus;
  const sub = status.submittedItemRevisionStatus;
  return {
    published: pub ? `${versionOf(pub)} (${pub.state})` : "none",
    submitted: sub ? `${versionOf(sub)} (${sub.state})` : "none",
    takenDown: status.takenDown === true,
    warned: status.warned === true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  const item = `/v2/publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_EXTENSION_ID")}`;
  const key = await loadKey();
  const token = await accessToken(key);
  console.log(`authenticated as ${key.client_email}`);

  const status = await call(token, "GET", `${item}:fetchStatus`);
  const info = describe(status);
  console.log("store status:", info);

  if (command === "status") {
    const out = option("--out");
    if (out) {
      const rev = (r) => (r ? { version: versionOf(r) ?? null, state: r.state } : null);
      await writeFile(out, `${JSON.stringify({
        itemId: status.itemId ?? env("CWS_EXTENSION_ID"),
        published: rev(status.publishedItemRevisionStatus),
        submitted: rev(status.submittedItemRevisionStatus),
        takenDown: status.takenDown === true,
        warned: status.warned === true,
      }, null, 2)}\n`);
    }
    return;
  }
  if (command !== "release") fail(`unknown command "${command}"`);

  const zipPath = option("--zip") ?? fail("--zip <file> is required");
  const zip = await readFile(zipPath);
  const manifest = manifestFromZip(zip);
  console.log(`package: ${zipPath} → ${manifest.name} ${manifest.version} (${zip.length} bytes)`);

  // Release gate: no upload unless the e2e run for *this* version passed
  // every test (Free and Pro, including the test-mode purchase) and skipped
  // none. There is deliberately no flag to bypass this.
  const resultsPath = option("--results") ?? fail("--results <e2e-results.json> is required");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  const gate = [];
  if (results.version !== manifest.version) gate.push(`results are for ${results.version}, package is ${manifest.version}`);
  if (results.failed?.length) gate.push(`failed: ${results.failed.join("; ")}`);
  if (results.skipped?.length) gate.push(`skipped: ${results.skipped.join("; ")}`);
  if (!(results.total > 0) || results.passed !== results.total) gate.push(`passed ${results.passed}/${results.total}`);
  if (gate.length) fail(`release gate closed:\n  ${gate.join("\n  ")}`);
  console.log(`release gate open: ${results.passed}/${results.total} e2e tests passed for ${results.version}, none skipped`);

  if (info.takenDown) fail("item is taken down; resolve it in the dashboard first");
  const live = versionOf(status.publishedItemRevisionStatus);
  if (live && !newer(manifest.version, live)) {
    fail(`package version ${manifest.version} is not newer than live ${live}`);
  }
  const pending = status.submittedItemRevisionStatus?.state;
  if (pending === "PENDING_REVIEW") {
    fail(`version ${versionOf(status.submittedItemRevisionStatus)} is still in review; cancel it in the dashboard or wait`);
  }

  if (flag("--dry-run")) {
    console.log(`DRY RUN: all checks passed. Would upload ${manifest.version} (live: ${live ?? "none"}) and submit with DEFAULT_PUBLISH. Nothing was sent.`);
    return;
  }

  console.log("uploading…");
  let upload = await call(token, "POST", `/upload${item}:upload`, zip, "application/zip");
  for (let i = 0; upload.uploadState === "IN_PROGRESS"; i++) {
    if (i >= 30) fail("upload still processing after 5 minutes");
    await sleep(10_000);
    const s = await call(token, "GET", `${item}:fetchStatus`);
    upload = { uploadState: s.lastAsyncUploadState, crxVersion: manifest.version };
  }
  if (upload.uploadState !== "SUCCEEDED") fail(`upload ended as ${upload.uploadState}`);
  console.log(`uploaded ${upload.crxVersion ?? manifest.version}`);

  // DEFAULT_PUBLISH: goes live on its own once review passes.
  const published = await call(
    token, "POST", `${item}:publish`,
    JSON.stringify({ publishType: "DEFAULT_PUBLISH" }), "application/json",
  );
  console.log(`submitted: ${published.state}`);
  for (const w of published.warningInfo?.warnings ?? []) console.warn("warning:", w);
}

await main();
