// Deterministic guard between an AI-written change and a release.
// Identical copy in every extension repo.
//
//   node tools/fix-guard.mjs <base-ref> <fix-ref> [--allow-listing]
//
// Prints JSON {ok, version, reasons[], listing{...}}. ok=false means a human
// decides: the change touches the extension's purpose, permissions, privacy
// claims or CI, or it isn't a well-formed release (version not bumped, no
// CHANGELOG). This is code, not a prompt, so the agent can't talk its way
// past it.
//
// --allow-listing (weekly improvement runs): the store name and short
// description may change without a human, within limits checked here:
// name <= 75 chars, description <= 132, at most one such change per 30 days
// (release/listing-history.json), no trademark symbols, no keyword stuffing.
// The single-purpose statement stays human-only.
import { execFileSync } from "node:child_process";

const [base, fix] = process.argv.slice(2);
const allowListing = process.argv.includes("--allow-listing");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const show = (ref, path) => {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
};

const reasons = [];
const changed = git("diff", "--name-only", `${base}...${fix}`).split("\n").filter(Boolean);

// Files that carry policy, privacy or pipeline meaning: any change needs a human.
const SENSITIVE = [
  /^\.github\//, /^docs\/privacy-policy\.html$/, /^LICENSE$/, /^NOTICE$/,
  /^tools\/(cws|fix-guard|review-watch|usage-limit|improve-data)\.mjs$/,
  /^release\/listing-history\.json$/,
];
for (const f of changed) if (SENSITIVE.some((re) => re.test(f))) reasons.push(`changes ${f}`);

// Manifest: compare only the fields that define what the extension may do.
const FIELDS = ["permissions", "optional_permissions", "host_permissions",
  "optional_host_permissions", "content_scripts", "externally_connectable",
  "web_accessible_resources", "content_security_policy"];
const m0 = JSON.parse(show(base, "src/manifest.template.json") ?? "{}");
const m1 = JSON.parse(show(fix, "src/manifest.template.json") ?? "{}");
for (const k of FIELDS) {
  if (JSON.stringify(m0[k]) !== JSON.stringify(m1[k])) reasons.push(`changes manifest "${k}"`);
}

// Store name and short description (src/shared/constants.ts).
// Parsed, never evaluated: this text comes from the agent's branch and the
// guard holds a GitHub token. Only string literals joined with + are
// accepted; anything else is reported as not a plain string.
const constant = (src, name) => {
  const start = src?.match(new RegExp(`\\b${name}(?:\\s*:\\s*string)?\\s*=`));
  if (!start) return undefined;
  // Scan: literal ( + literal )* ; with quotes respected, so a ";" inside
  // the text doesn't end it.
  let i = start.index + start[0].length, out = "";
  const skip = () => { while (/\s/.test(src[i] ?? "")) i++; };
  for (;;) {
    skip();
    const q = src[i];
    if (q !== '"' && q !== "'") return { notPlain: src.slice(start.index, start.index + 120) };
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") { out += src[i + 1] === "n" ? "\n" : src[i + 1]; i += 2; } else out += src[i++];
    }
    i++; // closing quote
    skip();
    if (src[i] === "+") { i++; continue; }
    if (src[i] === ";") return out;
    return { notPlain: src.slice(start.index, start.index + 120) };
  }
};
const c0 = show(base, "src/shared/constants.ts"), c1 = show(fix, "src/shared/constants.ts");
const name0 = constant(c0, "EXTENSION_NAME"), name1 = constant(c1, "EXTENSION_NAME");
const desc0 = constant(c0, "EXTENSION_DESCRIPTION"), desc1 = constant(c1, "EXTENSION_DESCRIPTION");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const listing = { nameChanged: !same(name0, name1), descriptionChanged: !same(desc0, desc1), name: name1, description: desc1 };
if (listing.nameChanged || listing.descriptionChanged) {
  if (typeof name1 !== "string" || typeof desc1 !== "string") {
    reasons.push("the store name or short description is no longer a plain string literal");
  } else if (!allowListing) {
    reasons.push("changes the store name or short description");
  } else {
    const problems = [];
    if (typeof name1 === "string" && name1.length > 75) problems.push(`name is ${name1.length} chars (max 75)`);
    if (typeof desc1 === "string" && desc1.length > 132) problems.push(`short description is ${desc1.length} chars (max 132)`);
    const text = `${name1 ?? ""} ${desc1 ?? ""}`;
    if (/[®™©]/.test(text)) problems.push("contains a trademark symbol");
    const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const counts = words.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
    const stuffed = [...counts].filter(([, n]) => n >= 3).map(([w]) => w);
    if (stuffed.length) problems.push(`repeats ${stuffed.join(", ")} 3+ times (keyword stuffing)`);
    if (((desc1 ?? "").match(/,/g) ?? []).length >= 5) problems.push("reads like a keyword list (5+ commas)");
    let history = { changes: [] };
    try { history = JSON.parse(show(base, "release/listing-history.json") ?? '{"changes":[]}'); } catch { /* keep empty */ }
    const last = history.changes.at(-1)?.at;
    if (last && Date.now() - Date.parse(last) < 30 * 864e5) problems.push(`the listing last changed ${last.slice(0, 10)}; at most once per 30 days`);
    for (const p of problems) reasons.push(`listing change: ${p}`);
  }
}

// Purpose: the single-purpose statement is human-only in every mode.
const purpose = (src) => src?.match(/## Single-purpose[\s\S]*?(?=\n## )/)?.[0];
for (const f of ["STORE_LISTING.md", "SUBMISSION.md"]) {
  if (purpose(show(base, f)) !== purpose(show(fix, f))) reasons.push(`changes the single-purpose statement in ${f}`);
}
// Dashboard-only listing parts the maintainer has to paste by hand.
listing.dashboardChanged = changed.filter((f) => /^(STORE_LISTING\.md|SUBMISSION\.md|store-assets\/)/.test(f));

// Well-formed release.
const v0 = JSON.parse(show(base, "package.json")).version;
const v1 = JSON.parse(show(fix, "package.json")).version;
const newer = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};
if (!newer(v1, v0)) reasons.push(`version ${v1} is not newer than ${v0}`);
if (!new RegExp(`^## ${v1.replaceAll(".", "\\.")} `, "m").test(show(fix, "CHANGELOG.md") ?? "")) {
  reasons.push(`CHANGELOG.md has no "## ${v1} " entry`);
}
if (git("merge-base", base, fix).trim() !== git("rev-parse", base).trim()) {
  reasons.push(`${fix} is not a fast-forward of ${base}`);
}

console.log(JSON.stringify({ ok: reasons.length === 0, version: v1, changed, reasons, listing }));
