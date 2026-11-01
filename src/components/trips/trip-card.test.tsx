import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", () => ({ useLinkStatus: () => status }));

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
