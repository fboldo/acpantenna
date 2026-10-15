#!/bin/sh
# Publishes the package in the current directory, unless npm already has its
# version: a release publishes what changed, and re-running it is harmless.
set -eu
name="$(node -p 'require("./package.json").name')"
version="$(node -p 'require("./package.json").version')"
if npm view "$name@$version" version >/dev/null 2>&1; then
	echo "$name@$version is already on npm."
	exit 0
fi
npm publish --provenance --access public
