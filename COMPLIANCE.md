# How the app uses data, and what keeps it compliant

This is the standard the app is held to. Every change that touches a venue, a key, a network call or a stored record should still pass it.

## What the app is

The app runs on the user's own computer and joins two sources:

1. **Lazy Edge, through the user's own Lazy Edge API key:** the numbers, the edges, the hot plays, the ladders, injuries and results.
2. **The exchange, through the user's own exchange API key:** prices, the user's balance and positions, and orders the user chooses to place.

The app is only useful with a Lazy Edge key. Open sourcing the client exposes nothing that matters, because the key check and the plan check happen on the Lazy Edge server.

## The one rule

Exchange data and exchange keys stay between the user's computer and the exchange. Nothing from the user's Kalshi account, and no Kalshi market data the app reads, is ever sent to Lazy Edge.

| Flow | What travels |
|---|---|
| Lazy Edge to the user's computer | Lazy Edge numbers and edges |
| Kalshi to and from the user's computer | Prices, balance, positions and orders |
| The user's computer to Lazy Edge | Only the Lazy Edge API key on each call. No Kalshi key, no positions, no fills, no prices |

This is what makes each user's use of Kalshi their own trading, which is the use Kalshi's Developer Agreement allows. Any AI provider a user connects is the user's own account, used with the user's own key for the user's own trading.

## Kalshi Developer Agreement v1.1, clause by clause

| Clause | What it requires | What the app does |
|---|---|---|
| §1, §4.1.1 | The API user must be a Kalshi member and accept the agreement. | The Kalshi key screen says the account and key are the user's own and that Kalshi's terms apply. |
| §3 | API use is limited to a member's own trading. | Orders go only to the account of the configured key. No shared or pooled accounts, no trading for anyone else. |
| §3.1 | No collecting, storing or sharing API data except for the member's own trading. | No telemetry, analytics or crash reports. Kalshi data is cached locally only and never uploaded to Lazy Edge. |
| §3.2 | No facilitating other members' trading or account creation; no Kalshi password elsewhere. | API keys only, never the Kalshi password. No referral or sign up flows. |
| §3.3 | No market manipulation. | No place and cancel strategies. Orders carry Kalshi's self trade prevention. |
| §3.5 | No benchmarking or monitoring of Kalshi's performance. | Quote age is shown to the user; nothing measures Kalshi's latency or uptime. |
| §3.7 | No sublicensing the API. | No relay server. Each install talks to Kalshi directly with its own key. |
| §3.8 | Secure, encrypted channels only. | HTTPS to every remote host. Plain http only to the user's own computer (sign in callback, a local Ollama model). |
| §4.2 | The member is responsible for key security. | Keys encrypted by Windows (DPAPI), never in plain files, logs or the repository. gitleaks runs in CI. |
| §4.3, §5 | Use the API efficiently and respect rate limits. | Backs off on 429 using Retry-After, caps retries, never retries an order, one key per user. |
| §2.2 | Kalshi can change the API. | Errors are shown, and a response that is not understood places no order. Orders carry `exchange_index: -1`. |
| §6.1, §6.4 | Kalshi keeps its marks; public statements about Kalshi need approval. | No venue name, logo or colour in the app's branding. Venue names inside the app are functional labels. |
| §7 | Kalshi's confidential information stays confidential. | Nothing non public about Kalshi's API in this repository. |

## The Lazy Edge API

1. Each user brings their own Lazy Edge key. API access is checked on the Lazy Edge server on every call.
2. Respect the per key limit of 240 calls a minute, and call each feed on a cadence that matches how often it changes.
3. Handle the failure replies: 402 means the plan lapsed, 429 means slow down, and a 5xx reply may carry `retryable`, `retry_after_s` and `try_instead`.
4. Lazy Edge data is for the user's own use in the app. The app does not republish it.
5. Prices come from the exchange with the user's own key, and edges come from Lazy Edge.

## Helping users use the data well

1. **Data, not advice.** Show the Lazy Edge number, the market price, the edge and the quote's age. The user sets the rules. No profit claims.
2. **Safe defaults.** Dry run at install, a paper mode, per trade and daily limits, a confirmation step before going live, and a kill switch that cancels open orders.
3. **No trading on a stale price.** Every bot refuses a price older than its own limit.
4. **Fees in every number.** Expected value is shown after the venue fee (Kalshi's is 0.07 × P × (1 − P) per contract).
5. **Venue on every number.** Every price says which venue it came from.
6. **Local logs only.** Trade logs stay on the user's computer.

## Other venues

1. **Polymarket:** each user is responsible for following Polymarket's terms where they live. The app never helps anyone get around a venue's location rules: no VPN guidance and no workarounds.
2. **Any new venue:** its API terms are read and added to this file before its adapter ships.

## In this repository

1. No secrets: gitleaks runs in CI, and `.env.example` holds placeholders only.
2. No real exchange data: test fixtures are made up, never recorded from a venue.
3. The README states that the app is not affiliated with or endorsed by any venue, that each user's exchange account and keys are their own, and that each venue's terms apply.
4. The app and repository names carry no venue name.

## Disclosures the app shows

1. Lazy Edge publishes data, not financial advice.
2. Lazy Edge never holds the user's funds or exchange keys; keys stay on the user's computer.
3. The user is responsible for their exchange account and for following each venue's terms.
4. The app is beta software, and Lazy Edge is not responsible for funds lost using it.
