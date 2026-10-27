#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ensureIdentityOnce,
	parseCodeSigningIdentities,
	withDirectoryLock,
} from "./setup-helper.mjs";

const SIGNING_LOCK_WAIT_MS = 2000;
const SIGNING_LOCK_RETRY_MS = 5;

const sample = `
Policy: Code Signing
  Matching identities
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "pi-computer-use Local Signing (com.injaneity.pi-computer-use)" (CSSMERR_TP_NOT_TRUSTED)
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "pi-computer-use Local Signing" (CSSMERR_TP_NOT_TRUSTED)
  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "pi-computer-use Local Signing (com.injaneity.pi-computer-use)" (CSSMERR_TP_NOT_TRUSTED)
     3 identities found
`;

assert.deepEqual(parseCodeSigningIdentities(sample), [
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
]);

const setupCopy = await fs.readFile(
	new URL("./setup-helper.mjs", import.meta.url),
	"utf8",
);
assert.doesNotMatch(setupCopy, /tccutil[\s\S]{0,80}reset|resetTcc/i);

const tempDir = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-computer-use-signing-test-"),
);
const lockPath = path.join(tempDir, "identity.lock");
let identity;
let createCount = 0;

try {
	const results = await Promise.all(
		Array.from(
			{ length: 12 },
			/** @returns {Promise<string>} Requests one shared signing identity. @throws {Error} On lock or identity creation failure. */
			() =>
				ensureIdentityOnce(
					async () => identity,
					/** @returns {Promise<string>} Creates the fixture identity once. @throws {never} No intentional failures. */
					async () => {
						createCount++;
						// All callers already performed their initial identity lookup; the real directory
						// lock must serialize creation. No synthetic creation latency is needed.
						identity = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
						return identity;
					},
					/** @returns {Promise<unknown>} Serializes identity creation with the real lock. @throws {Error} On lock or callback failure. */
					(callback) =>
						withDirectoryLock(lockPath, callback, {
							waitMs: SIGNING_LOCK_WAIT_MS,
							retryMs: SIGNING_LOCK_RETRY_MS,
						}),
				),
		),
	);

	assert.equal(
		createCount,
		1,
		"concurrent callers must create only one identity",
	);
	assert.deepEqual(new Set(results), new Set([identity]));
} finally {
	await fs.rm(tempDir, { force: true, recursive: true });
}

console.log(
	"[check-local-signing] stable identity, non-destructive install, and concurrent creation passed",
);
