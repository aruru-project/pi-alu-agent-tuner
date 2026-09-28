import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Private ChatGPT endpoint; protocol references and limitations are in README.md.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PAGE = "https://chatgpt.com/codex/settings/usage";
const MAX_BODY_BYTES = 64 * 1024;

function officialUrl(value: string | undefined): boolean {
	try {
		const url = new URL(value ?? "");
		return url.origin === "https://chatgpt.com" && !url.username && !url.password;
	} catch { return false; }
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | undefined {
	if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function label(value: unknown, fallback: string): string {
	return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 100) || fallback : fallback;
}

export function formatCodexUsage(payload: unknown): string {
	const data = object(payload);
	if (!data) throw new Error("额度接口返回了无法识别的数据。");
	const lines = ["Codex 订阅额度（账号级，非当前会话用量）"];
	if (typeof data.plan_type === "string") lines.push(`套餐：${label(data.plan_type, "未知")}`);
	let displayed = false;
	const addGroup = (title: string, raw: unknown) => {
		const group = object(raw);
		if (!group) return;
		const windows: string[] = [];
		for (const [key, fallback] of [["primary_window", "主窗口"], ["secondary_window", "次窗口"]]) {
			const window = object(group[key]);
			if (!window) continue;
			const used = number(window.used_percent);
			if (used === undefined) continue;
			const seconds = number(window.limit_window_seconds);
			const name = seconds === 604800 ? "周额度" : seconds === 18000 ? "5 小时额度"
				: seconds && seconds > 0 ? `${Number((seconds / 3600).toFixed(2))} 小时额度` : fallback;
			const resetAt = number(window.reset_at);
			const reset = resetAt === undefined ? undefined : new Date(resetAt * 1000);
			const resetText = reset && Number.isFinite(reset.getTime())
				? reset.toLocaleString("zh-CN", { hour12: false, timeZoneName: "short" }) : "未返回";
			windows.push(`  ${name}：剩余 ${Number((100 - Math.min(100, Math.max(0, used))).toFixed(1))}%；重置：${resetText}`);
		}
		if (windows.length) {
			displayed = true;
			lines.push(`${title}${group.limit_reached === true || group.allowed === false ? "（当前受限）" : ""}`, ...windows);
		}
	};
	addGroup("通用额度", data.rate_limit);
	if (Array.isArray(data.additional_rate_limits)) {
		for (const item of data.additional_rate_limits) {
			const group = object(item);
			if (group) addGroup(label(group.limit_name ?? group.metered_feature, "额外额度"), group.rate_limit);
		}
	}
	addGroup("代码审查额度", data.code_review_rate_limit);
	const credits = object(data.credits);
	if (credits?.has_credits === true || credits?.has_credits === false) {
		displayed = true;
		const balance = number(credits.balance);
		lines.push(`额外 Credits：${credits.unlimited === true ? "不限额" : credits.has_credits === false ? "无" : balance === undefined ? "可用（未返回余额）" : balance}`);
	}
	if (!displayed) throw new Error("额度接口未返回可显示的额度信息；请到 Codex 用量页面查看。");
	lines.push(`查询时间：${new Date().toLocaleString("zh-CN", { hour12: false, timeZoneName: "short" })}`);
	return lines.join("\n");
}

async function readUsage(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("额度接口没有返回内容。");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new Error("额度接口响应过大；请到 Codex 用量页面查看。");
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
	catch { throw new Error("额度接口没有返回有效 JSON；请稍后重试。"); }
}

async function queryUsage(ctx: ExtensionContext): Promise<string> {
	const model = ctx.model?.provider === "openai-codex" ? ctx.model
		: ctx.modelRegistry.getAll().find((candidate) => candidate.provider === "openai-codex" && officialUrl(candidate.baseUrl));
	if (!model) throw new Error("未找到官方 Codex 模型；请先配置 openai-codex 并通过 /login 登录。");
	if (!officialUrl(model.baseUrl)) throw new Error("当前 Codex 使用自定义服务地址，不能把该凭据发送到官方额度接口。");
	let auth;
	try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
	catch { throw new Error("无法取得 Pi 的 Codex 登录状态；请检查 /login 后重试。"); }
	if (!auth.ok) throw new Error("无法取得 Pi 的 Codex 登录状态；请检查 /login 后重试。");
	if (auth.baseUrl !== undefined && !officialUrl(auth.baseUrl)) {
		throw new Error("Pi 解析出的 Codex 服务地址不是官方地址，已停止查询。");
	}
	// Match Pi's Codex transport: it uses apiKey and derives the account from that JWT.
	// Pi owns credential storage/refresh; this extension never reads auth files itself.
	const token = auth.apiKey;
	let accountId: unknown;
	try {
		const parts = token?.split(".");
		if (parts?.length === 3) accountId = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
			?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch { /* Report a fixed message, never an auth payload. */ }
	if (!token || typeof accountId !== "string" || !accountId || /[\x00-\x1f\x7f]/.test(accountId)) {
		throw new Error("未取得有效的 Codex 订阅登录凭据；请通过 /login 登录 OpenAI Codex。");
	}
	const signal = AbortSignal.timeout(15_000);
	let response: Response;
	try {
		response = await fetch(USAGE_URL, {
			method: "GET", redirect: "error", signal,
			headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json" },
		});
	} catch {
		throw new Error(signal.aborted ? "额度查询超时，请稍后重试。" : "无法连接 Codex 额度接口，请检查网络后重试。");
	}
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 401) throw new Error("Codex 登录已失效或被拒绝；请通过 /login 重新登录后重试。");
		if (response.status === 403) throw new Error("Codex 拒绝了额度查询；请到 Codex 用量页面确认账号状态。");
		if (response.status === 429) throw new Error("额度查询过于频繁，请稍后重试。");
		throw new Error(`额度查询失败（HTTP ${response.status}）；请稍后重试。`);
	}
	try { return formatCodexUsage(await readUsage(response)); }
	catch (error) {
		if (signal.aborted) throw new Error("额度查询超时，请稍后重试。");
		// Only locally generated messages are exposed; transport errors may contain sensitive context.
		if (error instanceof Error && error.message.startsWith("额度接口")) throw error;
		throw new Error("额度响应读取失败，请稍后重试。");
	}
}

export function registerCodexUsage(pi: ExtensionAPI): void {
	let querying = false;
	pi.registerCommand("codex-usage", {
		description: "旁路查询 Pi 当前 Codex 账号的剩余额度与重置时间",
		handler: async (args, ctx) => {
			if (args.trim()) return ctx.ui.notify("用法：/codex-usage（无需参数）", "info");
			if (querying) return ctx.ui.notify("额度查询还在进行，请稍等。", "info");
			querying = true;
			try { ctx.ui.notify(await queryUsage(ctx), "info"); }
			catch (error) {
				ctx.ui.notify(`${error instanceof Error ? error.message : "额度查询失败，请稍后重试。"}\n${USAGE_PAGE}`, "error");
			} finally { querying = false; }
		},
	});
}
