# Installing Lazy Edge Desktop (beta)

Lazy Edge Desktop is beta software. It is unfinished, still being tested, and may contain faults that place, miss, size or price orders wrongly. Use it only with money you can afford to lose entirely.

## What you need

1. A Windows 10 or 11 computer.
2. A Lazy Edge account with API access (a paid plan, or 5 or more Lazy Lions in a linked wallet).
3. Optional: a Kalshi or Polymarket account and API key of your own, for live trading. Paper trading needs neither.
4. Optional: an Anthropic, OpenAI or xAI key, or a local Ollama model, for drafting strategies and agent mode.

## Download

Download the latest version from the **Releases** page of this repository. Each release offers two files:

| File | Use it when |
|---|---|
| `Lazy-Edge-Setup-<version>-x64.exe` | You want it installed, with a Start menu and desktop shortcut. |
| `Lazy-Edge-<version>-x64.exe` | You want a single portable file you run from anywhere. |

Download only from this repository's Releases page. Never run a copy someone sends you directly.

## Why Windows warns about it

The beta is **not yet signed with a Windows code signing certificate**. Signing is how Windows confirms who published a program, so until it is in place:

1. Windows SmartScreen shows **"Windows protected your PC"** and names the publisher as unknown.
2. Your browser may say the file "isn't commonly downloaded".
3. Some antivirus tools may flag or quarantine it as an unknown program.

This is expected for an unsigned beta and does not by itself mean the file is harmful. Code signing will come in a later release, and these warnings go away then. Until it does, the only protection is where you got the file: download it only from this repository's Releases page.

## First launch

1. **Windows SmartScreen warning.** Choose **More info**, then **Run anyway**. If your browser blocks the download, choose to keep it.
2. **Terms.** Read the terms of use and risk, tick each acknowledgement, and choose I agree. A new version of the terms asks again.
3. **Sign in** to Lazy Edge by email code or wallet. The app issues its own Lazy Edge key for this computer.
4. **Bots.** Seven starter bots are already in your list, switched off and in paper. Switch one on and start the engine to watch it trade practice money.
5. **Keys** (optional). Add your exchange or AI keys on the Keys screen. They are encrypted by Windows and never leave your computer except to the venue or provider they belong to.

Live trading stays in dry run until you turn dry run off on the Account screen, and every live bot asks for confirmation before it is switched on.

## Where your data lives

Everything the app stores stays on your computer, in `%APPDATA%\Lazy Edge`: your settings, bots, trade ledger, accuracy checks and encrypted keys. None of it is ever uploaded to GitHub or to Lazy Edge, and it does not live next to the exe, so you can move or replace the exe freely.

## Updating

The app checks this repository's releases every time it starts. When a newer version exists it shows a message with a **Download** button, which opens that release's page in your browser. Download the same kind of file you use now (installer or portable), close the app, and run the new file. Your bots, ledger and keys carry over, because they live in `%APPDATA%\Lazy Edge`, not in the exe. The installer version updates in place; with the portable version, delete the old file once the new one runs.

While the beta is unsigned, the app never downloads or installs an update on its own; you choose when to update. Once builds are signed, updates can install in one click inside the app.

The version you are running is shown at the top of the app, beside the Lazy Edge logo.

## Uninstalling

Use **Add or remove programs** for the installed version, or delete the portable file. To remove your data and keys as well, delete the `%APPDATA%\Lazy Edge` folder.

## Reporting a problem

Open an issue on this repository with:

1. The version shown at the top of the app.
2. What you did, what you expected, and what happened.
3. The detail line from the Dashboard or Ledger, if there is one.

Never paste an API key, private key, or anything from the Keys screen into an issue. Report a security problem privately through a GitHub security advisory instead.
