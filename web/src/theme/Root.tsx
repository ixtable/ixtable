import React, { type ReactNode } from "react";
import { AuthProvider } from "@site/src/contexts/AuthContext";

export default function Root({ children }: { children: ReactNode }): ReactNode {
  return <AuthProvider>{children}</AuthProvider>;
}
