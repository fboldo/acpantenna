/// <reference types="bun" />

/**
 * A throwaway homeserver for the end-to-end test: MATRIX_E2E_HOMESERVER (with
 * MATRIX_E2E_REGISTRATION_TOKEN) when set, else a Tuwunel container started
 * with docker. `undefined` when neither is available, and the test skips.
 */
export interface TestHomeserver {
	url: string;
	registrationToken: string;
	stop(): Promise<void>;
}

const IMAGE = "ghcr.io/matrix-construct/tuwunel:latest";

export async function startHomeserver(): Promise<TestHomeserver | undefined> {
	const given = process.env.MATRIX_E2E_HOMESERVER;

	if (given) {
		return {
			url: given,
			registrationToken: process.env.MATRIX_E2E_REGISTRATION_TOKEN ?? "",
			stop: async () => undefined,
		};
	}

	if (!Bun.which("docker")) {
		return undefined;
	}

	const registrationToken = crypto.randomUUID();
	const run = Bun.spawnSync([
		"docker",
		"run",
		"-d",
		"--rm",
		"--label",
		"acpantenna-e2e",
		"-p",
		"127.0.0.1::6167",
		"--tmpfs",
		"/var/lib/tuwunel",
		"-e",
		"TUWUNEL_SERVER_NAME=localhost",
		"-e",
		"TUWUNEL_DATABASE_PATH=/var/lib/tuwunel",
		"-e",
		"TUWUNEL_ADDRESS=0.0.0.0",
		"-e",
		"TUWUNEL_PORT=6167",
		"-e",
		"TUWUNEL_ALLOW_REGISTRATION=true",
		"-e",
		`TUWUNEL_REGISTRATION_TOKEN=${registrationToken}`,
		"-e",
		"TUWUNEL_ALLOW_FEDERATION=false",
		"-e",
		"TUWUNEL_LOG=warn",
		IMAGE,
	]);

	if (run.exitCode !== 0) {
		return undefined;
	}

	const container = run.stdout.toString().trim();
	const port = Bun.spawnSync(["docker", "port", container, "6167/tcp"])
		.stdout.toString()
		.trim()
		.split(":")
		.at(-1);
	const url = `http://127.0.0.1:${port}`;
	const stop = async () => {
		Bun.spawnSync(["docker", "rm", "-f", container]);
	};

	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`${url}/_matrix/client/versions`, {
				signal: AbortSignal.timeout(1000),
			});

			if (response.ok) {
				return { url, registrationToken, stop };
			}
		} catch {
			// Not listening yet.
		}

		await Bun.sleep(200);
	}

	await stop();
	return undefined;
}

export interface TestAccount {
	userId: string;
	accessToken: string;
	deviceId: string;
	password: string;
}

/** Register an account, answering the registration-token step. */
export async function register(
	homeserver: TestHomeserver,
	username: string,
): Promise<TestAccount> {
	const url = `${homeserver.url}/_matrix/client/v3/register`;
	const password = `pw-${crypto.randomUUID()}`;
	const post = async (auth?: Record<string, unknown>) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, password, ...(auth ? { auth } : {}) }),
		});
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	};

	let result = await post();

	for (const type of ["m.login.registration_token", "m.login.dummy"]) {
		if (result.status !== 401) {
			break;
		}

		result = await post({
			type,
			token: homeserver.registrationToken,
			session: result.body.session,
		});
	}

	if (typeof result.body.access_token !== "string") {
		throw new Error(
			`Could not register ${username}: ${JSON.stringify(result.body)}`,
		);
	}

	return {
		userId: result.body.user_id as string,
		accessToken: result.body.access_token,
		deviceId: result.body.device_id as string,
		password,
	};
}
