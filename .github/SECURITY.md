# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Voice Scribe, please report it
privately via GitHub's Private Vulnerability Reporting:

**[Report a vulnerability](../../security/advisories/new)**

Do not open a public GitHub issue for security vulnerabilities.

## Security Design

Voice Scribe is designed as a local-only tool:

- Audio and transcripts never leave the user's machine
- The API binds to localhost (`127.0.0.1`) in both modes — the Docker port
  mapping and the bare-host sidecar both pin the loopback interface
- Containers run as non-root
- Raw audio is transient: the one-shot path deletes its temp file after
  transcription; the streaming path never touches disk at all
- Transcript content is not logged; two explicitly opt-in diagnostic modes
  can capture it locally and are off by default — see
  [docs/privacy.md](../docs/privacy.md)

See [docs/threat-model.md](../docs/threat-model.md) for the full threat model.
