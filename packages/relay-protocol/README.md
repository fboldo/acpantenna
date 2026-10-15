# @acpantenna/relay-protocol

The wire protocol acpantenna speaks with a web client through a relay: Noise `NKpsk0_25519_ChaChaPoly_BLAKE2s` to pair and `KK_25519_ChaChaPoly_BLAKE2s` to reconnect, the frame codec, the pairing link and the SAS words. The spec is [`docs/relay-protocol.md`](https://github.com/fboldo/acpantenna/blob/main/docs/relay-protocol.md).

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

### Remembering and reconnecting

Right after `onConfirmed`, a browser that wants to come back sends the public half of a static key it made for this connection: `session.remember(publicKey)`. The agent side gets it in `onRemember`. In a browser the key can be a non-extractable WebCrypto X25519 key: a `StaticKey` is only its public half and an asynchronous `dh`.

```ts
const keys = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
const staticKey = {
	publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
	dh: async (publicKey) => {
		const peer = await crypto.subtle.importKey("raw", publicKey, { name: "X25519" }, false, []);
		return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, keys.privateKey, 256));
	},
};
```

To come back, join the room with `{"v":1,"role":"browser","resume":true}` and, on `ready`, start a `reconnectInitiator({ room, webOrigin, remoteStaticPublicKey, staticKey, resume, buffer, ... })`. Pass the `buffer` of the connection's last session and `resume: true` to carry on where it stopped. After a reload, pass `resume: false`; then `session.resumed` is false, and the client loads the session afresh. The agent side answers with `reconnectResponder({ staticKeyPair, room, webOrigin, remoteStaticPublicKey, buffer, ... })`, with the key it was given and its own buffer.

## Test vectors

`test-vectors/` holds what a second implementation should check itself against:

- `noise-nkpsk0.json` and `noise-kk.json`: the vectors for `Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s` and `Noise_KK_25519_ChaChaPoly_BLAKE2s`, from [cacophony](https://github.com/haskell-cryptography/cacophony/blob/master/vectors/cacophony.txt);
- `frames.json`: frames and their plaintexts, frames to refuse, padding buckets, chunking, and stream sequences to accept or refuse;
- `sas.json`: handshake hashes and their words;
- `session.json`: a whole pairing with fixed keys, every relay message in order.

`scripts/vectors.ts` regenerates the last three; only do that when the protocol changes on purpose.

The BIP-39 English wordlist in `src/bip39-english.ts` is MIT-licensed; its notice is in the file.
