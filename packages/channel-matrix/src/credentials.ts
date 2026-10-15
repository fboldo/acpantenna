import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MatrixSetupError } from "./errors.ts";

/** A JSON file only the bot's user can read: a session, a key. */
export class PrivateFile<T> {
	public constructor(public readonly path: string) {}

	public async read(): Promise<T | undefined> {
		if (!existsSync(this.path)) {
			return undefined;
		}

		try {
			return JSON.parse(await readFile(this.path, "utf8")) as T;
		} catch {
			return undefined;
		}
	}

	public async write(value: T): Promise<void> {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
		chmodSync(temporary, 0o600);
		await rename(temporary, this.path);
	}

	public remove(): void {
		rmSync(this.path, { force: true });
	}
}

/** What a password login gave the bot, kept so it logs in only once. */
export interface StoredSession {
	homeserver: string;
	userId: string;
	accessToken: string;
	deviceId: string;
}

/**
 * Log in with the bot's password, as a new device. Every login is a new
 * device with no keys yet, which is what the encryption needs.
 */
export async function passwordLogin(options: {
	baseUrl: string;
	userId: string;
	password: string;
	deviceName: string;
	fetchImpl?: typeof fetch;
}): Promise<StoredSession> {
	const response = await (options.fetchImpl ?? fetch)(
		`${options.baseUrl}/_matrix/client/v3/login`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "m.login.password",
				identifier: { type: "m.id.user", user: options.userId },
				password: options.password,
				initial_device_display_name: options.deviceName,
			}),
			signal: AbortSignal.timeout(15_000),
		},
	);
	const body = (await response.json().catch(() => ({}))) as {
		user_id?: string;
		access_token?: string;
		device_id?: string;
		errcode?: string;
		error?: string;
	};

	if (response.ok && body.access_token && body.device_id && body.user_id) {
		return {
			homeserver: options.baseUrl,
			userId: body.user_id,
			accessToken: body.access_token,
			deviceId: body.device_id,
		};
	}

	if (body.errcode === "M_FORBIDDEN" || response.status === 403) {
		throw new MatrixSetupError(
			`The homeserver rejected the password for ${options.userId}. Check userId and password.`,
		);
	}

	if (body.errcode === "M_UNKNOWN" && response.status === 400) {
		throw new MatrixSetupError(
			`The homeserver does not accept password login: ${body.error ?? "unknown error"}. Use an access token instead.`,
		);
	}

	throw Object.assign(
		new Error(body.error ?? `Login failed with HTTP ${response.status}`),
		{ errcode: body.errcode, httpStatus: response.status, data: body },
	);
}
