# blank-bot

Open-source reference bot that launches Solana memecoins from influencer tweets via the [blank.build](https://blank.build) SDK.

A working example of the Blank token-launch SDK end-to-end: real-time X (Twitter) ingestion, AI-driven memeability classification, AI-generated token metadata + image, IPFS upload, and a fully autonomous `blank.launch.create()` call — all with hard safety caps.

This is a **reference implementation**, not a profitable trading bot. It optimizes for clarity, forkability, and showing every integration point of the Blank SDK.

## What it does

1. Connects to the X API v2 Filtered Stream and watches a configured list of accounts (default: Elon Musk, Sam Altman, Sario, Vitalik, Anatoly, CZ).
2. For every new tweet, runs a two-stage AI pipeline (Gemini 2.5 Flash):
   - **Stage 1 — Classifier:** is this tweet memeable? Outputs a confidence score.
   - **Stage 2 — Metadata generator:** if confidence ≥ threshold, generate a token name, ticker, description, and image strategy (reuse the tweet image, remix it, or generate a new one with Nano Banana).
3. Uploads the image and metadata JSON to IPFS via Pinata.
4. Runs a safety gate (per-launch SOL cap, daily SOL cap, daily launch count, per-author cooldown, wallet balance sanity).
5. Calls `blank.launch.create()` with the IPFS metadata URI.
6. Persists the full audit trail to SQLite. Optionally pings Telegram and serves a tiny status dashboard at `localhost:3000`.

## Quickstart

```bash
git clone <this-repo>
cd blank-bot
npm install
cp .env.example .env       # fill in keys
cp accounts.example.yaml accounts.yaml
npm run check-config       # validate env + caps + wallet balance
npm run dev -- --dry-run   # full pipeline, skips the SDK call
```

The bot uses [`@blankdotbuild/sdk`](https://www.npmjs.com/package/@blankdotbuild/sdk) (pinned in `package.json`). `npm start` and the `blank-bot` binary both run the TypeScript source via `tsx` so the SDK's ESM imports resolve correctly.

When you're ready to go live, drop `--dry-run`. Start small: `MAX_SOL_PER_LAUNCH=0.001` and `MAX_LAUNCHES_PER_DAY=1` for the first day.

## Architecture

See [docs/plans/2026-05-02-blank-bot-design.md](./docs/plans/2026-05-02-blank-bot-design.md) for the full architecture, locked decisions with rationale, and component-by-component spec.

## Safety

The bot signs Solana transactions on a hot wallet. Three things keep blast radius bounded:

- **Hard caps in code** — `MAX_SOL_PER_LAUNCH`, `MAX_LAUNCHES_PER_DAY`, `MAX_SOL_PER_DAY`. The bot won't start if these are inconsistent with each other.
- **Wallet balance warning** — startup banner warns if `WARN_IF_BALANCE_ABOVE_SOL` is exceeded ("this is too much money for a hot wallet").
- **Idempotency** — every launch uses an idempotency key derived from the source tweet ID; Blank dedupes retries within 24h.

**Generate a fresh keypair, fund with only what you can afford to lose, never reuse with your main wallet.**

## Customization

The bot is built around two seams:

- **`TweetSource` interface** — default is X Filtered Stream. Implement the interface to plug in Nitter, a third-party API, or a webhook.
- **Vercel AI SDK `LanguageModel`** — default is Gemini 2.5 Flash. Swap one import + one line to use OpenAI, Anthropic, OpenRouter, Groq, or local Ollama.

Caps, threshold, and cooldown are all environment variables (see `.env.example`).

## Image rights footnote

The bot reuses tweet media when the AI decides it's the best image strategy. That's fair-use-ish for memes but not legal advice. Don't use this with copyrighted content you don't have rights to. Image-rights enforcement is the operator's responsibility.

## Contributing

Issues and PRs welcome. Keep the scope tight — this is a reference example, not a feature-rich product.

## License

MIT
