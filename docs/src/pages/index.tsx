/**
 * The landing page. Docs live at `routeBasePath: "/"` but no doc claims the
 * root slug, so this React page owns it — the standard Docusaurus split
 * between a marketing front door and the docs behind it.
 */
import Link from "@docusaurus/Link";
import CodeBlock from "@theme/CodeBlock";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import styles from "./index.module.css";

const HERO_SAMPLE = `import { computed, signal } from "dziry";

export const count = signal(0);
export const label = computed(() => \`clicked \${count} times\`);

export default function Counter() {
  return (
    <button
      className="rounded-lg bg-sky-600 px-4 py-2 text-white"
      onClick={() => count.set(count + 1)}
    >
      {label}
    </button>
  );
}`;

const FEATURES: { title: string; body: ReactNode }[] = [
  {
    title: "Compiled ahead of time",
    body: (
      <>
        Your components run once, at build time. Selectors, specificity and
        inheritance are resolved into a table of integers — the app ships no
        CSS parser and no virtual DOM, and an idle frame costs nothing.
      </>
    ),
  },
  {
    title: "A native engine",
    body: (
      <>
        A Rust engine draws the window with Skia and lays it out with Taffy.
        The two sides share memory: a style change or a route switch is a
        handful of byte writes, not a render.
      </>
    ),
  },
  {
    title: "Signals without ceremony",
    body: (
      <>
        <code>count * 2</code> just works. No <code>.value</code>, no
        dependency arrays — reads are rewritten at build time and typed so the
        same expression also satisfies <code>tsc</code>.
      </>
    ),
  },
  {
    title: "Real CSS, real Tailwind",
    body: (
      <>
        Your project's own Tailwind runs during the compile. A utility outside
        the supported subset is a build warning naming the property — never a
        silent no-op.
      </>
    ),
  },
  {
    title: "Typed routes and forms",
    body: (
      <>
        File-based routes with <code>href</code>s checked against the route
        table at build time. Form payloads are typed from the markup itself —
        a checkbox arrives as <code>boolean</code>.
      </>
    ),
  },
  {
    title: "One executable",
    body: (
      <>
        <code>dziry build</code> bundles your app and the engine into a single
        binary — the same code path <code>dziry dev</code> runs, with nothing
        to install on the user's machine.
      </>
    ),
  },
];

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroText}>
          <h1 className={styles.heroTitle}>
            Desktop apps in TypeScript, HTML&nbsp;and&nbsp;CSS
          </h1>
          <p className={styles.heroSubtitle}>
            Compiled ahead of time. Rendered by a native engine.
            <br />
            No browser, no DOM, no webview.
          </p>
          <div className={styles.heroActions}>
            <Link
              className="button button--primary button--lg"
              to="/learn/getting-started/quick-start"
            >
              Get started
            </Link>
            <Link
              className="button button--secondary button--outline button--lg"
              to="/learn/getting-started/what-is-dziry"
            >
              What is dziry?
            </Link>
          </div>
          <div className={styles.heroInstall}>
            <CodeBlock language="bash">bun create dziry my-app</CodeBlock>
          </div>
        </div>
        <div className={styles.heroCode}>
          <CodeBlock language="tsx" title="windows/main/pages/index.tsx">
            {HERO_SAMPLE}
          </CodeBlock>
        </div>
      </div>
    </header>
  );
}

function Pipeline() {
  return (
    <section className={styles.pipeline}>
      <div className={styles.pipelineInner}>
        <div className={styles.pipelineStep}>
          <span className={styles.pipelineIndex}>1</span>
          <h3>Write</h3>
          <p>TSX components, Tailwind classes, plain CSS — the authoring model you already know.</p>
        </div>
        <div className={styles.pipelineArrow} aria-hidden="true">→</div>
        <div className={styles.pipelineStep}>
          <span className={styles.pipelineIndex}>2</span>
          <h3>Compile</h3>
          <p>Components run once; the cascade resolves to numbers; the result is typed arrays.</p>
        </div>
        <div className={styles.pipelineArrow} aria-hidden="true">→</div>
        <div className={styles.pipelineStep}>
          <span className={styles.pipelineIndex}>3</span>
          <h3>Render</h3>
          <p>A Rust engine — Skia, Taffy, SDL3 — draws the window from shared memory.</p>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className={styles.features}>
      <div className={styles.featureGrid}>
        {FEATURES.map((f) => (
          <div key={f.title} className={styles.featureCard}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Beta() {
  return (
    <section className={styles.beta}>
      <p>
        dziry is in <strong>beta</strong> on Windows, macOS and Linux. Every
        API is tracked <em>done</em>, <em>partial</em> or <em>planned</em> in
        the <Link to="/reference">reference</Link>, and the status badges are
        generated from the project's tracking table at build time.
      </p>
    </section>
  );
}

export default function Home() {
  return (
    <Layout description="Desktop apps in TypeScript, HTML and CSS — compiled ahead of time, rendered by a native engine. No browser, no DOM, no webview.">
      <Hero />
      <Pipeline />
      <Features />
      <Beta />
    </Layout>
  );
}
