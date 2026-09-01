# alice-core

The Alice engine, packaged. Every tenant repository installs a pinned version of
this and calls it through one command:

```bash
npx alice plan --days 1
npx alice publish
npx alice verify
```

## Why this is a package

`src/` used to be copied into each tenant. Six features shipped into the Operra
install in a single day and reached none of the copies. A fix found on install
number three has to reach installs one and two, or the fleet becomes a set of
permanently different products sharing a name.

Pinning is per tenant, so a nervous client can stay on an older version while the
rest move.

## The working directory IS the tenant

Every path resolves from the process working directory, not from this package.
`src/paths.js` explains why: resolving relative to the module would point at
`node_modules/alice-core/`, and the engine would read an empty queue and write
posters into `node_modules` without ever throwing.

Set `ALICE_TENANT_DIR` to run against a tenant from elsewhere.

## What stays in the tenant repository

```
brands/brand/     the brand pack — colours, pillars, facts, logos
state/            queue, history, config, plan ceiling, licence cache
public/           rendered posters and reels, served by GitHub Pages
reel/             the HyperFrames project (assets and config)
.github/workflows the schedule
```

Everything else lives here.
