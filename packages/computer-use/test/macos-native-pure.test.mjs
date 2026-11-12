// The assertions live in headless_tests.swift and link the unchanged production files.
import { test } from "vitest";
import { main } from "../scripts/swift-coverage.mjs";

// One compiler, no live Bridge, AppKit windows, input, capture or clipboard calls.
// This replaces two sliced-source compiles with a single complete-source compile.
test.skipIf(process.platform !== "darwin")(
	"macOS real-source headless assertions and coverage",
	{ timeout: 90_000 },
	() => main(),
);
