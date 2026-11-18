# TabNap: Chrome Web Store submission pack

Paste these into the Developer Dashboard. Limits are checked below.

## Name (≤75)
TabNap: Sleep Idle Tabs

## Short description (≤132; equals the manifest description)
Puts tabs you haven't touched to sleep with Chrome's built-in tab discard. No access to your pages, no network, no tracking.

## Category
Productivity (Tools)

## Detailed description
TabNap puts tabs you haven't used for a while to sleep, so Chrome can free their memory. A sleeping tab stays in your tab strip and reloads when you click it.

HOW IT WORKS
TabNap checks once a minute. Any tab idle longer than the time you choose is put to sleep using Chrome's own tab discard feature. You can also sleep every other tab with one click.

WHAT IT NEVER TOUCHES (all configurable)
• The tab you are looking at
• Pinned tabs
• Tabs playing sound
• Tabs in a tab group
• Sites on your protected list

PRIVATE BY DESIGN
• No access to the content of your pages: no host permissions, no content scripts on websites
• The free version makes no network requests of any kind
• No analytics, no ads, no accounts, no remote code
• Settings stay on your device (Chrome may sync them across your own devices if you use Chrome sync)

FREE
• Idle timer (1 minute to 24 hours)
• Pause button and "Sleep all other tabs now"
• Skip pinned, audible and grouped tabs
• Up to 5 protected sites

PRO (one-time purchase, no subscription)
• Unlimited protected sites
• A separate idle timer for individual sites
• "Only sleep tabs when N or more tabs are open"
Pro is bought through ExtensionPay (payments by Stripe) only if you click "Unlock Pro". Everything in the free tier stays free.

Open source (MIT): https://github.com/dookofcards/tabnap

## Single purpose
TabNap puts idle browser tabs to sleep to free memory, using Chrome's built-in tab discard.

## Permission justifications (each ≤1,000)
- **tabs:** Needed to read each open tab's address, last-used time and pinned/audible/grouped state so TabNap can decide which tabs are idle and which sites the user protected, and to ask Chrome to discard those tabs. Addresses are used in memory only: never stored, logged or transmitted. TabNap cannot read page content.
- **storage:** Saves the user's settings (idle time, protected sites, Pro rules), a local counter of tabs put to sleep, and a local flag that Pro is unlocked. Nothing is sent anywhere.
- **alarms:** A once-a-minute timer that wakes the background service worker to check for idle tabs. Service workers are stopped by Chrome when idle, so a timer is required.
- **Content script on https://extensionpay.com/\*:** Only used after the user clicks "Unlock Pro". It lets the ExtensionPay library confirm the purchase to the extension. It does not run on any other site.
- **Host permissions:** none requested.

## Remote code
No, all code is bundled.

## Privacy practices form
- Single purpose and permission justifications: as above.
- Data collection: tick nothing under "personally identifiable information", "health", "financial and payment information", "authentication information", "personal communications", "location", "web history", "user activity" or "website content". (Payment details are entered on extensionpay.com / Stripe and never reach the extension.)
- Certifications (tick all three): I do not sell or transfer user data to third parties outside approved use cases; I do not use or transfer user data for purposes unrelated to the item's single purpose; I do not use or transfer user data to determine creditworthiness or for lending purposes.
- Note for the reviewer: reading tab addresses is local-only and transient, hence "web history" is not collected.

## URLs
- Privacy policy: https://dookofcards.github.io/tabnap/privacy-policy.html
- Homepage: https://dookofcards.github.io/tabnap/
- Support: https://github.com/dookofcards/tabnap/issues

## Assets (`store-assets/`)
- Screenshots (1280×800): `screenshot-1-settings.png`, `screenshot-2-protected-sites.png`, `screenshot-3-pro-locked.png`, `screenshot-4-popup.png`, `screenshot-5-pro-unlocked.png`
- Small promo tile (440×280): `promo-440x280.png`
- Marquee (1400×560): `promo-1400x560.png`
- Icon (128×128): `src/icons/icon128.png` (also `docs/icon128.png`)
- GitHub social preview (optional): `github-social-1280x640.png`

## Reviewer test instructions
1. Install and open a few websites in separate tabs, then open the TabNap popup and click "Sleep all other tabs now". The background tabs become dimmed/discarded; click one and it reloads. The active tab never sleeps.
2. Open settings (gear icon). Set the idle time to 1 minute, wait about a minute, and untouched background tabs sleep automatically.
3. Add protected sites: the 6th is refused on the Free tier with an explanation. The "Pro" section is visibly locked and explained.
4. To see Pro without paying: open the options page, DevTools console, and run
   `chrome.storage.local.set({ proEntitlement: { active: true, checkedAt: Date.now() } })`, then reload. Pro fields unlock (per-site timers, tab-count threshold, unlimited protected sites). Reset with `active: false`. (This only unlocks on your own copy; real purchases go through ExtensionPay.)
5. In DevTools → Network for the service worker, the free tier makes no requests.
