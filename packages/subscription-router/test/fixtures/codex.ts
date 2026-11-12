/** Entirely synthetic identities/offers, shared by unit tests and a credential-free app-server subprocess. */
export const NOW = 1_900_000_000_000;
export const token = (account = "synthetic-workspace", user = "synthetic-user") =>
	`fixture.${Buffer.from(JSON.stringify({ sub: user, "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: user } })).toString("base64url")}.fixture`;
export const payload = () => ({
	rateLimits: { primary: { usedPercent: 50 }, secondary: { usedPercent: 10 } },
	rateLimitResetCredits: {
		availableCount: 1,
		credits: [
			{
				id: "fixture-grant",
				resetType: "codexRateLimits",
				status: "available",
				grantedAt: NOW / 1000 - 100,
				expiresAt: NOW / 1000 + 100,
			},
		],
	},
});
