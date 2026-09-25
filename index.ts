import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentLoopConfig, type ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "alu-sol-tuner";
const STATUS_KEY = EXTENSION_ID;
const CODEX_FAST_STATUS_KEY = "codex-fast";
const TARGET_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-6-astra"]);
const DEFAULT_GUARD_THRESHOLD = 250_000;
const PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v2");
const LEGACY_PATCH_KEY = Symbol.for("pi.sol-mid-turn-guard.patch.v1");
const MARKER = "GPT-5.6 Sol";

const FLOOR = `

## 全局工程底线（机器级注入；项目明文规则在其领域内优先）

改动：同一能力、常量、协议形状只保留一个定义点，发现重复定义、逐方法转发、兼容壳、双轨实现先停下报告，不照着扩展。无调用方的代码、只写不读的状态、为假想场景准备的兼容分支发现即删或报告，不模仿。临时实现（mock、占位、写死值、跳过的错误路径）在代码和交付说明里显式申报，未申报的降级按缺陷处理。附近代码不是先例，模仿前先对照项目规则文档。用户可见文案不出现内部机制词、类名、UUID、裸枚举值；每条错误说清发生了什么、用户现在能做什么。界面文案说用户世界的状态（"文件保留在原位置"），不写程序状态自白或机制否定句（"不会删除文件"）。

验证：同一事实一份证据，换命令重证已确认的事实是浪费。升级到全量测试/构建每任务至多一次，且仅当改动确实跨模块。

测试：默认配额为一条产品能力一个走真实入口的端到端测试，加上有明确输入输出的模块测试，超出要有具体理由。否定式断言（bounded/rejects/never/closed）必须有出处：真实事故、安全边界、或被外部依赖的冻结协议，没有出处不写。fixture/fake 不得用被测系统的常量或算法计算断言期望值；复用生产库"说协议"可以，用被测逻辑"算答案"是自证。不断言 Mock 调用序列、内部调用次数、内部错误措辞，不为"理论上可能"写防御测试。测试标题说出用户动作和可见结果。

规则按本意执行：引用规则指控或模仿例外前，先回答"它防的是什么事故"，答不上来就不引用。`;

const SOL = `

## GPT-5.6 Sol 专项纪律（按模型注入）

你（GPT-5.6 Sol）的已知偏差：把可见努力当质量、把"充分验证"扩大为无界探索、规则字面化、在用户界面替程序自白。约束：

- One fact, one proof：通过的检查不重跑；换一条命令、换个措辞再证明同一事实也是重复验证，禁止。
- 数字锚：定位与阅读约 10 次工具调用内、验证约 5 条命令内完成；超出说明范围已漂移，收敛而不是加倍努力。
- 已有充分证据的结论不做第二遍复审。没找到缺陷时，"干净"是合法结果，不为找问题而继续搜索。
- 每个行为变化至多一条测试证明，优先修改既有断言；不新增防御性测试护栏，不把测试数量当完成证明。
- 上下文压缩是例行节流，不是收工信号：压缩后以原有力度继续原任务；摘要里已完成、已验证的结论直接沿用，不重做不重证。
- 新任务在第一次修改文件之前申报预期规模（改哪些文件、预计多久）：先只读看清再报数，报完再动手。开工后不补报也不中途插播申报；唯一合法的中途汇报是实际超过申报约两倍时停下请示，不静默加倍努力。
- 程序状态自白是你的招牌病：界面文案里的否定式安抚（"不会删除/不会重复/不会冒充"）与防御性测试同源同罪。新界面文案只对照用户明确指定过的基准语料；没指定就是没有基准，不猜存量里哪些是用户调过的，按"对不懂实现的人念出口"的标准写。
- 引用规则指控或模仿例外前，先回答"它防的是什么事故"；字面命中但本意不符，降级为一行备注或放弃。`;

