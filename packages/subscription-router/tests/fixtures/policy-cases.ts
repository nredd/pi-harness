/** Common JSON-representable schema/parser acceptance cases. */
export const POLICY_CASES = [
	{ policy: { version: 1, kind: "strict-priority" }, valid: true },
	{ policy: { version: 1, kind: "remaining-balanced", switchMargin: 0.2, stickiness: "none" }, valid: true },
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "remaining", window: { name: "weekly" }, direction: "desc" },
				{ metric: "chain-index", direction: "asc" },
			],
		},
		valid: true,
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "remaining", window: "binding", direction: "desc" }] },
		valid: true,
	},
	{ policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc" }] }, valid: true },
	{ policy: null, valid: false, error: "expected an object" },
	{ policy: { version: 2, kind: "strict-priority" }, valid: false, error: "expected 1" },
	{ policy: { version: 1, kind: "strict-priority", switchMargin: 0 }, valid: false, error: "unsupported" },
	{ policy: { version: 1, kind: "remaining-balanced", by: [] }, valid: false, error: "unsupported" },
	{ policy: { version: 1, kind: "remaining-balanced", switchMargin: 2 }, valid: false, error: "finite" },
	{ policy: { version: 1, kind: "remaining-balanced", stickiness: "session" }, valid: false, error: "expected none" },
	{ policy: { version: 1, kind: "lexicographic", by: [] }, valid: false, error: "non-empty" },
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc" }], switchMargin: 0 },
		valid: false,
		error: "leading remaining",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [{ metric: "remaining", window: { name: "" }, direction: "desc" }],
		},
		valid: false,
		error: "non-empty",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "remaining", window: "binding", direction: "desc" },
				{ metric: "remaining", window: "binding", direction: "desc" },
			],
		},
		valid: false,
		error: "unique",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "chain-index", direction: "asc" },
				{ metric: "remaining", window: "binding", direction: "desc" },
			],
		},
		valid: false,
		error: "last",
	},
];
