// The build script injects these into manifest.json, so a rename happens
// here and nowhere else.
export const EXTENSION_NAME = "TabNap: Sleep Idle Tabs";
export const EXTENSION_DESCRIPTION =
  "Sleeps idle tabs with Chrome's built-in tab discard. Never reads your pages, no tracking. Free version makes no network requests.";

/** Outbound links shown in the UI. Nothing here is fetched at runtime. */
export const HOMEPAGE_URL = "https://dookofcards.github.io/tabnap/";
export const SUPPORT_URL = "https://github.com/dookofcards/tabnap/issues";

/**
 * ExtensionPay slug (the maintainer registers it at extensionpay.com).
 * While it is empty, payment is not configured: no upgrade UI is shown, no
 * payment code loads, and the extension makes no network requests at all.
 */
// Typed as string so comparing against "" stays legal once a slug is set.
export const EXTENSIONPAY_ID: string = "tabnap";

export const paymentConfigured = (): boolean => EXTENSIONPAY_ID !== "";

export const DEFAULT_IDLE_MINUTES = 30;
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 1440;
/** Protected sites a free user can keep. */
export const FREE_PROTECTED_SITES = 5;
export const SWEEP_ALARM = "tabnap-sweep";
