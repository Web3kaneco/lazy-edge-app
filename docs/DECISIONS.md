# Design decisions

Code comments cite these as "decision N".

## The thesis

The engine does not lose money because the engine is wrong. It loses money when the settings are wrong. So the settings document is the product. The executor underneath it is a deliberately obedient machine that does exactly what the settings say and refuses anything it does not understand. Every decision an AI agent could make is a decision the settings should have made already.

## Locked decisions

1. **Both AI modes, switchable per bot.** The deterministic rules engine is the default and decides every trade from the Lazy Edge numbers. An agent mode exists per bot for anyone who wants it, and it operates inside the same hard gates: it can only decline a trade the settings already approved.
2. **Every venue available to the user.** Paper, Kalshi and Polymarket sit behind one venue adapter interface.
3. **Electron with React and TypeScript.** Ships a Windows executable through electron builder.
4. **Its own repository.** The app consumes the public Lazy Edge API exactly as any other customer would.
5. **Everything the API serves.** NFL, MLB, NBA, World Cup, props, the full board. No lane is hidden from the settings, and no lane trades unless the settings enable it.
6. **The settings are the authority.** No per ticket approval prompt. The user sets account standards once and the bot trades those exact rules. Dry run is the shipped default and the kill switch is always one click away.
7. **Keys are encrypted by Windows.** Every secret is encrypted with Electron safeStorage, which on Windows is DPAPI bound to the Windows user. Nothing sensitive is ever written to a readable file, and the interface can never read a key back.
8. **Polymarket takes the user's Polygon private key.** Polymarket's API key, secret and passphrase authenticate a request but cannot place an order, because the order payload must be signed by the account key. The key goes straight into the vault and never leaves the machine.
9. **Sign in, key fetched for them.** Email or wallet sign in against Lazy Edge, then the app issues and stores the user's Lazy Edge API key itself.
10. **All four AI providers.** Anthropic, OpenAI, xAI and a local Ollama model, each with the user's own key.
11. **Best price wins, among venues the user actually funded.** The router compares the real ask on the user's side after each venue's own fees, and skips any venue with no usable balance.
12. **Unlimited bots, created and switched on by the user.** Each bot is its own settings document with its own caps and ticket log. An account cap sits above all of them so the bots together cannot exceed the daily limit.
13. **The execution rules are ported to TypeScript.** The Lazy Edge server engine stays the reference. The port carries the measured rules and the fail closed behaviour, and it is unit tested against the same cases.
14. **Runs while the window is open.** No tray process, no autostart, no background service. Closing the app stops trading.
15. **Unsigned executable for now.** Signing needs a paid certificate, so testers see one SmartScreen warning. The update channel is wired in and works properly once a certificate exists.
16. **Defaults are layered.** The measured constants ship inside the executable so the app works offline, refresh from the API when it can reach it, and are always overridable by the user.
