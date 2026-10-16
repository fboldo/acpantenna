---
name: acpantenna
description: Carry the current coding-agent session over to a phone or any browser with acpantenna, end-to-end encrypted, through a one-time link and QR code. Use when the user wants to continue this session on their phone, tablet or another computer, keep working away from their desk, hand the session off to a browser, or share it through latch.im; also when they ask to list or disconnect acpantenna connections. Works for Claude Code, Codex, OpenCode and any ACP agent.
---

# acpantenna

[acpantenna](https://github.com/fboldo/acpantenna) gives an agent session a link. Opened in a browser — the web client at latch.im unless the user's config says otherwise — it carries on the same session there, end-to-end encrypted. The relay in between only forwards ciphertext.

Needs Node 18 or newer. Run it as `npx -y acpantenna`; the package brings its own Bun.

## The rule that matters

Pairing ends with **four words** shown in the browser and in the terminal. Only the human can see both. **Never answer the words yourself.** Show the user the words, ask whether they match what their browser shows, and send `yes` only when they say they do. Anything else — no, unsure, no answer — is `no`. A yes is what lets the browser into the session; a wrong yes hands it to whoever opened the link.

## Carry this session over

### 1. Find the agent and its session id

| You are | Agent | Session id |
| --- | --- | --- |
| Claude Code | `claude` | `$CLAUDE_CODE_SESSION_ID` |
| Codex | `codex` | `$CODEX_THREAD_ID` if set; else the id at the end of the newest `~/.codex/sessions/**/rollout-*.jsonl` |
| OpenCode | `opencode` | the current session in `opencode session list` |

Check the id is not empty before going on. If you cannot find it, leave out `--session-id` and `--fork`: the browser gets a new session in this directory, and say so to the user.

### 2. Fork, or hand off

This session is still running here, and two processes writing to one session drift apart. So:

- **Fork** (the default when you run it): `--session-id <id> --fork`. The browser gets a copy of the conversation so far; this terminal session carries on separately.
- **Hand off**, if the user wants the very same session on the phone: they quit here first, then run in their terminal:

  ```bash
  npx -y acpantenna connect <agent> --session-id <id>
  ```

  Give them that line with the id filled in, and stop: you cannot run it after they have quit you. Back at the desk, `claude --resume <id>` (or `codex resume <id>`, `opencode --session <id>`) shows everything said in the browser.

### 3. Connect

`connect` waits for the browser, then reads the answer to the words from stdin. Run it in the background, with stdin from a file you append to, from the project directory:

```bash
dir=$(mktemp -d)
touch "$dir/answer"
(npx -y acpantenna connect claude --session-id "$CLAUDE_CODE_SESSION_ID" --fork \
  < <(timeout 11m tail -f "$dir/answer") >"$dir/out" 2>&1
 echo "exit $?" >>"$dir/out") &
echo "$dir"
```

That needs bash or zsh. Keep `$dir`; every later step needs it. Without a terminal, `connect` prints everything to `$dir/out` and draws no QR code.

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
