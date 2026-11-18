# EQIP Release 1

EQIP is an internal quality portal foundation with a React/Vite frontend, NestJS API and file-backed SQLite. Its identity adapter is for local development only, not enterprise SSO. Do not deploy this adapter or the compose defaults to production or expose them publicly.

## Implemented features

- Development sign-in and role-based access: administrators and executives have enterprise-wide inventory access; other roles see only assigned segments. The API reloads current roles and assignments from SQLite.
- Segment and application inventory: administrators can create and edit segments and applications; users can search their accessible applications. Application records include owner, lifecycle, criticality and an optional quality score. An absent score is shown as unavailable.
- User administration: administrators can create local development accounts, update roles, status and segment assignments, and view access-change audit history. Disabling an account invalidates its sessions; the last active administrator cannot be disabled or demoted.
- Overview and reporting: scoped counts and per-segment application breakdowns come from persisted inventory, including counts of scored and unscored applications. Administrators and executives can export accessible application records as CSV; owner details are excluded.

Authenticated API endpoints include `/api/v1/segments`, `/api/v1/applications`, `/api/v1/users`, `/api/v1/users/audit`, `/api/v1/reports/overview` and `/api/v1/reports/applications.csv`. Inventory and user mutations require an administrator; CSV export requires an administrator or executive.

## Scope and limitations

Enterprise SSO, external integrations, Releases 2–7, production quality scoring, and historical or predictive scores are out of scope. Production authentication is blocked until an approved SSO integration is implemented; setting `NODE_ENV=production` disables development login and sessions. This is not a production-ready deployment or an enterprise availability, backup, concurrency or disaster-recovery guarantee.

## Requirements

Node.js 22.13 or newer (the backend uses the built-in `node:sqlite` API), npm, and optionally Docker Compose. Node may report SQLite as experimental. From the repository root:

```sh
cd backend
npm install
cp .env.example .env
npm run build
npm start
```

In a second terminal:

```sh
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. The Vite server proxies `/api` to the backend. The example account is `admin@example.test` and the example password is `local-development-password`; replace both and the signing secret for your local environment. `.env` is ignored by git. The seed is created only when no account exists with the configured email; changing the environment password does not reset an existing account. Delete only your own development database if you intentionally want a fresh seed. SQLite defaults to `backend/data/eqip.sqlite`; initialization upgrades supported older databases to schema version 3 and rejects schemas newer than version 3.

Alternatively, `docker compose up --build` runs the explicitly development-only stack at http://localhost:8080 and stores SQLite in the `eqip-data` volume. Configure the `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`, and `SESSION_SECRET` shell variables before starting to override the insecure examples. Compose is not a production deployment. Back up the volume separately if its development data matters.

## Identity and safety

`POST /api/v1/auth/login` accepts JSON `{ "email": "...", "password": "..." }` and returns a signed eight-hour bearer token and public user. `GET /api/v1/auth/me` requires that bearer token and loads current role and segment assignments from SQLite. `GET /api/health` is public. The password is salted and scrypt-hashed on initial seeding. The adapter is enabled only when `DEV_LOGIN_ENABLED=true` and `NODE_ENV` is not `production`; both login and existing sessions fail closed in production. Use a random `SESSION_SECRET` of at least 32 characters. The browser stores the token in sessionStorage for the current tab; sign-out removes it locally but does not revoke a copied token before expiry. Protect the development environment from untrusted access: this adapter does not provide rate limiting, account recovery, sign-out token revocation, SSO, or production hardening. Disabling an account invalidates its existing sessions. SQLite is not an enterprise availability, backup, or concurrency guarantee.

## Tests

After installing dependencies in both tiers, run the complete backend suite (including API and cross-feature integration tests) and frontend component suite from the repository root:

```sh
cd backend
npm test
cd ../frontend
npm test
```

The following existing commands run the focused identity tests and builds:

```sh
cd backend
node node_modules/vitest/vitest.mjs run test/auth.spec.ts
npm run build
cd ../frontend
node node_modules/vitest/vitest.mjs run src/auth/Login.test.tsx
npm run build
```

If SQLite reports a readonly database or locking error on a mounted workspace, set `DATABASE_PATH` to a writable local filesystem (for example `/tmp/eqip-dev/eqip.sqlite` in the Linux sandbox); `/tmp` is ephemeral and is not a persistent deployment location. The API tests use a temporary file on the Linux guest's local `/tmp` filesystem.

Playwright starts both services automatically on ports 3107 and 5177, builds the backend, and uses a fresh file-backed SQLite database in a unique `/tmp/eqip-playwright-*` directory for each invocation. It never reuses an existing service; free those ports first. Install dependencies in both tiers and Playwright Chromium with `cd frontend && node node_modules/@playwright/test/cli.js install chromium`, then run `node node_modules/@playwright/test/cli.js test`. Node 22.13+ is required. Set `E2E_EMAIL` and `E2E_PASSWORD` together to override the local-only seed credentials; the password must be at least 12 characters. The database directories are ephemeral but are not automatically deleted; remove only your own `/tmp/eqip-playwright-*` directories when finished. Screenshots and failure traces are in Playwright's test output and results in `frontend/e2e-results.json`. These tests are not a substitute for security or production-readiness testing.
