/**
 * The client API's base URL for a homeserver: its `.well-known/matrix/client`
 * says when it differs (matrix.org's is matrix-client.matrix.org), else the
 * URL as given.
 */
export async function discoverBaseUrl(
	homeserverUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const given = homeserverUrl.replace(/\/+$/, "");

	try {
		const response = await fetchImpl(`${given}/.well-known/matrix/client`, {
			signal: AbortSignal.timeout(5_000),
		});
		const body = (await response.json()) as {
			"m.homeserver"?: { base_url?: unknown };
		};
		const baseUrl = body["m.homeserver"]?.base_url;

		if (
			response.ok &&
			typeof baseUrl === "string" &&
			/^https?:\/\//.test(baseUrl)
		) {
			return baseUrl.replace(/\/+$/, "");
		}
	} catch {
		// No well-known (or not JSON): the URL is the API.
	}

	return given;
}
