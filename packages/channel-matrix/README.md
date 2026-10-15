# @acpantenna/channel-matrix

A [Matrix](https://matrix.org) channel: talk to the agent in Matrix rooms, end-to-end encrypted. It works with a public homeserver such as matrix.org, or your own (Synapse, Tuwunel/conduwuit, …): only `homeserverUrl` changes.

One room is one conversation. The bot joins rooms it is invited to by someone on the inbound allowlist, and answers messages there.

## Config

```ts
channels: {
	matrix: {
		type: "matrix",
		homeserverUrl: "https://matrix.org",
		userId: "@mybot:matrix.org",
		password: "${MATRIX_BOT_PASSWORD}",
		permissions: {
			inbound: { mode: "allowlist", allow: ["@me:matrix.org"] },
			toolCalls: "ask",
		},
		// Optional: stream replies into one message, edited as they grow.
		delivery: { mode: "streamChunks" },
	},
},
```

| Field | | |
| --- | --- | --- |
| `homeserverUrl` | required, default `https://matrix.org` | The bot account's homeserver. A server name with a `.well-known/matrix/client` file works too. |
| `userId` | required | The bot's Matrix ID, `@name:server`. |
| `password` | **secret**; this or `accessToken` | The bot's password. The bot logs in once, as a new device, and keeps that session in its state dir (`session.json`, 0600); it logs in again only if the session is rejected or its keys are gone. The password also lets it set up its cross-signing identity on servers that ask for the password to do so. |
| `accessToken` | **secret**; this or `password` | Instead of a password: an access token for a device with no encryption keys yet (see below). |
| `deviceId` | optional | With `accessToken`: the device it belongs to. Left empty, the homeserver is asked. |
| `deviceName` | default `acpantenna` | With `password`: the name of the device the bot logs in as. |
| `encryption` | default `true` | End-to-end encryption. With it off, the bot cannot read encrypted rooms. |
| `storePassphrase` | optional, **secret** | Encrypts the bot's key store on disk. Once set, the bot cannot start without it. |
| `editIntervalMs` | default `3000` | Least time between two edits of a streamed message. |

`permissions.inbound.allow` takes Matrix user IDs (`@me:matrix.org`) or room IDs (`!abc:matrix.org`). Invites, messages, reactions and verification requests from anyone else are ignored.

Exactly one of `password` and `accessToken` is needed; a schema cannot say "one of", so a missing or doubled one is reported when the channel starts. Put either in an env var and write `${MATRIX_BOT_PASSWORD}`.

The bot's session, encryption keys and secret-storage key are kept in `<state dir>/channels/<channel id>/` (beside `acpantenna.sqlite`), mode 0600. Nothing to configure, but keep that directory: losing it means the bot gets a new identity (see below).

## One-time setup

1. **Create a bot account.** Sign up on your homeserver, for example at <https://app.element.io/#/register> for matrix.org. Use a private window so you stay signed in as yourself elsewhere. Pick a password.

2. **Give the bot its password** (`password` in the config). That's all: it logs in by itself, once.

   Or, if you'd rather not store the password, **get an access token for a new device** by logging the bot in once through the API. Each login is a new device, with no encryption keys yet, which is what the bot needs:

   ```bash
   curl -s https://matrix.org/_matrix/client/v3/login \
     -H 'content-type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"mybot"},"password":"…","initial_device_display_name":"Agent"}'
   ```

   Copy `access_token` (and `user_id`; `device_id` is optional) into the channel config. Keep the token secret: it is the bot's login.

   Don't use the token Element shows under *Settings → Help & About*: that device already holds Element's own encryption keys, and the bot would refuse to start with it ("this device already has encryption keys").

3. **Invite the bot.** In Element, start a direct chat with (or create an encrypted room and invite) `@mybot:matrix.org`, from an account on the allowlist. The bot joins within a few seconds of starting.

4. **Verify the bot (recommended).** On its first start the bot cross-signs its own device, so Element doesn't warn that its messages come from "a device not verified by its owner" (see *Cross-signing* below for the one case that needs you). To get the green shield as well, verify the bot in Element: open the bot's profile → *Verify* → *Verify by emoji*. The bot accepts, and posts the emoji it sees in the room. If they match the ones in Element, confirm in Element. That's all; the bot confirms its side by itself.

   Until you do, Element shows the bot as unverified (a grey shield). Messages still work both ways.

## Cross-signing

The bot makes sure its device is cross-signed, without asking anyone for a secret:

- **A fresh account** (no cross-signing yet): it creates the keys and publishes them. Homeservers allow a first upload without re-authentication.
- **An account another app set up first.** Element sets up cross-signing (and secret storage, under a recovery key the bot doesn't have) as soon as you open an account in it, for example to register it. The bot can't use those keys, so it replaces them with its own. If the account's secret storage uses a key it doesn't hold, it first creates its own secret-storage key, keeps it in its state dir, and makes that the account's default. Replacing published keys needs re-authentication:
  - On a server that takes the password for that (Synapse with its own logins, Tuwunel, conduwuit), the bot uses `password`. With only an access token, it logs that it needs `password`.
  - On a server that delegates login to an authentication service (matrix.org, through MAS), no client can do it with a password. The account's owner has to approve the reset once, in a browser. The bot logs a warning with the link (`https://account.matrix.org/account/?action=org.matrix.cross_signing_reset` on matrix.org). Open it signed in as the bot and approve; the bot retries every five minutes and finishes by itself, within the ten minutes the approval lasts.

  To avoid all of this on matrix.org, register the bot at <https://account.matrix.org> and don't open it in Element before the bot has started once.
- **Afterwards** the keys are in the bot's state dir and nothing is redone on restart. Losing the state dir is the "another app" case again, with the bot's own earlier keys.

## In a room

- Replies are formatted (markdown is sent as HTML, sanitised; the plain text stays as the fallback). With `delivery.mode: "streamChunks"` (or `debounceChunks`) a reply is one message, edited as it streams in, at most every `editIntervalMs`. The default `bufferUntilTurnEnd` sends it once, complete.
- Tool calls are folded into one quiet notice per turn, one line each (`⏳ 💻 Run tests` → `✅ 💻 Run tests`), edited in place as their status changes.
- Messages the agent sends between turns arrive as new messages.
- Files the agent sends (an ACP `image`/`audio` block, an embedded `resource`, or a `resource_link` to a `file://` path) are uploaded: images as `m.image` with their size, video and audio as `m.video`/`m.audio`, anything else as `m.file`. In an encrypted room the file is encrypted before upload and the homeserver sees only ciphertext. A file over the homeserver's `m.upload.size` is not uploaded; the room gets a notice saying which file, how big, and the limit. A file the agent names that is gone by then is reported the same way.
- A permission or question is a numbered list. Answer by tapping a reaction: ✅ for the first "allow", ❌ for the first "reject", 1️⃣ 2️⃣ … for choices (👍/👎 work too). You can also reply with the number, the option's text, or yes/no. A form question takes a plain reply (one field) or `name: value` lines; `decline` turns it down. The prompt is edited to show the answer.
- The gateway's own commands work as everywhere: `/cancel`, `/new`, `/mode <id>`.
- The bot ignores its own messages, other bots' notices, edits, and anything sent before it started.

## Health

`GET /status` shows the channel as ready, or failing with a reason such as:

- *Matrix channel: Set the bot's password (or an access token).* (or "…not both")
- *The homeserver rejected the password for @mybot:matrix.org. Check userId and password.*
- *The access token was rejected by matrix.org. Create a new one for the bot and update the channel.*
- *Can't reach the homeserver at matrix.org; retrying.*
- *The access token belongs to @other:matrix.org, not @mybot:matrix.org.*
- *matrix.org is rate-limiting the bot; retrying.*

Connection loss is retried in the background; a rejected password or token is not (fix the config). With a password, a stored session the server no longer accepts is replaced by a new login on its own.

## Keys and restarts

The Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`) keeps its state in IndexedDB. Under Bun that is [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) in memory, with a copy written to `crypto-<device>.bin` shortly after every change and restored at start. If the process is killed in the half second between a key change and the write, the newest change is lost: a message or two may then fail to decrypt (the bot says so in the room) until the sender's client starts a new session, which Matrix clients do on their own.

If the state directory is lost, the bot's device cannot be restored. With `password` the bot logs in again as a new device by itself, and sets up cross-signing again as above; people who verified it will need to verify it again. With `accessToken`, get a token for a new device (step 2).

## Bundling

`bun build --target bun` of the CLI produces one file that includes the crypto. The wasm (7.4 MB) is inlined gzipped as base64 (≈2.8 MB) by a Bun macro (`src/crypto-wasm.macro.ts`). A small patch to the crypto package (`patches/`, applied by `bun install` via `patchedDependencies`) makes its loader take those bytes instead of reading `pkg/*.wasm` beside the module, which a single file doesn't have. `src/crypto-wasm.test.ts` fails if the patch is missing.

## Tests

`bun test src` covers the pure parts. `bun test e2e` (from this package) runs the whole path against a real homeserver: a Tuwunel container started with docker, or the one in `MATRIX_E2E_HOMESERVER` (with `MATRIX_E2E_REGISTRATION_TOKEN`). It bundles the CLI into one file, runs it from a directory with no `node_modules`, and has a person chat with the bot in an encrypted room: replies, tool calls, a permission answered by reaction and by number, a restart, emoji verification, and a rejected token.
