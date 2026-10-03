import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import styles from "./pricing.module.css";

// Source: PRD.md §4.1 (free desktop edition).
const freeFeatures = [
  "Desktop Studio and local Runtime on Windows, macOS, and Linux",
  "Create and edit `.ixt` applications",
  "Local single-user application execution",
  "SQLite and PostgreSQL record stores",
  "DuckDB read and query engine",
  "Schema, query, form, report, and dashboard designers",
  "Expressions, actions, and local triggers",
  "Application-managed attachments",
  "Local autosave, checkpoints, and recovery",
  "Share complete editable `.ixt` projects",
  "Versioned runtime-only bundle export",
  "Optional password protection for runtime-only bundles",
  "Manual distribution and update of runtime-only bundles",
];

// Source: PRD.md §4.2 (paid ixtable Cloud).
const cloudFeatures = [
  "Accounts and organizations",
  "Authenticated runtime users and custom runtime roles",
  "Private-by-default application distribution",
  "Explicit publishing of application checkpoints",
  "Automatic runtime updates on sync",
  "Signed, user-fingerprinted runtime bundles",
  "Encrypted datasource credential delivery",
  "Archive backup, versioning, and checkpoint restore",
  "Cloud audit history",
];

// Source: PRD.md §4.4 (manual versus managed distribution).
const comparison: [string, string, string][] = [
  ["Editable `.ixt` sharing", "Yes", "Yes"],
  ["Runtime-only bundle", "Yes", "Yes"],
  ["Versioned bundle export", "Yes", "Yes"],
  ["Password protection", "Yes", "Optional"],
  ["Manual file delivery", "Yes", "Optional"],
  ["Authenticated private delivery", "No", "Yes"],
  ["User fingerprinting", "No", "Yes"],
  ["Per-user entitlement and revocation", "No", "Yes"],
  ["Automatic update delivery", "No", "Yes"],
  ["Cloud archive backup and history", "No", "Yes"],
  ["Central audit history", "No", "Yes"],
];

// Source: PRD.md §4.3 (paid cloud is not).
const cloudIsNot = [
  "A managed PostgreSQL service. You run your own database.",
  "A cloud SQLite runtime. SQLite data stays on the desktop.",
  "A browser runtime. Studio and Runtime are desktop apps.",
  "A multi-developer editor. Each cloud application has one developer.",
  "A row-level SQLite synchronization engine.",
  "A self-hostable cloud control plane.",
];

function withCode(text: string): ReactNode {
  return text.split("`").map((part, index) =>
    // Odd segments sit between backticks.
    index % 2 === 1 ? <code key={part}>{part}</code> : part,
  );
}

export default function Pricing(): ReactNode {
  return (
    <Layout
      title="Pricing for the free desktop app and ixtable Cloud"
      description="The ixtable desktop app is free and open source under Apache-2.0. ixtable Cloud adds private distribution, priced per cloud application."
    >
      <main className={styles.page}>
        <header className={styles.header}>
          <h1>Pricing</h1>
          <p>
            The desktop app is free and does not need an account. You pay for ixtable Cloud only
            when you want to distribute an application privately to signed-in users.
          </p>
        </header>

        <div className={styles.plans}>
          <section className={styles.plan} aria-labelledby="plan-free">
            <h2 id="plan-free">Free desktop</h2>
            <p className={styles.price}>
              <b>US$0</b> forever
            </p>
            <p className={styles.license}>Open source under Apache-2.0.</p>
            <ul>
              {freeFeatures.map((feature) => (
                <li key={feature}>{withCode(feature)}</li>
              ))}
            </ul>
            <Link className={styles.secondaryButton} href="https://github.com/ixtable/ixtable">
              View on GitHub
            </Link>
          </section>

          <section className={styles.plan} aria-labelledby="plan-cloud">
            <h2 id="plan-cloud">ixtable Cloud</h2>
            <p className={styles.draft}>Planned pricing. Subject to change before launch.</p>
            <p className={styles.price}>
              <b>US$19</b> per cloud application per month
            </p>
            <ul className={styles.terms}>
              <li>Includes 5 runtime users</li>
              <li>US$4 per additional runtime user per month</li>
              <li>Annual billing gets 2 months free</li>
            </ul>
            <p>Everything in the free desktop app, plus:</p>
            <ul>
              {cloudFeatures.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <Link className={styles.primaryButton} to="/#waitlist">
              Join the waitlist
            </Link>
          </section>
        </div>

        <section className={styles.section} aria-labelledby="compare">
          <h2 id="compare">Manual versus managed distribution</h2>
          <p>
            Free users can share editable projects or locked runtime-only bundles by hand. Cloud
            adds identity, per-user bundles, automatic updates, revocation, and recovery.
          </p>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Free</th>
                  <th scope="col">Cloud</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([capability, free, cloud]) => (
                  <tr key={capability}>
                    <td>{withCode(capability)}</td>
                    <td>{free}</td>
                    <td>{cloud}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="cloud-is-not">
          <h2 id="cloud-is-not">What Cloud is not</h2>
          <ul>
            {cloudIsNot.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </main>
    </Layout>
  );
}
