import { rmSync } from "node:fs";

/**
 * Removes a directory a server or agent worked in, for tests. On Windows a
 * process that has exited can hold its files for a moment longer, and Bun's
 * rmSync does not retry by itself, so this does.
 */
export async function removeDir(path: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 50) {
				throw error;
			}

			await Bun.sleep(100);
		}
	}
}
