import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

let client: SupabaseClient | null = null;

/**
 * Lazily creates a singleton Supabase client. Must only be called from
 * browser-side code (event handlers, useEffect) since Docusaurus statically
 * renders pages in Node during build.
 */
export function getSupabaseClient(url: string, anonKey: string): SupabaseClient {
  if (!ExecutionEnvironment.canUseDOM) {
    throw new Error('getSupabaseClient() can only be called in the browser');
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}
