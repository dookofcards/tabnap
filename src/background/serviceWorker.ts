// The service worker can be killed at any time, so no state lives in module
// scope: every handler re-reads from chrome.storage.
//
// The ExtPay import must stay at top level: MV3 only allows importScripts()
// during the worker's initial evaluation. Loading it is inert — nothing runs
// and no request is made until the user clicks Upgrade.
import { SWEEP_ALARM, paymentConfigured } from "../shared/constants.ts";

declare function importScripts(...urls: string[]): void;

if (paymentConfigured()) {
  try {
    importScripts("extpay/ExtPay.js");
  } catch {
    // Payment simply stays unavailable; tab sleeping is unaffected.
  }
}

import { sleepTabs } from "../core/runner.ts";
import {
  beginUpgrade,
  registerPaymentListeners,
  revalidateEntitlement,
} from "./payment.ts";
import { serialized } from "../shared/lock.ts";
import type {
  BeginUpgradeResponse,
  Message,
  SleepResponse,
} from "../shared/messages.ts";

registerPaymentListeners();

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(SWEEP_ALARM))) {
    await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void revalidateEntitlement();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  void serialized(() => sleepTabs("idle"));
});

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (r: unknown) => void) => {
    switch (message.type) {
      case "sleepOthers":
        void serialized(() => sleepTabs("others")).then(
          (slept): void => sendResponse({ slept } satisfies SleepResponse),
        );
        return true;
      case "runSweep":
        void serialized(() => sleepTabs("idle")).then(
          (slept): void => sendResponse({ slept } satisfies SleepResponse),
        );
        return true;
      case "beginUpgrade":
        void beginUpgrade().then(
          (started): void =>
            sendResponse({ started } satisfies BeginUpgradeResponse),
        );
        return true;
      default:
        return false;
    }
  },
);

void ensureAlarm();
