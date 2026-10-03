---
sidebar_position: 1
---

# Privacy policy

_What personal data ixtable Cloud collects, why, where it is stored, and how you export or delete it._

:::note Draft

This policy describes how the service works today. It is pending legal review before the public launch of ixtable Cloud.

:::

This policy covers the ixtable website and ixtable Cloud. The ixtable desktop app works without an account and sends nothing to ixtable unless you sign in to ixtable Cloud.

## Data we collect

| Data | Why |
| --- | --- |
| Email address, display name, and linked sign-in providers | To identify your account and send invitations and password resets |
| Organizations, memberships, and roles | To decide who can manage and run each cloud app |
| App archives you publish and installation backups | To distribute, back up, and restore your apps |
| Encrypted datasource credentials | To deliver them to authorized runtime users |
| Installation and device names, last sync time, and versions | To deliver updates and let owners revoke devices |
| Audit events, with a one-way hash of the IP address | To show owners who did what, and to investigate abuse |
| Subscription status and Stripe customer ids | To bill per app and enforce plan limits |

We do not collect payment card details. Stripe processes payments under its own privacy policy. We do not read the records in your PostgreSQL database. The Runtime connects to it directly from each user's computer.

## Archives and credentials

An app archive contains the app definition and, for SQLite apps, its bootstrap records. Installation backups contain the local records of one installation. Archives are stored encrypted at rest in a private bucket. Only signed links issued to authorized users can download them.

Datasource credentials are encrypted on the developer's computer before upload. ixtable Cloud stores the ciphertext and a data key wrapped with its own key-encryption key, so the service can issue time-limited key grants to authorized runtime users. It never logs or displays credentials. The [security model](../cloud/security) describes this design.

## Where data is stored

ixtable Cloud runs on Supabase, which provides the database, authentication, file storage on S3-compatible object storage, and serverless functions. Stripe processes payments. Email is sent through the authentication provider.

## How long we keep data

Account data stays until you delete your account. Published versions and backups follow the retention settings of each app. Audit events are kept after an app or account is deleted, because they are the record of what happened, and they no longer link to your profile.

## Export and deletion

Open your [account page](/account) to export your data as a JSON file with download links for the archives you can access. From the same page you can delete your account. Deletion removes your profile and memberships. It is refused while you own an app with an active subscription, unless you also choose to cancel those subscriptions.

## Contact

Send questions or requests about your data through the contact listed on the [ixtable GitHub project](https://github.com/ixtable/ixtable).
