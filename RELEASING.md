# Releasing git-wik to npm

This project is configured for npm release via GitHub Actions trusted publishing.

## One-time setup

1. Publish once manually (optional, only if package does not exist yet):

```bash
npm login
npm publish --access public
```

2. In npm package settings for `git-wik`, add a trusted publisher:
   - Provider: GitHub Actions
   - Owner/Org: `git-wik`
   - Repository: `git-wik`
   - Workflow: `release.yml`

## Release a new version

1. Update version:

```bash
npm version patch
# or: npm version minor / npm version major
```

2. Push commit + tag:

```bash
git push origin main --follow-tags
```

3. GitHub Actions publishes to npm automatically from the `v*` tag.

## Local verification before release

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```
