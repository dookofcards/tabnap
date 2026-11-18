import { describe, expect, it } from "vitest";
import { getEntitlement, hasFeature, setEntitlement } from "../src/shared/features.ts";
import { getSettings, updateSettings } from "../src/shared/settings.ts";

describe("entitlement", () => {
  it("is locked by default and unlocks once set", async () => {
    expect(await hasFeature("perSiteTimeouts")).toBe(false);
    await setEntitlement(true);
    expect(await hasFeature("perSiteTimeouts")).toBe(true);
    expect((await getEntitlement()).checkedAt).toBeGreaterThan(0);
    await setEntitlement(false);
    expect(await hasFeature("unlimitedProtectedSites")).toBe(false);
  });
});

describe("settings storage", () => {
  it("round-trips and normalizes", async () => {
    expect((await getSettings()).idleMinutes).toBe(30);
    await updateSettings({ idleMinutes: 12, protectedSites: ["a.com"] });
    const s = await getSettings();
    expect(s.idleMinutes).toBe(12);
    expect(s.protectedSites).toEqual(["a.com"]);
    await updateSettings({ idleMinutes: -5 });
    expect((await getSettings()).idleMinutes).toBe(1);
  });
});
