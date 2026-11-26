# CSIR–IIP Training Center & Guest House Inventory

React + TypeScript + Vite inventory application for CSIR–Indian Institute of Petroleum, now running on **Firebase Authentication + Cloud Firestore + Vercel serverless functions**.

```
Browser (React, Firebase Auth SDK)
   │  Authorization: Bearer <Firebase ID token>
   ▼
Vercel serverless function  api/[...path].mjs   (Node 22, one function, Hobby-plan friendly)
   │  firebase-admin: verifyIdToken → users/{uid} (role, disabled) → permission check
   ▼
Cloud Firestore  (users, inventory, activityLogs, locations, appConfig)
```

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for environment variables, Firebase setup and Git commands.

## Project layout

| Path | Purpose |
|---|---|
| `src/` | React UI (`App.tsx`), Firebase client helpers (`firebase.ts`), styles |
| `api/[...path].mjs` | Vercel entry point; every `/api/*` request |
| `server/app.mjs` | Router, token verification, server-side permission checks |
| `server/store.mjs` | Firestore data layer: seeding, transactions, import apply, reset |
| `server/users.mjs` | User profiles and Firebase Admin account management |
| `server/import.mjs` | CSV/XLSX parsing and import validation (unchanged from the original) |
| `server/xlsx.mjs` | Excel export (same four worksheets as before) |
| `server/index.mjs` | Local/self-hosted server running the same handler (not used on Vercel) |
| `firestore.rules` | Deny-all client rules; the Admin SDK bypasses them |
| `tests/` | API tests against an in-memory Firestore/Auth fake |

## Roles

| Role | Permissions |
|---|---|
| Administrator | view, export, stock, edit, delete, reset, manageUsers |
| Manager | view, export, stock, edit |
| Viewer | view, export |

Roles are read from `users/{uid}` on the server for every request; nothing sent by the browser can change them.

## Firestore data model

- `users/{uid}` – `email`, `username`, `role`, `disabled`, `createdAt`
- `inventory/{itemId}` – `name`, `category`, `qty`, `unit`, `min`, `description`, `alloc` (location → qty), `roomMin` (location → minimum), `sample`, `createdAt` (+ internal `nameKey` used to enforce unique names)
- `activityLogs/{logId}` – `ts`, `date`, `type`, `item`, `itemId`, `qty`, `loc`, `note`, `actor`, `actorUid`, `sample`
- `locations/{id}` – `name`, `group`, `groupOrder`, `order`
- `appConfig/current` – seeding flags and reset audit

## API

All routes require `Authorization: Bearer <ID token>` except `GET /api/health` and `GET /api/auth/status`.

| Route | Permission |
|---|---|
| `GET /api/auth/me` | any active user |
| `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id` | manageUsers |
| `GET /api/state` | view |
| `GET /api/export` | export |
| `POST /api/stock-in`, `/api/issue`, `/api/return`, `/api/room-action` | stock |
| `POST /api/import` | stock (`mode: "set"` also needs edit) |
| `PATCH /api/room-minimum` | edit |
| `PUT /api/items/:id` | edit |
| `DELETE /api/items/:id` | delete |
| `POST /api/reset` | reset |

`POST /api/room-action` takes `{ action: "consume" | "damage" | "missing" | "return", itemId, location, qty, date?, note? }`.

## Local development

```bash
cp .env.example .env     # fill in the Firebase values
npm ci
npm run dev              # Vite on :5173, API on :3001 (same handler as Vercel, real Firebase)
npm test                 # API tests (no Firebase needed)
npm run build            # type-check + production build
```

`vercel env pull .env.local` also works and is read automatically.
