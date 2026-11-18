import {
  DEFAULT_IDLE_MINUTES,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
} from "./constants.ts";

const SETTINGS_KEY = "settings";

export interface SiteTimeout {
  host: string;
  minutes: number;
}

export interface Settings {
  /** Minutes without use before a tab is put to sleep. */
  idleMinutes: number;
  paused: boolean;
  skipPinned: boolean;
  skipAudible: boolean;
  skipGrouped: boolean;
  /** Hostnames that never sleep. Free keeps the first 5; Pro is unlimited. */
  protectedSites: string[];
  /** Pro: custom idle time per site. */
  siteTimeouts: SiteTimeout[];
  /** Pro: only sleep tabs while at least this many tabs are open (0 = always). */
  minOpenTabs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  idleMinutes: DEFAULT_IDLE_MINUTES,
  paused: false,
  skipPinned: true,
  skipAudible: true,
  skipGrouped: false,
  protectedSites: [],
  siteTimeouts: [],
  minOpenTabs: 0,
};

export function normalizeSettings(saved: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  const minutes = Number.isFinite(s.idleMinutes) ? Math.round(s.idleMinutes) : DEFAULT_IDLE_MINUTES;
  s.idleMinutes = Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, minutes));
  s.protectedSites = Array.isArray(s.protectedSites) ? s.protectedSites : [];
  s.siteTimeouts = Array.isArray(s.siteTimeouts) ? s.siteTimeouts : [];
  s.minOpenTabs = Number.isFinite(s.minOpenTabs) ? Math.max(0, Math.round(s.minOpenTabs)) : 0;
  return s;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}
