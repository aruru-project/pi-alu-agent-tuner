import assert from "node:assert/strict";

// Synthetic credential only. No user credential storage or real network is used.
export const usageAuth = {
	apiKey: `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`,
	baseUrl: "https://chatgpt.com/backend-api",
};

export async function runUsageChecks({ runtime, model }) {
	const originalFetch = globalThis.fetch;
	const originalUrl = model.baseUrl;
	const ask = async () => {
		runtime.notifications.length = 0;
		await runtime.host.session.prompt("/codex-usage");
		return runtime.notifications.at(-1);
	};
	try {
		globalThis.fetch = async (url, options) => {
			assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
			assert.equal(options.method, "GET");
			assert.equal(options.redirect, "error");
			assert.equal(options.headers.Authorization, `Bearer ${usageAuth.apiKey}`);
			assert.equal(options.headers["ChatGPT-Account-Id"], "test-account");
			return Response.json({
				plan_type: "pro",
				rate_limit: {
					primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1790000000 },
					secondary_window: { used_percent: 67.5, limit_window_seconds: 604800, reset_at: 1790500000 },
				},
				additional_rate_limits: [{ limit_name: "Future Model", rate_limit: {
					primary_window: { used_percent: 0, limit_window_seconds: 7200 },
				} }],
				credits: { has_credits: true, balance: "42.5" },
			});
		};
		const notice = await ask();
		assert.equal(notice.level, "info");
		assert.match(notice.text, /5 小时额度：剩余 75%/);
		assert.match(notice.text, /周额度：剩余 32.5%/);
		assert.match(notice.text, /重置：.*2026/);
		assert.match(notice.text, /Future Model\n  2 小时额度：剩余 100%；重置：未返回/);
		assert.match(notice.text, /额外 Credits：42.5/);
		assert.equal(runtime.host.session.messages.length, 0, "quota output must stay out of model history");

		globalThis.fetch = async () => Response.json({ email: "private@example.invalid" });
		assert.match((await ask()).text, /未返回可显示的额度信息/);

		// Auth failures must not print raw upstream bodies (which may include credentials).
		globalThis.fetch = async () => new Response(`upstream reflected ${usageAuth.apiKey}`, { status: 401 });
		const expired = await ask();
		assert.equal(expired.level, "error");
		assert.match(expired.text, /重新登录/);
		assert.ok(!expired.text.includes(usageAuth.apiKey));

		// A resolved proxy credential must not be sent to the official endpoint.
		globalThis.fetch = async () => { throw new Error("unexpected credential transmission"); };
		usageAuth.baseUrl = "https://proxy.example.invalid";
		assert.match((await ask()).text, /解析出的.*不是官方地址/);
		usageAuth.baseUrl = "https://chatgpt.com/backend-api";
		model.baseUrl = "https://proxy.example.invalid";
		assert.match((await ask()).text, /自定义服务地址/);
		console.log("Codex usage: real /codex-usage dispatch displays remote quotas without an LLM turn; missing data, expired login and proxy credential boundaries verified (synthetic auth/HTTP).");
	} finally {
		globalThis.fetch = originalFetch;
		model.baseUrl = originalUrl;
		usageAuth.baseUrl = "https://chatgpt.com/backend-api";
	}
}
