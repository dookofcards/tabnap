// Glue between the pure policy and chrome.tabs. Reads everything fresh.
import { hasFeature } from "../shared/features.ts";
import { getSettings } from "../shared/settings.ts";
import { pickTabsToSleep } from "./sleeper.ts";

const STATS_KEY = "stats";

export async function sleepTabs(mode: "idle" | "others"): Promise<number> {
  const [settings, pro, tabs] = await Promise.all([
    getSettings(),
    hasFeature("unlimitedProtectedSites"),
    chrome.tabs.query({}),
  ]);
  const ids = pickTabsToSleep(tabs, { now: Date.now(), settings, pro, mode });
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
