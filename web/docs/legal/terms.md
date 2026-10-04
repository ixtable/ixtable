---
sidebar_position: 2
---

# Terms of service

_The terms for using ixtable Cloud, including the trusted-user security model that every developer accepts._

:::note Draft

These terms describe how the service works today. They are pending legal review before the public launch of ixtable Cloud.

:::

These terms apply to the ixtable website and ixtable Cloud. The ixtable desktop app is open source under the Apache License 2.0. Its license, and not these terms, governs the desktop app when you use it without ixtable Cloud.

## The service

ixtable Cloud lets a developer publish an app built in the ixtable desktop app and distribute it privately to invited runtime users. It provides accounts and organizations, signed and personalized runtime bundles, encrypted credential delivery, archive versions and backups, restore, audit history, and per-app subscriptions.

ixtable Cloud is not a managed PostgreSQL service, a browser runtime, a cloud SQLite runtime, a multi-developer editor, or a row-level synchronization engine. Each runtime installation keeps its own local records.

## Accounts

You are responsible for your account and for what happens under it. Keep your password secret, and approve a desktop sign-in request only if you started it. Each cloud app has exactly one Developer/Owner, who is responsible for that app, its content, and the people it is distributed to.

## The trusted-user security model

ixtable Cloud controls who receives an app and its credentials, and it records what happened. It does not prevent an authorized runtime user from copying what their computer can read. By distributing an app, you accept the following.

- An invited runtime user can read every record the app shows them and can copy the app archive installed on their computer.
- A runtime user who receives a datasource credential can extract it and use it outside ixtable. Revoking the user blocks future key grants. It cannot erase a credential, archive, or export they already have.
- Runtime roles control what the Runtime shows and does. For an app that connects straight to PostgreSQL, runtime roles do not protect your database from a runtime user who extracts the credential. Database-level isolation requires separate least-privileged credentials and database permissions, which you configure.
- Bundle fingerprints attribute a copy to a user. They do not prevent copying.
- A password-protected runtime bundle protects the file at rest and against casual opening. It does not stop a person who knows the password from reading the data.

Distribute an app only to people you trust with everything the app and its credentials can reach. The [security model](../cloud/security) describes the design in detail.

## Your responsibilities as a developer

You host, secure, and back up any PostgreSQL database your app uses. ixtable Cloud does not back up PostgreSQL records, and restoring an archive does not restore them. You choose the TLS settings of your database connections. If you confirm the warning for a connection without TLS, you accept the risk of credentials and data crossing the network unencrypted.

You must have the right to distribute the app, its data, and its credentials to the people you invite. Do not use ixtable Cloud to distribute malware, to collect credentials under false pretenses, or to process data you are not allowed to process.

## Plans and billing

Plans are priced per cloud app and include a runtime user allowance. The owner of an app, or an organization member with the billing role, manages its subscription from the app's Billing tab. Stripe processes payments.

When an app exceeds its allowance or its subscription becomes inactive, runtime users cannot accept invitations, install, sync, or get key grants until the plan is upgraded or renewed. A past-due subscription keeps access for a 7-day grace period. You can cancel at any time. Cancellation takes effect at the end of the paid period.

## Your data

You own the apps, archives, and records you upload. You grant ixtable the rights needed to store them, process them, and deliver them to the people you authorize. You can export your account data and delete your account from the [account page](/account). The [privacy policy](./privacy) describes what we collect and keep.

## Availability and changes

We operate ixtable Cloud with care but do not guarantee uninterrupted service. Runtime installations keep working offline with their local records when the service is unavailable, until a key grant expires. We may change these terms and will announce material changes on this site before they take effect.

## Termination

You can stop using ixtable Cloud at any time by deleting your apps and your account. We may suspend accounts that break these terms or put other users or the service at risk.
