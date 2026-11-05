import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TripSummary } from "@/lib/domain";
import type { Grant } from "@/lib/domain/sharing";
import type { ResolvedGroup } from "@/lib/group-text";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }) }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, className, href }: { children: ReactNode; className?: string; href: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/server/sharing", () => ({
  shareWith: vi.fn(),
  setShareAccess: vi.fn(),
  unshare: vi.fn(),
  leaveShare: vi.fn(),
}));

import { TripCard } from "@/components/trips/trip-card";
import { PeopleShare } from "./people-share";
import { ShareBadge, SharedPill } from "./share-badge";
import { SharedContext } from "./shared-context";

const render = (node: ReactNode, locale: "de" | "en" = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      {node}
    </NextIntlClientProvider>,
  );

const owner = { name: "Mia", email: "mia@example.test" };

describe("ShareBadge", () => {
  it("always writes the owner and the level as text", () => {
    expect(render(<ShareBadge owner={owner} access="read" />)).toContain("Mia · Read-only");
    expect(render(<ShareBadge owner={owner} access="write" />)).toContain("Mia · Can edit");
    expect(render(<ShareBadge owner={owner} access="read" />, "de")).toContain("Mia · Nur lesen");
  });

  it("falls back to the email without a name", () => {
    expect(render(<ShareBadge owner={{ name: null, email: "mia@example.test" }} access="write" />)).toContain("mia@example.test · Can edit");
  });

  it("shows the number of people on the pill", () => {
    expect(render(<SharedPill count={3} />)).toContain("Shared · 3");
  });
});

describe("TripCard with sharing", () => {
  const base = {
    id: "t1", title: "Berlin", lengthDays: 3, timing: { kind: "none" }, updatedAt: "2026-01-01T00:00:00.000Z",
    destination: { kind: "freetext", name: "Berlin" }, groupName: null, purposeName: null,
    access: "owner", sharedBy: null, shareCount: 0,
  } as unknown as TripSummary;

  it("shows the badge on an incoming trip and the pill on an own shared trip", () => {
    const incoming = render(<TripCard trip={{ ...base, access: "write", sharedBy: { id: "o", ...owner } }} />);
    expect(incoming).toContain("Mia · Can edit");
    expect(incoming).not.toContain("Shared ·");
    const own = render(<TripCard trip={{ ...base, shareCount: 2 }} />);
    expect(own).toContain("Shared · 2");
    expect(own).not.toContain("Can edit");
  });

  it("shows neither for a plain own trip", () => {
    const html = render(<TripCard trip={base} />);
    expect(html).not.toContain("Shared");
    expect(html).not.toContain("Read-only");
  });
});

describe("PeopleShare", () => {
  const grants: Grant[] = [
    { id: "g1", grantee: { id: "u1", name: "Ben", email: "ben@example.test" }, access: "write", createdAt: "2026-11-01T00:00:00Z" },
    { id: "g2", grantee: { id: "u2", name: null, email: "kim@example.test" }, access: "read", createdAt: "2026-11-02T00:00:00Z" },
  ];
  const props = { resourceId: "r1", grants, candidates: null, disabledReason: null };

  it("trip: email field, two access options, the group notice and the count", () => {
    const html = render(<PeopleShare resource="trip" {...props} />);
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("Can view");
    expect(html).toContain("They will see the whole trip, including the travel group with names and birthdates.");
    expect(html).toContain("Shared with 2 of 10");
    // name above the email; email alone when there is no name
    expect(html).toContain("ben@example.test");
    expect(html).toContain("kim@example.test");
    expect(html).toContain('role="status"');
  });

  it("purpose: the purpose notice instead", () => {
    const html = render(<PeopleShare resource="purpose" {...props} />);
    expect(html).toContain("destination searches");
    expect(html).not.toContain("travel group with names");
  });

  it("admin: a user picker instead of the email field", () => {
    const html = render(
      <PeopleShare resource="trip" {...props} candidates={[{ id: "u9", email: "x@example.test", name: "Xaver" }]} />,
    );
    expect(html).not.toContain('type="email"');
    expect(html).toContain("<select");
    expect(html).toContain("x@example.test (Xaver)");
  });

  it("demo: the form is off and says why", () => {
    const html = render(<PeopleShare resource="trip" {...props} grants={[]} disabledReason="Not in the demo" />);
    expect(html).toContain("Not in the demo");
    expect(html).not.toContain("<form");
  });

  it("disables the share button at the limit of 10", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...grants[0], id: `g${i}` }));
    expect(render(<PeopleShare resource="trip" {...props} grants={ten} />)).toMatch(/<button[^>]*disabled[^>]*>Share</);
  });
});

describe("SharedContext", () => {
  const group = {
    source: "entries",
    rows: [
      { kind: "member", count: 1, name: "Self", isSelf: true, age: { status: "known", age: 46, approximate: false } },
      { kind: "member", count: 1, name: "Lena", isSelf: false, age: { status: "known", age: 7, approximate: false } },
      { kind: "composition", count: 3, label: "Friends", isSelf: false, age: { status: "unknown" } },
    ],
    size: 5,
    summary: { total: 5, adults: 4, children: 1, toddlers: 0, unknown: 0 },
  } as unknown as ResolvedGroup;

  it("shows the is_self entry as the owner with the age, never a birthdate", () => {
    const html = render(
      <SharedContext group={group} purpose={{ id: "p1", name: "Golf", text: "18 holes", usable: false }} ownerName="Mia" canChange />,
    );
    expect(html).toContain("Mia (trip owner)");
    expect(html).toContain("46 years");
    expect(html).toContain("Lena");
    expect(html).toContain("3 × Friends");
    expect(html).toContain("Golf");
    expect(html).toContain("Only Mia can change the group and purpose.");
    expect(html).not.toContain("/app/purposes/p1"); // not usable: no link
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("links the purpose only when it is also shared with the viewer", () => {
    const html = render(
      <SharedContext group={null} purpose={{ id: "p1", name: "Golf", text: "", usable: true }} ownerName="Mia" canChange={false} />,
    );
    expect(html).toContain("/app/purposes/p1");
    expect(html).not.toContain("Only Mia");
  });
});
