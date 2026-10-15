import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	createChannelAdapter,
	defineChannel,
} from "@acpantenna/channel";
import {
	DEFAULT_LINK_TTL_SECONDS,
	type KeyPair,
} from "@acpantenna/relay-protocol";
import {
	configProblems,
	DEFAULT_COALESCE_MS,
	RELAY_CONFIG_SCHEMA,
	type RelayChannelConfig,
} from "./config.ts";
import { RelayPairing } from "./pairing.ts";
import {
	fileKeyStore,
	forgetStaticKey,
	keychainKeyStore,
	loadStaticKey,
} from "./static-key.ts";

export type { RelayChannelConfig } from "./config.ts";
export { RelayPairing } from "./pairing.ts";
export { AcpProxy, ALLOWED_METHODS, filteredInitialize } from "./proxy.ts";

/** It carries ACP itself; no chat messages. */
export const RELAY_CAPABILITIES: ChannelCapabilities = {
	acp: true,
};

/** Default time the browser has to answer the agent's question. */
const DEFAULT_INTERACTION_TIMEOUT_SECONDS = 120;

export function createRelayChannel(
	rawConfig: unknown,
): ChannelAdapter<unknown> {
	const config = rawConfig as RelayChannelConfig;
	let context: ChannelContext<unknown> | undefined;
	let staticKey: Promise<KeyPair> | undefined;
	const pairings = new Set<RelayPairing>();

	const stores = () => {
		const stateDir = context?.stateDir;

		if (!stateDir || !context) {
			throw new Error("The relay channel has no state directory.");
		}

		return config.keyStorage === "file"
			? [fileKeyStore(stateDir)]
			: [keychainKeyStore(context.channelId), fileKeyStore(stateDir)];
	};

	/** Read, or made, on first use: a config that never connects never touches the keychain. */
	const loadKey = () => {
		staticKey ??= loadStaticKey(stores()).catch((error) => {
			staticKey = undefined;
			throw error;
		});

		return staticKey;
	};

	return createChannelAdapter({
		manifest: {
			type: "relay",
			name: "Web (relay)",
			version: "0.0.0",
			capabilities: RELAY_CAPABILITIES,
		},

		start(nextContext) {
			const problems = configProblems(config);

			if (problems.length > 0) {
				throw new Error(`Relay channel: ${problems.join(" ")}`);
			}

			context = nextContext;
		},

		stop() {
			for (const pairing of pairings) {
				pairing.close("The server stopped.");
			}
		},

		async revoke() {
			for (const pairing of pairings) {
				pairing.close("Every link of this channel was revoked.");
			}

			staticKey = undefined;
			await forgetStaticKey(stores());
		},

		send() {
			return {
				ok: false,
				error: "A relay channel carries ACP; it sends no chat messages.",
			};
		},

		health() {
			return {
				state: context ? "ready" : "starting",
				checkedAt: new Date().toISOString(),
			};
		},

		async attachAcp(connection) {
			const pairing = new RelayPairing({
				connection,
				relayUrl: config.relayUrl,
				webOrigin: new URL(config.webOrigin).origin,
				staticKeyPair: await loadKey(),
				linkTtlSeconds: config.linkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
				coalesceMs: config.coalesceMs ?? DEFAULT_COALESCE_MS,
				interactionTimeoutMs:
					(config.permissions?.interactionTimeoutSeconds ??
						DEFAULT_INTERACTION_TIMEOUT_SECONDS) * 1000,
				...(config.relayToken ? { relayToken: config.relayToken } : {}),
				...(context ? { logger: context.logger } : {}),
				onEnd: (ended) => pairings.delete(ended),
			});

			pairings.add(pairing);

			try {
				await pairing.start();
			} catch (error) {
				pairing.close("Could not start.");
				throw error;
			}

			return pairing;
		},
	});
}

export const relayChannel = defineChannel({
	type: "relay",
	name: "Web (relay)",
	description:
		"Use the agent from a web client on any device, end-to-end encrypted through a relay. `connect` prints a one-time link and a QR code; open it, check that the four words match, and the browser is the session's client.",
	capabilities: RELAY_CAPABILITIES,
	configSchema: RELAY_CONFIG_SCHEMA,
	create: createRelayChannel,
});
