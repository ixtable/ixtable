import type { SupabaseClient } from "@supabase/supabase-js";
import { CloudError, fromErrorBody, toCloudError } from "./errors";
import type { FunctionMap, FunctionName } from "./types";

interface FunctionsErrorLike {
  name?: string;
  context?: unknown;
  message?: string;
}

async function readErrorResponse(context: unknown): Promise<CloudError> {
  if (context && typeof context === "object" && "status" in context && "json" in context) {
    const response = context as Response;
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    return fromErrorBody(body, response.status);
  }
  return new CloudError("UNKNOWN");
}

/**
 * Calls an ixtable Cloud Edge Function with the signed-in user's JWT and returns the typed
 * output. Throws a CloudError with a friendly message for every failure.
 */
export async function invokeFunction<K extends FunctionName>(
  client: SupabaseClient,
  name: K,
  input: FunctionMap[K]["in"],
): Promise<FunctionMap[K]["out"]> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client.functions.invoke(name, { body: input });
  } catch (error) {
    throw toCloudError(error);
  }
  if (result.error) {
    const error = result.error as FunctionsErrorLike;
    if (error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError") {
      throw new CloudError("NETWORK", error.message ?? null);
    }
    throw await readErrorResponse(error.context);
  }
  const data = result.data as unknown;
  if (data && typeof data === "object" && "error" in data) throw fromErrorBody(data, null);
  return (data ?? {}) as FunctionMap[K]["out"];
}
