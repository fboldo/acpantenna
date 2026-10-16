# @acpantenna/channel-telegram

A [Telegram](https://telegram.org) channel: talk to the agent through a bot, in a private chat, a group, or a topic of a forum group. It speaks the [Bot API](https://core.telegram.org/bots/api) over `fetch`, with no dependencies, and polls for updates (`getUpdates`), so nothing has to reach your machine from outside: no webhook, no open port.

A private chat is one conversation, a group is one conversation, and in a group with topics each topic is one conversation of its own.

## Config

```ts
channels: {
	telegram: {
		type: "telegram",
		botToken: "${TELEGRAM_BOT_TOKEN}",
		permissions: {
			inbound: { mode: "allowlist", allow: ["123456789"] },
			toolCalls: "ask",
		},
		// Optional: stream replies into one message, edited as they grow.
		delivery: { mode: "streamChunks" },
	},
},
```

| Field | | |
| --- | --- | --- |
| `botToken` | required, **secret** | The token @BotFather gave the bot, like `123456789:AAE…`. Put it in an env var and write `${TELEGRAM_BOT_TOKEN}`. |
| `apiUrl` | default `https://api.telegram.org` | The Bot API server. Change it only for a [Bot API server of your own](https://github.com/tdlib/telegram-bot-api). |
| `requireMention` | default `true` | In a group, answer only messages that @mention the bot, reply to one of its messages, or are a command. Private chats are always answered. |
| `editIntervalMs` | default `1000` | Least time between two edits of a streamed message in a private chat. Groups use at least 3000. |

`permissions.inbound.allow` takes numeric ids, as strings: user ids (`"123456789"`) and chat ids (`"-1001234567890"`, a group; `"-1001234567890:42"`, one topic of it). Not usernames: a username can be changed or given up, and someone else can take it; an id stays with its account. Allowing a user lets them talk to the bot anywhere it is, privately or in a group; allowing a group's chat id lets everyone in that group talk to it there. Messages and button taps from anyone else are ignored.

The channel keeps one file, `offset.json`, in `<state dir>/channels/<channel id>/`: the next update to ask Telegram for, so a restart neither handles an update twice nor confirms one it never saw.

## One-time setup

1. **Create the bot.** In Telegram, open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`. Give it a name (shown in chats) and a username ending in `bot`. BotFather answers with the bot's token: that is `botToken`. Keep it secret; it is the bot's login. `/token` in BotFather shows it again, and `/revoke` replaces it if it leaks.

2. **Find your user id.** Start the channel with an empty allowlist, open a chat with your bot and press *Start*. It answers with your user id, the number to put in `permissions.inbound.allow`. (Bots such as @userinfobot tell you too.)

3. **Optional: commands in the menu.** In BotFather, `/setcommands`, choose the bot, and send:

   ```
   new - Start a new session
   cancel - Stop the current turn
   mode - Switch the agent's mode
   ```

   These are the gateway's own commands; the menu only makes them one tap away.

`acpantenna setup` asks for the token (kept in the OS keychain), the conversation `connect` uses when none is given (a chat id, such as your own user id for your private chat with the bot), and the ids that may talk to it.

## In groups

Add the bot to the group like any member. Then:

- With `requireMention` (the default), the bot answers a message only when it is for the bot: an `@mention` of it, a reply to one of its messages, or a command (`/new`, or `/new@yourbot`; a command for another bot is ignored). The mention is taken out of the text the agent gets. Set `requireMention: false` to answer every message in the group.
- **Privacy mode.** Bots start with privacy mode on, and Telegram then sends a bot only some of a group's messages: commands, and replies to the bot's own messages. To have the bot see mentions (and, with `requireMention: false`, everything), either turn privacy mode off in BotFather (`/setprivacy` → the bot → *Disable*) and then remove the bot from the group and add it again, which is when the change takes effect; or make the bot an admin of the group, since admins receive every message.
- **Forum topics.** In a group with topics, each topic is a conversation (`<chat id>:<topic id>`), with a session of its own; the bot answers in the topic it was written to. The general topic is the group's own chat id.
- Telegram allows a bot about 20 messages a minute in a group, edits included. The channel spaces its sends and edits to stay under that (and about one a second in a private chat), and waits out the `retry_after` of a 429 when it gets one anyway.
- When a group becomes a supergroup, its chat id changes; the bot logs the new id. Update `allow` and `defaultConversation` if they name the old one.

## In a chat

- Replies are formatted: the agent's markdown is sent as Telegram HTML (bold, italic, strikethrough, inline code, code blocks with their language, links, quotes; headings as bold lines and list items with •). Every piece of text is escaped, links keep only `http(s)`, `mailto` and `tg` URLs, and should Telegram still refuse the HTML, the plain text is sent instead.
- A reply longer than Telegram's 4096 characters continues in a new message, cut at a paragraph or line, a code block closed and opened again across the cut.
- With `delivery.mode: "streamChunks"` (or `debounceChunks`) a reply is one message edited as it streams in, at most every `editIntervalMs`. The default `bufferUntilTurnEnd` sends it once, complete. When the bot takes a message, the chat shows *typing…* for a few seconds.
- Tool calls are folded into one message per turn, one line each (`⏳ 💻 Run tests` → `✅ 💻 Run tests`), edited in place as their status changes.
- A permission comes with a button per option (✅ for allowing ones, ❌ for refusing ones). Tap one: the prompt is edited to show the answer and who gave it, and the buttons are gone. Only someone on the allowlist can answer; anyone else's tap gets "You can't answer this." You can also reply with the option's number or text, or yes/no. A question with a form takes a reply to its message (one field: the answer; several: `name: value` lines), or the Decline button. A button under a question the agent no longer waits for says so.
- Files the agent sends are uploaded: PNG, JPEG and WebP images up to 10 MB as photos, MP4 video and MP3/M4A audio to play in the chat, anything else (a GIF, an SVG, a larger image, a zip) as a document. A file over the Bot API's 50 MB is not uploaded; the chat gets a message saying which file, how big, and the limit.
- The gateway's own commands work as everywhere: `/cancel`, `/new`, `/mode <id>`.
- The bot ignores other bots, channels, messages other than text (it says so), edits, and anything sent before it started.

## Health

`GET /status` shows the channel as ready, or failing with a reason such as:

- *Telegram channel: Set the bot's token (from @BotFather).*
- *Telegram rejected the bot token. Copy it again from @BotFather (/token) and update the channel.*
- *The bot has a webhook set (…), so it can't poll for updates. Remove it (deleteWebhook), or use another bot.* The channel does not remove a webhook itself: something else may be using it.
- *Another program is polling for this bot's updates; only one can at a time.* Run one channel per bot.
- *Can't reach api.telegram.org; retrying.*

A rejected token stops the channel (fix the config); losing the connection is retried in the background. The token is never written to a log.

## Not supported

- Webhooks: the channel only polls.
- Messages the agent can't read: photos, files, voice notes and stickers sent to the bot get "I can only read text messages for now." A photo's caption is read as text.
- Edits of messages already sent, and the agent's thoughts.
- Channels (Telegram's broadcast kind) and inline mode.

## Tests

`bun test src` covers the formatting, splitting at 4096, the buttons and answers, the allowlist and addressing, rate limiting and pacing, and the runtime against an in-memory Bot API; nothing goes to Telegram.
