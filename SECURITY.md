# Security policy

## Reporting a vulnerability

Do not publish credentials, tokens, or a working exploit in a public issue. Contact the repository owner privately through the contact method configured on the hosting profile. If no private contact method is configured, open a minimal issue asking for a private reporting channel without including exploit details.

## Security boundaries

- The daemon is intended to bind to loopback and apply authentication, host/origin checks, path validation, and symlink protections. Review implementation and tests before relying on these controls in a sensitive environment.
- The terminal command allowlist is a safety rail, not a sandbox.
- Do not expose the daemon to the public internet.
- Treat model-provider credentials and daemon tokens as secrets. Redact them from logs and screenshots.
- Test file-editing, Git, and snapshot/rollback flows on a disposable project before using valuable source code.
- Android/Termux integration is not yet broadly device-certified. A passing Linux test does not prove the Android security boundary.
