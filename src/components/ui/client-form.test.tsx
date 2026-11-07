import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientForm } from "./client-form";
import { useHydrated } from "@/lib/hooks/use-hydrated";

describe("ClientForm", () => {
  it("server-renders every control disabled so nothing can submit natively before hydration", () => {
    const html = renderToStaticMarkup(
      <ClientForm onSubmit={() => {}}>
        <input aria-label="email" />
        <button type="submit">Go</button>
      </ClientForm>,
    );
    expect(html).toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(html).toContain('data-hydrated="false"');
    expect(html).not.toContain("action=");
  });

  it('gate="submit" leaves the fields enabled (the caller disables the submit button)', () => {
    const html = renderToStaticMarkup(
      <ClientForm gate="submit" onSubmit={() => {}}>
        <input aria-label="email" />
      </ClientForm>,
    );
    expect(html).not.toMatch(/<fieldset[^>]*\sdisabled/);
    expect(html).toContain('data-hydrated="false"');
  });

  it("useHydrated is false on the server", () => {
    function Probe() {
      return <span>{String(useHydrated())}</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toContain("false");
  });
});
