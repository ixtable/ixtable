# PRD: Cloud Publishing, Authentication & RBAC

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the paid workflow for private application publishing, authenticated Runtime access, user invitations, runtime roles, and personalized bundle delivery.

## Identity

MVP cloud supports:

- email/password;
- Google authentication;
- Microsoft authentication;
- organizations;
- invitations;
- one Developer/Owner per cloud application;
- Runtime Users.

The website is account/control-plane UI only; it is not a browser Runtime/Studio.

## Publishing

Publishing is always explicit.

- Autosave/backup never implicitly publishes.
- A publish operation selects a valid application checkpoint.
- Publish validation checks application dependencies, permissions, migrations, datasource configuration, and archive size.
- Each published version has immutable identity/version metadata.

## Private distribution

- Cloud applications are private by default.
- Only entitled/invited users can discover/download a runtime application.
- Runtime delivery produces a signed, user-fingerprinted personalized bundle.
- Runtime verifies signature before activation.

## RBAC

- Developer defines custom Runtime roles.
- Roles control application object/action access.
- Authorization is enforced at runtime entry points, not just UI visibility.
- Field-level and row-level ixtable permissions are out of MVP scope.

## Credential delivery

- Datasource credentials are never stored plaintext in ordinary archive/config entries.
- Cloud supports encrypted credential/key-grant delivery under the documented trusted-user threat model.
- Authorization/key grants renew on the parent PRD cadence.
- Revocation blocks new grants and new bundle delivery.

## Acceptance criteria

- Unauthorized users cannot enumerate/download private apps.
- Revoked users cannot obtain new bundles or key grants.
- Direct object invocation cannot bypass RBAC.
- Publishing never happens as a side effect of autosave.
- Signature verification fails closed.
- Credential logs/support tooling do not expose secrets.

## Non-goals

- OIDC/enterprise SSO in MVP;
- multiple developers per app;
- public/anonymous apps;
- row/field permissions;
- claim that credentials are safe from a malicious authorized runtime user.
