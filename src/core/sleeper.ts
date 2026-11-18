// Pure decision logic: which tabs should sleep right now. No chrome.* calls,
// so everything here is unit-tested directly.
import { FREE_PROTECTED_SITES } from "../shared/constants.ts";
import type { Settings } from "../shared/settings.ts";

export interface TabLike {
  id?: number;
  url?: string;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  discarded?: boolean;
  autoDiscardable?: boolean;
  groupId?: number;
  lastAccessed?: number;
}

/** Hostname for http(s) pages; null for everything else (never touched). */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const host = hostOf(/^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
  return host !== null && (host.includes(".") || host === "localhost") ? host : null;
}

/** A pattern matches its own host and any subdomain of it. */
export function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

export interface Policy {
  protectedSites: string[];
  siteTimeouts: Settings["siteTimeouts"];
  minOpenTabs: number;
}

/** Applies the Free limits when there is no entitlement. */
export function effectivePolicy(settings: Settings, pro: boolean): Policy {
  if (pro) {
    return {
      protectedSites: settings.protectedSites,
      siteTimeouts: settings.siteTimeouts,
      minOpenTabs: settings.minOpenTabs,
    };
  }
  return {
    protectedSites: settings.protectedSites.slice(0, FREE_PROTECTED_SITES),
    siteTimeouts: [],
    minOpenTabs: 0,
  };
}

export interface PickOptions {
  now: number;
  settings: Settings;
  pro: boolean;
  /** "idle": honour idle timers. "others": sleep every eligible non-active tab now. */
  mode: "idle" | "others";
}

export function pickTabsToSleep(tabs: TabLike[], opts: PickOptions): number[] {
  const { settings, now, mode } = opts;
  const policy = effectivePolicy(settings, opts.pro);
  if (mode === "idle") {
    if (settings.paused) return [];
    if (policy.minOpenTabs > 0 && tabs.length < policy.minOpenTabs) return [];
  }
  const picked: number[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.active || tab.discarded) continue;
    if (tab.autoDiscardable === false) continue;
    const host = hostOf(tab.url);
    if (host === null) continue;
    if (settings.skipPinned && tab.pinned) continue;
    if (settings.skipAudible && tab.audible) continue;
    if (settings.skipGrouped && tab.groupId !== undefined && tab.groupId >= 0) continue;
    if (policy.protectedSites.some((p) => hostMatches(host, p))) continue;
    if (mode === "idle") {
      if (tab.lastAccessed === undefined) continue;
      const rule = policy.siteTimeouts.find((r) => hostMatches(host, r.host));
      const minutes = rule ? rule.minutes : settings.idleMinutes;
      if (now - tab.lastAccessed < minutes * 60_000) continue;
    }
    picked.push(tab.id);
  }
  return picked;
}