const COMPACTION_COMPLETED_CONTINUATION =
	"Automatic context compaction completed after a finished tool turn. Continue the original task from the compacted state. Do not repeat completed work or tool calls. If the requested task is already complete, finish normally now.";
const COMPACTION_FAILED_CONTINUATION =
	"Automatic context compaction failed after a finished tool turn. Continue the original task from the current context. Do not repeat completed work or tool calls. If the requested task is already complete, finish normally now.";

type GuardPhase = "idle" | "stopped" | "compacting";

type AgentInternals = Agent & {
	createLoopConfig(options?: { skipInitialSteeringPoll?: boolean }): AgentLoopConfig;
};

interface GuardController {
	readonly generation: symbol;
	shouldStop(agent: Agent, turn: ShouldStopAfterTurnContext): Promise<boolean>;
	onNativeHookDetected(): void;
	reportShimError(error: unknown): void;
}

interface PatchHost {
	readonly original: AgentInternals["createLoopConfig"];
	readonly wrapper: AgentInternals["createLoopConfig"];
	readonly controllers: Map<string, GuardController>;
}

interface LegacyPatchHost {
	readonly original: AgentInternals["createLoopConfig"];
	readonly wrapper: AgentInternals["createLoopConfig"];
	controller?: GuardController;
}

interface AluSolConfig {
	disabled: Set<string>;
	guardThreshold: number;
	guardEnabled: boolean;
}

function readConfig(cwd: string): AluSolConfig {
	const config: AluSolConfig = {
		disabled: new Set(),
		guardThreshold: DEFAULT_GUARD_THRESHOLD,
		guardEnabled: true,
	};
	for (const [layer, dir] of [getAgentDir(), join(cwd, CONFIG_DIR_NAME)].entries()) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, "alu-agent.json"), "utf8")) as {
				disable?: unknown;
				guardThreshold?: unknown;
				guardEnabled?: unknown;
			};
			if (Array.isArray(parsed?.disable) && parsed.disable.every((item) => typeof item === "string")) {
				config.disabled = new Set(parsed.disable);
			}
			// Project overrides apply only to discipline, never to guard defaults.
			if (layer === 0) {
				const threshold = parsed?.guardThreshold;
				if (typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0) {
					config.guardThreshold = threshold;
				}
				if (typeof parsed?.guardEnabled === "boolean") config.guardEnabled = parsed.guardEnabled;
			}
		} catch {
			// Missing and malformed layers are ignored independently.
		}
	}
	return config;
}

