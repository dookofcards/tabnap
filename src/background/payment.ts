// ExtensionPay integration — the only code in TabNap that touches the
// network, and it is unreachable until the user asks for it.
//
// Three constraints shaped this file:
//
// 1. "No network requests of any kind" is the headline privacy claim. ExtPay
//    is therefore never *called* until the user has clicked Upgrade — a free
//    user's browser opens no connection, which an e2e test asserts.
//
//    It is loaded at service-worker startup rather than on demand, because
//    MV3 only permits importScripts() during the worker's initial
//    evaluation; calling it later fails with ERR_FAILED. Loading is inert —
//    the file defines a function and nothing else runs in a worker context
//    (its only top-level side effect is guarded by `typeof window`).
//
// 2. ExtPay.js is AGPLv3 while TabNap is MIT. Shipping it as a discrete,
//    unmodified file keeps the two separable and identifiable rather than
//    melting AGPL code into an MIT bundle. See NOTICE.
//
// 3. The upstream sample registers a content script on every http(s) page.
//    That is unacceptable here — the extensionpay.com match is the only one
//    needed for payment callbacks, and it is the only one in our manifest.
import { EXTENSIONPAY_ID, paymentConfigured } from "../shared/constants.ts";
import { getEntitlement, setEntitlement } from "../shared/features.ts";

const PURCHASE_INITIATED_KEY = "purchaseInitiated";
/** Entitlement is cached; re-check at most weekly, never on every startup. */
const REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

interface ExtPayUser {
  paid: boolean;
  paidAt: string | Date | null;
  email: string | null;
}

interface ExtPayClient {
  getUser: () => Promise<ExtPayUser>;
  openPaymentPage: (planNickname?: string) => Promise<void>;
  onPaid: { addListener: (callback: (user: ExtPayUser) => void) => void };
  startBackground: () => void;
}

export async function hasInitiatedPurchase(): Promise<boolean> {
  const stored = await chrome.storage.local.get(PURCHASE_INITIATED_KEY);
  return stored[PURCHASE_INITIATED_KEY] === true;
}

async function markPurchaseInitiated(): Promise<void> {
  await chrome.storage.local.set({ [PURCHASE_INITIATED_KEY]: true });
}

let client: ExtPayClient | undefined;

/**
 * Builds the client from the global that serviceWorker.ts imported at
 * startup. Returns undefined if the script is absent, so a missing or
 * blocked file can never break tab sleeping — the part that actually matters.
 */
function loadClient(): ExtPayClient | undefined {
  if (client !== undefined) return client;
  if (!paymentConfigured()) return undefined;
  const global = self as unknown as { ExtPay?: (id: string) => ExtPayClient };
  if (global.ExtPay === undefined) return undefined;
  try {
    client = global.ExtPay(EXTENSIONPAY_ID);
    return client;
  } catch {
    return undefined;
  }
}

/**
 * Registers the payment-completed listener. Must be called synchronously
 * during the worker's initial evaluation: paying takes minutes, so the
 * worker has almost always been killed by the time extensionpay.com reports
 * success, and a listener added later misses the message that woke it.
 *
 * Deliberately not gated on hasInitiatedPurchase(). That check is async, so
 * gating on it would push registration past the first turn of the event loop
 * and reintroduce the same race. It costs nothing: registering a listener
 * opens no connection, and the message it waits for can only come from a
 * content script on extensionpay.com, which a user who never clicks Upgrade
 * never visits. The zero-network e2e test guards this.
 */
export function registerPaymentListeners(): void {
  if (!paymentConfigured()) return;
  const extpay = loadClient();
  if (extpay === undefined) return;
  extpay.startBackground();
  extpay.onPaid.addListener((user) => {
    void setEntitlement(user.paid === true);
  });
}

/** The one place a network connection is opened, from an explicit click. */
export async function beginUpgrade(): Promise<boolean> {
  if (!paymentConfigured()) return false;
  const extpay = loadClient();
  if (extpay === undefined) return false;
  await markPurchaseInitiated();
  // Listeners are already registered at startup; this only opens checkout.
  await extpay.openPaymentPage();
  return true;
}

/**
 * Re-checks a cached entitlement at most weekly. A network failure keeps the
 * cached answer: a paying user must not lose their features because their
 * wifi dropped.
 */
export async function revalidateEntitlement(force = false): Promise<void> {
  if (!paymentConfigured()) return;
  if (!(await hasInitiatedPurchase())) return;
  const entitlement = await getEntitlement();
  if (!force && Date.now() - entitlement.checkedAt < REVALIDATE_INTERVAL_MS) {
    return;
  }
  const extpay = loadClient();
  if (extpay === undefined) return;
  try {
    const user = await extpay.getUser();
    await setEntitlement(user.paid === true);
  } catch {
    // Offline, or ExtensionPay is down. Keep what we had.
  }
}
