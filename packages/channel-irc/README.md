# @acpantenna/channel-irc

An IRC channel: talk to the agent in IRC channels or private messages. It works with any IRC server — Libera.Chat, OFTC, your own (InspIRCd, Ergo, UnrealIRCd, …) — over TLS, logged in to a services account with SASL. The client is written on `node:tls` with no dependencies.

A channel is one conversation, and so is each person writing to the bot privately: the conversation id is the channel name (`#team`) or the nick (`alice`), in the server's lower case.

## Config

```ts
channels: {
	irc: {
		type: "irc",
		server: "irc.libera.chat",
		nick: "mybot",
		password: "${IRC_BOT_PASSWORD}",
		channels: ["#my-project", "#private-room ${IRC_ROOM_KEY}"],
		permissions: {
			inbound: { mode: "allowlist", allow: ["account:me"] },
			toolCalls: "ask",
		},
		// Optional: send a reply line by line as it streams in.
		delivery: { mode: "streamChunks" },
	},
},
```

| Field | | |
| --- | --- | --- |
| `server` | required | The server's host name. |
| `nick` | required | The bot's nick. Register it with the network's services (see below). |
| `password` | **secret**, optional | The bot's services account password. Sent with SASL PLAIN, inside TLS. With it set, the bot does not connect without logging in: a server without SASL, or a rejected password, stops the channel (unless `nickserv`). |
| `account` | default the nick | The services account to log in to, when it is not the nick. |
| `nickserv` | default `false` | On a server without SASL, identify by sending `IDENTIFY <account> <password>` to NickServ after connecting. Weaker: the bot is briefly online unidentified, and the password goes to whatever answers to NickServ. |
| `serverPassword` | **secret**, optional | A password for the server itself (`PASS`), for bouncers and private servers. |
| `channels` | optional | Channels to join: `#name`, or `#name key` for one with a key (write the key as `${ENV_VAR}`). Private messages work without any. |
| `port` | default `6697` (TLS), `6667` | |
| `tls` | default `true` | Turn off only for a server on this machine: the channel refuses to send a password over plain text to any other host. |
| `tlsVerify` | default `true` | Check the server's certificate. |
| `username`, `realname` | default the nick, `acpantenna` | The `user` in `nick!user@host`, and the real name. |
| `respond` | default `mention` | In a channel: `mention` answers only messages addressed to the bot (`mybot: …`, `mybot, …`, `@mybot …`); `always` answers every message from an allowed sender. Private messages are always answered. |
| `maxLines` | default `10` | Most lines one reply sends; the rest wait for `more` (`mybot: more` in a channel). `0` sends everything. |
| `sendBurst`, `sendIntervalMs` | default `4`, `1000` | Flood control: this many lines at once, then one per interval. Servers disconnect clients that send too fast ("Excess Flood"). |
| `showToolCalls` | default `true` | The agent's tool calls as short notices. |

`setup` asks for the server, nick and passwords, then the channels and the rest if you want to adjust them.

## Who may talk to the bot

`permissions.inbound.allow` takes:

| Entry | Lets in | |
| --- | --- | --- |
| `account:alice` | anyone logged in to the services account `alice` | **Use this.** The server vouches for the account. |
| `*!*@user/alice` | anyone whose `nick!user@host` matches (`*`, `?` wildcards) | As safe as the host part: a services cloak (`user/alice` on Libera.Chat) or an address you control. `alice!*@*` is no better than a bare nick. |
| `#channel` | anyone writing in that channel | Fine for a channel with `+i`, a key, or only people you trust. |
| `alice` | anyone using the nick `alice` | **Spoofable.** Nicks belong to whoever has them right now: on a network without services, or while `alice` is offline, anyone can take it. The bot logs a warning for these. |
| `*` | everybody | |

How the bot knows an account. It asks the server for IRCv3 `account-tag`, and then reads the account from each message's tag: a message with no tag is from someone not logged in. Where the server has no `account-tag` but has `account-notify` and `extended-join` (and `WHOX`), the bot keeps track of the accounts of the people in its channels instead; that only covers people who share a channel with it. Where the server offers neither, nobody's account is known and `account:` entries let nobody in: use masks on cloaked hosts, or a server that supports IRCv3 (Libera.Chat, OFTC's newer servers, Ergo, InspIRCd and UnrealIRCd with their modules).

The same check applies to answers to the agent's questions: nobody off the allowlist can approve a permission.

## In a channel or a private message

- Replies are plain text. Markdown is made readable: headings and bold lose their markers, links read `label <url>`, code blocks lose their fences, blank lines go (IRC has no empty message). Control characters are dropped, so an agent's text can never become IRC formatting, a CTCP request, or a second command.
- Each line is cut to fit IRC's 512-byte limit, counting the `:mybot!user@host PRIVMSG #channel :` the server puts in front (at its longest, until the bot has seen its own host). Cuts are between words, and never inside a UTF-8 character or an emoji.
- A reply over `maxLines` sends its first lines and a notice: *… 14 more lines; say “mybot: more” to see them.* What is held is dropped when someone writes the next prompt.
- With `delivery.mode: "streamChunks"` (or `debounceChunks`) a reply goes out a line at a time as it is written; an unfinished line is sent after two seconds of quiet. IRC cannot edit a message, so there is nothing to update in place. The default `bufferUntilTurnEnd` sends the reply once, complete.
- Tool calls close together share one notice (`📖 Read src/a.ts · 💻 Run tests`); a tool call that fails gets one of its own.
- A permission or question is a numbered list. Answer with the number, the option's text, or yes / no; in a channel a bare `2` is enough. A form question takes `mybot: <answer>` (one field) or `mybot: name: value; name: value`; `decline` turns it down. The bot confirms with a notice: *→ Allow once (alice)*.
- Files the agent sends are not uploaded (IRC carries only text); the gateway says in the conversation which file was not sent.
- The gateway's own commands work as everywhere, addressed in a channel: `mybot: /cancel`, `/new`, `/mode <id>`.
- The bot ignores NOTICEs (what bots send, so two bots can't loop), CTCP other than `/me`, and its own messages.

## Connection

- Registration negotiates IRCv3 capabilities (`CAP LS 302`): `sasl`, `account-tag`, `account-notify`, `extended-join`, `message-tags`, `cap-notify`, each only when offered.
- The bot answers the server's PINGs straight away (ahead of any queued lines), pings a server that has gone quiet for 90 s, and reconnects when it has heard nothing for 4 minutes.
- If its nick is taken it uses `mybot_` (then `mybot` and digits), and asks for its own nick back every minute.
- A lost connection is retried with backoff, from 2 s doubling to 5 minutes. A rejected SASL login, a refused nick or a wrong server password is not retried (fix the config); `GET /status` says why.
- Kicked from a configured channel, it rejoins after 15 s.

## Security notes

- Keep `tls` on. The bot checks the certificate, and refuses to send a password in plain text except to `localhost`.
- Register the bot's nick with the network's services and set `password`, so nobody can take the nick while the bot is away. SASL logs in before the bot is visible; NickServ identification comes after.
- Prefer `account:` entries. A hostmask is as good as its host; a nick is not good at all.
- A channel entry trusts everyone who can write in the channel. Anyone who can talk to the bot can ask the agent to act, within `permissions.toolCalls`.
- Everything said on IRC is seen by the server operators and, in a channel, by everyone in it. Don't let the agent work on what they shouldn't read.

## Tests

`bun test src` covers the protocol parser, splitting, formatting, flood control, the allowlist, interactions, and the client and runtime against a fake server. Nothing touches the network.
