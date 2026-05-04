# Contributing

This repo is a teaching example for the
[`@blankdotbuild/sdk`](https://www.npmjs.com/package/@blankdotbuild/sdk).
Good changes make the launch path clearer, safer, or easier to run locally.

## Setup

```bash
git clone <fork-url>
cd blank-bot-launcher
npm install
cp .env.example .env
cp accounts.example.yaml accounts.yaml
npm test
npm run check
```

Fill `.env` only when you need live API calls. Unit tests do not require
network access or real keys.

## Before a PR

```bash
npm run check
npm test
```

CI runs the same checks on every PR.

## Code style

- Biome formats and lints the project. Run `npm run format` before committing.
- TypeScript stays strict. Avoid `any` outside focused test mocks.
- Comments explain risk or intent. Do not narrate obvious code.
- Keep the SDK call easy to find in `src/launcher/blank-launcher.ts`.
- Keep `src/pipeline.ts` linear. It should read like one tweet moving through
  the launch flow.

## Tests

- Unit tests live in `test/`.
- Pipeline behavior lives in `test/pipeline.test.ts`.
- Security defenses live in `test/security.test.ts`.
- Use `vi.doMock` for module-level mocks and `vi.fn()` for fetch or small
  dependency stubs.

## Changes to discuss first

- New top-level dependencies.
- Moving the SDK launch call away from the launcher module.
- Removing safety checks, log redaction, prompt fencing, or SSRF checks.
- Disabling tests instead of fixing the failing behavior.

## Reporting bugs

Open an issue with:

- The command and flags you ran.
- What you expected.
- What happened, including logs or a dashboard screenshot when useful.

For security issues, see `SECURITY.md`.
