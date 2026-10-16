import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The next update to ask getUpdates for, kept in the state dir so a restart
 * neither repeats updates already handled nor (by confirming them) drops ones
 * that were not. Written to a temporary file and renamed into place, so a
 * crash mid-write leaves the previous offset rather than a broken file.
 */
export class OffsetStore {
	public readonly path: string;

	public constructor(stateDir: string) {
		this.path = join(stateDir, "offset.json");
	}

	public async read(): Promise<number | undefined> {
		try {
			const stored = (await Bun.file(this.path).json()) as { offset?: unknown };
			return typeof stored.offset === "number" &&
				Number.isSafeInteger(stored.offset)
				? stored.offset
				: undefined;
		} catch {
			return undefined;
		}
	}

	public async write(offset: number): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ offset })}\n`, {
			mode: 0o600,
		});
		await rename(temporary, this.path);
	}
}
