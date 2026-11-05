import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { ConflictNotice } from "./conflict-notice";

type El = ReactElement<{ children?: unknown; onClick?: () => void; role?: string }>;

function buttons(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    if (el.type === "button") out.push(el);
    buttons(el.props.children, out);
  }
  return out;
}

describe("ConflictNotice", () => {
  it("is an alert with 'load latest' and 'save anyway', each calling its own handler", () => {
    const onLoadLatest = vi.fn();
    const onOverwrite = vi.fn();
    const tree = ConflictNotice({ onLoadLatest, onOverwrite, pending: false }) as El;
    expect(tree.props.role).toBe("alert");
    const [load, overwrite] = buttons(tree);
    load.props.onClick?.();
    expect(onLoadLatest).toHaveBeenCalledTimes(1);
    expect(onOverwrite).not.toHaveBeenCalled();
    overwrite.props.onClick?.();
    expect(onOverwrite).toHaveBeenCalledTimes(1);
  });

  it("offers only loading when the latest version could not be read", () => {
    const tree = ConflictNotice({ onLoadLatest: vi.fn(), pending: false }) as El;
    expect(buttons(tree)).toHaveLength(1);
  });
});
