// Paid-tier capability checks. One one-time unlock turns on every Pro
// feature; the enum exists for call-site readability.
//
// The entitlement is cached in storage.local (device-local on purpose).
// Nothing here touches the network; payment lives behind an explicit user
// action (see background/payment.ts).
export type ProFeature =
  | "unlimitedProtectedSites"
  | "perSiteTimeouts"
  | "tabCountThreshold";

const ENTITLEMENT_KEY = "proEntitlement";

export interface Entitlement {
  active: boolean;
  /** Epoch ms of the last successful check; 0 means never checked. */
  checkedAt: number;
}

const NO_ENTITLEMENT: Entitlement = { active: false, checkedAt: 0 };

export async function getEntitlement(): Promise<Entitlement> {
  try {
    const stored = await chrome.storage.local.get(ENTITLEMENT_KEY);
    const saved = stored[ENTITLEMENT_KEY] as Partial<Entitlement> | undefined;
    if (saved === undefined) return NO_ENTITLEMENT;
    return {
      active: saved.active === true,
      checkedAt: typeof saved.checkedAt === "number" ? saved.checkedAt : 0,
    };
  } catch {
    // Storage unavailable: fall back to Free rather than granting access.
    return NO_ENTITLEMENT;
  }
}

export async function setEntitlement(active: boolean): Promise<void> {
  const entitlement: Entitlement = { active, checkedAt: Date.now() };
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: entitlement });
}

/** Async: the answer lives in storage and the worker's memory is ephemeral. */
export async function hasFeature(_feature: ProFeature): Promise<boolean> {
  return (await getEntitlement()).active;
}
