import { expect, test } from "bun:test";
import { createConsoleLogger } from "@acpantenna/channel";
import { configProblems } from "./config.ts";
import { createMatrixChannel, matrixChannel } from "./index.ts";

test("the definition is named for people, with its secrets marked", () => {
	expect(matrixChannel.type).toBe("matrix");
	expect(matrixChannel.name).toBe("Matrix");
	expect(matrixChannel.configSchema.properties.accessToken?.secret).toBe(true);
	expect(matrixChannel.configSchema.properties.password?.secret).toBe(true);
	// Either one will do, so neither can be required.
	expect(matrixChannel.configSchema.required).toEqual([
		"homeserverUrl",
		"userId",
	]);
});

test("missing or malformed fields are reported before anything connects", () => {
	expect(
		configProblems({
			homeserverUrl: "https://matrix.org",
			userId: "@bot:matrix.org",
			accessToken: "syt_x",
		}),
	).toEqual([]);
	expect(configProblems({ userId: "bot", accessToken: "" })).toEqual([
		"userId must be the bot's Matrix ID, like @mybot:matrix.org.",
		"Set the bot's password (or an access token).",
	]);
	expect(
		configProblems({ userId: "@bot:matrix.org", password: "hunter2" }),
	).toEqual([]);
	expect(
		configProblems({
			userId: "@bot:matrix.org",
			password: "hunter2",
			accessToken: "syt_x",
		}),
	).toEqual(["Set either the bot's password or an access token, not both."]);
	expect(
		configProblems({
			homeserverUrl: "matrix.org",
			userId: "@bot:matrix.org",
			accessToken: "x",
		}),
	).toEqual(["homeserverUrl is not a URL: matrix.org"]);
});

test("a channel that cannot start says why", async () => {
	const adapter = createMatrixChannel({ type: "matrix", userId: "@bot:x" });

	await expect(
		adapter.start({
			channelId: "matrix",
			config: {},
			logger: createConsoleLogger("test"),
			emit: () => undefined,
		}),
	).rejects.toThrow(
		"Matrix channel: Set the bot's password (or an access token).",
	);
	expect(await adapter.health?.()).toMatchObject({ state: "starting" });
	expect(
		await adapter.send({ conversationId: "!room:x", text: "hi" }),
	).toMatchObject({ ok: false, retryAfterMs: 5000 });
});
