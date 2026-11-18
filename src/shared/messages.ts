// Typed popup/options -> service worker messages.
export interface SleepOthersMessage {
  type: "sleepOthers";
}
export interface RunSweepMessage {
  type: "runSweep";
}
/** Opens the ExtensionPay checkout. The only message that touches a network. */
export interface BeginUpgradeMessage {
  type: "beginUpgrade";
}

export type Message = SleepOthersMessage | RunSweepMessage | BeginUpgradeMessage;

export interface SleepResponse {
  slept: number;
}
export interface BeginUpgradeResponse {
  /** False when payment is not configured for this build. */
  started: boolean;
}
