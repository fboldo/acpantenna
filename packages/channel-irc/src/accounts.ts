import { type CaseMapping, casefold } from "./protocol.ts";

/**
 * Which services account each nick the bot shares a channel with is logged
 * in to, for servers without `account-tag`. Filled by `extended-join` and
 * WHOX, kept current by `account-notify`, and forgotten when the bot no
 * longer shares a channel with the nick (it would hear no more changes).
 *
 * Only as good as those capabilities: without `account-notify` the server
 * does not report logouts, so the tracker is not used at all.
 */
export class AccountTracker {
	private readonly accounts = new Map<string, string | null>();
	private readonly channels = new Map<string, Set<string>>();

	public constructor(private mapping: CaseMapping = "rfc1459") {}

	public setCaseMapping(mapping: CaseMapping): void {
		this.mapping = mapping;
		this.clear();
	}

	/** The account, null when known to be logged out, undefined when not known. */
	public get(nick: string): string | null | undefined {
		return this.accounts.get(this.fold(nick));
	}

	/** `*` or `0` (as servers write "no account") is logged out. */
	public set(nick: string, account: string): void {
		this.accounts.set(
			this.fold(nick),
			account === "*" || account === "0" || account === "" ? null : account,
		);
	}

	public joined(nick: string, channel: string, account?: string): void {
		const key = this.fold(nick);
		const shared = this.channels.get(key) ?? new Set<string>();

		shared.add(this.fold(channel));
		this.channels.set(key, shared);

		if (account !== undefined) {
			this.set(nick, account);
		}
	}

	public parted(nick: string, channel: string): void {
		const key = this.fold(nick);
		const shared = this.channels.get(key);

		shared?.delete(this.fold(channel));

		if (!shared || shared.size === 0) {
			this.forget(nick);
		}
	}

	/** The bot left a channel: what it knew from there goes too. */
	public leftChannel(channel: string): void {
		const folded = this.fold(channel);

		for (const [key, shared] of this.channels) {
			shared.delete(folded);

			if (shared.size === 0) {
				this.channels.delete(key);
				this.accounts.delete(key);
			}
		}
	}

	public renamed(from: string, to: string): void {
		const fromKey = this.fold(from);
		const toKey = this.fold(to);
		const account = this.accounts.get(fromKey);
		const shared = this.channels.get(fromKey);

		this.accounts.delete(fromKey);
		this.channels.delete(fromKey);

		if (account !== undefined) {
			this.accounts.set(toKey, account);
		}

		if (shared) {
			this.channels.set(toKey, shared);
		}
	}

	public forget(nick: string): void {
		const key = this.fold(nick);
		this.accounts.delete(key);
		this.channels.delete(key);
	}

	public clear(): void {
		this.accounts.clear();
		this.channels.clear();
	}

	private fold(name: string): string {
		return casefold(name, this.mapping);
	}
}
