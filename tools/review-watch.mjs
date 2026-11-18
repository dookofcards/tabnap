// Daily Chrome Web Store review watcher (run by .github/workflows/review-watch.yml).
//
//   node tools/review-watch.mjs <status.json from `cws.mjs status --out`>
//
// 1. Records the status in release/store-status.json, committing only when it
//    changed, so the history of reviews lives in git.
// 2. Opens one GitHub issue (label `store-review`) per problem: a rejected
//    submission, a policy warning, or a takedown. The API exposes no reason, so
//    the issue asks the maintainer to paste it. Their comment starts
//    .github/workflows/store-fix.yml.
// 3. Closes open `store-review` issues once a newer version is live.
//
// Never logs anything but versions and states: this repo's logs are public.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const LABEL = "store-review";
const RECORD = "release/store-status.json";
const repo = process.env.GITHUB_REPOSITORY;
const owner = process.env.GITHUB_REPOSITORY_OWNER;

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const gh = (...args) => run("gh", args);

function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const status = JSON.parse(await readFile(process.argv[2], "utf8"));
const previous = await readFile(RECORD, "utf8").then(JSON.parse, () => null);
const summary = [];

// --- 1. record ---
const same = previous && JSON.stringify({ ...previous, checkedAt: 0 }) === JSON.stringify({ ...status, checkedAt: 0 });
if (!same) {
  await mkdir("release", { recursive: true });
  await writeFile(RECORD, `${JSON.stringify({ ...status, checkedAt: new Date().toISOString() }, null, 2)}\n`);
  const line = `published ${status.published?.version ?? "none"} (${status.published?.state ?? "-"}), ` +
    `submitted ${status.submitted?.version ?? "none"} (${status.submitted?.state ?? "-"})`;
  run("git", ["config", "user.name", "github-actions[bot]"]);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  run("git", ["add", RECORD]);
  run("git", ["commit", "-m", `Record store status: ${line}`]);
  run("git", ["push", "origin", "HEAD:main"]);
  summary.push(`Status changed and was recorded: ${line}`);
} else {
  summary.push("No change since the last check.");
}

// --- 2. alert ---
const problems = [];
if (status.submitted?.state === "REJECTED") {
  problems.push({ key: `v${status.submitted.version} rejected`, what: `Version ${status.submitted.version} was **rejected** in review.` });
}
if (status.warned) problems.push({ key: "policy warning", what: "The item has a **policy warning** and will be taken down if it isn't resolved." });
if (status.takenDown) problems.push({ key: "taken down", what: "The item has been **taken down** for a policy violation." });

if (problems.length) gh("label", "create", LABEL, "--color", "D93F0B", "--description", "Chrome Web Store review problem", "--force");
for (const { key, what } of problems) {
  const title = `Store review: ${key}`;
  const existing = gh("issue", "list", "--repo", repo, "--label", LABEL, "--state", "all",
    "--search", `"${title}" in:title`, "--json", "number,title", "--jq", `map(select(.title == "${title}")) | .[0].number // empty`);
  if (existing) {
    summary.push(`Issue #${existing} already tracks: ${key}`);
    continue;
  }
  const body = [
    what,
    "",
    "The Chrome Web Store API reports the state but **not the reason**. Google sends the reason by email and shows it in the Developer Dashboard (item → Status).",
    "",
    "**To start the automatic fix:** paste the reason as a comment on this issue. Then:",
    "1. Claude fixes the cause, bumps the version, updates CHANGELOG, and runs the tests.",
    "2. If the fix changes the extension's purpose, permissions or privacy claims, it stops and opens a PR for you to decide instead.",
    "3. Otherwise it tags the new version, and the release workflow runs the full gate (Free + Pro + test purchase) before resubmitting.",
    "",
    "This issue closes itself when a newer version is live.",
  ].join("\n");
  const url = gh("issue", "create", "--repo", repo, "--title", title, "--body", body, "--label", LABEL, "--assignee", owner);
  summary.push(`Opened ${url} for: ${key}`);
}

// --- 3. resolve ---
const live = status.published?.state === "PUBLISHED" ? status.published.version : null;
if (live && !status.warned && !status.takenDown && status.submitted?.state !== "REJECTED") {
  const open = JSON.parse(gh("issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--json", "number,title"));
  for (const { number, title } of open) {
    const m = title.match(/v(\d+(?:\.\d+)*) rejected/);
    if (m && !newer(live, m[1])) continue; // the fix isn't live yet
    gh("issue", "close", String(number), "--repo", repo, "--comment", `Resolved: version ${live} is live and the item has no warnings.`);
    summary.push(`Closed #${number} (${live} is live).`);
  }
}

console.log(summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY,
    `### Store status\n\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\`\n\n${summary.map((s) => `- ${s}`).join("\n")}\n`,
    { flag: "a" });
}
