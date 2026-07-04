# API Discovery

**Compose ephemeral API catalogs.** This tool is built on a simple statement:

> API catalogs are relative to domains, teams, categories, and purposes — and they
> are ephemeral and ever-changing, not static central catalogs.

Rapidly build **APIs.json (APIs.yml) indexes and capability artifacts** for any
purpose — a team, a domain, a project, an agent — from one shared pool of
discovered artifacts. Regenerate them from their recipes, let them go stale, throw
them away, make new ones. Federate them with a catalog-of-catalogs instead of
centralizing them.

Live at **[discovery.apicommons.org](https://discovery.apicommons.org)**. Runs
entirely in your browser — no backend, keys stay in `localStorage`. Part of the
[API Commons](https://apicommons.org) tools, alongside
[API Reusability](https://reusability.apicommons.org) (which judges how reusable
your APIs are — this tool composes them) and
[API Validator](https://validator.apicommons.org) (deep linting).

## What it does

1. **Discover into the pool** — search or **Scan** APIs.io, GitHub/GitLab/Bitbucket,
   SwaggerHub, Postman (sources appear as you add keys, across 11 artifact types:
   OpenAPI, AsyncAPI, Arazzo, MCP, agent skills…); upload **HAR** traffic captures
   (synthesized into evidence-based OpenAPI); or **Import** a bundle from the
   [enterprise helper CLI](https://github.com/api-commons/api-reusability/tree/main/helper)
   (Backstage, Apigee/Azure APIM/MuleSoft/AWS/Kong/Tyk, Kubernetes, Kafka…).
2. **Compose catalogs** — named, purpose-scoped **views** over the pool. Type an
   intent (*"everything payments"*) and **🧠 Compose** semantic-matches the pool
   (a small embedding model runs in your browser). The same artifact can live in
   many catalogs; deleting a catalog deletes nothing.
3. **Regenerate** — every composed catalog carries its **recipe** (`x-recipe` in
   the export) and can be rebuilt against live sources anytime. Freshness badges
   are first-class: a catalog is a build artifact, not a database.
4. **Validate on index** — every artifact is linted on entry (Spectral engine,
   in-browser, per-type default rulesets) and stamped ✓/⚠/✗; catalogs roll the
   stamps up, so trust travels with the catalog.
5. **Capabilities** — inside any catalog, cluster members into named business
   capabilities (**🧠 Suggest**), pick canonicals, and ship the capability map as
   `x-capabilities` in the export.
6. **Publish & federate** — download any catalog as APIs.json (YAML), commit/PR it
   to a repo, and export a **catalog of catalogs**: an APIs.json `includes` index
   linking every purpose-built catalog.

## Getting started

Load the **demo org** set (25 synthetic APIs — instantly creates two org catalogs
from one pool) or any of **50+ real provider sets** (Stripe, Twilio, GitHub,
Claude… served cross-origin by the API Reusability project). Then 🧠 Compose a
catalog by intent and watch the same artifacts appear in multiple views.

## Develop

```bash
npm install
npm run dev      # localhost dev server
npm run build    # -> dist/ (what GitHub Pages serves)
```

Deploys to GitHub Pages via `.github/workflows/pages.yml` on push to `main`.
The Spectral lint engine and the embedding model load lazily — the initial
bundle stays the usual Monaco-sized payload.
