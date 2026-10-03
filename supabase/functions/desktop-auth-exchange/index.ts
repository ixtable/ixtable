// Placeholder so the local stack boots (supabase/config.toml declares this
// function). The owning agent replaces this file with the implementation.
import { handler, HttpError } from "../_shared/http.ts";

Deno.serve(
  handler(() => {
    throw new HttpError("NOT_FOUND", "desktop-auth-exchange is not implemented yet");
  }),
);
