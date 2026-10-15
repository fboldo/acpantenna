#!/usr/bin/env node
/**
 * Moves acpantenna and @acpantenna/relay-protocol to their next version, and
 * prints it. They are released together, at one version.
 *
 *     node npm/acpantenna/scripts/bump-version.mjs patch|minor|major|<x.y.z>
 *
 * Only each file's "version" line changes, so the formatting stays as it is.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const files = [
	join(root, "npm/acpantenna/package.json"),
	join(root, "packages/relay-protocol/package.json"),
];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, bump) {
	const parts = SEMVER.exec(current);
	if (!parts) throw new Error(`Not a plain x.y.z version: ${current}`);
	const [major, minor, patch] = parts.slice(1).map(Number);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
	const wanted = SEMVER.exec(bump ?? "");
	if (!wanted)
		throw new Error(`Say patch, minor, major or x.y.z, not "${bump}"`);
	const from = [major, minor, patch];
	const to = wanted.slice(1).map(Number);
	const first = to.findIndex((n, i) => n !== from[i]);
	if (first < 0 || to[first] < from[first])
		throw new Error(`${bump} is not after ${current}`);
	return bump;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const versions = files.map(
		(file) => JSON.parse(readFileSync(file, "utf8")).version,
	);
	if (new Set(versions).size !== 1) {
		throw new Error(
			`The packages are at different versions (${versions.join(", ")}); line them up first.`,
		);
	}
	const next = nextVersion(versions[0], process.argv[2]);
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const updated = text.replace(/("version":\s*")[^"]*(")/, `$1${next}$2`);
		if (updated === text) throw new Error(`No version in ${file}`);
		writeFileSync(file, updated);
	}
	console.log(next);
}
