import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import AuthForm from "@site/src/components/auth/AuthForm";

export default function LoginPage(): ReactNode {
  return (
    <Layout title="Log in" description="Sign in to your ixtable account">
      <AuthForm initialMode="signin" />
    </Layout>
  );
}
