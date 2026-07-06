# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

## Agent skills

### Issue tracker

This project uses **bd (beads)** for issue tracking.

Quick reference:
- `bd create "Title" --type task --priority 2` — Create a new issue
- `bd create-form` — Interactive form
- `bd label add <id> <label>` — Add label to issue
- `bd set-state <id> <state>` — Set operational state
- `bd close <id>` — Close issue
- `bd list` — List open issues
- `bd show <id>` — Show issue details
- `bd ready` — Find unblocked work
- `bd github sync` — Sync with GitHub (when needed)

### Triage labels

Five canonical triage roles, all using default strings:

| Role | Label | Meaning |
|---|---|---|
| Needs evaluation | `needs-triage` | Maintainer needs to evaluate this issue |
| Waiting on reporter | `needs-info` | Waiting for more information |
| Ready for AFK agent | `ready-for-agent` | Fully specified, AFK-ready |
| Needs human | `ready-for-human` | Requires human implementation |
| Won't fix | `wontfix` | Will not be actioned |

### Domain docs

Single-context layout:
- `CONTEXT.md` at repo root (not yet created — created lazily by /grill-with-docs when terms get resolved)
- `docs/adr/` for architectural decisions (not yet created)
- Skills that read domain docs will look for these files and proceed silently if absent

## Child DOX Index

| Path | Scope |
|---|---|
| `docs/` | Project documentation, plans, ADRs, PRDs. See `docs/plan.md` for implementation plan, `docs/prd-error-state-invisibility.md` for the error invisibility PRD, `docs/prd-cooldown-escalation.md` for the escalating cooldown + SQLite backend PRD, `docs/prd-ctw-dynamic-update.md` for the dynamic context window update PRD, and `docs/prd-cost-usage.md` for the cost & usage tracking PRD. |
| `extensions/` | Extension source code + tests (10 modules, ~1000 lines). Custom model router pi extension with fallback chain. Vitest unit tests in `*.test.ts`. See `docs/plan.md` for full spec. |
| `README.md` | Project overview, instalasi, konfigurasi, usage, commands, features, development guide, dan lisensi dalam Bahasa Indonesia. |
| `package.json` | Root project manifest: pi extension registration, scripts (`npm test` → vitest, `npm run typecheck` → tsc), devDependencies. |
| `tsconfig.json` | TypeScript configuration: strict, ESNext, bundler resolution. |
| `model-router.example.json` | Example user configuration for the model router extension. |
| `.gitignore` | Project-wide ignores: node_modules/, dist/, .pi/plans/, *.log. |
