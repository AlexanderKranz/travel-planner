import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/server/plans", () => ({ editPlan: vi.fn() }));
vi.mock("./plan-runner", () => ({ PlanRunner: () => null, PlanErrorBanner: () => null }));

import { carriedReply, carryReply, dropCarriedReply, newVersionOf } from "./carried-reply";
import { PlanIterate } from "./plan-iterate";

const render = (baseVersion: number) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanIterate tripId="t1" locale="en" baseVersion={baseVersion} dayCount={5} aiBlock={null} editBlock={null} />
    </NextIntlClientProvider>,
  );

describe("carried reply (issue #158)", () => {
  it("finds the new version in the response state only when it differs from the base", () => {
    expect(newVersionOf({ version: { meta: { versionNo: 5 } } }, 4)).toBe(5);
    expect(newVersionOf({ version: { meta: { versionNo: 4 } } }, 4)).toBeNull();
    expect(newVersionOf({ version: null }, 4)).toBeNull();
    expect(newVersionOf(undefined, 4)).toBeNull();
  });

  it("the component remounted on the new version shows the answer; other versions do not", () => {
    carryReply("t1", 5, "Golf on every day. Day 3 was not changed.");
    expect(render(5)).toContain("Golf on every day. Day 3 was not changed.");
    expect(render(4)).not.toContain("Golf on every day");
    dropCarriedReply("t1", 5);
    expect(carriedReply("t1", 5)).toBeNull();
    expect(render(5)).not.toContain("Golf on every day");
  });
});
