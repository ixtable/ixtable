---
sidebar_position: 1
---

# Getting started with ixtable Cloud

_Publish an app from Studio, invite runtime users, and keep their installations up to date._

ixtable Cloud distributes an app you built in the desktop app to people you invite. They install it in the ixtable Runtime and receive each version you publish when they sync. Each person keeps their own local records, and the cloud never edits your app.

The desktop app stays free and works without an account. You need ixtable Cloud only for private distribution, automatic updates, credential delivery, backups, and audit history.

## Create an account and an organization

Create an account on the [sign-up page](/signup) with your email address, or continue with Google or Microsoft. Then open the [Cloud dashboard](/cloud) and create an **organization**. An organization owns cloud apps and their billing. You become its owner.

Add colleagues on the dashboard under Members. Each one gets an organization role.

| Role | Can do |
| --- | --- |
| Owner | Everything, including deleting the organization |
| Admin | Manage members, apps, and invitations |
| Billing | See plans, subscriptions, and invoices |
| Member | Belong to the organization without management rights |

## Publish the first version

Open the project in Studio and sign in to ixtable Cloud from the Cloud tab in Settings. Studio creates the cloud app in the organization you choose, then publishes a **checkpoint**. A checkpoint is an immutable version of the app: its definition, its bootstrap data, its schema migrations, and a security summary. Autosave never publishes. You publish each version on purpose.

Every cloud app has exactly one **Developer/Owner**. That person publishes versions and manages datasource credentials. Ownership moves only through an explicit transfer on the app's Overview tab.

An archive can be up to 500 MB. Studio checks the size before upload, and ixtable Cloud checks it again.

## Choose a plan

Plans are priced per cloud app. Each plan includes a number of **runtime users**, the people who run the app. See [pricing](/pricing) for the current plans. Open the app's Billing tab and choose a plan. Until the app has an active plan, you can publish but runtime users cannot install or sync.

## Invite runtime users

Runtime roles come from Studio. Define them in Settings, Roles, and publish so they sync to the cloud app. Then open the app's Runtime users tab, enter an email address, and choose a role.

The invitee receives an email with a link. They sign in or create an account with that address and accept. If the plan has no free seats, accepting fails and the page tells them to ask you to upgrade.

## Install and sync

A runtime user signs in to the desktop app and installs the app from the cloud apps list. The Runtime downloads a bundle that is signed by ixtable Cloud and personalized for that user. It checks the signature, the expiry, and the archive checksum before it opens anything.

When you publish a new version, each Runtime receives it on its next sync. The Runtime keeps a recovery checkpoint, applies migrations to its own local records, runs health checks, and switches to the new version only if every step passes. A failed update leaves the previous version running. Updates never replace a user's records.

## Backups and restore

The Versions tab lists every published checkpoint with its checksum, size, migrations, minimum Runtime version, and security summary. You can withdraw a version, make an older version the head again, or fork a version into a new app.

Turn on installation backups on the Backups tab to keep a copy of each installation's local SQLite records. Each installation has its own stream, and streams are never merged. A restore always creates a new local copy.

For an app that uses PostgreSQL, restoring an archive does not restore the records in your database. You back up PostgreSQL yourself.

## Next steps

- [Security model](./security)
- [Deployment without the cloud](../concepts/deployment)
- [Terms of service](../legal/terms)
