# Releasing

## Version numbers

Versions follow semantic versioning with a beta tag: `0.2.0-beta.1`, `0.2.0-beta.2`, and so on.

| Change | Bump | Example |
|---|---|---|
| A fix or small change during the beta | the beta number | `0.2.0-beta.1` to `0.2.0-beta.2` |
| A new feature or a settings change | the minor version, beta number reset | `0.2.0-beta.2` to `0.3.0-beta.1` |
| The first release out of beta | drop the tag | `1.0.0` |

The version lives in `package.json` and is shown in the app header, the sidebar and the window title. Bump it with:

```bash
npm version 0.2.0-beta.2 --no-git-tag-version
```

## When the terms change

Any change to `src/shared/terms.ts` must bump `TERMS_VERSION` in the same file. Every user then accepts the new terms before the engine will start again. A change to the acknowledgements does the same automatically.

## Building a release

1. Make sure master is green: typecheck, tests and gitleaks in CI.
2. Bump the version (above) and commit.
3. Build on Windows:

   ```bash
   npm run dist
   ```

   This writes `Lazy Edge-Setup-<version>-x64.exe` (installer) and `Lazy Edge-<version>-x64.exe` (portable) to `dist/`, plus `latest.yml`, which the in app update check reads.
4. Tag the commit `v<version>` and push the tag.
5. Create a GitHub release for the tag, marked **pre-release** while the version carries a beta tag. Upload both exe files and `latest.yml`. Write the notes in plain language: what changed, anything testers must do, and the beta warning.

Builds are unsigned until a code signing certificate exists (docs/DECISIONS.md, decision 15).

## Never in a release or the repository

1. Anything from `%APPDATA%\Lazy Edge` on the machine that built it: ledgers, settings, keys.
2. A `.env` file or any key. Only `.env.example` with placeholders is committed.
3. Real venue data in tests or docs.
