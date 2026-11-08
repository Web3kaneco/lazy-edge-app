# Lazy Edge Desktop

A Windows application that runs Lazy Edge trading bots on your own computer, with your own AI keys and your own exchange keys, under settings you control. Phase one of the Lazy Edge terminal. The design and every locked decision live in [docs/DECISIONS.md](docs/DECISIONS.md).

The settings are the contract. Each bot is a settings document, and the engine follows it exactly, refusing anything it does not recognise. Every default is a measured number from the Lazy Edge server engine, and the interface shows it beside every field so loosening a guard is always visible.

> **Beta.** This software is unfinished and still being tested. It may contain faults that place, miss, size or price orders wrongly. Use it only with money you can afford to lose entirely. Lazy Edge is not responsible for any funds lost using it.

> **Not code signed yet.** The beta builds are not yet signed with a Windows code signing certificate, so Windows SmartScreen and some antivirus tools warn that the publisher is unknown. Signing will come in a later release. Until then, download only from this repository's Releases page; see [docs/INSTALL.md](docs/INSTALL.md) for getting past the warning.

## Important notices

1. **Not affiliated with any venue.** Lazy Edge is not affiliated with, endorsed by or sponsored by Kalshi, Polymarket or any other venue. Venue names appear only to say where a price comes from.
2. **Your accounts, your keys, their terms.** Each user's exchange account and API keys are their own, and each venue's own terms apply to their use, including its rules on location, age and identity.
3. **Data, not advice.** Lazy Edge publishes data, not financial, investment or trading advice. Every order is the user's own decision under their own settings.
4. **Your keys stay on your computer.** Lazy Edge never holds funds or exchange keys. Keys are encrypted by Windows on the user's computer and sent only to the venue or provider they belong to.

How the app handles data, clause by clause against Kalshi's Developer Agreement, is in [COMPLIANCE.md](COMPLIANCE.md).

## Install

Testers: download the latest release and follow [docs/INSTALL.md](docs/INSTALL.md). Everything below is for building from source.

## Run it

```bash
npm install
```

```bash
npm run dev
```

The sign in screen needs the Lazy Edge Supabase anon key at build time. It is public by design, but it is supplied through the environment rather than committed. Copy `.env.example` to `.env` at the repository root (gitignored) and fill it in.

## Test and build

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dist
```

`npm run dist` writes a Windows executable to `dist/`. Builds are unsigned for now, so Windows SmartScreen shows a warning the first time; choose More info, then Run anyway.

## How a trade happens

1. The supervisor pulls the board from `api.lazyedge.net` with the key the app issued for this computer.
2. Each row becomes a signal. The normaliser follows the publisher's own orientation: every row states its side, the probabilities are already for that side, and an UNDER or NO is bought as NO on the same ticker. Anything it cannot map is refused and counted on the Board screen.
3. Every candidate is requoted from the venue's live orderbook, because the board's price is when it was published, not when the book last moved. The edge is recomputed at the price that can actually be paid.
4. Each enabled bot runs the gate stack in `src/main/rules/gates.ts`, in the same order as the server engine's Kalshi executor. Every skip names its gate.
5. In agent mode, a model sees only tickets that already passed every gate and can only decline them.
6. The order goes to paper, Kalshi or Polymarket. Live orders obey the account's dry run switch and the kill switch.
7. Fills and settlements are read back from the venue's own record and written to the append only ledger.

## Where things are

```
src/shared/      the settings schema, the measured ruleset, the signal shape
src/main/rules/  fees, the fail closed side table, the gate stack
src/main/venues/ paper, Kalshi, Polymarket behind one interface
src/main/data/   the API client, sign in, the normaliser
src/main/ai/     four providers, strategy drafting, agent screening
src/main/bots/   the supervisor and the accuracy check
src/main/store/  the Windows vault, settings documents, the ledger
src/renderer/    the interface, which holds no key and decides nothing
tests/           the scars the server engine learned from, as tests
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a security problem privately through a GitHub security advisory on this repository, not in a public issue.

## License

Copyright 2026 Lazy Ventures Inc. Licensed under the Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Releases and versioning: [RELEASING.md](RELEASING.md).
