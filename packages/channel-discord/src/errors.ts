/** A configuration the user has to change (a rejected token); never retried. */
export class DiscordSetupError extends Error {
	public override readonly name = "DiscordSetupError";
}
