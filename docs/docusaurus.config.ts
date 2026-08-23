/**
 * The docs site.
 *
 * Two things here are not boilerplate and should not be "cleaned up":
 *
 * - `future.v4` switches the bundler from webpack to Rspack (`@docusaurus/faster`).
 *   It is stable as of 3.10 and is roughly 3× faster cold, 2–5× on rebuilds.
 * - `remarkCitations` fails the build on a rotted `file.ts:LINE` citation, using the
 *   same resolver as `bun run doc-lint`. That is the point of this site being built
 *   rather than merely written.
 *
 * Search is `@easyops-cn/docusaurus-search-local` rather than Algolia: DocSearch
 * requires a *public* site to qualify, and dziry is not published yet. Swapping to
 * Algolia later is a themeConfig change, nothing more.
 */
import { themes as prismThemes } from "prism-react-renderer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

import remarkCitations from "./src/remark/citations.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * Citations link to the public repo by default; `DZIRY_SOURCE_URL` overrides it —
 * useful for a fork, or for pointing at a branch while reviewing.
 */
const SOURCE_URL =
  process.env.DZIRY_SOURCE_URL ?? "https://github.com/dziry-dev/dziry/blob/main/{path}#L{line}";

const citations = [
  remarkCitations,
  {
    root: REPO_ROOT,
    sourceUrl: SOURCE_URL,
    // `docs start` should not die on a citation while you are mid-edit; `docs:build`
    // must. This is the only difference between the two modes.
    warnOnly: process.env.NODE_ENV === "development",
  },
];

const config: Config = {
  title: "dziry",
  tagline: "A UI framework that does its work before the app runs",
  favicon: "img/favicon.svg",

  url: "https://dziry.dev",
  baseUrl: "/",
  trailingSlash: false,

  // The repo is unpublished, so a broken link is a mistake we can still fix cheaply.
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  onDuplicateRoutes: "throw",

  future: {
    // Rspack + SWC + Lightning CSS. Requires `@docusaurus/faster`, which is a dep.
    v4: true,
  },

  i18n: { defaultLocale: "en", locales: ["en"] },

  markdown: {
    format: "detect",
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: "throw" },
  },
  themes: ["@docusaurus/theme-mermaid"],

  presets: [
    [
      "classic",
      {
        docs: {
          path: "docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          remarkPlugins: [citations],
          showLastUpdateTime: true,
          // A doc without an explicit position should not silently sort by filename.
          sidebarCollapsed: false,
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    // Both read facts that already exist elsewhere in the repo, rather than letting
    // the docs keep a second copy: `API.md` for what works, `guards/architecture/data.ts`
    // for the pipeline and the guards.
    "./src/plugins/api-status.ts",
    "./src/plugins/arch-data.ts",
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: "/",
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "dziry",
      items: [
        { type: "docSidebar", sidebarId: "learn", position: "left", label: "Docs" },
        { type: "docSidebar", sidebarId: "reference", position: "left", label: "Reference" },
        { type: "docSidebar", sidebarId: "architecture", position: "left", label: "Architecture" },
        { type: "docSidebar", sidebarId: "contributing", position: "left", label: "Contributing" },
      ],
    },
    footer: {
      style: "dark",
      copyright: "dziry — compiled UI. Docs built from a tree that is checked, not remembered.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["rust", "toml", "bash", "diff", "json"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
