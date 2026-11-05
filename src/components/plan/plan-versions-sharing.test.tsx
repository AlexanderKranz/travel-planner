import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanVersionMeta } from "@/lib/domain/plan";
import en from "../../../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("./restore-button", () => ({ RestoreButton: () => <button>Restore-stub</button> }));

import { PlanVersions } from "./plan-versions";

const meta = (versionNo: number, createdBy: string | null): PlanVersionMeta => ({
  versionNo, kind: "patch", createdAt: "2026-11-01T10:00:00Z", feedback: null, restoredFrom: null, changedDays: [], model: null, createdBy,
});
const render = (props: Partial<React.ComponentProps<typeof PlanVersions>>) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanVersions tripId="t1" versions={[meta(2, "other"), meta(1, "me")]} shown={2} busy={false} {...props} />
    </NextIntlClientProvider>,
  );

describe("PlanVersions on a shared trip", () => {
  it("names the author of a version written by someone else, not the viewer's own", () => {
    const html = render({ authors: { other: "Ben" } });
    expect(html).toContain("by Ben");
    expect(html.match(/by Ben/g)).toHaveLength(1);
  });

  it("offers restore to editors and not to a read grantee", () => {
    expect(render({})).toContain("Restore-stub");
    expect(render({ readOnly: true })).not.toContain("Restore-stub");
  });
});
