# Security

acpantenna gives a remote client a coding agent that can run commands on your machine, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Please don't open a public issue for it.

Include what you found, how to reproduce it, and what it lets an attacker do. You will get an answer within a few days, and credit in the fix's release notes if you want it.

## Scope

- The `acpantenna` CLI and its background server
- The channels, including the relay channel's filtering ACP proxy
- The relay protocol ([docs/relay-protocol.md](docs/relay-protocol.md)) and `@acpantenna/relay-protocol`: the handshake, the link, the words, the frames

Problems with the hosted web client or relay at latch.im can be reported the same way.
