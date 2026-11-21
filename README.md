# Sandstone Point

The website for the Sandstone Point Property Owners Association at Lake Cumberland, Kentucky.

- `site/` — the public pages and photos.
- `lib/site-stack.ts` — the AWS hosting (S3 + CloudFront, AWS CDK in TypeScript).
- `photos/` — the photo library; see `photos/README.md` for what may be published.

## Commands

```bash
npm install
npm test         # stack + content checks (no addresses, emails or phone numbers on the site)
npm run deploy   # cdk deploy with the `sandstone` AWS profile
```
