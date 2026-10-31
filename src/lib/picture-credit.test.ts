import { describe, expect, it } from "vitest";
import { pictureCredit } from "./picture-credit";

const base = { author: "Diliff derivative work: Jjtkk", licenseName: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", sourcePageUrl: "https://commons.wikimedia.org/wiki/File:X.jpg" };

describe("pictureCredit", () => {
  it("keeps the full author text", () => {
    expect(pictureCredit(base)).toMatchObject({ variant: "withAuthor", author: base.author, licenseUrl: base.licenseUrl });
  });
  it("omits the author part when null or blank", () => {
    expect(pictureCredit({ ...base, author: null }).variant).toBe("licenseOnly");
    expect(pictureCredit({ ...base, author: "  " }).variant).toBe("licenseOnly");
  });
  it("passes a null licence url through", () => {
    expect(pictureCredit({ ...base, licenseUrl: null }).licenseUrl).toBeNull();
  });
});
