/** Test helper: a chainable fake of the Supabase query builder. Awaiting it resolves to `result(calls)`. */
export type Call = { method: string; args: unknown[] };
export function chain(result: (calls: Call[]) => unknown): { builder: unknown; calls: Call[] } {
  const calls: Call[] = [];
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        const value = result(calls);
        return (resolve: (v: unknown) => void) => resolve(value);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return proxy;
      };
    },
  });
  return { builder: proxy, calls };
}
