import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const features = [
  {number: '01', title: 'A clear view of every project', text: 'See owners, status, and recent activity in one calm, sortable workspace.'},
  {number: '02', title: 'Fast, focused workflows', text: 'Search, filter, select, and update work without hopping between screens.'},
  {number: '03', title: 'Built for shared momentum', text: 'Give everyone the same live view, from first draft through final review.'},
];

function ProductPreview(): ReactNode {
  return (
    <div className={styles.previewShell} aria-label="Preview of the ixtable project workspace">
      <div className={styles.previewTopbar}>
        <span className={styles.previewLogo}>ix</span>
        <span className={styles.previewBrand}>ixtable</span>
        <span className={styles.previewSearch}>⌕&nbsp;&nbsp; Search projects</span>
        <span className={styles.avatar}>MC</span>
      </div>
      <div className={styles.previewBody}>
        <aside className={styles.previewSidebar}>
          <span className={styles.sideActive}>▦&nbsp;&nbsp; Projects</span>
          <span>◫&nbsp;&nbsp; Overview</span>
          <span>⚙&nbsp;&nbsp; Settings</span>
        </aside>
        <div className={styles.previewContent}>
          <div className={styles.previewHeading}>
            <div><small>WORKSPACE / PROJECTS</small><h3>Projects</h3></div>
            <button type="button">＋ New project</button>
          </div>
          <div className={styles.tableHead}><span>PROJECT</span><span>OWNER</span><span>STATUS</span><span>UPDATED</span></div>
          {[
            ['Website refresh', 'Maya Chen', 'Active', 'Today'],
            ['Q3 campaign', 'Noah Williams', 'Review', 'Yesterday'],
            ['Mobile research', 'Ava Patel', 'Draft', 'Aug 12'],
            ['Customer stories', 'Liam Scott', 'Active', 'Aug 10'],
          ].map((row) => (
            <div className={styles.tableRow} key={row[0]}>
              <span><b>{row[0]}</b><small>Shared workspace</small></span>
              <span>{row[1]}</span><span><i data-status={row[2]} />{row[2]}</span><span>{row[3]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout title="Work, clearly organized" description="A focused project workspace for teams that want less admin and more momentum.">
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.eyebrow}>THE CALM WAY TO RUN PROJECTS</div>
          <h1>Keep every project<br /><em>beautifully clear.</em></h1>
          <p>ixtable brings projects, owners, and progress into one focused workspace—so your team always knows what moves next.</p>
          <div className={styles.actions}>
            <Link className={styles.primaryButton} to="/login">Get started free <span>→</span></Link>
            <Link className={styles.textButton} to="/docs/intro">Explore the docs <span>↗</span></Link>
          </div>
          <p className={styles.microcopy}>Simple setup · Built for desktop · Your work stays yours</p>
          <ProductPreview />
        </section>

        <section className={styles.statement}>
          <p className={styles.kicker}>ONE PLACE FOR THE WORK THAT MATTERS</p>
          <h2>Less time managing work.<br />More time <em>moving it forward.</em></h2>
          <div className={styles.featureGrid}>
            {features.map((feature) => (
              <article key={feature.number}>
                <span>{feature.number}</span><h3>{feature.title}</h3><p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.splitSection}>
          <div className={styles.photoWrap}>
            <img src="https://images.unsplash.com/photo-1680963551392-f17f6d9eca71?auto=format&fit=crop&w=1400&q=85" alt="A tidy workspace with a notebook, keyboard, and monitor" loading="eager" />
            <span className={styles.photoNote}>A calmer workspace<br />starts with a clearer view.</span>
          </div>
          <div className={styles.splitCopy}>
            <span className={styles.sectionNumber}>/ 01</span>
            <p className={styles.kicker}>ORGANIZE</p>
            <h2>Everything in its place. Nothing in your way.</h2>
            <p>Turn a scattered list of initiatives into a workspace your whole team can understand at a glance. Flexible enough for the way you already work, structured enough to keep everyone aligned.</p>
            <Link to="/docs/intro">See how ixtable works <span>→</span></Link>
          </div>
        </section>

        <section className={styles.workflowSection}>
          <div className={styles.workflowCopy}>
            <span className={styles.sectionNumber}>/ 02</span>
            <p className={styles.kicker}>FOCUS</p>
            <h2>Find the signal.<br />Move with confidence.</h2>
            <p>Filter down to what needs attention, make changes in a few clicks, and trust that the latest state is always close at hand.</p>
          </div>
          <div className={styles.statusCard}>
            <div className={styles.statusHeader}><span>Project health</span><b>12 projects</b></div>
            <div className={styles.statusBars}><i /><i /><i /></div>
            <div className={styles.statusLegend}><span><b>7</b> Active</span><span><b>3</b> Review</span><span><b>2</b> Draft</span></div>
            <div className={styles.saved}><span>✓</span><div><b>Changes saved</b><small>Your workspace is up to date</small></div></div>
          </div>
        </section>

        <section className={styles.cta}>
          <p className={styles.kicker}>YOUR NEXT PROJECT STARTS HERE</p>
          <h2>Make space for<br /><em>better work.</em></h2>
          <p>Bring clarity to your projects in minutes.</p>
          <Link className={styles.primaryButton} to="/login">Start using ixtable <span>→</span></Link>
        </section>
      </main>
    </Layout>
  );
}
