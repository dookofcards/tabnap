// Serializes async state mutations. Every event handler in the service
// worker funnels through this so concurrent tab events can't interleave
// their read-modify-write cycles on chrome.storage.
let chain: Promise<unknown> = Promise.resolve();

export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
