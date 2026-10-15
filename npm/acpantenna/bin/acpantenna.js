#!/usr/bin/env node
// acpantenna runs on Bun. This launcher, which npx and npm run with Node,
// finds the Bun the package depends on and runs the CLI with it, so nobody
// has to install Bun first.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "acpantenna.js");
const require = createRequire(import.meta.url);

/** The Bun to run with, or undefined when there is none. */
function findBun() {
	if (process.env.ACPANTENNA_BUN) {
		return process.env.ACPANTENNA_BUN;
	}

	// Already on Bun (bunx acpantenna): use it.
	if (process.versions.bun) {
		return process.execPath;
	}

	const exe = process.platform === "win32" ? "bun.exe" : "bun";
	const platform = `${process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch}`;
	const candidates = [
		// Where the `bun` package's postinstall moves the binary.
		["bun", "bun.exe"],
		// Where it stays when that postinstall did not run (pnpm, --ignore-scripts).
		...(isMusl() ? [[`@oven/bun-${platform}-musl`, exe]] : []),
		[`@oven/bun-${platform}`, exe],
		[`@oven/bun-${platform}-baseline`, exe],
	];

	for (const [name, file] of candidates) {
		try {
			const binary = join(
				dirname(require.resolve(`${name}/package.json`)),
				"bin",
				file,
			);

			// Without its postinstall, `bun` holds a small script that only
			// says so: the binary is tens of megabytes.
			if (statSync(binary).size > 1_000_000) {
				return binary;
			}
		} catch {
			// Not installed for this platform.
		}
	}

	return undefined;
}

function isMusl() {
	if (process.platform !== "linux") {
		return false;
	}

	try {
		return !process.report?.getReport()?.header?.glibcVersionRuntime;
	} catch {
		return false;
	}
}

const bun = findBun() ?? "bun";
const child = spawn(bun, [cli, ...process.argv.slice(2)], {
	stdio: "inherit",
});

child.on("error", (error) => {
	if (error.code === "ENOENT" && process.env.ACPANTENNA_BUN) {
		console.error(
			`ACPANTENNA_BUN is ${process.env.ACPANTENNA_BUN}, which is not a bun binary.`,
		);
	} else if (error.code === "ENOENT") {
		console.error(
			"acpantenna needs Bun, and none came with this install. Install it from https://bun.sh, or set ACPANTENNA_BUN to a bun binary.",
		);
	} else {
		console.error(error.message);
	}

	process.exit(1);
});

// Ctrl-C reaches Bun from the terminal itself: wait for it to finish rather
// than leave it behind. Other signals are passed on.
process.on("SIGINT", () => undefined);

for (const signal of ["SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});
