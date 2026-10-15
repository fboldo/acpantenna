import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateFile, passwordLogin } from "./credentials.ts";
import { MatrixSetupError } from "./errors.ts";

const directory = mkdtempSync(join(tmpdir(), "matrix-credentials-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const answering = (status: number, body: unknown) => {
	const requests: Array<{ url: string; body: unknown }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { requests, fetchImpl };
};

test("a password login is a new device with the configured name", async () => {
	const { requests, fetchImpl } = answering(200, {
		user_id: "@bot:x",
		access_token: "syt_token",
		device_id: "NEWDEVICE",
	});

	expect(
		await passwordLogin({
			baseUrl: "https://hs.example",
			userId: "@bot:x",
			password: "hunter2",
			deviceName: "acpantenna",
			fetchImpl,
		}),
	).toEqual({
		homeserver: "https://hs.example",
		userId: "@bot:x",
		accessToken: "syt_token",
		deviceId: "NEWDEVICE",
	});
	expect(requests).toEqual([
		{
			url: "https://hs.example/_matrix/client/v3/login",
			body: {
				type: "m.login.password",
				identifier: { type: "m.id.user", user: "@bot:x" },
				password: "hunter2",
				initial_device_display_name: "acpantenna",
			},
		},
	]);
});

test("a wrong password is a setup error, said plainly", async () => {
	const { fetchImpl } = answering(403, {
		errcode: "M_FORBIDDEN",
		error: "Invalid password",
	});
	const login = passwordLogin({
		baseUrl: "https://hs.example",
		userId: "@bot:x",
		password: "nope",
		deviceName: "acpantenna",
		fetchImpl,
	});

	await expect(login).rejects.toBeInstanceOf(MatrixSetupError);
	await expect(login).rejects.toThrow(
		"The homeserver rejected the password for @bot:x",
	);
});

test("an outage is not a setup error (it is retried)", async () => {
	const { fetchImpl } = answering(502, {});
	const login = passwordLogin({
		baseUrl: "https://hs.example",
		userId: "@bot:x",
		password: "x",
		deviceName: "acpantenna",
		fetchImpl,
	});

	await expect(login).rejects.toMatchObject({ httpStatus: 502 });
	await expect(login).rejects.not.toBeInstanceOf(MatrixSetupError);
});

test("the session is kept where only the bot's user can read it", async () => {
	const file = new PrivateFile<{ token: string }>(
		join(directory, "nested", "session.json"),
	);

	expect(await file.read()).toBeUndefined();
	await file.write({ token: "secret" });
	expect(await file.read()).toEqual({ token: "secret" });
	// Windows has no owner-only modes; its user profile's access rules apply.
	if (process.platform !== "win32") {
		expect(statSync(file.path).mode & 0o777).toBe(0o600);
		expect(statSync(join(directory, "nested")).mode & 0o777).toBe(0o700);
	}
	file.remove();
	expect(await file.read()).toBeUndefined();
});
