import { ModePlaceholder, TabPlaceholder } from "../shell/FeaturePlaceholder";

/** Run mode: local Runtime preview of the application. Placeholder until Forms/Runtime lands. */
export function RunMode() {
  return (
    <ModePlaceholder
      title="Runtime"
      description="Run the application as its users will see it, with navigation and roles applied."
    />
  );
}

export function RolesTab() {
  return (
    <TabPlaceholder
      title="Roles"
      description="Define runtime roles and what each can see and change."
    />
  );
}
