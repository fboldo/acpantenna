# Relay protocol, version 1

How acpantenna and a web client reach each other through a relay, end-to-end encrypted. The relay only forwards ciphertext. The browser speaks ACP to an agent on your machine, and acpantenna filters what it may do.

The reference implementation is [`@acpantenna/relay-protocol`](../packages/relay-protocol/), which runs in Bun and in browsers. Its `test-vectors/` directory holds the vectors in §6.

## Parties

- **Agent side:** acpantenna on the user's machine, carrying one connection's ACP session. It is the Noise *responder* and has a static X25519 key.
- **Browser:** the web client, an ACP client. It is the Noise *initiator*. It pairs with no static key; a browser that is to be remembered then gives the agent side a static X25519 key of its own, made for this connection, and reconnects with it (§2.2).
- **Relay:** joins the two by room and forwards opaque binary messages. It holds no keys.

## 1. Relay transport

The relay is at `wss://<relay>/v1/rooms/<room>`. `room` is 16 random bytes in base64url, 22 characters.

1. **Join.** Each peer opens the WebSocket. Its first message is a text JSON **hello**:
   - `{"v":1,"role":"agent","token"?:string}`, sent only by acpantenna. `token` is an optional credential the relay may ask for.
   - `{"v":1,"role":"browser","resume"?:true}`. `resume` marks a remembered browser coming back (§2.2).
2. **Messages from the relay** are text JSON:
   - `{"t":"waiting"}`: you are alone in the room so far.
   - `{"t":"ready"}`: both peers are here; start the Noise handshake.
   - `{"t":"peer-left"}`: the other peer disconnected. The room stays until its TTL.
   - `{"t":"closed","reason":"time-limit"|"ttl"|"replaced"|"limit"|"protocol"}`, after which the relay closes the socket.
3. **Rules:**
   - The agent creates the room by joining first. A browser that joins a room with no agent gets `closed: "ttl"`.
   - A room holds at most one agent and one browser. A second browser is refused with WebSocket close code 4009, unless its hello has `resume`: then it replaces the first, which gets `closed: "replaced"`, because a phone's dead socket often still looks open to the relay. A second agent replaces the first in the same way. Either way the peer that stays gets `peer-left`, then `ready`.
   - A `resume` browser that joins a room which has been `ready` before, but has no agent right now, gets `waiting`, not `closed: "ttl"`.
   - After `ready`, every **binary** message from one peer is forwarded unchanged to the other. A text message after the hello is a protocol error.
   - A relay may close a room some time after the **first** `ready`, with `time-limit`. Reconnects and replacements never restart that clock.
   - A room expires 15 minutes after its last peer leaves, with `ttl`.
   - A relay stores nothing, and logs nothing about rooms beyond aggregate counts.
   - A binary message is at most 65,535 + 16 bytes (one Noise message). A larger one closes the room with `protocol`.

`@acpantenna/channel-relay/dev-relay` is a relay for development and tests that follows these rules.

## 2. Handshakes

A room sees one **pairing** (§2.1), then any number of **reconnects** (§2.2) by the browser that paired. State, not a flag, says which a message 1 starts: until key confirmation of the pairing it is a pairing, after it a reconnect.

### 2.1 Pairing

The handshake is `Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s`, as in the Noise Protocol Framework, revision 34, with:

- **Prologue:** UTF-8 `"acpantenna-relay/1"` ‖ 0x00 ‖ room (16 bytes) ‖ 0x00 ‖ the UTF-8 web origin of the browser page, e.g. `https://app.example`. The agent side learns the origin from its configuration; the browser takes it from the link (§5).
- **psk:** the 32 bytes from the link.
- **Message 1** (browser → agent): `psk, e, es`, with an **empty payload**.
- **Message 2** (agent → browser): `e, ee`, with an **empty payload**.
- **Key confirmation.** The agent side treats the psk as spent only once it has decrypted the browser's first transport message. Until then, a replayed message 1 does not use the link up. While the link is valid, the agent side remembers the `e` values it has seen and refuses any that repeat.
- **SAS.** Compute `BLAKE2s("acpantenna-sas" ‖ h)`, where `h` is the final handshake hash. Its 44 most significant bits, starting from byte 0, are four 11-bit indexes into the BIP-39 English wordlist.
  - The **browser sends a PING** as its first transport message, right after message 2.
  - The agent side **shows the words only after key confirmation**, once it has decrypted that first frame. A replayed message 1 never puts words in front of the user.
  - Both sides show the words. The agent side lets the browser in only after the user confirms them **on the agent side** (in the terminal that ran `connect`).
