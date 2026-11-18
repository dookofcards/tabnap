// Usage-limit recovery for Claude Code runs in GitHub Actions.
// Identical copies live in dookofcards/crumbsweep and extension-factory (keep in sync).
//
// Layer 1 (in the workflow, not here): the Claude step runs with
// {"autoContinueAtUsageLimit": true}, so a limit that resets before the
// step's timeout is waited out inside the same session: true continuation.
//
// Layer 2 (this script), when the step still fails:
//   node tools/usage-limit.mjs handle --workflow <file.yml> --attempt <n>
//        --origin-run <id> --inputs '<json>' [--execution-file <path>]
//        [--notify-issue <n>]
//     If the failure was a usage limit: commits the working tree to
//     resume/<workflow>-<origin-run>, writes a marker on branch
//     automation/resume, and enables resume.yml. After 3 attempts it stops
//     and tells the maintainer instead. Any other failure: does nothing.
//
//   node tools/usage-limit.mjs dispatch-due      (run by resume.yml)
//     Re-dispatches every marker whose reset time has passed, deletes it,
//     and disables resume.yml once nothing is pending.
//
// Uses GH_TOKEN (the workflow token) for everything, never the token the
// Claude action leaves in the git remote: the action revokes that one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const MAX_ATTEMPTS = 3;
const MARKER_BRANCH = "automation/resume";
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const gh = (...args) => run("gh", args);
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** Finds a usage-limit message and, if present, when the limit resets. */
export function classify(text) {
  const limited = /usage limit|limit reached|hit your (?:usage |weekly |session )?limit|rate[ _-]?limit(?:ed)?|out of (?:extra )?usage|resets? (?:at|in|on)\b/i.test(text);
  if (!limited) return { limited: false };
  const now = Date.now();
  let resetAt;
  const epoch = text.match(/limit[^|\n]{0,80}\|(\d{10})\b/i) ?? text.match(/"resets?_?at"\s*:\s*"?(\d{10})/i);
  if (epoch) resetAt = Number(epoch[1]) * 1000;
  const iso = !resetAt && text.match(/resets?[^"\n]{0,20}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)/i);
  if (iso) resetAt = Date.parse(iso[1]);
  const rel = !resetAt && text.match(/resets? in (\d+)\s*(h|hour|hours|m|min|minutes)\b/i);
  if (rel) resetAt = now + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3600e3 : 60e3);
  // Unknown or implausible: retry in an hour. The resumer re-checks anyway.
  if (!resetAt || resetAt < now || resetAt > now + 8 * 864e5) resetAt = now + 3600e3;
  return { limited: true, resetAt: new Date(resetAt + 5 * 60e3).toISOString() }; // +5 min margin
}

/**
 * Only the end of the run decides. The execution file also holds every web
 * page and tool output the agent saw, and those can mention "rate limit"
 * without the run having hit one.
 */
export function endOfRun(raw) {
  try {
    const msgs = JSON.parse(raw);
    if (Array.isArray(msgs)) {
      const result = [...msgs].reverse().find((m) => m?.type === "result");
      const tail = msgs.slice(-2).filter((m) => m?.type !== "user"); // user turns carry tool output
      return JSON.stringify(result ? [result, ...tail] : tail);
    }
  } catch { /* not JSON: fall through */ }
  return raw.slice(-2000);
}

function ensureMarkerBranch() {
  try {
    gh("api", `repos/${repo}/git/ref/heads/${MARKER_BRANCH}`);
  } catch {
    const main = gh("api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha");
    gh("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${MARKER_BRANCH}`, "-f", `sha=${main}`);
  }
}

function handle() {
  const workflow = opt("--workflow");
  const attempt = Number(opt("--attempt") ?? 0);
  const originRun = opt("--origin-run");
  const inputs = JSON.parse(opt("--inputs") ?? "{}");
  const file = opt("--execution-file");
  const notifyIssue = opt("--notify-issue");
  const raw = file && existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "";
  const verdict = classify(endOfRun(raw));
  if (!verdict.limited) {
    console.log("Not a usage-limit failure; no resume scheduled.");
    return;
  }

  if (attempt + 1 > MAX_ATTEMPTS) {
    const body = [
      `The \`${workflow}\` run kept hitting the Claude usage limit and has been resumed ${MAX_ATTEMPTS} times, so it has stopped trying.`,
      "",
      `Its last work in progress is saved on branch \`resume/${workflow.replace(/\.yml$/, "")}-${originRun}\`.`,
      "To continue later, run the workflow by hand from the Actions tab (its inputs accept that branch), or ask Claude Code locally to pick it up.",
    ].join("\n");
    if (notifyIssue) gh("issue", "comment", notifyIssue, "--repo", repo, "--body", body);
    else gh("issue", "create", "--repo", repo, "--title", `Paused: ${workflow} hit the Claude usage limit ${MAX_ATTEMPTS} times`, "--body", body, "--assignee", process.env.GITHUB_REPOSITORY_OWNER);
    console.log("Gave up after the attempt cap; the maintainer was told.");
    return;
  }

  // 1. Checkpoint the working tree, authenticated with the workflow token.
  const checkpoint = `resume/${workflow.replace(/\.yml$/, "")}-${originRun}`;
  const git = (...args) => run("git", ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", ...args]);
  git("add", "-A");
  try { git("commit", "-q", "-m", `WIP checkpoint: paused at the Claude usage limit (attempt ${attempt + 1})`); } catch { /* nothing new */ }
  git("-c", "http.https://github.com/.extraheader=", "push", "--force", "-q",
    `https://x-access-token:${token}@github.com/${repo}.git`, `HEAD:refs/heads/${checkpoint}`);

  // 2. Marker for resume.yml.
  ensureMarkerBranch();
  const marker = { workflow, resumeAfter: verdict.resetAt, attempt: attempt + 1, originRun, checkpoint, inputs };
  const path = `pending/${workflow.replace(/\.yml$/, "")}-${originRun}.json`;
  let sha = [];
  try { sha = ["-f", `sha=${gh("api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(MARKER_BRANCH)}`, "--jq", ".sha")}`]; } catch { /* new */ }
  gh("api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=Schedule resume of ${workflow} after ${verdict.resetAt}`,
    "-f", `content=${Buffer.from(JSON.stringify(marker, null, 2)).toString("base64")}`, "-f", `branch=${MARKER_BRANCH}`, ...sha);

  // 3. Wake the resumer (it disables itself when nothing is pending).
  gh("workflow", "enable", "resume.yml", "--repo", repo);
  console.log(`Usage limit: checkpointed to ${checkpoint}; resume ${attempt + 1}/${MAX_ATTEMPTS} scheduled after ${verdict.resetAt}.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync("node", ["-e", `require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, ${JSON.stringify(`Paused at the Claude usage limit. Work saved to \`${checkpoint}\`; resume ${attempt + 1}/${MAX_ATTEMPTS} scheduled after ${verdict.resetAt}.\n`)})`]);
  }
}

function dispatchDue() {
  let files = [];
  try {
    files = JSON.parse(gh("api", `repos/${repo}/contents/pending?ref=${encodeURIComponent(MARKER_BRANCH)}`));
  } catch { /* no branch or no folder: nothing pending */ }
  let remaining = 0;
  for (const f of files.filter((x) => x.name.endsWith(".json"))) {
    const m = JSON.parse(Buffer.from(JSON.parse(gh("api", `repos/${repo}/contents/${f.path}?ref=${encodeURIComponent(MARKER_BRANCH)}`)).content, "base64").toString("utf8"));
    if (Date.parse(m.resumeAfter) > Date.now()) { remaining++; console.log(`waiting: ${f.name} until ${m.resumeAfter}`); continue; }
    const fields = { ...m.inputs, resume_checkpoint: m.checkpoint, attempt: String(m.attempt), origin_run: String(m.originRun) };
    gh("workflow", "run", m.workflow, "--repo", repo, "--ref", "main", ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`]));
    gh("api", "-X", "DELETE", `repos/${repo}/contents/${f.path}`, "-f", `message=Resumed ${m.workflow} (attempt ${m.attempt})`, "-f", `sha=${f.sha}`, "-f", `branch=${MARKER_BRANCH}`);
    console.log(`resumed: ${m.workflow} from ${m.checkpoint} (attempt ${m.attempt}/${MAX_ATTEMPTS})`);
  }
  if (remaining === 0) {
    gh("workflow", "disable", "resume.yml", "--repo", repo);
    console.log("Nothing pending; resume.yml disabled until the next usage-limit pause.");
  }
}

const cmd = process.argv[2];
if (cmd === "handle") handle();
else if (cmd === "dispatch-due") dispatchDue();
else if (cmd === "classify") console.log(JSON.stringify(classify(endOfRun(readFileSync(process.argv[3], "utf8")))));
else if (cmd) { console.error(`unknown command ${cmd}`); process.exit(1); }
