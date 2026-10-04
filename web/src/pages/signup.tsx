import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import AuthForm from "@site/src/components/auth/AuthForm";

export default function SignupPage(): ReactNode {
  return (
    <Layout title="Sign up" description="Create an ixtable account">
      <AuthForm initialMode="signup" />
    </Layout>
  );
}
