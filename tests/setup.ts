import { beforeEach } from "vitest";
import { makeChromeMock, type ChromeMock } from "./chromeMock.ts";

const mock: ChromeMock = makeChromeMock();
(globalThis as { chrome?: unknown }).chrome = mock;

export function chromeMock(): ChromeMock {
  return mock;
}

beforeEach(() => {
  mock.storage.local._reset();
  mock.storage.sync._reset();
  mock.storage.session._reset();
  mock.alarms._reset();
});
