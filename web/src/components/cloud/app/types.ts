import type { User } from "@supabase/supabase-js";
import type { CloudApp, Entitlement, Profile } from "@site/src/lib/cloud";

export interface AppTabProps {
  app: CloudApp;
  user: User;
  /** The single Developer/Owner of the app. */
  isOwner: boolean;
  /** Owner, or owner/admin of the app's organization. */
  isAdmin: boolean;
  /** Organization role of the viewer, if any. */
  orgRole: string | null;
  owner: Profile | null;
  entitlement: Entitlement | null;
  reloadApp: () => void;
}
