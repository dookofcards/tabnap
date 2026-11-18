# TabNap — notes for Claude

Manifest V3 Chrome extension that puts idle tabs to sleep with Chrome's
built-in `chrome.tabs.discard`. Free core, optional one-time "Pro" unlock sold
through ExtensionPay. Solo side project (handle **dookofcards**, business
name **Extension Tools**): prefer simple, low-maintenance solutions.

Born in the extension factory (`ideas/2026-W47-tabnap.md` in the factory
repo). The reference implementation is CrumbSweep; its Hard rules and Release
standard apply here unchanged. In short:

## Hard rules

1. **Releases are autonomous, money is not.** Never enter a real card or pay
   in live mode, use a Stripe live key, force-push, delete or overwrite a
   published tag/release, unpublish a store item, or change the ExtensionPay
   plan or price.
2. **Use the handle `dookofcards` only**, never a real name. CI logs are
   public: never log or screenshot Stripe/ExtensionPay page text (see
   `dumpPage` in `tools/e2e.mjs`).
3. **Never commit** `planning/`, `brief.md`, `.env*` or `*.zip`.
4. **Privacy claim:** "the free version makes no network requests of any
   kind." No analytics, remote config or update pings. The e2e test
   `a free user's session makes no external network requests` guards it.
5. **ExtPay.js is AGPLv3, the extension is MIT.** It ships as a separate,
   unmodified `dist/extpay/ExtPay.js`, never bundled. See `NOTICE`.
6. **Permissions stay `tabs`, `storage`, `alarms`**, with no host
   permissions. An e2e test fails if they grow. Adding any needs the
   maintainer.
7. **Copy stays in sync.** If behaviour changes, update `SUBMISSION.md`,
   `docs/privacy-policy.html` (bump the date), `docs/index.html` and
   `CHANGELOG.md` in the same commit.

## Commands

```sh
npm ci
npm run typecheck
npm test                    # vitest
npm run build               # → dist/
npm run package             # minified build + tabnap-v<version>.zip
CI=1 xvfb-run --auto-servernum node tools/e2e.mjs      # skips the 2 live ExtensionPay tests
# Release-gate mode (what release.yml runs):
npm run package && CI=1 RUN_PAYMENT_E2E=1 EXTPAY_DEV_PASSWORD=… E2E_RESULTS=e2e-results.json xvfb-run --auto-servernum node tools/e2e.mjs
```

Version comes from `package.json`; `build.mjs` stamps it into the manifest.
Name and short description live in `src/shared/constants.ts`.

## Design

- `src/core/sleeper.ts` is pure policy (which tabs sleep). `src/core/runner.ts`
  applies it with `chrome.tabs.discard`. The worker keeps no state in memory.
- Free vs Pro is enforced in `effectivePolicy()` (not only in the UI): Free
  honours the first 5 protected sites and ignores per-site timers and the
  tab-count threshold.
- No toolbar badge on purpose: updating it right after a discard crashed
  GPU-less Chrome in CI.

## e2e gotcha: discarding tabs under Playwright

Discarding a tab that Playwright is attached to intermittently crashes
Chrome (SEGV), with or without this extension. Tests that really discard tabs
(`{ raw: true }`) therefore run in a second Chrome launched directly and
driven over raw CDP, attached only to the extension's own service worker and
options page. Do not move them back to Playwright pages.

## Release standard

Same as CrumbSweep: a version ships only when typecheck, unit tests and every
e2e test (Free, Pro and the test-mode purchase, none skipped) pass on the
minified build. `tools/cws.mjs` refuses to upload otherwise. Up to 3 fix
attempts per failure, then contact the maintainer. Never add a bypass flag.
The `release` and `watch` workflow jobs run only once repo variable
`CWS_EXTENSION_ID` is set (after the first listing exists).
