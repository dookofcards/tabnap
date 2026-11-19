import {
  FREE_PROTECTED_SITES,
  HOMEPAGE_URL,
  SUPPORT_URL,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  paymentConfigured,
} from "../shared/constants.ts";
import { getEntitlement } from "../shared/features.ts";
import { getSettings, updateSettings } from "../shared/settings.ts";
import { normalizeHost } from "../core/sleeper.ts";
import { hasTabAccess, requestTabAccess, TAB_ACCESS_EXPLAINED } from "../shared/tabAccess.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const el = {
  idle: $<HTMLInputElement>("idle-minutes"),
  paused: $<HTMLInputElement>("opt-paused"),
  pinned: $<HTMLInputElement>("opt-skip-pinned"),
  audible: $<HTMLInputElement>("opt-skip-audible"),
  grouped: $<HTMLInputElement>("opt-skip-grouped"),
  protectForm: $<HTMLFormElement>("protect-form"),
  protectInput: $<HTMLInputElement>("protect-input"),
  protectList: $<HTMLUListElement>("protect-list"),
  protectNote: $("protect-limit-note"),
  protectError: $("protect-error"),
  proBadge: $("pro-badge"),
  proLocked: $("pro-locked"),
  proFields: $<HTMLFieldSetElement>("pro-fields"),
  btnUpgrade: $<HTMLButtonElement>("btn-upgrade"),
  upgradeNote: $("upgrade-note"),
  timeoutForm: $<HTMLFormElement>("timeout-form"),
  timeoutHost: $<HTMLInputElement>("timeout-host"),
  timeoutMinutes: $<HTMLInputElement>("timeout-minutes"),
  timeoutList: $<HTMLUListElement>("timeout-list"),
  minTabs: $<HTMLInputElement>("min-tabs"),
  stats: $("stats"),
  tabAccessNote: $("tab-access-note"),
  btnTabAccess: $<HTMLButtonElement>("btn-tab-access"),
};

function chip(label: string, onRemove: () => void): HTMLLIElement {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "×";
  btn.setAttribute("aria-label", `Remove ${label}`);
  btn.addEventListener("click", onRemove);
  li.append(span, btn);
  return li;
}

async function render(): Promise<void> {
  const [settings, entitlement] = await Promise.all([getSettings(), getEntitlement()]);
  const pro = entitlement.active;
  el.idle.value = String(settings.idleMinutes);
  el.paused.checked = settings.paused;
  el.pinned.checked = settings.skipPinned;
  el.audible.checked = settings.skipAudible;
  el.grouped.checked = settings.skipGrouped;
  el.minTabs.value = String(settings.minOpenTabs);

  el.protectNote.textContent = pro
    ? ""
    : `Free keeps up to ${FREE_PROTECTED_SITES} protected sites.`;
  el.protectList.replaceChildren(
    ...settings.protectedSites.map((host, i) => {
      const li = chip(host, async () => {
        const s = await getSettings();
        await updateSettings({ protectedSites: s.protectedSites.filter((h) => h !== host) });
        await render();
      });
      // Past the free limit without Pro: shown, but not enforced.
      if (!pro && i >= FREE_PROTECTED_SITES) {
        li.title = "Not active on the Free tier";
        li.style.opacity = "0.5";
      }
      return li;
    }),
  );
  el.timeoutList.replaceChildren(
    ...settings.siteTimeouts.map((r) =>
      chip(`${r.host} · ${r.minutes} min`, async () => {
        const s = await getSettings();
        await updateSettings({ siteTimeouts: s.siteTimeouts.filter((x) => x.host !== r.host) });
        await render();
      }),
    ),
  );

  // Site rules exist but tab addresses aren't visible (declined or revoked).
  const hasRules = settings.protectedSites.length > 0 || settings.siteTimeouts.length > 0;
  el.tabAccessNote.hidden = !hasRules || (await hasTabAccess());

  el.proFields.disabled = !pro;
  el.proBadge.hidden = !pro;
  el.proLocked.hidden = pro;
  el.btnUpgrade.hidden = pro || !paymentConfigured();
  if (!pro) {
    el.proLocked.textContent = paymentConfigured()
      ? "Per-site timers, unlimited protected sites and the tab-count threshold are part of TabNap Pro, a one-time unlock. Everything above stays free."
      : "Pro features (per-site timers, unlimited protected sites, tab-count threshold) are coming soon. Everything above stays free.";
    el.upgradeNote.textContent = paymentConfigured()
      ? "Opens extensionpay.com in a new tab. Nothing is sent until you click."
      : "";
  } else {
    el.upgradeNote.textContent = "";
  }

  const { stats } = await chrome.storage.local.get("stats");
  const slept = Number((stats as { slept?: number } | undefined)?.slept ?? 0);
  el.stats.textContent = `${slept} tab${slept === 1 ? "" : "s"} put to sleep so far (stored only on this device).`;
}

