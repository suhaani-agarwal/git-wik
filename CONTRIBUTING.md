# Contributing to git-wik

Thanks for contributing.

## Development setup

```bash
git clone https://github.com/git-wik/git-wik
cd git-wik
npm install
```

## Common commands

```bash
npm run dev -- index expressjs/express
npm run typecheck
npm test
npm run build
```

## Pull request checklist

- Keep PRs focused and small when possible.
- Add or update tests for behavior changes.
- Run `npm run typecheck` and `npm test` before opening PR.
- Update `README.md` if user-facing CLI behavior changes.
- Use clear commit messages (`feat:`, `fix:`, `docs:`, etc.) when possible.

## Reporting bugs

Open an issue and include:

- Your `node -v` and `gh --version`
- Command you ran
- Full error output
- Repo name used (if relevant)
- Steps to reproduce

## Feature requests

Open an issue with:

- Problem statement (what is painful today)
- Desired command/output
- Why this helps maintainers or AI coding workflows
