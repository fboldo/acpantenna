---
name: continue-on-phone
description: Continue the current agent session on your phone, mobile or any browser — remote access to a coding agent (Claude Code, Codex, OpenCode, Gemini CLI, Cursor, Cline or any other that speaks ACP) away from your desk — with acpantenna, end-to-end encrypted, through a one-time link and QR code. Use when the user wants to continue this session on their phone, tablet or another computer, keep working away from their desk, hand the session off to a browser, or share it through latch.im; also when they ask to list or disconnect acpantenna connections.
---

# Continue on your phone

[acpantenna](https://github.com/fboldo/acpantenna) gives an agent session a link. Opened in a browser — the web client at latch.im unless the user's config says otherwise — it carries on the same session there, end-to-end encrypted. The relay in between only forwards ciphertext.

It works for any agent that speaks [ACP](https://agentclientprotocol.com): Claude Code, Codex and OpenCode are built in, and Gemini CLI, GitHub Copilot, Cursor, Qwen Code, Kimi CLI, Mistral Vibe, Cline or anything else is one entry in the config (see [Other agents](#other-agents)).

Needs Node 18 or newer. Run it as `npx -y acpantenna`; the package brings its own Bun.

## The rule that matters

Pairing ends with **four words** shown in the browser and in the terminal. Only the human can see both. **Never answer the words yourself.** Show the user the words, ask whether they match what their browser shows, and send `yes` only when they say they do. Anything else — no, unsure, no answer — is `no`. A yes is what lets the browser into the session; a wrong yes hands it to whoever opened the link.

## Carry this session over

### 1. Name the agent, find the session id

`connect` wants two things: what your agent goes by — `claude`, `codex`, `opencode`, or the id its entry in the config uses — and the id of the session you are in. That id is the one your own CLI would resume:

| You are | `connect` with | Your session id | Back at your desk |
| --- | --- | --- | --- |
| Claude Code | `claude` | `$CLAUDE_CODE_SESSION_ID` | `claude --resume <id>` |
| Codex | `codex` | `$CODEX_THREAD_ID` if set; else the id at the end of the newest `~/.codex/sessions/**/rollout-*.jsonl` | `codex resume <id>` |
| OpenCode | `opencode` | the current one in `opencode session list` | `opencode --session <id>` |
| Anything else | the id in your config | your agent's own: an environment variable, a session-list command, or its session store | your agent's own resume command |

Check the id is not empty before going on, and that the agent behind `connect` reads the same session store — the built-in three do, an adapter someone else wrote may not. If you cannot find an id, or cannot tell whether it is the one the adapter reads, leave out `--session-id` and `--fork`: the browser gets a new session in this directory, and say so to the user.

### 2. Fork, or hand off

This session is still running here, and two processes writing to one session drift apart. So:

- **Fork** (what you run, by default): `--session-id <id> --fork`. The browser gets a copy of the conversation so far; this terminal session carries on separately. Forking needs the agent to support ACP's `session/fork`: if it does not, `connect` fails with `Agent "<agent>" cannot fork sessions.` — hand off instead.
- **Hand off**, if the user wants the very same session on the phone: they quit here first, then run in their terminal:

  ```bash
  npx -y acpantenna connect <agent> --session-id <id>
  ```

  Give them that line with the agent and id filled in, and stop: you cannot run it after they have quit you. Back at the desk, resume it your agent's own way — the last column above.

### 3. Connect

`connect` waits for the browser, then reads the answer to the words from stdin. Run it in the background, with stdin from a file you append to, from the project directory:

```bash
dir=$(mktemp -d)
touch "$dir/answer"
(npx -y acpantenna connect <agent> --session-id "<id>" --fork \
  < <(timeout 11m tail -f "$dir/answer") >"$dir/out" 2>&1
 echo "exit $?" >>"$dir/out") &
echo "$dir"
```

Put your own agent and id in — `connect claude --session-id "$CLAUDE_CODE_SESSION_ID"` for Claude Code, for instance. That needs bash or zsh. Keep `$dir`; every later step needs it. Without a terminal, `connect` prints everything to `$dir/out` and draws no QR code. If you cannot run a process in the background — no shell, or no process substitution — give the user that `connect` line to run in their own terminal and stop there; they answer about the words themselves, the way steps 5 and 6 describe.

### 4. Give the user the link

Wait until `$dir/out` has a line starting with `https://` (the first run may take a minute, fetching the agent's adapter). Give the user that link and tell them:

- open it on the phone or browser they want to use; it works **once**, for **10 minutes**;
- the browser will show four words, and you will ask about them.

If they want a QR code, `npx -y qrcode-terminal '<link>'` draws one, or they can paste the link into anything that makes them.

### 5. Check the words

When `$dir/out` has `The browser shows: …`, ask the user, quoting the four words exactly:

> Your terminal shows **word1 word2 word3 word4**. Does your browser show the same four words?

Then, only with their yes:

```bash
echo yes >>"$dir/answer"
```

Otherwise `echo no >>"$dir/answer"`, and tell them nothing was connected.

### 6. Confirm

`$dir/out` ends with `Connected <agent> session <id> to latch · <conversation>` and `exit 0` when it worked. Tell the user it is connected, and how to end it:

```bash
npx -y acpantenna kill <session-id>
```

An `exit` other than 0 means it did not connect; show the user the last lines of `$dir/out`. Then `rm -rf "$dir"`.

## Other agents

Claude Code, Codex and OpenCode are built in: `connect claude`, `connect codex`, `connect opencode`. Any other agent that speaks ACP — Gemini CLI, GitHub Copilot, Cursor, Qwen Code, Kimi CLI, Mistral Vibe, Cline, and [the rest of the list](https://agentclientprotocol.com/get-started/agents) — is one entry in the config, with the command its documentation gives for ACP:

```json
{ "agents": { "my-agent": { "command": "my-agent", "args": ["acp"] } } }
```

```bash
npx -y acpantenna connect my-agent
```

It has to be installed and logged in, as it is in your terminal. From there every step above is the same, with `my-agent` where `<agent>` is. More in the [README](https://github.com/fboldo/acpantenna#agents).

## Other commands

| | |
| --- | --- |
| `npx -y acpantenna ls` | What is connected (`--json` for the details) |
| `npx -y acpantenna kill <id>` | Disconnect, by session id or a unique prefix; `--all` for every one. The session itself is kept |
| `npx -y acpantenna revoke` | New key for the relay channel: every link given out stops working, and its connections are dropped. Use it if a link went somewhere it should not have |
| `npx -y acpantenna doctor` | Check the config and point out risky settings |
| `npx -y acpantenna setup` | Add Matrix or a webhook channel. Interactive: ask the user to run it in their own terminal |

`connect --channel <id>` connects through another configured channel, such as Matrix, instead of latch.im; those need no words.

## What the browser can do

The browser is an ACP client of the session behind a filtering proxy: it can prompt, cancel, and change mode, in the session's own directory. The agent's own permission requests are asked in the browser. File and terminal requests to the client are refused, and "always allow" is answered as "allow once". More in the [README](https://github.com/fboldo/acpantenna#latchim-the-built-in-channel).
