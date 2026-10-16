# @acpantenna/channel-discord

A [Discord](https://discord.com) channel: talk to the agent in direct messages, server channels and threads. It speaks Discord's Gateway (WebSocket) and REST API v10 itself, with Bun's `WebSocket` and `fetch`; there is no Discord library to install.

One Discord channel is one conversation: a DM with the bot, a text channel, or a thread (each thread is a conversation of its own). The bot answers messages there from people on the inbound allowlist.

## Config

```ts
channels: {
	discord: {
		type: "discord",
		botToken: "${DISCORD_BOT_TOKEN}",
		permissions: {
			inbound: { mode: "allowlist", allow: ["123456789012345678"] },
			toolCalls: "ask",
		},
		// Optional: stream replies into one message, edited as they grow.
		delivery: { mode: "streamChunks" },
	},
},
```

| Field | | |
| --- | --- | --- |
| `botToken` | required, **secret** | The bot's token, from the developer portal (see below). Put it in an env var and write `${DISCORD_BOT_TOKEN}`. |
| `requireMention` | default `false` | In server channels and threads, answer only messages that @mention the bot (and replies to its questions). DMs are always answered. |
| `editIntervalMs` | default `1500` | Least time between two edits of a streamed message. Discord allows about five edits per five seconds in a channel. |
| `maxUploadBytes` | default `10485760` (10 MiB) | Largest file the bot uploads. Discord takes 10 MiB without boosts; raise it to 50 MiB or 100 MiB for a server at boost level 2 or 3. |

`permissions.inbound.allow` takes Discord IDs, any mix of:

- **user IDs**: that person, wherever they talk to the bot (a DM, or any channel the bot can read);
- **channel IDs**: anyone in that channel, and in the threads started in it;
- **server (guild) IDs**: anyone in any channel of that server.

Messages and button presses from anyone else are ignored (a button press gets a private "not on the allowlist" reply). To copy an ID, turn on *Settings → Advanced → Developer Mode* in Discord, then right-click a user, channel or server → *Copy ID*.

`defaultConversation` (what `connect` uses when no conversation is given) is a channel ID. For a DM with the bot, it is the DM's channel ID: the last number in the URL when you open the DM in a browser (`https://discord.com/channels/@me/<channel id>`).

## One-time setup

1. **Create an application.** Open the [developer portal](https://discord.com/developers/applications) → *New Application*, and give it a name (the bot shows under it).

2. **Get the bot's token.** In the application, open *Bot* → *Reset Token*, and copy it into `DISCORD_BOT_TOKEN`. Keep it secret: it is the bot's login. On the same page you may turn off *Public Bot*, so only you can add it to servers.

3. **Turn on the Message Content intent.** Still on the *Bot* page, under *Privileged Gateway Intents*, turn on **Message Content Intent** and save. Without it the bot cannot read what people write in server channels; Discord refuses its connection, and the channel's health says so. (The bot also asks for the Guilds, Guild Messages and Direct Messages intents, which need no switch.)

4. **Invite the bot to a server.** Open this URL with your application's ID (*General Information → Application ID*) in place of `APP_ID`:

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=274878008320
   ```

   The scope is `bot`; the permissions are View Channels, Send Messages, Send Messages in Threads, Attach Files and Read Message History. Pick the server and authorize. In a private channel, also add the bot (or its role) to the channel.

   For DMs only, the bot still needs to share a server with you: Discord lets a bot be messaged only by people it shares a server with. Once it is in one, open its profile and *Send Message*.

5. **Allow yourself.** Put your user ID (or the channel's, or the server's) in `permissions.inbound.allow`, start acpantenna, and say hello.

## In a conversation

- Replies are Discord markdown, as the agent writes it. Mentions in them never ping anyone (`@everyone` included). A reply over Discord's 2000-character limit continues in a new message, cut at a paragraph or line; a code block cut in two is closed and reopened with its language, so both halves render as code.
- With `delivery.mode: "streamChunks"` (or `debounceChunks`) a reply is one message, edited as it streams in, at most every `editIntervalMs`. The default `bufferUntilTurnEnd` sends it once, complete.
- Tool calls are folded into one quiet message per turn, one small grey line each (`⏳ 💻 Run tests` → `✅ 💻 Run tests`), edited in place as their status changes. It is sent without a notification or link previews.
- A permission comes with buttons: green for allow, red for reject. A question with choices has a button per choice, and *Decline*. A question with fields (up to five) has *Answer…*, which opens a Discord form; what is typed there is checked (a number where a number is wanted, one of the allowed values) before it is passed on. You can also reply in the channel: the option's number or text, yes/no, a form question's answer (or `name: value` lines), or `decline`. The question is edited to show the answer and who gave it, and its buttons go. When the gateway stops waiting (`permissions.interactionTimeoutSeconds`), the buttons go too, and the question says it is no longer open.
- Files the agent sends are uploaded: images show inline, video and audio play, anything else is a download. A file over `maxUploadBytes`, or one Discord refuses as too large, is not sent; the conversation gets a message saying which file, how big, and why.
- While the agent works on a prompt, the bot shows as typing.
- The gateway's own commands work as everywhere: `/cancel`, `/new`, `/mode <id>`.
- The bot ignores other bots, webhooks, its own messages, and system messages (joins, pins). It reads text only: a message with only an attachment gets "I can only read text messages for now."

## Connection

The bot keeps one Gateway connection: it identifies, heartbeats at the interval Discord gives, and on a dropped connection, a heartbeat Discord does not answer, or Discord asking it to reconnect, resumes the same session, so no message sent meanwhile is missed. When Discord says the session cannot be resumed, it identifies afresh. Reconnects back off from 1 s to a minute.

REST requests follow Discord's rate limits: each route's bucket (`X-RateLimit-*` headers) is respected before sending, and a 429 is waited out for its `retry_after` (every route waits on a global one). A wait over 30 seconds is handed back to the gateway, which retries the message later instead of holding the conversation.

## Health

`GET /status` shows the channel as ready, or failing with a reason such as:

- *Discord channel: Set the bot's token (botToken).*
- *Discord rejected the bot token. Reset it in the developer portal and update botToken.*
- *The bot asked for the Message Content intent, which is not enabled for it. …* (step 3)
- *Lost the connection to Discord (1006); reconnecting.*
- *The bot lacks a permission it needs there (Send Messages, Attach Files, Read Message History, …).* (for a message that could not be sent)

A rejected token or a refused intent is not retried (fix the config, or the portal, and restart); connection loss is.

## Not supported

- Slash commands: the gateway's commands are typed as messages (`/cancel`), which Discord passes through as text.
- Reading files people upload, voice, and reactions.
- The agent's thoughts are not shown.
- Sharding: one connection serves up to 2,500 servers, which is Discord's limit before sharding is required.

## Tests

`bun test src` covers the pure parts (splitting, buttons and forms, the allowlist, rate-limit buckets, the Gateway's identify/resume/heartbeat) and the runtime against a fake Discord: REST answered from a script and the Gateway on a fake socket. Nothing touches the network.
