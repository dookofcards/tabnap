// Deterministic guard between an AI-written fix and a release.
//
//   node tools/fix-guard.mjs <base-ref> <fix-ref>
//
// Prints JSON {ok, version, reasons[]}. ok=false means a human decides:
// the fix touches the extension's purpose, permissions, privacy claims or
// CI, or it isn't a well-formed release (version not bumped, no CHANGELOG).
// This is code, not a prompt, so the agent can't talk its way past it.
import { execFileSync } from "node:child_process";

const [base, fix] = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const show = (ref, path) => {
  try { return git("show", `${ref}:${path}`); } catch { return null; }
};

const reasons = [];
const changed = git("diff", "--name-only", `${base}...${fix}`).split("\n").filter(Boolean);

// Files that carry policy, privacy or pipeline meaning: any change needs a human.
const SENSITIVE = [
  /^\.github\//, /^docs\/privacy-policy\.html$/, /^LICENSE$/, /^NOTICE$/,
  /^tools\/(cws|fix-guard|review-watch|usage-limit)\.mjs$/,
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

// Purpose: the store short description and the single-purpose statement.
const desc = (src) => src?.match(/EXTENSION_DESCRIPTION\s*=\s*([\s\S]*?);/)?.[1];
if (desc(show(base, "src/shared/constants.ts")) !== desc(show(fix, "src/shared/constants.ts"))) {
  reasons.push("changes EXTENSION_DESCRIPTION (the store's short description)");
}
const purpose = (src) => src?.match(/## Single-purpose description[\s\S]*?(?=\n## )/)?.[0];
if (purpose(show(base, "STORE_LISTING.md")) !== purpose(show(fix, "STORE_LISTING.md"))) {
  reasons.push("changes the single-purpose description");
}

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

console.log(JSON.stringify({ ok: reasons.length === 0, version: v1, changed, reasons }));
