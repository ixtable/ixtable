---
sidebar_position: 4
---

# Deployment

_Deployment support for ixtable projects is planned and not implemented._

Design view can render a local preview of an app. It does not package, publish, host, or update that app.

:::warning Work in progress

Deployment is a documentation stub. Preview app is the final implemented step in the current workflow.

:::

## Planned scope

A deployment flow needs a runtime artifact, environment configuration, data access rules, and a release process. Those boundaries have not been defined.

:::note TODO

Define build output, target environments, secrets, migrations, access control, release history, rollback, and custom domains.

:::

## Preview is not deployment

The Design view preview runs inside the editor and uses the current prototype state. Treat it as a design check. It provides no public URL or production isolation.

## Next steps

- [Overview](/docs/)
- [Design view](./design-view.md)
- [Testing](./testing.md)
