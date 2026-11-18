// Minimal in-memory chrome.* mock covering what core/ modules touch in
// unit tests: storage areas and alarms. Installed as globalThis.chrome by
// tests/setup.ts and reset before each test.

type Store = Record<string, unknown>;

export function makeStorageArea() {
  let data: Store = {};
  return {
    async get(keys?: string | string[] | null): Promise<Store> {
      if (keys === undefined || keys === null) return structuredClone(data);
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Store = {};
      for (const key of wanted) {
        if (key in data) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(items: Store): Promise<void> {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        delete data[key];
      }
    },
    _reset(): void {
      data = {};
    },
  };
}

export interface AlarmRecord {
  name: string;
  info: { when?: number; periodInMinutes?: number };
}

export function makeAlarms() {
  const created: AlarmRecord[] = [];
  const cleared: string[] = [];
  return {
    async create(name: string, info: AlarmRecord["info"]): Promise<void> {
      created.push({ name, info });
    },
    async clear(name: string): Promise<boolean> {
      cleared.push(name);
      return true;
    },
    _created: created,
    _cleared: cleared,
    _reset(): void {
      created.length = 0;
      cleared.length = 0;
    },
  };
}

export function makeChromeMock() {
  return {
    storage: {
      local: makeStorageArea(),
      sync: makeStorageArea(),
      // Memory-only in Chrome; an ordinary area is a faithful enough stand-in
      // for tests, which never restart the browser.
      session: makeStorageArea(),
    },
    alarms: makeAlarms(),
  };
}

export type ChromeMock = ReturnType<typeof makeChromeMock>;
