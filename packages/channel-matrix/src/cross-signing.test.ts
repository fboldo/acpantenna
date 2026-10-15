import { describe, expect, test } from "bun:test";
import type { CryptoApi } from "matrix-js-sdk/lib/crypto-api/index.js";
import {
	CrossSigningApprovalNeeded,
	crossSigningAuth,
	ensureCrossSigning,
	nextUiaStep,
} from "./cross-signing.ts";

const challenge = (body: Record<string, unknown>) =>
	Object.assign(new Error("Unauthorized"), { httpStatus: 401, data: body });

const masChallenge = challenge({
	session: "dummy",
	flows: [
		{ stages: ["m.oauth"] },
		{ stages: ["org.matrix.cross_signing_reset"] },
	],
	params: {
		"m.oauth": {
			url: "https://account.matrix.org/account/?action=org.matrix.cross_signing_reset",
		},
		"org.matrix.cross_signing_reset": {
			url: "https://account.matrix.org/account/?action=org.matrix.cross_signing_reset",
		},
	},
});
const passwordChallenge = challenge({
	session: "s1",
	flows: [{ stages: ["m.login.password"] }],
});

describe("the UIA step", () => {
	test("a password when the server takes one and the bot has it", () => {
		expect(nextUiaStep(passwordChallenge, true)).toEqual({
			kind: "password",
			session: "s1",
		});
		expect(nextUiaStep(passwordChallenge, false)).toEqual({
			kind: "unsupported",
			flows: ["m.login.password"],
		});
	});

	test("an approval link on a server that delegates login (MAS)", () => {
		expect(nextUiaStep(masChallenge, true)).toEqual({
			kind: "approval",
			url: "https://account.matrix.org/account/?action=org.matrix.cross_signing_reset",
		});
	});

	test("anything else is not a UIA challenge", () => {
		expect(nextUiaStep(new Error("fetch failed"), true)).toBeUndefined();
		expect(
			nextUiaStep(Object.assign(new Error("x"), { httpStatus: 403 }), true),
		).toBeUndefined();
	});
});

describe("authenticating the key upload", () => {
	test("no auth first; a first upload needs none", async () => {
		const sent: unknown[] = [];
		await crossSigningAuth(
			"@bot:x",
			undefined,
		)(async (auth) => {
			sent.push(auth);
		});
		expect(sent).toEqual([null]);
	});

	test("then the password, in the server's session", async () => {
		const sent: unknown[] = [];
		await crossSigningAuth(
			"@bot:x",
			"hunter2",
		)(async (auth) => {
			sent.push(auth);
			if (auth === null) {
				throw passwordChallenge;
			}
		});
		expect(sent).toEqual([
			null,
			{
				type: "m.login.password",
				identifier: { type: "m.id.user", user: "@bot:x" },
				password: "hunter2",
				session: "s1",
			},
		]);
	});

	test("an approval the bot cannot give is reported with its link", async () => {
		const auth = crossSigningAuth(
			"@bot:x",
			"hunter2",
		)(async () => {
			throw masChallenge;
		});
		await expect(auth).rejects.toBeInstanceOf(CrossSigningApprovalNeeded);
		await expect(auth).rejects.toMatchObject({
			url: "https://account.matrix.org/account/?action=org.matrix.cross_signing_reset",
		});
	});

	test("a password the server wants but the bot lacks says so", async () => {
		await expect(
			crossSigningAuth(
				"@bot:x",
				undefined,
			)(async () => {
				throw passwordChallenge;
			}),
		).rejects.toThrow("set password in the channel config");
	});
});

/** A stand-in for the SDK's crypto, recording what was asked of it. */
function fakeCrypto(state: { ready: boolean; signed: boolean }) {
	const calls: string[] = [];
	const crypto = {
		userHasCrossSigningKeys: async () => {
			calls.push("download");
			return true;
		},
		isCrossSigningReady: async () => state.ready,
		getDeviceVerificationStatus: async () => ({ signedByOwner: state.signed }),
		crossSignDevice: async () => {
			calls.push("crossSignDevice");
		},
		createRecoveryKeyFromPassphrase: async () => ({
			privateKey: new Uint8Array(32),
		}),
		bootstrapSecretStorage: async (options: {
			setupNewSecretStorage?: boolean;
		}) => {
			calls.push(`bootstrapSecretStorage:${options.setupNewSecretStorage}`);
		},
		bootstrapCrossSigning: async (options: {
			setupNewCrossSigning?: boolean;
		}) => {
			calls.push(`bootstrapCrossSigning:${options.setupNewCrossSigning}`);
		},
	};

	return { calls, crypto: crypto as unknown as CryptoApi };
}

const run = (
	crypto: CryptoApi,
	defaultKeyId: string | null,
	ownKeyId?: string,
) =>
	ensureCrossSigning({
		crypto,
		secretStorage: { getDefaultKeyId: async () => defaultKeyId },
		userId: "@bot:x",
		deviceId: "DEV",
		ownSecretStorageKeyId: () => ownKeyId,
		auth: async () => undefined,
	});

describe("ensuring the device is cross-signed", () => {
	test("nothing to do when the keys are held and the device signed", async () => {
		const { calls, crypto } = fakeCrypto({ ready: true, signed: true });
		expect(await run(crypto, "theirs")).toBe("ready");
		expect(calls).toEqual(["download"]);
	});

	test("keys held but the device unsigned: just sign it", async () => {
		const { calls, crypto } = fakeCrypto({ ready: true, signed: false });
		expect(await run(crypto, null)).toBe("signed-device");
		expect(calls).toEqual(["download", "crossSignDevice"]);
	});

	test("a fresh account: new keys, no secret storage involved", async () => {
		const { calls, crypto } = fakeCrypto({ ready: false, signed: false });
		expect(await run(crypto, null)).toBe("reset");
		expect(calls).toEqual(["download", "bootstrapCrossSigning:true"]);
	});

	test("secret storage under someone else's key: the bot's own key first", async () => {
		const { calls, crypto } = fakeCrypto({ ready: false, signed: false });
		expect(await run(crypto, "element-key")).toBe("reset");
		expect(calls).toEqual([
			"download",
			"bootstrapSecretStorage:true",
			"bootstrapCrossSigning:true",
		]);
	});

	test("after a failed attempt, under the bot's own key: straight to the reset", async () => {
		const { calls, crypto } = fakeCrypto({ ready: false, signed: false });
		expect(await run(crypto, "bot-key", "bot-key")).toBe("reset");
		expect(calls).toEqual(["download", "bootstrapCrossSigning:true"]);
	});
});
