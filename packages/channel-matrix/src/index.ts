import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	createChannelAdapter,
	defineChannel,
} from "@acpantenna/channel";
import {
	configProblems,
	MATRIX_CONFIG_SCHEMA,
	type MatrixChannelConfig,
} from "./config.ts";
import type { MatrixRuntime } from "./runtime.ts";

export type { MatrixChannelConfig } from "./config.ts";

/**
 * Buttons: prompts come with their options, rendered as a numbered list with
 * reactions to tap. Tool calls: shown as a compact log. No thoughts. Files:
 * uploaded, encrypted in an encrypted room, within the homeserver's limit.
 */
export const MATRIX_CAPABILITIES: ChannelCapabilities = {
	inbound: true,
	outbound: true,
	approvals: true,
	attachments: true,
	buttons: true,
	toolCalls: true,
	thoughts: false,
};

export function createMatrixChannel(
	rawConfig: unknown,
): ChannelAdapter<unknown> {
	const config = rawConfig as MatrixChannelConfig;
	let runtime: MatrixRuntime | undefined;

	return createChannelAdapter({
		manifest: {
			type: "matrix",
			name: "Matrix",
			version: "0.0.0",
			capabilities: MATRIX_CAPABILITIES,
		},

		async start(context: ChannelContext<unknown>) {
			const problems = configProblems(config);

			if (problems.length > 0) {
				throw new Error(`Matrix channel: ${problems.join(" ")}`);
			}

			// The SDK and its crypto are loaded only when a Matrix channel runs.
			// The log routing goes first: the SDK's modules copy it as they load.
			await import("./sdk-logs.ts");
			const { MatrixRuntime } = await import("./runtime.ts");
			runtime = new MatrixRuntime(config, context);
			await runtime.start();
		},

		async stop() {
			await runtime?.stop();
		},

		send(message) {
			if (!runtime) {
				return {
					ok: false,
					retryAfterMs: 5_000,
					error: "The Matrix channel is not started.",
				};
			}

			return runtime.send(message);
		},

		health() {
			return (
				runtime?.health() ?? {
					state: "starting",
					checkedAt: new Date().toISOString(),
				}
			);
		},
	});
}

export const matrixChannel = defineChannel({
	type: "matrix",
	name: "Matrix",
	description:
		"Chat with the agent in Matrix rooms, end-to-end encrypted. Works with matrix.org or your own homeserver: invite the bot to a room and talk to it there.",
	capabilities: MATRIX_CAPABILITIES,
	configSchema: MATRIX_CONFIG_SCHEMA,
	create: createMatrixChannel,
});
