# TabNap

A Manifest V3 Chrome extension that puts idle tabs to sleep using Chrome's
built-in tab discard. It needs only the `storage` and `alarms`
permissions, plus an optional `tabs` permission it asks for only when you
protect a site: no host access, no content scripts on websites, and the free
version makes no network requests.

- **Free:** idle timer, pause, "sleep all other tabs", skip pinned / audible /
  grouped tabs, up to 5 protected sites.
- **Pro (one-time, via ExtensionPay):** unlimited protected sites, per-site
  idle timers, and a tab-count threshold.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run package            # minified build + tabnap-v<version>.zip
CI=1 xvfb-run --auto-servernum node tools/e2e.mjs
```

See `CLAUDE.md` for the project rules. Privacy policy: `docs/privacy-policy.html`.

## License

MIT, © dookofcards. ExtPay.js (AGPLv3) ships as a separate unmodified file; see `NOTICE`.
