# 07 — Atlas experience (synthesis)

Workstream: make the primary Atlas workflows — connect, sync, wallet, managed compute — noticeably smoother. This is the **connective-tissue** workstream: it folds in the concrete fixes from [02 codex](02-codex-oauth.md), [03 sync](03-atlas-sync.md), [06 compute](06-compute-integrations.md), and [08 wallet](08-wallet-usage-settings.md), and adds the cross-cutting glue those don't own. Citations `file:line`.

## Current state — the Atlas surface is fragmented

A user touches "Atlas" through many disjoint seams, each in a different place and shape:

- **Connect / identity** — CLI `openscience login/logout/status/sync/devices` (shipped v1.2.5); **the browser can't log in at all** (`browserLogin` exists but is unwrapped — see [04](04-onboarding-setup.md)).
- **Sync** — the per-command staleness probe + `syncServices()`, with real correctness bugs (shell-export clobber → billing flip; 402 strands stale creds; non-atomic writes) — see [03](03-atlas-sync.md).
- **Wallet / usage** — split across `Spend`/`Usage`/`General` panels + `openscience wallet`; only a scalar balance from Atlas; `/api/credits*` never called; no ledger/auto-topup/usage-history — see [08](08-wallet-usage-settings.md).
- **Managed compute** — the `atlas compute:*` suite exists in the published atlas CLI (0.13.2) but OpenScience pins `@synsci/atlas@^0.5.12`, so it's version-gapped and the managed prompt can't resolve — see [06](06-compute-integrations.md).
- **Codex** — tokens are pushed to Atlas but have **zero consumers** (status-dot only) — see [02](02-codex-oauth.md).
- **The `atlas` companion CLI** — SSO-seeded from the OpenScience session (`ensureAtlasCliConfig`), `atlas doctor` healthy, but the version drifts (pinned 0.5.12 vs installed 0.13.1 vs latest 0.13.2).

## What's broken / missing (the cross-cutting glue)

1. **No single "Atlas" status surface.** Connection, identity, entitlements/plan, wallet balance, usage, managed-compute availability, and atlas-CLI health live in ≥5 different places (`connect status`, `Spend`, `Usage`, `General`, `Compute`, `atlas doctor`). There's no one view (CLI or browser) that answers "what's my Atlas state?"
2. **Version drift across the atlas integration.** `@synsci/atlas` pinned `^0.5.12` (`backend/cli/package.json`) while latest is 0.13.2 — this simultaneously breaks managed compute ([06](06-compute-integrations.md)), risks other atlas-CLI command drift, and means the companion the wizard installs (`@synsci/atlas@latest` = 0.13.2) diverges from what OpenScience expects.
3. **BYOK keys live in three unreconciled stores** — local Compute panel, local Credentials panel, and Atlas server-side `compute_keys_service` (see [06](06-compute-integrations.md)) — different execution contexts, no source of truth.
4. **Entitlement changes are invisible** — a lapsed plan silently strands managed creds until a call 402s (see [03](03-atlas-sync.md)); nothing proactively tells the user "your Atlas plan changed."
5. **Managed spend is opaque** — no usage history/ledger/auto-topup surfaced (see [08](08-wallet-usage-settings.md)).
6. **Naming/brand incoherence** — "Atlas" vs "Thesis" (`THESIS_*` env, session `thk_`) vs `synsci` (provider id) vs "Daytona/Modal/Atlas-provisioned" (compute substrate). A user sees three names for one platform.

## Proposed change — one coherent Atlas surface (built on 02/03/06/08)

- **A1 — Unified Atlas status.** Extend `openscience status`/`doctor` (CLI) and add a browser **Atlas** settings section that shows, in one place: connection + identity + plan/entitlements + wallet balance + recent usage + managed-compute availability + `atlas` CLI version/health. Reuse `getBillingMode`/`getCredits` ([08](08-wallet-usage-settings.md)) and fold `atlas doctor` output in. This is the primary net-new deliverable of this workstream.
- **A2 — Align the atlas-CLI version.** Bump `@synsci/atlas` to `^0.13.2` (fixes compute [06](06-compute-integrations.md) and general parity); add a version/health probe to `doctor` that warns when the installed companion drifts from the expected range; keep the SSO seeding.
- **A3 — Reconcile the BYOK stores** ([06](06-compute-integrations.md) cross-cutting) — pick a source of truth (recommend: local stores authoritative for local skill runs; Atlas server-side vault for managed sandboxes; a clear one-way sync + labeling so a key isn't silently shadowed).
- **A4 — Surface entitlement + spend changes** — land [03](03-atlas-sync.md) P4 (visible 402/entitlement notice) and [08](08-wallet-usage-settings.md) (wallet/usage/auto-topup) so the Atlas state is legible, not discovered via a failed call.
- **A5 — Browser Atlas login** — land [04](04-onboarding-setup.md)'s bridge route so managed Atlas is usable without a terminal.
- **A6 — Name/brand pass** — one user-facing name ("Atlas") across copy; keep the wire-contract identifiers (`synsci`, `thk_`, `THESIS_*`) internal and unchanged (CLAUDE.md forbids renaming the provider id), but stop showing the internal names to users.

## Risks

- This workstream is **downstream of 02/03/06/08** — sequence it after (or alongside) those; on its own it's mostly aggregation + naming.
- The version bump (A2) could surface behavior changes between atlas-CLI 0.5.x and 0.13.x — test the companion's commands OpenScience actually invokes (`project init`, config seeding, any exec) before bumping.
- The unified status surface (A1) must degrade gracefully when signed out / offline / Atlas endpoints absent (same discipline as [08](08-wallet-usage-settings.md)).
- Naming changes (A6) are broad copy edits — batch + review; never touch the wire contract.
- Several items need **owner + Atlas-team decisions** (BYOK source of truth, managed-compute UX direction, whether Atlas-repo changes are in scope).

## Acceptance criteria

- One command (`openscience status`/`doctor`) and one browser section answer "what's my Atlas state?" — connection, plan, wallet, usage, managed-compute availability, companion health — degrading gracefully when signed out.
- The installed `atlas` companion is on a version that matches what OpenScience expects; a drift is surfaced by `doctor`; managed compute resolves (with resale + wallet).
- A BYOK key has one documented source of truth per execution context; it is never silently shadowed.
- Entitlement/plan changes and low balance are surfaced proactively, not only via a failed call.
- Managed Atlas is fully usable from the browser (login + wallet) without a terminal.
- User-facing copy uses one name for the platform; wire identifiers stay internal.

**Depends on:** 02, 03, 04, 06, 08. **Owner decisions:** BYOK source of truth; managed-compute UX (CLI vs web dashboard); whether Atlas-repo changes ship this sprint. **Key files:** `cli/cmd/connect.ts` (status/doctor), `cli/onboard.ts`, `openscience/index.ts`, `components/settings/{Spend,Usage,General,Compute}.tsx`, `backend/cli/package.json` (version pin), `session/prompt.ts` + `config.ts` (naming/substrate). Atlas: `routes/{cli,credits,compute}.py`.
