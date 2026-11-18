# EQIP development identity foundation

This slice provides a local-development identity adapter, not enterprise SSO. Inventory, user administration and reporting are not implemented yet. Do not deploy this adapter or the compose defaults to production or expose them publicly.

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

Open http://localhost:5173. The Vite server proxies `/api` to the backend. The example account is `admin@example.test` and the example password is `local-development-password`; replace both and the signing secret for your local environment. `.env` is ignored by git. The seed is created only when no account exists with the configured email; changing the environment password does not reset an existing account. Delete only your own development database if you intentionally want a fresh seed. SQLite defaults to `backend/data/eqip.sqlite` and uses schema version 1.

Alternatively, `docker compose up --build` runs the explicitly development-only stack at http://localhost:8080 and stores SQLite in the `eqip-data` volume. Configure the `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`, and `SESSION_SECRET` shell variables before starting to override the insecure examples. Compose is not a production deployment. Back up the volume separately if its development data matters.

## Identity and safety

`POST /api/v1/auth/login` accepts JSON `{ "email": "...", "password": "..." }` and returns a signed eight-hour bearer token and public user. `GET /api/v1/auth/me` requires that bearer token and loads current role and segment assignments from SQLite. `GET /api/health` is public. The password is salted and scrypt-hashed on initial seeding. The adapter is enabled only when `DEV_LOGIN_ENABLED=true` and `NODE_ENV` is not `production`; both login and existing sessions fail closed in production. Use a random `SESSION_SECRET` of at least 32 characters. The browser stores the token in sessionStorage for the current tab; sign-out removes it locally but does not revoke a copied token before expiry. Protect the development environment from untrusted access: this adapter does not provide rate limiting, account recovery, server-side token revocation, SSO, or production hardening. SQLite is not an enterprise availability, backup, or concurrency guarantee.

## Tests

```sh
cd backend
node node_modules/vitest/vitest.mjs run test/auth.spec.ts
npm run build
cd ../frontend
node node_modules/vitest/vitest.mjs run src/auth/Login.test.tsx
npm run build
```

If SQLite reports a readonly database or locking error on a mounted workspace, set `DATABASE_PATH` to a writable local filesystem (for example `/tmp/eqip-dev/eqip.sqlite` in the Linux sandbox); `/tmp` is ephemeral and is not a persistent deployment location. The API tests use a temporary file on the Linux guest's local `/tmp` filesystem.

The Playwright spec requires both services running, with credentials matching the configured seed. Run from `frontend` with `E2E_EMAIL` and `E2E_PASSWORD` if they differ from the examples: `node node_modules/@playwright/test/cli.js test`. Install Playwright Chromium first with `node node_modules/@playwright/test/cli.js install chromium`. The spec is not a substitute for security or production-readiness testing.
