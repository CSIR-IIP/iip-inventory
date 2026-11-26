# Deployment guide

## 1. Vercel environment variables

Set these in **Vercel → iip-inventory → Settings → Environment Variables** for Production (and Preview if you use previews). `VITE_*` values are baked in at **build time**, so redeploy after changing them.

| Variable | Used by | Secret? |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | browser | no (public identifier) |
| `VITE_FIREBASE_AUTH_DOMAIN` | browser | no |
| `VITE_FIREBASE_PROJECT_ID` | browser | no |
| `VITE_FIREBASE_STORAGE_BUCKET` | browser | no |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | browser | no |
| `VITE_FIREBASE_APP_ID` | browser | no |
| `FIREBASE_PROJECT_ID` | server | no |
| `FIREBASE_CLIENT_EMAIL` | server | **yes** – mark Sensitive |
| `FIREBASE_PRIVATE_KEY` | server | **yes** – mark Sensitive |
| `APP_TIMEZONE` (optional, default `Asia/Kolkata`) | server | no |
| `STATE_LOG_LIMIT` (optional, default `500`) | server | no |

`FIREBASE_PRIVATE_KEY` may be pasted with literal `\n` sequences (as in the JSON key file) or with real line breaks; both work.

## 2. Firebase configuration

1. **Authentication → Sign-in method:** Email/Password enabled (already done).
2. **Authentication → Settings → Authorized domains:** add `iip-inventory.vercel.app` (needed for any redirect-based flow; harmless otherwise).
3. **Firestore → Rules:** deploy the deny-all rules from `firestore.rules`, either by pasting the file into the console's Rules tab and publishing, or:
   ```bash
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules --project iip-inventory
   ```
4. **Administrator profile:** `users/09JYXShCynbEmYqB1hTYnry5RfP2` must have `role: "admin"`. `email`, `username` and `disabled` are optional – the API falls back to the email prefix for the username and treats a missing `disabled` as active. Adding `username` (for example `iip.admin`), `email` and `disabled: false` is recommended for consistency.
5. **Service account:** Project settings → Service accounts → Generate new private key; copy `client_email` and `private_key` into Vercel. Delete the downloaded file afterwards. Rotate the key if it was ever pasted anywhere public.
6. No composite Firestore indexes are required. Cloud Functions are not used.

First run: the first authenticated request seeds the 48 locations, 5 groups and the sample inventory **only if those collections are empty**, using a transaction so simultaneous first requests cannot duplicate it.

## 3. Git commands

Run from the repository root (`CSIR-IIP/iip-inventory`), after copying this project's files over the repository contents. Replace `main` if your default branch differs.

```bash
git checkout -b firebase-migration
git add -A
git status                      # confirm: no .env, no data/, no *.json key files listed
git commit -m "Migrate to Firebase Auth + Firestore with Vercel serverless API"
git push -u origin firebase-migration
```

Vercel builds a preview for the branch. After checking it, publish to production:

```bash
git checkout main
git merge firebase-migration
git push origin main
```

`git add -A` also records the deletion of `render.yaml` and the old JSON `data/` files, which are no longer used.

## 4. Behaviour changes and limits to know about

- **Sign-in uses email + password.** Old username/password accounts from the JSON store are not migrated; recreate users under Access Management.
- **Import file size:** Vercel rejects request bodies over 4.5 MB and uploads are base64-encoded, so the practical limit is about **3 MB** (was 5 MB). The 1,000-row limit is unchanged and a 1,000-row sheet is far below 3 MB.
- **Activity log in `/api/state`** returns the most recent 500 entries (configurable with `STATE_LOG_LIMIT`) to stay within the Firebase Spark plan's 50,000 reads/day. The Excel export always contains the complete history.
- **Imports above 200 rows** are saved in chunked transactions. Each chunk is atomic; the whole import is atomic only up to 200 rows. A failure part-way reports how many rows were saved.
- **Restore sample data** deletes and rewrites collections in batches and is not atomic; avoid running it while others are editing.
- **Password policy:** the UI requires 12+ characters for password changes and the API requires 12+ for admin-created accounts, but Firebase itself only enforces its own minimum for self-service changes.
