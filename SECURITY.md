# Security

## Reporting a vulnerability

Do not open a public GitHub issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/jcoulaud/blank-bot-launcher/security/advisories/new)
to report the issue privately, including:

- A short description of the issue.
- Steps to reproduce, or a proof of concept.
- The commit hash you tested.

You should receive an acknowledgement within 5 business days.

## Defenses in this repo

| Defense | Code | Test |
|---|---|---|
| SSRF guard: HTTPS, host allowlist, DNS rejects private/local IPs | `src/brain/image.ts` | `test/security.test.ts` |
| Image download caps: 5 MB max, content type check, no redirects | `src/brain/image.ts` | `test/image.test.ts`, `test/security.test.ts` |
| Prompt sanitization: NFKC, zero-width strip, length cap, nonce fence | `src/brain/prompts.ts` | `test/security.test.ts` |
| Signed transaction redaction in launch errors | `src/launcher/blank-launcher.ts` | `test/blank-launcher.test.ts` |
| Log redaction for secrets and signed transactions | `src/logger.ts` | `test/security.test.ts` |
| Dashboard HTML escaping | `src/dashboard/render.ts` | `test/security.test.ts` |
| Dashboard security headers | `src/dashboard/server.ts` | manual |
| Dashboard loopback bind only | `src/dashboard/server.ts` | manual |
| Daily caps and balance check | `src/safety/safety.ts` | `test/safety.test.ts` |
| Atomic daily-cap reservation | `src/store/db.ts` | `test/db.test.ts`, `test/pipeline.test.ts` |

## Known sharp edges

- If the process dies between `reserveLaunchSlot` and `commitReservedLaunch`,
  the daily counter can sit ahead of the launches table. Use
  `npm run reset-today -- --apply` after a hard crash.
- The bot signs transactions with a hot wallet. If that secret leaks, an
  attacker can spend the wallet balance. Use a disposable wallet and keep the
  balance low.

## Out of scope

- Image rights and copyright. You are responsible for using accounts and media
  you are allowed to use.
- Classifier false positives and false negatives. Open a normal issue for
  tuning problems.
