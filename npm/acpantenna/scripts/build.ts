#!/usr/bin/env bun
// Builds what npm ships: the CLI bundled into one file for Bun, with no
// node_modules beside it; the repo's README and LICENSE; and the licences
// and notices of every package bundled into it.

import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageDir, "..", "..");
const dist = join(packageDir, "dist");

const packageVersion = (
	(await Bun.file(join(packageDir, "package.json")).json()) as {
		version: string;
	}
).version;

rmSync(dist, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [join(repoRoot, "packages", "cli", "src", "main.ts")],
	target: "bun",
	outdir: dist,
	naming: "acpantenna.js",
	minify: { syntax: true, whitespace: true },
	// The CLI and its background server compare versions with this.
	define: { ACPANTENNA_VERSION: JSON.stringify(packageVersion) },
	metafile: true,
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}

	process.exit(1);
}

copyFileSync(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));
await Bun.write(
	join(packageDir, "README.md"),
	absoluteLinks(await Bun.file(join(repoRoot, "README.md")).text()),
);

await Bun.write(
	join(packageDir, "THIRD_PARTY_LICENSES.md"),
	await thirdPartyLicenses(Object.keys(result.metafile?.inputs ?? {})),
);

// Proves the bundle runs on its own: it answers with every channel type.
const listed = Bun.spawnSync(
	[process.execPath, join(dist, "acpantenna.js"), "channels", "--json"],
	{ cwd: dist },
);
const channels = JSON.parse(listed.stdout.toString() || "{}") as {
	version?: number;
	channels?: Array<{ type: string }>;
};

if (listed.exitCode !== 0 || channels.version !== 1) {
	console.error(
		`The bundle does not run: ${listed.stderr.toString().trim() || "no channels"}`,
	);
	process.exit(1);
}

const size = Bun.file(join(dist, "acpantenna.js")).size;

console.log(
	`dist/acpantenna.js: ${(size / 1024 / 1024).toFixed(1)} MB, channels: ${channels.channels?.map((channel) => channel.type).join(", ")}`,
);

/**
 * The README's links point into the repository, which npmjs.com does not
 * have: there they go to GitHub, and images to their raw files.
 */
function absoluteLinks(readme: string): string {
	const repo = "https://github.com/fboldo/acpantenna";
	const raw = "https://raw.githubusercontent.com/fboldo/acpantenna/main/";
	const relative = (target: string) => !/^([a-z]+:|#|\/)/i.test(target);

	return readme
		.replace(/(<img [^>]*src=")([^"]+)"/g, (whole, start, target) =>
			relative(target) ? `${start}${raw}${target}"` : whole,
		)
		.replace(/\]\(([^)\s]+)\)/g, (whole, target) =>
			relative(target)
				? `](${repo}/${target.endsWith("/") ? "tree" : "blob"}/main/${target})`
				: whole,
		);
}

/**
 * Every package the bundle took code from, with its licence text and any
 * NOTICE, as their licences ask of a redistribution.
 */
async function thirdPartyLicenses(inputs: string[]): Promise<string> {
	const packageDirs = new Set<string>();

	for (const input of inputs) {
		// The metafile's paths are relative to where the build runs.
		const path = resolve(input);

		if (!path.includes("node_modules")) {
			continue;
		}

		let dir = dirname(path);

		// A package's own package.json has its name; some subfolders have one too.
		while (!(await isPackageRoot(dir)) && dirname(dir) !== dir) {
			dir = dirname(dir);
		}

		packageDirs.add(dir);
	}

	const packages = await Promise.all(
		[...packageDirs].map(async (dir) => {
			const manifest = (await Bun.file(join(dir, "package.json")).json()) as {
				name?: string;
				version?: string;
				license?: string;
			};
			const notices = readdirSync(dir).filter((file) =>
				/^(licen[cs]e|notice|copying)/i.test(file),
			);

			return {
				name: manifest.name ?? dir,
				version: manifest.version ?? "",
				license: manifest.license ?? "see below",
				texts: await Promise.all(
					notices.map(async (file) => ({
						file,
						text: (await Bun.file(join(dir, file)).text()).trim(),
					})),
				),
			};
		}),
	);
	const byName = new Map(packages.map((entry) => [entry.name, entry]));
	const sorted = [...byName.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const missing = sorted.filter((entry) => entry.texts.length === 0);

	if (missing.length > 0) {
		console.warn(
			`No licence file in: ${missing.map((entry) => entry.name).join(", ")}`,
		);
	}

	return [
		"# Third-party licences",
		"",
		"`dist/acpantenna.js` bundles code from these packages, under their own licences.",
		"",
		...sorted.map((entry) =>
			[
				`## ${entry.name} ${entry.version}`,
				"",
				`License: ${entry.license}`,
				"",
				...entry.texts.map(({ file, text }) =>
					[
						`<details><summary>${file}</summary>`,
						"",
						"```",
						text,
						"```",
						"",
						"</details>",
						"",
					].join("\n"),
				),
			].join("\n"),
		),
	].join("\n");
}

async function isPackageRoot(dir: string): Promise<boolean> {
	const manifest = join(dir, "package.json");

	return (
		existsSync(manifest) &&
		typeof ((await Bun.file(manifest).json()) as { name?: unknown }).name ===
			"string"
	);
}