function saveGuardDefault(update: { guardEnabled: boolean } | { guardThreshold: number }): void {
	const dir = getAgentDir();
	const file = join(dir, "alu-agent.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		parsed = {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("全局配置必须是 JSON 对象");
	}
	mkdirSync(dir, { recursive: true });
	const tempDir = mkdtempSync(join(dir, ".alu-agent-"));
	try {
		const tempFile = join(tempDir, "alu-agent.json");
		writeFileSync(tempFile, `${JSON.stringify({ ...parsed, ...update }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempFile, file);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function parseThreshold(input: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(input);
	if (!match) return undefined;
	const suffix = match[2].toLowerCase();
	const scale = suffix === "m" ? 6 : suffix === "k" ? 3 : 0;
	const tokens = Number(`${match[1]}e${scale}`);
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function getPatchHost(): PatchHost | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[PATCH_KEY] as PatchHost | undefined;
}

function getLegacyPatchHost(): LegacyPatchHost | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[LEGACY_PATCH_KEY] as LegacyPatchHost | undefined;
}

function setPatchHost(host: PatchHost): void {
	(globalThis as Record<PropertyKey, unknown>)[PATCH_KEY] = host;
}

function usageTokens(turn: ShouldStopAfterTurnContext): number {
	const usage = turn.message.usage;
	if (!usage) return 0;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

function installPatch(): { active: boolean; reason?: string } {
	const prototype = Agent.prototype as unknown as AgentInternals;
	let host = getPatchHost();

	if (!host) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "createLoopConfig");
		const legacy = getLegacyPatchHost();
		const legacyIsInstalled = legacy && descriptor?.value === legacy.wrapper;
		const original = (legacyIsInstalled ? legacy.original : descriptor?.value) as
			| AgentInternals["createLoopConfig"]
			| undefined;
		if (typeof original !== "function") {
			return { active: false, reason: "当前 Pi 版本不支持此保护；请更新插件或 Pi" };
		}
		if (legacyIsInstalled) legacy.controller = undefined;

		host = {
			original,
			controllers: new Map(),
			wrapper: function (this: AgentInternals, options) {
				const config = original.call(this, options);
				const sessionId = config.sessionId;
				const current = sessionId ? host?.controllers.get(sessionId) : undefined;
				if (!current) return config;

				if (typeof config.shouldStopAfterTurn === "function") {
					current.onNativeHookDetected();
					return config;
				}

				return {
					...config,
					shouldStopAfterTurn: async (turn) => {
						const live = sessionId ? host?.controllers.get(sessionId) : undefined;
						if (!live) return false;
						try {
							return await live.shouldStop(this, turn);
						} catch (error) {
							live.reportShimError(error);
							return false;
						}
					},
				};
			},
		};

		Object.defineProperty(prototype, "createLoopConfig", {
			...descriptor,
			value: host.wrapper,
		});
		setPatchHost(host);
	} else if (prototype.createLoopConfig !== host.wrapper) {
		return { active: false, reason: "检测到其他上下文保护；请避免同时加载同类插件" };
	}

	return { active: true };
}

export default function aluSolTuner(pi: ExtensionAPI): void {
	const generation = Symbol("alu-sol-tuner-generation");
	let phase: GuardPhase = "idle";
	let latestContext: ExtensionContext | undefined;
	let stoppedTokens = 0;
	let nativeCompacted = false;
	let nativeHookDetected = false;
	let continuationCount = 0;
	let lastError: string | undefined;
	let activeSessionId: string | undefined;
	let guardThreshold = DEFAULT_GUARD_THRESHOLD;
	let guardEnabled = true;
	let disabled = new Set<string>();
	let codexFastEnabled = false;

	const supportsCodexFast = (model: ExtensionContext["model"]) =>
		model?.provider === "openai-codex" && model.api === "openai-codex-responses";

	const updateCodexFastStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, codexFastEnabled && supportsCodexFast(ctx.model) ? "codex-fast" : undefined);
	};

	const resetCycle = () => {
		phase = "idle";
		stoppedTokens = 0;
		nativeCompacted = false;
	};

	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (latestContext?.hasUI) latestContext.ui.notify(message, level);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const controller: GuardController = {
		generation,
		async shouldStop(agent, turn) {
			if (!guardEnabled || phase !== "idle" || nativeHookDetected) return false;
			if (!TARGET_MODEL_IDS.has(turn.message.model)) return false;
			if (turn.message.stopReason !== "toolUse" || turn.toolResults.length === 0) return false;

			const tokens = usageTokens(turn);
			if (tokens <= guardThreshold) return false;
			if (agent.hasQueuedMessages()) return false;
			if (latestContext?.hasPendingMessages()) return false;

			phase = "stopped";
			stoppedTokens = tokens;
			nativeCompacted = false;
			notify(`阿露 Agent 调教在 ${formatTokens(tokens)} tokens 暂停；空闲后压缩上下文`, "warning");
			return true;
		},
		onNativeHookDetected() {
			if (nativeHookDetected) return;
			nativeHookDetected = true;
			resetCycle();
			if (latestContext) setStatus(latestContext, undefined);
			notify("阿露 Agent 调教已让位：Pi 已提供回合后停止能力", "info");
		},
		reportShimError(error) {
			lastError = error instanceof Error ? error.message : String(error);
			resetCycle();
			if (latestContext) setStatus(latestContext, undefined);
			notify(`阿露 Agent 调教出错：${lastError}`, "error");
		},
	};

	const patch = installPatch();

	const registerController = (ctx: ExtensionContext): boolean => {
		const host = getPatchHost();
		if (!host) return false;
		const sessionId = ctx.sessionManager.getSessionId();
		if (activeSessionId && activeSessionId !== sessionId && host.controllers.get(activeSessionId) === controller) {
			host.controllers.delete(activeSessionId);
		}
		activeSessionId = sessionId;
		host.controllers.set(sessionId, controller);
		return true;
	};

	const unregisterController = () => {
		const host = getPatchHost();
		if (activeSessionId && host?.controllers.get(activeSessionId) === controller) {
			host.controllers.delete(activeSessionId);
		}
		activeSessionId = undefined;
	};

	const continueAgentLoop = (ctx: ExtensionContext, content: string) => {
		const host = getPatchHost();
		if (!activeSessionId || host?.controllers.get(activeSessionId) !== controller) return;
		resetCycle();
		continuationCount++;
		pi.sendMessage(
			{
				customType: EXTENSION_ID,
				content,
				display: false,
				details: { threshold: guardThreshold, continuation: continuationCount },
			},
			{ triggerTurn: true },
		);
		setStatus(ctx, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		codexFastEnabled = false;
		updateCodexFastStatus(ctx);
		// Pi 0.84 session_start covers startup, /reload and the new runtime from /new.
		const config = readConfig(ctx.cwd);
		guardThreshold = config.guardThreshold;
		guardEnabled = config.guardEnabled;
		disabled = config.disabled;
		nativeHookDetected = false;
		continuationCount = 0;
		resetCycle();
		lastError = undefined;
		setStatus(ctx, undefined);
		if (!patch.active || !registerController(ctx)) {
			ctx.ui.notify(`阿露 Agent 调教已停用：${patch.reason ?? "无法注册会话保护"}`, "error");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		updateCodexFastStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!codexFastEnabled || !supportsCodexFast(ctx.model)) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		return { ...payload, service_tier: "priority" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (disabled.has("all") || disabled.has("*")) return;

		let prompt = event.systemPrompt;
		let changed = false;
		if (!disabled.has("engineering-discipline")) {
			prompt += FLOOR;
			changed = true;
		}
		const model = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
		if (!disabled.has("sol-discipline")
			&& /gpt-[\d.]+[a-z0-9-]*-sol/i.test(model)
			&& !event.systemPrompt.includes(MARKER)) {
			prompt += SOL;
			changed = true;
		}
		if (changed) return { systemPrompt: prompt };
	});

	pi.on("turn_end", (_event, ctx) => {
		latestContext = ctx;
	});

	pi.on("agent_start", (_event, ctx) => {
		latestContext = ctx;
		if (patch.active) registerController(ctx);
		if (phase === "stopped") resetCycle();
	});

	pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
		latestContext = ctx;
		if (phase === "stopped" && event.reason !== "manual") nativeCompacted = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		latestContext = ctx;
		if (!patch.active || phase !== "stopped") return;

		if (nativeCompacted) {
			continueAgentLoop(ctx, COMPACTION_COMPLETED_CONTINUATION);
			return;
		}

		phase = "compacting";
		setStatus(ctx, `阿露 Agent 调教 · 正在压缩 ${formatTokens(stoppedTokens)}`);
		// Use Pi's normal compaction preparation, summarizer, and session rebuild path.
		ctx.compact({
			onComplete: () => {
				if (phase !== "compacting") return;
				continueAgentLoop(ctx, COMPACTION_COMPLETED_CONTINUATION);
			},
			onError: (error) => {
				if (phase !== "compacting") return;
				lastError = error.message;
				ctx.ui.notify(`阿露 Agent 调教压缩失败，已继续任务 — ${error.message}`, "error");
				continueAgentLoop(ctx, COMPACTION_FAILED_CONTINUATION);
			},
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, undefined);
		codexFastEnabled = false;
		setStatus(ctx, undefined);
		unregisterController();
		latestContext = undefined;
		resetCycle();
	});

	const showStatus = (ctx: ExtensionContext) => {
		const phaseText: Record<GuardPhase, string> = {
			idle: guardEnabled ? "等待触发" : "等待开启",
			stopped: "等待压缩",
			compacting: "正在压缩",
		};
		const availability = !patch.active
			? `保护不可用：${patch.reason}`
			: nativeHookDetected ? "Pi 已提供原生保护，本插件已让位" : phaseText[phase];
		const status = `阿露 Agent 调教：当前会话保护=${guardEnabled ? "开启" : "关闭"}，当前阈值=${formatTokens(guardThreshold)} tokens；${availability}；已续跑=${continuationCount}`
			+ "\n全局默认在启动、/reload、/new 时读取；on/off 仅改当前会话，threshold 同时保存全局默认。";
		ctx.ui.notify(lastError ? `${status}\n最近错误：${lastError}` : status, patch.active ? "info" : "error");
	};

	const help = "/alu-agent on|off — 仅切换当前会话保护\n"
		+ "/alu-agent default on|off — 保存全局默认开关，当前会话开关保持原值\n"
		+ "/alu-agent threshold <tokens> — 修改当前阈值并保存全局默认，如 450k、1.05m\n"
		+ "/alu-agent status|help — 查看状态或帮助\n"
		+ "全局默认与纪律配置仅在启动、/reload、/new 时读取；其他已存在会话保持原值。";

	pi.registerCommand("codex-fast", {
		description: "切换当前会话 Codex Fast 请求档位，或查看状态",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "on" || command === "off") {
				codexFastEnabled = command === "on";
				updateCodexFastStatus(ctx);
			} else if (command !== "status") {
				ctx.ui.notify("用法：/codex-fast on|off|status", "error");
				return;
			}
			ctx.ui.notify(`Codex Fast 当前会话开关：${codexFastEnabled ? "开启" : "关闭"}；当前模型：${supportsCodexFast(ctx.model) ? "适用" : "不适用"}。开启时仅请求 Fast 档位，实际是否兑现取决于订阅服务。`, "info");
		},
	});

	pi.registerCommand("alu-agent", {
		description: "设置当前上下文保护、全局默认，或查看状态",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const [command, value] = parts;
			if ((!command || command === "status") && parts.length === 1) return showStatus(ctx);
			if (command === "help" && parts.length === 1) return ctx.ui.notify(help, "info");
			if ((command === "on" || command === "off") && parts.length === 1) {
				guardEnabled = command === "on";
				showStatus(ctx);
				return;
			}
			const threshold = command === "threshold" && value ? parseThreshold(value) : undefined;
			if (parts.length !== 2 || !((command === "default" && (value === "on" || value === "off"))
				|| (command === "threshold" && threshold !== undefined))) {
				ctx.ui.notify(`命令参数有误；阈值需为正整数 tokens（支持 k/m）。\n${help}`, "error");
				return;
			}
			try {
				saveGuardDefault(command === "default" ? { guardEnabled: value === "on" } : { guardThreshold: threshold! });
			} catch (error) {
				ctx.ui.notify(`全局默认保存失败，当前会话设置保持原值。请检查 alu-agent.json的格式和目录写入权限后重试：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (command === "threshold") guardThreshold = threshold!;
			ctx.ui.notify(command === "default"
				? `全局默认保护已保存为${value === "on" ? "开启" : "关闭"}；当前会话开关保持原值。`
				: `当前阈值和全局默认阈值已保存为 ${formatTokens(guardThreshold)} tokens。`, "info");
			showStatus(ctx);
		},
	});
}
