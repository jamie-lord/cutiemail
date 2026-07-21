# cutiemail site

The docs + marketing site for cutiemail, served at [cuti.email](https://cuti.email).

It is a small, hand-rolled static generator — no framework, in keeping with the project. The
homepage (`pages/home.html`) is bespoke, built to the brand design. Every docs page is rendered
from the repository's **own markdown** (`README.md`, `docs/*`, the ADRs), so the published docs and
the repo docs are literally the same files — there is nothing to keep in sync.

This is a separate sub-project with its own dependencies, so the mail server's `package.json` stays
zero-dependency.

## Build & preview

```sh
cd site
npm install
npm run build          # renders the repo's markdown into ./dist
npx wrangler dev       # preview locally (or serve ./dist with any static server)
```

## How it deploys

`site/build.mjs` writes static HTML to `site/dist`, which Cloudflare Workers serves as static
assets (`wrangler.jsonc`). A GitHub Actions workflow (`.github/workflows/deploy-site.yml`) rebuilds
and deploys on every push to `main` that touches a published source — the docs, the README, or
this directory. No manual step, and a new ADR appears automatically (the sidebar is generated from
`docs/decisions/`).

## What lives where

- `build.mjs` — the generator: markdown → HTML, internal-link rewriting, sidebar, mermaid.
- `styles/site.css` — the brand design system (tokens + components).
- `pages/home.html` — the homepage content.
- `assets/` — Cuti (the mascot) as SVGs.
- `wrangler.jsonc` — the Cloudflare Workers static-assets + custom-domain config.
