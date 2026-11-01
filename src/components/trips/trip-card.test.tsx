import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TripSummary } from "@/lib/domain";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", () => ({ useLinkStatus: () => status }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, className, href }: { children: ReactNode; className?: string; href: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { TripCard } from "./trip-card";
import { TripCardPending } from "./trip-card-pending";

const render = (locale: "de" | "en", messages: object) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <TripCardPending />
    </NextIntlClientProvider>,
  );

describe("TripCardPending", () => {
  it("renders an empty live region while idle", () => {
    status.pending = false;
    const html = render("en", en);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Opening trip");
    expect(html).not.toContain("animate-spin");
  });

  it("shows a reduced-motion-safe spinner and a localized label while pending", () => {
    status.pending = true;
    const html = render("de", de);
    expect(html).toContain("Reise wird geöffnet…");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain('aria-hidden="true"');
    expect(render("en", en)).toContain("Opening trip…");
  });
});

describe("TripCard", () => {
  const trip: TripSummary = {
    id: "t1", title: "Berlin trip", lengthDays: 3, timing: { kind: "none" }, updatedAt: "2026-01-01T00:00:00.000Z",
    destination: { kind: "freetext", name: "Berlin" },
    groupName: null, purposeName: null,
  } as TripSummary;

  it("keeps the pending indicator inside the link, with the pending highlight and room for the spinner", () => {
    status.pending = true;
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <TripCard trip={trip} />
      </NextIntlClientProvider>,
    );
    const link = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(link).toContain('href="/app/trips/t1"');
    expect(link).toContain("has-[[data-pending=true]]:bg-hover");
    expect(link).toContain('role="status"');
    expect(link).toContain("Opening trip…");
    expect(link).toContain("pr-7");
  });
});
