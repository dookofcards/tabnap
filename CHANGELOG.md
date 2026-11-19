# Changelog

## 1.0.1 — 2026-11-18

- TabNap now installs with only the storage and alarms permissions. It
  asks to see tab addresses only when you protect a site or set a per-site
  timer, and idle tabs go to sleep without it.
- If that permission is declined or withdrawn, protected sites are put on
  hold and TabNap leaves tabs awake rather than risk sleeping one. The
  settings page says so and offers an Allow button.
- TabNap never puts its own pages to sleep.

## 1.0.0 — 2026-11-18

First release.

- Puts idle tabs to sleep with Chrome's built-in tab discard after a time you choose.
- One-click "Sleep all other tabs now" from the popup.
- Never sleeps the active tab, pinned tabs, tabs playing sound, or tabs in groups (all optional).
- Protected sites that never sleep (Free: 5).
- Pro (one-time purchase): unlimited protected sites, per-site idle timers, and a tab-count threshold.
- No host access, no network requests in the free version, no tracking.
