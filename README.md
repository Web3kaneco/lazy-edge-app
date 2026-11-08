# Lazy Edge Desktop

Run Lazy Edge trading bots on your own Windows computer, with your own keys, under settings you control. No coding, no setup files, nothing to install but the app.

## Get the app

**[Download the latest release](https://github.com/Web3kaneco/lazy-edge-app/releases/latest)** and pick one file:

| File | Use it when |
|---|---|
| `Lazy-Edge-Setup-<version>-x64.exe` | You want it installed, with a Start menu and desktop shortcut. |
| `Lazy-Edge-<version>-x64.exe` | You want a single portable file you run from anywhere. |

Then:

1. **Run it.** Windows warns that the publisher is unknown, because the beta is not code signed yet. Choose **More info**, then **Run anyway**.
2. **Accept the terms** and **sign in** to your Lazy Edge account (email code or wallet). The app gets its own Lazy Edge key for you; you never copy one.
3. **Switch on a bot.** Seven starter bots are already in your list, switched off and trading practice money. Switch one on and press Start engine.
4. **Optional:** to trade real money or use an AI, paste your exchange or AI keys on the app's **Keys** screen. They are encrypted by Windows and never leave your computer except to the venue or provider they belong to.

You need a Lazy Edge account with API access (a paid plan, or 5 or more Lazy Lions in a linked wallet). The full guide, including where your data lives, updating and uninstalling, is in [docs/INSTALL.md](docs/INSTALL.md).

> **Beta.** This software is unfinished and still being tested. It may contain faults that place, miss, size or price orders wrongly. Use it only with money you can afford to lose entirely. Lazy Edge is not responsible for any funds lost using it.

> **Not code signed yet.** Windows SmartScreen and some antivirus tools warn that the publisher is unknown until the builds are signed, which will come in a later release. Download only from this repository's Releases page.

## Important notices

1. **Not affiliated with any venue.** Lazy Edge is not affiliated with, endorsed by or sponsored by Kalshi, Polymarket or any other venue. Venue names appear only to say where a price comes from.
2. **Your accounts, your keys, their terms.** Each user's exchange account and API keys are their own, and each venue's own terms apply to their use, including its rules on location, age and identity.
3. **Data, not advice.** Lazy Edge publishes data, not financial, investment or trading advice. Every order is the user's own decision under their own settings.
4. **Your keys stay on your computer.** Lazy Edge never holds funds or exchange keys. Keys are encrypted by Windows on the user's computer and sent only to the venue or provider they belong to.

How the app handles data, clause by clause against Kalshi's Developer Agreement, is in [COMPLIANCE.md](COMPLIANCE.md).

## How it works

The settings are the contract. Each bot is a settings document, and the engine follows it exactly, refusing anything it does not recognise. Every default is a measured number, and the app shows it beside every field so loosening a guard is always visible.

1. The app pulls the Lazy Edge board with the key it issued for this computer.
2. Each row becomes a signal. Anything the app cannot map exactly is refused and counted on the Board screen.
3. Every candidate is repriced from the venue's live order book, and the edge is recomputed at the price that can actually be paid.
4. Each bot that is switched on runs its gates in order. Every skip names the gate that stopped it.
5. In agent mode, an AI sees only trades that already passed every gate and can only decline them.
6. The order goes to paper, Kalshi or Polymarket. Live orders obey the dry run switch and the kill switch.
7. Fills and settlements are read back from the venue's own record and written to the local ledger.

The design decisions are in [docs/DECISIONS.md](docs/DECISIONS.md).

---

## For developers only

Nothing below is needed to use the app. It is for people who want to build it from the source code themselves.

```bash
npm install
```

```bash
npm run dev
```

Sign in needs the Lazy Edge Supabase anon key at build time. Copy `.env.example` to `.env` and fill it in.

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dist
```

```
src/shared/      the settings schema, the measured ruleset, the signal shape
src/main/rules/  fees, the fail closed side table, the gate stack
src/main/venues/ paper, Kalshi, Polymarket behind one interface
src/main/data/   the API client, sign in, the normaliser
src/main/ai/     four providers, strategy drafting, agent screening
src/main/bots/   the supervisor and the accuracy check
src/main/store/  the Windows vault, settings documents, the ledger
src/renderer/    the interface, which holds no key and decides nothing
tests/           the lessons the server engine learned, as tests
```

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Releases and versioning: [RELEASING.md](RELEASING.md). Report a security problem privately through a GitHub security advisory on this repository, not in a public issue.

## License

Copyright 2026 Lazy Ventures Inc. Licensed under the Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
