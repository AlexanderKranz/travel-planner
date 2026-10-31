import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Keys that occur twice in one object. JSON.parse keeps only the last one, which silently drops a whole block. */
function duplicateKeys(json: string): string[] {
  const dups: string[] = [];
  const stack: Set<string>[] = [];
  const path: string[] = [];
  const string = /"(?:[^"\\]|\\.)*"/y;
  let pending: string | null = null; // key of the value being read
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      string.lastIndex = i;
      const raw = string.exec(json)![0];
      i += raw.length - 1;
      if (!/^\s*:/.test(json.slice(i + 1, i + 12))) continue;
      const key = JSON.parse(raw) as string;
      const seen = stack[stack.length - 1];
      if (seen.has(key)) dups.push([...path, key].join("."));
      seen.add(key);
      pending = key;
    } else if (c === "{") {
      if (stack.length > 0) path.push(pending ?? "");
      stack.push(new Set());
    } else if (c === "}") {
      stack.pop();
      path.pop();
    }
  }
  return dups;
}

const read = (locale: string) => readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8");

describe("message files", () => {
  it("finds a duplicate key", () => {
    expect(duplicateKeys('{"a":{"b":1,"b":2},"c":{"b":"x: y"}}')).toEqual(["a.b"]);
  });
  it.each(["de", "en"])("%s has no duplicate keys", (locale) => {
    expect(duplicateKeys(read(locale))).toEqual([]);
  });
});
