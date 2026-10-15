# @acpantenna/relay-protocol

The wire protocol acpantenna speaks with a web client through a relay: Noise `NKpsk0_25519_ChaChaPoly_BLAKE2s`, the frame codec, the pairing link and the SAS words. The spec is [`docs/relay-protocol.md`](https://github.com/fboldo/acpantenna/blob/main/docs/relay-protocol.md).

It uses only `Uint8Array`, `TextEncoder`, `crypto.getRandomValues` and the [@noble](https://paulmillr.com/noble/) libraries, so the same code runs in Bun and in a browser.

```ts
import { initiator, parseLink, isLinkExpired } from "@acpantenna/relay-protocol";

const link = parseLink(location.href);
const session = initiator({
	link,
	send: (data) => socket.send(data),
	onHandshake: ({ sas }) => showWords(sas),
	onConfirmed: () => session.send(JSON.stringify(initializeRequest)),
	onMessage: (message) => handle(JSON.parse(message)),
	onClose: (event) => socket.close(),
});
// After the relay says {"t":"ready"}:
session.start();
// Every binary WebSocket message:
socket.onmessage = (event) => session.receive(new Uint8Array(event.data));
```

When message 2 arrives the initiator sends a PING on its own: its first transport frame, which lets the agent side confirm the keys. The agent side is `responder({ staticKeyPair, psk, room, webOrigin, acceptEphemeral, send, ... })`; it calls `onHandshake` with the words only once that PING has decrypted, and `confirm()` once the user has checked them.

## Test vectors

`test-vectors/` holds what a second implementation should check itself against:

- `noise-nkpsk0.json`: the cacophony vector for `Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s`, from [cacophony](https://github.com/haskell-cryptography/cacophony/blob/master/vectors/cacophony.txt);
- `frames.json`: frames and their plaintexts, frames to refuse, padding buckets, chunking, and stream sequences to accept or refuse;
- `sas.json`: handshake hashes and their words;
- `session.json`: a whole pairing with fixed keys, every relay message in order.

`scripts/vectors.ts` regenerates the last three; only do that when the protocol changes on purpose.

The BIP-39 English wordlist in `src/bip39-english.ts` is MIT-licensed; its notice is in the file.
