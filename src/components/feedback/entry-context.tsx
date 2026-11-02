"use client";

import { createContext, useContext } from "react";

const Ctx = createContext(false);

/** Tells client entry points (the error view) whether this user may send feedback (false for the demo account). */
export function FeedbackEntryProvider({ canReport, children }: { canReport: boolean; children: React.ReactNode }) {
  return <Ctx.Provider value={canReport}>{children}</Ctx.Provider>;
}
export const useCanReportFeedback = () => useContext(Ctx);
