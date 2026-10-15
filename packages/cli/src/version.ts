/** Set by the npm build (`define`); not defined when run from source. */
declare const ACPANTENNA_VERSION: string | undefined;

/**
 * This build's version, "dev" from source. A background server reports its
 * own, so a CLI of another version can replace it.
 */
export const VERSION: string =
	typeof ACPANTENNA_VERSION === "string" ? ACPANTENNA_VERSION : "dev";
