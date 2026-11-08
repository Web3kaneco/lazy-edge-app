# Contributing

## Before a pull request

```bash
npm run typecheck
```

```bash
npm test
```

CI runs both, plus gitleaks over the full history.

## Rules that are not style

1. **The settings are the contract.** Every settings field maps to one gate in `src/main/rules/gates.ts`. A field with no gate is a bug, and a gate that fails open is a bug.
2. **No secrets.** Keys live only in the Windows vault at runtime. Never in code, tests, logs or `.env.example`.
3. **No real exchange data.** Test fixtures are made up, with tickers on an obviously fake date (`99JAN01`). Never paste a recorded order book, trade or price from a venue.
4. **No new network hosts** without updating [COMPLIANCE.md](COMPLIANCE.md). The only remote hosts are the Lazy Edge API and auth, the venues, and the AI providers the user connects, all over https.
5. **Nothing from a venue goes to Lazy Edge.** Calls to the Lazy Edge API carry only the Lazy Edge key.

Releases and version numbers are covered in [RELEASING.md](RELEASING.md).
