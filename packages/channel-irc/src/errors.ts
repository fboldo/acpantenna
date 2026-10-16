/** A configuration (or account state) the user has to change; never retried. */
export class IrcSetupError extends Error {
	public override readonly name = "IrcSetupError";
}
