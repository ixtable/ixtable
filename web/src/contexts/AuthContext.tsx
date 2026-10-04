import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import { getSupabaseClient } from "@site/src/lib/supabaseClient";

type AuthResult = { error: string | null };
type SignUpResult = AuthResult & { needsConfirmation: boolean };

/** Supabase provider ids. Microsoft sign-in uses the "azure" provider. */
export type OAuthProvider = "google" | "azure";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  oauthEnabled: boolean;
  providers: Record<OAuthProvider, boolean>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string, next?: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  resetPasswordForEmail: (email: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  signInWithOAuth: (provider: OAuthProvider, next?: string) => Promise<AuthResult>;
}

function callbackUrl(next: string): string {
  return `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const { supabaseUrl, supabaseAnonKey, oauthEnabled, googleAuthEnabled, microsoftAuthEnabled } =
    siteConfig.customFields as {
      supabaseUrl: string;
      supabaseAnonKey: string;
      oauthEnabled: boolean;
      googleAuthEnabled: boolean;
      microsoftAuthEnabled: boolean;
    };
  const providers: Record<OAuthProvider, boolean> = {
    google: oauthEnabled || googleAuthEnabled,
    azure: oauthEnabled || microsoftAuthEnabled,
  };

  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [supabaseUrl, supabaseAnonKey]);

  const signIn = async (email: string, password: string): Promise<AuthResult> => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp = async (
    email: string,
    password: string,
    next = "/account",
  ): Promise<SignUpResult> => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    const emailRedirectTo = callbackUrl(next);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    // With email confirmation on, Supabase returns a user but no session until the link is opened.
    return { error: error?.message ?? null, needsConfirmation: !error && !data.session };
  };

  const signOut = async (): Promise<void> => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    await supabase.auth.signOut();
  };

  const resetPasswordForEmail = async (email: string): Promise<AuthResult> => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    return { error: error?.message ?? null };
  };

  const updatePassword = async (password: string): Promise<AuthResult> => {
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    const { error } = await supabase.auth.updateUser({ password });
    return { error: error?.message ?? null };
  };

  const signInWithOAuth = async (
    provider: OAuthProvider,
    next = "/account",
  ): Promise<AuthResult> => {
    if (!providers[provider]) {
      return { error: "This sign-in provider is not configured for this environment." };
    }
    const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl(next), scopes: "email" },
    });
    return { error: error?.message ?? null };
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        oauthEnabled,
        providers,
        signIn,
        signUp,
        signOut,
        resetPasswordForEmail,
        updatePassword,
        signInWithOAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
