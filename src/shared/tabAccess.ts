// Optional "tabs" permission: lets TabNap read tab addresses.
//
// Idle sleeping never needs it: last-used time, pinned, audible, grouped and
// discard all work without it. Only features that depend on *which site* a
// tab shows need it: protected sites, Pro per-site timers, and "never sleep
// this site" in the popup. So it is requested the first time someone uses one
// of those, from the options page (a permission prompt opened from the popup
// closes the popup before it can answer).
const TAB_ACCESS: chrome.permissions.Permissions = { permissions: ["tabs"] };

export async function hasTabAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(TAB_ACCESS);
  } catch {
    return false;
  }
}

/**
 * Must be the first await in a click/submit handler: Chrome only shows the
 * prompt during a user gesture. Resolves true at once if already granted.
 */
export async function requestTabAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request(TAB_ACCESS);
  } catch {
    return false;
  }
}

export const TAB_ACCESS_EXPLAINED =
  "TabNap needs permission to see tab addresses to know which tabs belong to a protected site. Addresses are only checked on your device, never stored or sent.";
