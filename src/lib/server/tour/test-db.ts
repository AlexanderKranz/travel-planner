/**
 * Minimal PostgREST query-builder fake for the city tour server tests. Every finished query is recorded in `ops`
 * and answered by `reply(op)`. Test helper only (not imported by app code).
 */
export type Reply = { data?: unknown; error?: { code: string } | null; count?: number | null };
export type Op = {
  client: string;
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  eqs: [string, unknown][];
  head: boolean;
};

export function fakeDb(client: string, ops: Op[], reply: (op: Op) => Reply) {
  const from = (table: string) => {
    const q: Op = { client, table, op: "select", eqs: [], head: false };
    const settle = () => {
      ops.push(q);
      return { data: null, error: null, count: null, ...reply(q) };
    };
    const b: Record<string, unknown> = {};
    b.select = (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) q.head = true;
      return b;
    };
    for (const m of ["order", "returns", "gte", "in", "neq", "or"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => {
      q.eqs.push([c, v]);
      return b;
    };
    b.insert = (p: unknown) => {
      q.op = "insert";
      q.payload = p;
      return b;
    };
    b.update = (p: unknown) => {
      q.op = "update";
      q.payload = p;
      return b;
    };
    b.delete = () => {
      q.op = "delete";
      return b;
    };
    b.single = async () => settle();
    b.maybeSingle = async () => settle();
    b.then = (res: (v: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
    return b;
  };
  return { from };
}