function clampMinutes(raw: string): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MIN_IDLE_MINUTES;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, n));
}

el.idle.addEventListener("change", async () => {
  await updateSettings({ idleMinutes: clampMinutes(el.idle.value) });
  await render();
});
for (const [input, key] of [
  [el.paused, "paused"],
  [el.pinned, "skipPinned"],
  [el.audible, "skipAudible"],
  [el.grouped, "skipGrouped"],
] as const) {
  input.addEventListener("change", () => void updateSettings({ [key]: input.checked }));
}

el.protectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.protectError.hidden = true;
  const host = normalizeHost(el.protectInput.value);
  if (host === null) {
    el.protectError.textContent = "Enter a site like example.com.";
    el.protectError.hidden = false;
    return;
  }
  // First await: Chrome shows the prompt only during the user's click.
  if (!(await requestTabAccess())) {
    el.protectError.textContent = TAB_ACCESS_EXPLAINED;
    el.protectError.hidden = false;
    return;
  }
  const [settings, entitlement] = await Promise.all([getSettings(), getEntitlement()]);
  if (settings.protectedSites.includes(host)) {
    el.protectInput.value = "";
    return;
  }
  if (!entitlement.active && settings.protectedSites.length >= FREE_PROTECTED_SITES) {
    el.protectError.textContent = `The Free tier keeps ${FREE_PROTECTED_SITES} protected sites. Pro removes the limit.`;
    el.protectError.hidden = false;
    return;
  }
  await updateSettings({ protectedSites: [...settings.protectedSites, host] });
  el.protectInput.value = "";
  await render();
});

el.btnTabAccess.addEventListener("click", async () => {
  if (await requestTabAccess()) await render();
});

el.timeoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const host = normalizeHost(el.timeoutHost.value);
  if (host === null) return;
  // First await: Chrome shows the prompt only during the user's click.
  if (!(await requestTabAccess())) {
    el.protectError.textContent = TAB_ACCESS_EXPLAINED;
    el.protectError.hidden = false;
    return;
  }
  if (!(await getEntitlement()).active) return;
  const s = await getSettings();
  const rest = s.siteTimeouts.filter((r) => r.host !== host);
  await updateSettings({
    siteTimeouts: [...rest, { host, minutes: clampMinutes(el.timeoutMinutes.value) }],
  });
  el.timeoutHost.value = "";
  await render();
});

el.minTabs.addEventListener("change", async () => {
  if (!(await getEntitlement()).active) return;
  await updateSettings({ minOpenTabs: Math.max(0, Math.round(Number(el.minTabs.value)) || 0) });
  await render();
});

el.btnUpgrade.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "beginUpgrade" });
});

$<HTMLAnchorElement>("link-home").href = HOMEPAGE_URL;
$<HTMLAnchorElement>("link-support").href = SUPPORT_URL;

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void render();
});
void render();
