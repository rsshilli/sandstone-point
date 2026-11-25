# Sandstone Point

The website for the Sandstone Point Property Owners Association at Lake Cumberland, Kentucky.

- `site/` — the public pages and photos, served by Firebase Hosting.
- `lib/portal/` — the owner portal API: checks the Firebase sign-in, reads the owner records Google
  Sheet. Deployed as one Cloud Function (`api`); Firebase Hosting sends `/api/*` to it.
- `firebase.json` — hosting, headers, the `/api/*` rewrite and the local sign-in emulator.
- `functions/` — what Firebase deploys; `functions/lib/index.js` is built from `lib/portal/`.
- `dev/fake-sheet.json` — made-up owners and lots for local development (no real owner data).
- `photos/` — the photo library; see `photos/README.md` for what may be published.

## Commands

```bash
npm install
npm start        # preview the public pages at http://localhost:4321 (PORT=… to change)
npm run dev      # the whole site with owner login, on Firebase's local sign-in emulator; reads the
                 #   real owner sheet read-only when ~/.config/sandstone/google-sheets.json exists
npm run dev:fake # same, always with the fake data (approve/reject work here)
npm test         # API, sign-in, sheet and content checks (no addresses, emails or phones on the site)
npm run deploy   # build the API and deploy the site + API to the sandstone-point-hoa project
```

`npm run dev` prints the fake users and their password. Confirmation and password-reset links
(nothing is really emailed locally) appear in the browser console. Delete `.local/sheet.json` to
reset the fake data.

Deploying needs `gcloud auth login --update-adc` as an owner of the Google Cloud project. The live
API runs as the HOA's robot service account, which the owner sheet is shared with, so no key is
stored anywhere. The "Message the board" form sends through Resend: it switches on when the
`RESEND_API_KEY` secret (Secret Manager) holds a real key and `BOARD_EMAIL_FROM` is set when
deploying, e.g. `BOARD_EMAIL_FROM="Sandstone Point website <website@sandstonepoint.org>" npm run deploy`.
