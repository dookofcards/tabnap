import { FREE_PROTECTED_SITES } from "../shared/constants.ts";
import { getEntitlement } from "../shared/features.ts";
import { getSettings, updateSettings } from "../shared/settings.ts";
import { hostMatches, hostOf } from "../core/sleeper.ts";
import type { SleepResponse } from "../shared/messages.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const btnSleep = $<HTMLButtonElement>("btn-sleep");
const btnProtect = $<HTMLButtonElement>("btn-protect");
const paused = $<HTMLInputElement>("opt-paused");
const feedback = $("feedback");

function say(text: string): void {
  feedback.textContent = text;
  feedback.hidden = false;
}

async function render(): Promise<void> {
  const [settings, entitlement, sleeping, active] = await Promise.all([
    getSettings(),
    getEntitlement(),
    chrome.tabs.query({ discarded: true }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  $("sleeping-count").textContent = String(sleeping.length);
  paused.checked = settings.paused;
  $("idle-line").textContent = settings.paused
    ? "Automatic sleeping is paused."
    : `Tabs sleep after ${settings.idleMinutes} idle minutes.`;

  const host = hostOf(active[0]?.url);
  if (host === null) {
    btnProtect.disabled = true;
    $("site-line").textContent = "This page can't be put to sleep.";
    return;
  }
  const isProtected = settings.protectedSites.some((p) => hostMatches(host, p));
  const full = !entitlement.active && settings.protectedSites.length >= FREE_PROTECTED_SITES;
  btnProtect.textContent = isProtected ? `${host} never sleeps` : `Never sleep ${host}`;
  btnProtect.disabled = isProtected || full;
  $("site-line").textContent =
    full && !isProtected
      ? `Free keeps ${FREE_PROTECTED_SITES} protected sites. Pro removes the limit.`
      : "";
  btnProtect.dataset.host = host;
}

btnSleep.addEventListener("click", async () => {
  btnSleep.disabled = true;
  const res = (await chrome.runtime.sendMessage({ type: "sleepOthers" })) as SleepResponse;
  say(res.slept === 0 ? "Nothing to put to sleep." : `Put ${res.slept} tab${res.slept === 1 ? "" : "s"} to sleep.`);
  btnSleep.disabled = false;
  await render();
});

btnProtect.addEventListener("click", async () => {
  const host = btnProtect.dataset.host;
  if (!host) return;
  const s = await getSettings();
  await updateSettings({ protectedSites: [...s.protectedSites, host] });
  await render();
});

paused.addEventListener("change", async () => {
  await updateSettings({ paused: paused.checked });
  await render();
});

$("btn-settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
void render();
