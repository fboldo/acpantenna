import type { CryptoApi } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth.js";

/**
 * The homeserver wants the account's owner to approve replacing the
 * cross-signing keys in a browser first. Servers that delegate login to an
 * auth service (MAS: matrix.org since 2025) cannot take a password for it.
 */
export class CrossSigningApprovalNeeded extends Error {
	public override readonly name = "CrossSigningApprovalNeeded";

	public constructor(public readonly url: string) {
		super(
			`The homeserver wants the bot's account to approve resetting its cross-signing keys at ${url} (signed in as the bot); the bot keeps retrying and finishes on its own once that is done.`,
		);
	}
}

export type UiaStep =
	| { kind: "password"; session?: string }
	| { kind: "approval"; url: string }
	| { kind: "unsupported"; flows: string[] };

interface UiaBody {
	session?: string;
	flows?: Array<{ stages?: string[] }>;
	params?: Record<string, { url?: string }>;
}

/**
 * What a 401 from an endpoint behind user-interactive auth asks for, given
 * whether the bot knows its password. `undefined` when the error is not a
 * UIA challenge at all.
 */
export function nextUiaStep(
	error: unknown,
	hasPassword: boolean,
): UiaStep | undefined {
	const candidate = error as { httpStatus?: number; data?: UiaBody };

	if (candidate?.httpStatus !== 401 || !Array.isArray(candidate.data?.flows)) {
		return undefined;
	}

	const body = candidate.data;
	const stages = (body.flows ?? []).map((flow) => flow.stages ?? []);
	const single = (stage: string) =>
		stages.some((flow) => flow.length === 1 && flow[0] === stage);

	if (hasPassword && single("m.login.password")) {
		return { kind: "password", session: body.session };
	}

	for (const stage of ["m.oauth", "org.matrix.cross_signing_reset"]) {
		const url = body.params?.[stage]?.url;

		if (single(stage) && url) {
			return { kind: "approval", url };
		}
	}

	return { kind: "unsupported", flows: stages.map((flow) => flow.join("+")) };
}

/**
 * Authentication for uploading cross-signing keys: none first (a first
 * upload needs none, MSC3967), then the password when the server takes it.
 */
export function crossSigningAuth(
	userId: string,
	password: string | undefined,
): UIAuthCallback<void> {
	return async (makeRequest) => {
		try {
			await makeRequest(null);
			return;
		} catch (error) {
			const step = nextUiaStep(error, password !== undefined);

			if (!step) {
				throw error;
			}

			if (step.kind === "approval") {
				throw new CrossSigningApprovalNeeded(step.url);
			}

			if (step.kind === "unsupported" || password === undefined) {
				throw new Error(
					password === undefined
						? "The homeserver wants the account password to replace the bot's cross-signing keys; set password in the channel config."
						: `The homeserver asked for authentication the bot cannot do (${step.kind === "unsupported" ? step.flows.join(", ") : "unknown"}).`,
				);
			}

			await makeRequest({
				type: "m.login.password",
				identifier: { type: "m.id.user", user: userId },
				password,
				...(step.session ? { session: step.session } : {}),
			});
		}
	};
}

export type CrossSigningOutcome = "ready" | "signed-device" | "reset";

/**
 * Leave the bot's device cross-signed, without asking anyone for a secret.
 *
 * - Keys already held (an earlier run): sign the device if it is not yet.
 * - Otherwise make new cross-signing keys and publish them, replacing any
 *   the account had: their private halves are out of reach (another app
 *   made them, or a lost state dir held them). That also covers what a
 *   failed attempt leaves behind (keys made here but never published).
 * - If the account's secret storage uses a key the bot does not have
 *   (Element sets one up), the SDK would ask for it to store the new keys.
 *   The bot makes its own secret-storage key first, kept in its state dir,
 *   and makes that the account's default; the old one only protected keys
 *   that are being replaced.
 */
export async function ensureCrossSigning(options: {
	crypto: CryptoApi;
	secretStorage: { getDefaultKeyId(): Promise<string | null> };
	userId: string;
	deviceId: string;
	/** The id of the secret-storage key the bot holds, if any. */
	ownSecretStorageKeyId: () => string | undefined;
	auth: UIAuthCallback<void>;
}): Promise<CrossSigningOutcome> {
	const { crypto } = options;

	// Fetch the account's published keys first: judged against a stale copy,
	// a healthy identity would look missing and be replaced on every start.
	await crypto.userHasCrossSigningKeys(options.userId, true);

	if (await crypto.isCrossSigningReady()) {
		const device = await crypto.getDeviceVerificationStatus(
			options.userId,
			options.deviceId,
		);

		if (device?.signedByOwner) {
			return "ready";
		}

		await crypto.crossSignDevice(options.deviceId);
		return "signed-device";
	}

	const defaultKeyId = await options.secretStorage.getDefaultKeyId();

	if (defaultKeyId && defaultKeyId !== options.ownSecretStorageKeyId()) {
		await crypto.bootstrapSecretStorage({
			setupNewSecretStorage: true,
			createSecretStorageKey: () => crypto.createRecoveryKeyFromPassphrase(),
		});
	}

	await crypto.bootstrapCrossSigning({
		setupNewCrossSigning: true,
		authUploadDeviceSigningKeys: options.auth,
	});
	return "reset";
}
