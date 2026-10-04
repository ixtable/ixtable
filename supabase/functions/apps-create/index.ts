// Creates a cloud app in an organization. The caller becomes its single
// Developer/Owner (PRD §20.1). Org owners, admins and members may create
// apps; billing-only members may not. Audits app.create.
//
// POST {orgId, name, documentId, datasourceKind?:"sqlite"|"postgres"} → {app}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { orgRole } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { oneOf, str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const orgId = uuid(body, "orgId");
    const name = str(body, "name", { max: 200 }).trim();
    if (!name) throw new HttpError("VALIDATION", "name: is required", { field: "name" });
    const documentId = str(body, "documentId", { max: 200 });
    const datasourceKind =
      oneOf(body, "datasourceKind", ["sqlite", "postgres"] as const, { optional: true }) ??
      "sqlite";

    await enforceNamedRateLimit("apps-create", user.id);
    const role = await orgRole(orgId, user.id);
    if (!role) throw new HttpError("NOT_FOUND", "Organization not found");
    if (role === "billing")
      throw new HttpError("FORBIDDEN", "Billing members cannot create applications");

    const db = serviceClient();
    const { data: app, error } = await db
      .from("cloud_apps")
      .insert({
        org_id: orgId,
        owner_id: user.id,
        name,
        document_id: documentId,
        datasource_kind: datasourceKind,
      })
      .select()
      .single();
    if (error?.code === "23505") {
      const { data: existing } = await db
        .from("cloud_apps")
        .select("id")
        .eq("org_id", orgId)
        .eq("document_id", documentId)
        .is("deleted_at", null)
        .maybeSingle();
      throw new HttpError(
        "VALIDATION",
        "documentId: this document is already linked to a cloud app in the organization",
        { field: "documentId", appId: existing?.id ?? null },
      );
    }
    if (error || !app) throw new Error(`create app: ${error?.message}`);

    await audit({
      action: "app.create",
      actorId: user.id,
      orgId,
      appId: app.id,
      target: `app:${app.id}`,
      details: { name, documentId, datasourceKind },
      req,
    });
    await incrementMetric("apps.create");
    return { app };
  }),
);
