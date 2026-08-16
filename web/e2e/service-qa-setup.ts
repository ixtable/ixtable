import globalSetup from "./global-setup";

export default async function serviceQaSetup(): Promise<void> {
  await globalSetup();
  if (process.env.E2E_SUPABASE_AVAILABLE !== "true") {
    throw new Error(
      "Service QA requires local Supabase at http://127.0.0.1:54321. Run `supabase start` and retry.",
    );
  }
}
