import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { isServerActionRequest, protectedAreaLocale } from "./lib/protected-paths";
import { refreshSession } from "./lib/server/supabase/middleware";

const intlMiddleware = createIntlMiddleware(routing);

export async function proxy(request: NextRequest) {
  // 1. next-intl decides locale redirects/rewrites.
  const response = intlMiddleware(request);

  // 2. Refresh the Supabase session on whatever response intl produced.
  const userId = await refreshSession(request, response);

  // 3. Signed-out users may not enter protected areas. Server action calls pass: a redirect answers them with the login
  //    page's HTML, which the client rejects; the action checks the session itself and returns its own error.
  const locale = protectedAreaLocale(request.nextUrl.pathname);
  if (locale && !userId && !isServerActionRequest(request.headers)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = `/${locale}/login`;
    loginUrl.search = "";
    const redirect = NextResponse.redirect(loginUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}

export const config = {
  // Skip API routes, auth route handlers, Next internals and static files.
  matcher: "/((?!api|auth|_next|_vercel|.*\\..*).*)",
};
