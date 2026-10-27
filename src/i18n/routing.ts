import { defineRouting } from "next-intl/routing";

// Adding a language: add its code here and a matching messages/<code>.json.
export const routing = defineRouting({
  locales: ["de", "en"],
  defaultLocale: "de",
});
