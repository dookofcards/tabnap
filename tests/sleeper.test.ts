import { describe, expect, it } from "vitest";
import {
  effectivePolicy,
  hostMatches,
  hostOf,
  normalizeHost,
  pickTabsToSleep,
  type TabLike,
} from "../src/core/sleeper.ts";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../src/shared/settings.ts";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const s = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const tab = (id: number, url: string, idleMin: number, extra: Partial<TabLike> = {}): TabLike => ({
  id, url, lastAccessed: NOW - idleMin * MIN, ...extra,
});
const pick = (tabs: TabLike[], settings: Settings, pro = false, mode: "idle" | "others" = "idle") =>
  pickTabsToSleep(tabs, { now: NOW, settings, pro, mode });

describe("hostOf / normalizeHost / hostMatches", () => {
  it("handles http(s) only and strips www", () => {
    expect(hostOf("https://www.Example.com/a")).toBe("example.com");
    expect(hostOf("chrome://settings")).toBeNull();
    expect(hostOf("chrome-extension://abc/x.html")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
  it("normalizes user input", () => {
    expect(normalizeHost("https://News.Example.com/path")).toBe("news.example.com");
    expect(normalizeHost(" example.com ")).toBe("example.com");
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("nodots")).toBeNull();
  });
  it("matches subdomains but not look-alikes", () => {
    expect(hostMatches("a.example.com", "example.com")).toBe(true);
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("badexample.com", "example.com")).toBe(false);
  });
});

describe("pickTabsToSleep (idle mode)", () => {
  it("sleeps only tabs idle past the threshold", () => {
    const tabs = [tab(1, "https://a.com", 40), tab(2, "https://b.com", 10)];
    expect(pick(tabs, s({ idleMinutes: 30 }))).toEqual([1]);
  });
  it("never sleeps the active tab, discarded tabs, or non-web pages", () => {
    const tabs = [
      tab(1, "https://a.com", 99, { active: true }),
      tab(2, "https://b.com", 99, { discarded: true }),
      tab(3, "chrome://extensions", 99),
      tab(4, "https://c.com", 99, { autoDiscardable: false }),
    ];
    expect(pick(tabs, s())).toEqual([]);
  });
  it("respects pinned, audible and grouped toggles", () => {
    const tabs = [
      tab(1, "https://a.com", 99, { pinned: true }),
      tab(2, "https://b.com", 99, { audible: true }),
      tab(3, "https://c.com", 99, { groupId: 7 }),
      tab(4, "https://d.com", 99, { groupId: -1 }),
    ];
    expect(pick(tabs, s())).toEqual([3, 4]);
    expect(pick(tabs, s({ skipGrouped: true }))).toEqual([4]);
    expect(pick(tabs, s({ skipPinned: false, skipAudible: false }))).toEqual([1, 2, 3, 4]);
  });
  it("does nothing while paused", () => {
    expect(pick([tab(1, "https://a.com", 99)], s({ paused: true }))).toEqual([]);
  });
  it("skips tabs with no lastAccessed rather than guessing", () => {
    expect(pick([{ id: 1, url: "https://a.com" }], s())).toEqual([]);
  });
  it("protected sites never sleep, subdomains included", () => {
    const tabs = [tab(1, "https://mail.example.com", 99), tab(2, "https://other.com", 99)];
    expect(pick(tabs, s({ protectedSites: ["example.com"] }))).toEqual([2]);
  });
});

describe("Free vs Pro policy", () => {
  const many = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"];
  it("Free enforces only the first five protected sites", () => {
    expect(effectivePolicy(s({ protectedSites: many }), false).protectedSites).toHaveLength(5);
    expect(effectivePolicy(s({ protectedSites: many }), true).protectedSites).toHaveLength(7);
  });
  it("Free ignores per-site timers and the tab threshold", () => {
    const settings = s({
      idleMinutes: 30,
      siteTimeouts: [{ host: "a.com", minutes: 5 }],
      minOpenTabs: 10,
    });
    const tabs = [tab(1, "https://a.com", 10)];
    expect(pick(tabs, settings, false)).toEqual([]);
    // Pro: a.com has a 5 minute rule, and 1 tab < 10 threshold blocks it...
    expect(pick(tabs, settings, true)).toEqual([]);
    // ...until enough tabs are open.
    const crowd = [tab(1, "https://a.com", 10), ...Array.from({ length: 9 }, (_, i) => tab(10 + i, "https://z.com", 1))];
    expect(pick(crowd, settings, true)).toEqual([1]);
  });
  it("per-site timer can also lengthen the timeout", () => {
    const settings = s({ idleMinutes: 5, siteTimeouts: [{ host: "docs.com", minutes: 120 }] });
    const tabs = [tab(1, "https://docs.com", 60), tab(2, "https://x.com", 60)];
    expect(pick(tabs, settings, true)).toEqual([2]);
  });
});

describe("others mode (manual)", () => {
  it("ignores idle time and pause, still honours protection", () => {
    const tabs = [
      tab(1, "https://a.com", 0),
      tab(2, "https://keep.com", 0),
      tab(3, "https://b.com", 0, { pinned: true }),
      tab(4, "https://c.com", 0, { active: true }),
    ];
    expect(pick(tabs, s({ paused: true, protectedSites: ["keep.com"] }), false, "others")).toEqual([1]);
  });
});

describe("normalizeSettings", () => {
  it("clamps and repairs bad stored values", () => {
    expect(normalizeSettings({ idleMinutes: 0 }).idleMinutes).toBe(1);
    expect(normalizeSettings({ idleMinutes: 99999 }).idleMinutes).toBe(1440);
    expect(normalizeSettings({ idleMinutes: NaN }).idleMinutes).toBe(30);
    expect(normalizeSettings({ minOpenTabs: -4 }).minOpenTabs).toBe(0);
    expect(normalizeSettings({ protectedSites: "x" as unknown as string[] }).protectedSites).toEqual([]);
  });
});

// Without the optional "tabs" permission Chrome leaves tab.url undefined.
describe("without tab-address access (optional tabs permission not granted)", () => {
  const hidden = (id: number, idleMin: number, extra: Partial<TabLike> = {}): TabLike => ({
    id, lastAccessed: NOW - idleMin * MIN, ...extra,
  });

  it("still sleeps idle tabs when there are no site rules", () => {
    expect(pick([hidden(1, 120), hidden(2, 1)], s({ idleMinutes: 30 }))).toEqual([1]);
  });

  it("still honours pinned, audible, grouped and active without addresses", () => {
    const tabs = [
      hidden(1, 120, { pinned: true }),
      hidden(2, 120, { audible: true }),
      hidden(3, 120, { groupId: 4 }),
      hidden(4, 120, { active: true }),
      hidden(5, 120),
    ];
    expect(pick(tabs, s({ idleMinutes: 30, skipPinned: true, skipAudible: true, skipGrouped: true }))).toEqual([5]);
  });

  it("sleep-others works without addresses", () => {
    expect(pick([hidden(1, 0), hidden(2, 0, { active: true })], s(), false, "others")).toEqual([1]);
  });

  it("leaves hidden tabs awake when protected sites exist (can't tell which tab is protected)", () => {
    expect(pick([hidden(1, 120), hidden(2, 120)], s({ idleMinutes: 30, protectedSites: ["mail.example.com"] }))).toEqual([]);
    expect(pick([hidden(1, 0)], s({ protectedSites: ["mail.example.com"] }), false, "others")).toEqual([]);
  });

  it("leaves hidden tabs awake when Pro per-site timers exist", () => {
    const settings = s({ idleMinutes: 30, siteTimeouts: [{ host: "docs.example.com", minutes: 240 }] });
    expect(pick([hidden(1, 120)], settings, true)).toEqual([]);
  });

  it("Free ignores per-site timers, so hidden tabs sleep normally on Free", () => {
    const settings = s({ idleMinutes: 30, siteTimeouts: [{ host: "docs.example.com", minutes: 240 }] });
    expect(pick([hidden(1, 120)], settings, false)).toEqual([1]);
  });

  it("with addresses visible, behaviour is unchanged", () => {
    const tabs = [tab(1, "https://mail.example.com/", 120), tab(2, "https://news.example.com/", 120)];
    expect(pick(tabs, s({ idleMinutes: 30, protectedSites: ["mail.example.com"] }))).toEqual([2]);
  });
});
