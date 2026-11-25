---
"@traces/cli": minor
---

`traces secret set <name> --insecure-storage` stores a secret in `~/.config/traces/secrets.json` (plain text, mode 0600) for SSH and headless machines where the keychain cannot prompt. Secrets are read from the file first, then the keychain; `traces services` shows which store each came from and warns about a too-open file or a name in both.
