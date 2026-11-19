// Glue between the pure policy and chrome.tabs. Reads everything fresh.
import { hasFeature } from "../shared/features.ts";
import { getSettings } from "../shared/settings.ts";
import { pickTabsToSleep } from "./sleeper.ts";

const STATS_KEY = "stats";

/**
 * TabNap's own open pages (settings, popup opened in a tab). Without the
 * optional "tabs" permission their addresses are hidden too, so they're found
 * through runtime.getContexts(), which needs no permission.
 */
async function ownTabIds(): Promise<Set<number>> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
    return new Set(contexts.map((c) => c.tabId).filter((id) => id >= 0));
  } catch {
    return new Set();
  }
}

export async function sleepTabs(mode: "idle" | "others"): Promise<number> {
  const [settings, pro, tabs, own] = await Promise.all([
    getSettings(),
    hasFeature("unlimitedProtectedSites"),
    chrome.tabs.query({}),
    ownTabIds(),
  ]);
  const candidates = tabs.filter((t) => t.id === undefined || !own.has(t.id));
  const ids = pickTabsToSleep(candidates, { now: Date.now(), settings, pro, mode });
  let slept = 0;
  for (const id of ids) {
    try {
      const result = await chrome.tabs.discard(id);
      if (result?.discarded) slept += 1;
    } catch {
      // tab closed in the meantime
    }
  }
  if (slept > 0) {
    const stored = await chrome.storage.local.get(STATS_KEY);
    const total = Number((stored[STATS_KEY] as { slept?: number } | undefined)?.slept ?? 0);
    await chrome.storage.local.set({ [STATS_KEY]: { slept: total + slept } });
  }
  return slept;
}
