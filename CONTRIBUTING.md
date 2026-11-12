# Contributing to SunShade Syndication

Welcome to `sunshade-syndication` (`publish.sunshade.icu`), the decoupled outbound social publishing and scheduling worker for SunShade Systems.

## Prerequisites

- **Node.js** >= 20 and **npm** >= 10 (npm workspaces only — do not use Yarn or pnpm)
- **Docker** (optional, only required for `npm run test:db` against local Supabase)

## Local Setup

1. Install workspace dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template if running locally or seeding test data (never commit `.env` or `.dev.vars`):

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell, chain commands with `;` rather than `&&`. Always use `-stag` subdomains (`publish-stag.sunshade.icu`, `links-stag.sunshade.icu`) for non-production environments.

## Running Tests & Verification

- **Typecheck all workspaces:**
  ```bash
  npm run typecheck
  ```
- **Run fast unit tests (`< 2s`, zero Docker/network required):**
  ```bash
  npm test
  ```
- **Run local Docker Supabase integration tests (`127.0.0.1:54321`):**
  ```bash
  npm run test:db
  ```
- **Seed Tenant 0 & dummy channels into local dev database:**
  ```bash
  npm run seed:mock
  ```
- **Build all workspaces:**
  ```bash
  npm run build
  ```

## Database Migration Law

**Do not add `.sql` migration files to this repository.** All PostgreSQL schemas (`syndication.*`), `pgsodium` encrypted columns, and RLS policies live exclusively in `sunshade-db-platform/supabase/migrations/`. This repository contains only TypeScript interfaces, Zod schemas, and Supabase client wrappers targeting the `syndication` schema.

## Branching, Commits & Pull Requests

1. **Branch from `staging`** using your SunShade Tracker reference ID:
   ```bash
   git checkout staging
   git pull origin staging
   git checkout -b feat/<task-ref-id>-<slug>
   ```
2. **Sign off every commit (DCO)** with `git commit -s`:
   ```bash
   git commit -s -m "feat(syndication): [<task-ref-id>] concise summary"
   ```
3. **Target PRs to `staging`** (never commit directly to `main` or `staging`).
4. **Reference the Tracker `external_ref_id`** (e.g., `SYN-123`) in your PR description and verify `npm run typecheck`, `npm test`, and `npm run build` pass before opening the PR.
