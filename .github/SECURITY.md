# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Voice Scribe, please report it responsibly.

Email: [TBD — add a contact before public release]

Do not open a public GitHub issue for security vulnerabilities.

## Security Design

Voice Scribe is designed as a local-only tool:

- Audio and transcripts never leave the user's machine
- The API binds to localhost only
- Containers run as non-root
- Raw audio is deleted immediately after transcription
- Transcript content is not logged

See [docs/threat-model.md](../docs/threat-model.md) for the full threat model.
