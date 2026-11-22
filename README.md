# Sandstone Point

The website for the Sandstone Point Property Owners Association at Lake Cumberland, Kentucky.

- `site/` — the public pages and photos.
- `lib/site-stack.ts` — the AWS hosting (S3 + CloudFront, the Cognito owner login, and the
  `/api/*` Lambda; AWS CDK in TypeScript).
- `lib/portal/` — the owner portal API: checks the sign-in, reads the owner records Google Sheet.
- `dev/fake-sheet.json` — made-up owners and lots for local development (no real owner data).
- `photos/` — the photo library; see `photos/README.md` for what may be published.

## Commands

```bash
npm install
npm start        # preview the public pages at http://localhost:4321 (PORT=… to change)
npm run dev      # the whole site with owner login: cognito-local in Docker; reads the real owner
                 #   sheet read-only when ~/.config/sandstone/google-sheets.json exists, else fake data
npm run dev:fake # same, always with the fake data (approve/reject work here)
npm test         # stack, API and content checks (no addresses, emails or phone numbers on the site)
npm run deploy   # cdk deploy with the `sandstone` AWS profile
```

`npm run dev` prints the fake users and their password, and shows each emailed sign-up or reset
code in the terminal (cognito-local doesn't send email). Delete `.local/sheet.json` to reset the
fake data. The live site reads the sheet with a Google service account whose key is in the
`sandstone-point/google-sheets` secret in AWS Secrets Manager.