- **Failed attempts.** Before key confirmation, a handshake that fails ends that attempt, not the link: the agent side waits for another browser. After 5 failed attempts it gives the link up.
- **Remember.** Right after CONFIRMED, before any ACP message, a browser that is to be remembered sends one **REMEMBER** frame (§3) with the public half of a static X25519 key it has made for this connection. The words authenticated the channel, so they authenticate the key. The agent side binds the key to the connection. A browser that sends no REMEMBER can't reconnect.

### 2.2 Reconnect

`Noise_KK_25519_ChaChaPoly_BLAKE2s`, for a remembered browser coming back to its room:

- **Prologue:** the same as pairing's.
- **Pre-messages:** the browser knows the agent side's static key (from the link), and the agent side the browser's (from REMEMBER).
- **Message 1** (browser → agent): `e, es, ss`, with an empty payload. **Message 2** (agent → browser): `e, ee, se`, with an empty payload.
- **No psk and no words:** both static keys are already authenticated.
- **Key confirmation.** As in pairing, the browser's first transport frame is a PING, and the agent side acts only once it has decrypted it, so a replayed message 1 changes nothing. Then the agent side answers CONFIRMED by itself.
- **Resuming.** ACP stream ids don't restart with a reconnect: they go on counting over the whole connection, and each side keeps the messages it sent most recently (8 MiB by default).
  - The browser's PING carries the last stream it received whole, as a u32 BE, or nothing if it has lost its state (a reloaded page).
  - If it can, the agent side answers CONFIRMED with the last stream it received whole, as a u32 BE, then sends again every stream after the one the browser named. The browser does the same the other way. Nothing in flight when the socket died is lost.
  - If the browser sent an empty PING, or the agent side no longer has what the browser missed, CONFIRMED is empty: both sides start again from stream 1, and the browser loads the session afresh (§4). If the browser no longer has what the agent side missed, it fails the session, and reconnects with an empty PING.
- **Failures.** A reconnect that fails to decrypt ends only that attempt. After 5 failed attempts in a row, the agent side ends the connection.

## 3. Transport frames

After the handshake, each binary relay message is one Noise transport message. Its **plaintext** is:

```
offset size field
0      1    type      1 = ACP, 2 = CLOSE, 3 = PING, 4 = PONG, 5 = CONFIRMED, 6 = REMEMBER
1      4    stream    u32 BE; one ACP message is one stream
5      4    seq       u32 BE; chunk index within the stream, from 0
9      1    flags     bit0 FINAL (the last chunk of the stream)
10     4    length    u32 BE; bytes of payload in this chunk
14     n    payload
14+n   pad  zero bytes up to the bucket
```

- **Buckets.** The plaintext is padded to 256 bytes, else to the next power of two, capped at 65,519 (65,535 − 16). An ACP message longer than one frame is cut into chunks.
- **ACP payload:** one JSON-RPC 2.0 message in UTF-8, exactly as ACP defines it.
- **Streams.** ACP streams start at 1 and go up by exactly 1 per sender, across reconnects (§2.2). A stream is sent whole before the next starts, with no interleaving. `seq` goes up by 1, and `FINAL` ends the stream.
- **Control frames** (CLOSE, PING, PONG, CONFIRMED, REMEMBER) have stream 0, seq 0 and FINAL set.
- **Strict decoding.** Anything else is fatal:
  - a flag bit other than FINAL;
  - a plaintext whose length is not `bucket(14 + length)`;
  - non-zero padding;
  - a CONFIRMED whose payload is neither empty nor 4 bytes, or a CONFIRMED of a pairing with any payload;
  - a REMEMBER whose payload is not a 32-byte key in base64url without padding (43 characters), one from the agent side, one after a reconnect, a second one, or one after an ACP message;
  - a payload that is not valid UTF-8;
  - an unknown type, a gap or a repeat in `stream` or `seq`, or interleaved streams;
  - a stream left without `FINAL` when CLOSE arrives.
