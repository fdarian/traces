# @traces/cli

## 0.1.2

### Patch Changes

- b24ae92: `traces secret set <name> --insecure-storage` stores a secret in `~/.config/traces/secrets.json` (plain text, mode 0600) for SSH and headless machines where the keychain cannot prompt. Secrets are read from the file first, then the keychain; `traces services` shows which store each came from and warns about a too-open file or a name in both.

## 0.1.1

### Patch Changes

- 6c30ab5: Report a nested response-schema mismatch from a successful Jaeger response as a traces bug instead of suggesting the URL is wrong.
- Updated dependencies [6c30ab5]
  - @traces/core@0.0.1

## 0.1.0

### Minor Changes

- a80ee9c: Initial release: prebuilt `traces` binaries on GitHub Releases and Homebrew (`brew install fdarian/tap/traces`).
