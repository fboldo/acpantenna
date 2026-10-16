import { expect, test } from "bun:test";
import { AccountTracker } from "./accounts.ts";

test("accounts follow joins, account changes, nick changes and parts", () => {
	const tracker = new AccountTracker();

	tracker.joined("Alice", "#a", "alice");
	tracker.joined("alice", "#b");
	expect(tracker.get("ALICE")).toBe("alice");

	tracker.set("alice", "*");
	expect(tracker.get("alice")).toBeNull();
	tracker.set("alice", "alice");

	tracker.renamed("alice", "alice_away");
	expect(tracker.get("alice")).toBeUndefined();
	expect(tracker.get("alice_away")).toBe("alice");

	tracker.parted("alice_away", "#a");
	expect(tracker.get("alice_away")).toBe("alice");
	// No channel shared any more: no more account-notify, so forgotten.
	tracker.parted("alice_away", "#b");
	expect(tracker.get("alice_away")).toBeUndefined();
});

test("leaving a channel forgets who was known only from there", () => {
	const tracker = new AccountTracker();

	tracker.joined("bob", "#a", "bob");
	tracker.joined("carol", "#a", "carol");
	tracker.joined("carol", "#b");
	tracker.leftChannel("#A");

	expect(tracker.get("bob")).toBeUndefined();
	expect(tracker.get("carol")).toBe("carol");
});