- **A failed decryption is fatal.** Close the WebSocket and never resync.
- **CLOSE.** The payload is a UTF-8 reason, and the receiver closes. A socket that ends *without* an authenticated CLOSE is reported as a lost connection, not an ended one.
- **PING and PONG.** A PONG echoes its PING's payload. They are allowed while pairing (before CONFIRMED) and between the chunks of a stream.
- **CONFIRMED** goes from the agent side to the browser, once the user has accepted the words, or once a reconnect's keys are confirmed. Before it, an ACP frame is fatal, and so is a CONFIRMED sent by the browser.
- **Rekey.** `Rekey()` runs on each CipherState after every 10,000 transport messages it has encrypted or decrypted. Handshake messages don't count.
- **Reassembly** caps one ACP message at 32 MiB.
- **Coalescing.** The agent side sends streamed text from `session/update` in batches, on a 150 ms tick. That is an optimisation the protocol cannot see.
- **No compression,** ever.

## 4. ACP over the channel

- **Roles.** The browser is a normal ACP **client**. To the browser, the agent side is an ACP **agent**: a **filtering proxy** in front of the real one.
- **`initialize`** is answered by the proxy. It reports the real agent's capabilities minus whatever is filtered. The proxy never passes the browser's `fs` or `terminal` client capabilities on to the real agent; it answers those requests itself.
- **Session.** The connection is bound to one ACP session, the one `connect` resumed or created.
  - `session/load` and `session/resume` are allowed **only for that session id**.
  - `session/new` is allowed and rebinds the connection. The proxy forces `cwd` to the connection's directory and `mcpServers` to the configured set, and ignores whatever the browser sends.
  - `session/list` returns exactly the bound session: one `SessionInfo`, with its `cwd`. That is how the browser learns the session id, which is not in the link.
- **Methods allowed from the browser:** `initialize`, `session/list`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`, `session/set_mode` and `session/set_config_option`, plus responses to the agent's requests. Anything else gets JSON-RPC error `-32601`. A method that names another session gets `-32602`.
- **Start-up sequence in the browser:** `initialize`, then `session/list`, then `session/load {sessionId, cwd, mcpServers: []}`. The proxy forces `cwd` and `mcpServers` anyway. If the list is empty, the browser calls `session/new`; since `connect` always binds a session, that is only a fallback.
- **From the agent to the browser.** `session/update` and the agent's `session/request_permission` and `elicitation/create` requests are forwarded.
  - If the browser picks an `allow_always` option, the proxy replaces it with the matching `allow_once`. An option the agent did not offer, or no answer, refuses.
  - `fs/*` and `terminal/*` requests are answered locally (refused) and never forwarded.
- **Ids.** The proxy remaps JSON-RPC ids in both directions, so the browser's ids never meet the agent's.
- **Leaving.** When a browser that isn't remembered goes, the connection ends, and the proxy cancels a turn it started.
- **Away.** When a remembered browser goes, the connection stays, waiting for it in the room for as long as the connection lives. The agent's turn goes on; what it sends is kept for the browser's return. Its questions wait for an answer as usual, and are refused if none comes in time.
- **Coming back.** A browser that resumed (§2.2) carries on as if it had never left. One that started again from stream 1 is a new client: questions put to the old one are refused, the turn goes on, and the browser runs its start-up sequence again.
- **A remembered browser can only come back to its connection.** It can't start another: that takes `connect`, a new link, and the words.

## 5. The link

```
https://<web origin>/#v1.<room>.<s_pub>.<psk>.<expiry>
```

- **Fields.** `room` is 16 bytes, `s_pub` 32 and `psk` 32, all in base64url without padding. `expiry` is unix seconds, in decimal.
- **Validity.** About 10 minutes, and single use. A remembered browser reconnects without it (§2.2): it keeps the room and `s_pub`, never the psk.
- **Web origin.** The scheme and host before the `#`, exactly `URL.origin`; a link with a path before the `#` is rejected. The origin also goes into the prologue. acpantenna is configured with it (`webOrigin`), and with the relay's URL separately (`relayUrl`).
- **What the web client does:**
  - reads the fragment, then calls `history.replaceState` to remove it;
  - checks `expiry`;
  - waits for a **click** before it connects;
  - shows the words, and sends nothing but its PING until the agent side's CONFIRMED.

## 6. Test vectors

`packages/relay-protocol/test-vectors/` has:

- `noise-nkpsk0.json` and `noise-kk.json`: the cacophony vectors for `Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s` and `Noise_KK_25519_ChaChaPoly_BLAKE2s`;
- `frames.json`: frames and their plaintexts, frames to refuse, the padding buckets, chunking, and stream sequences to accept or refuse;
- `sas.json`: handshake hashes and their words;
- `session.json`: a whole pairing with fixed keys, with every relay message in order.

Every implementation should pass them all.
