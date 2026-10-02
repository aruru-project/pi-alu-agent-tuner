import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runLifecycle } from "./lifecycle.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardOnly = process.argv.includes("--guard-only");
const extensionPath = join(projectRoot, "index.ts");
const piRoot = process.env.PI_CODING_AGENT_ROOT
	?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
const tempAgentDir = mkdtempSync(join(tmpdir(), "alu-agent-smoke-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

try {
	const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")));
	const nestedAgentCore = join(piRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js");
	const { Agent } = await import(pathToFileURL(existsSync(nestedAgentCore)
		? nestedAgentCore : join(piRoot, "../pi-agent-core/dist/index.js")));

	const context = (sessionId, calls, cwd, model) => ({
		hasUI: false,
		cwd,
		model,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify(text, level) { calls.notifications.push({ text, level }); },
			setStatus(key, text) {
				calls.statusChanges.push({ key, text });
				if (text === undefined) calls.extensionStatus.delete(key);
				else calls.extensionStatus.set(key, text);
			},
		},
		hasPendingMessages: () => !!calls.pending,
		compact(options) {
			calls.compactions++;
			if (calls.deferCompact) { calls.compactOptions = options; return; }
			if (calls.compactError) options.onError?.(new Error("synthetic compact failure"));
			else options.onComplete?.({});
		},
	});
	const emit = async (extension, eventName, ctx, extra = {}) => {
		let result;
		for (const handler of extension.handlers.get(eventName) ?? []) {
			const next = await handler({ type: eventName, ...extra }, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	};
	const loadRuntime = async (
		sessionId,
		cwd = projectRoot,
		model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
	) => {
		const result = await loader.discoverAndLoadExtensions([extensionPath], cwd, tempAgentDir);
		if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
		const extension = result.extensions[0];
		const calls = {
			compactions: 0,
			compactError: false,
			messages: [],
			notifications: [],
			statusChanges: [],
			extensionStatus: new Map(),
		};
		result.runtime.sendMessage = (message, options) => calls.messages.push({ message, options });
		const ctx = context(sessionId, calls, cwd, model);
		await emit(extension, "session_start", ctx);
		return { extension, ctx, calls };
	};

	const message = (model, totalTokens, withTools = true) => ({
		role: "assistant",
		content: withTools ? [{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }] : [],
		api: "openai-responses",
		provider: "openai-codex",
		model,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: withTools ? "toolUse" : "stop",
		timestamp: Date.now(),
	});
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "noop",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
	const turn = (assistant, toolResults = [toolResult]) => ({
		message: assistant,
		toolResults,
		context: { systemPrompt: "", messages: [assistant, ...toolResults], tools: [] },
		newMessages: [assistant, ...toolResults],
	});

	const stopAfterTurn = async (config, completed) => (await config.finishTurn(completed))?.action === "end";

	// Simulate upgrading the old process-global patch during /reload.
	const original = Agent.prototype.createLoopConfig;
	// A config exposing only the removed protocol cannot be advertised as enabled.
	Agent.prototype.createLoopConfig = function (options) {
		const { finishTurn: _removed, ...config } = original.call(this, options);
		return config;
	};
	try {
		const legacyRuntime = await loadRuntime("runtime-legacy-protocol");
		await legacyRuntime.extension.commands.get("alu-agent").handler("on", legacyRuntime.ctx);
		assert.match(legacyRuntime.calls.notifications.at(-1).text, /当前会话保护=不可用/);
		assert.equal(legacyRuntime.calls.notifications.at(-1).level, "error");
		await emit(legacyRuntime.extension, "session_shutdown", legacyRuntime.ctx, { reason: "shutdown" });
	} finally { Agent.prototype.createLoopConfig = original; }
	const oldHost = { original, controllers: new Map([["old-session", {}]]),
		wrapper(options) { return { ...original.call(this, options), shouldStopAfterTurn: async () => false }; },
	};
	globalThis[Symbol.for("pi.sol-mid-turn-guard.patch.v2")] = oldHost;
	Agent.prototype.createLoopConfig = oldHost.wrapper;
	const runtimeA = await loadRuntime("runtime-a");
	assert.equal(oldHost.controllers.size, 0);
	assert.deepEqual([...runtimeA.extension.commands.keys()].sort(), ["alu-agent", "codex-fast", "codex-usage"]);
	const fast = runtimeA.extension.commands.get("codex-fast").handler;
	const payload = { model: "gpt-5.6-sol", instructions: "keep", text: { verbosity: "low" }, reasoning: { effort: "high" } };
	assert.equal(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload }), undefined);
	await fast("on", runtimeA.ctx);
	assert.equal(runtimeA.calls.extensionStatus.get("codex-fast"), "codex-fast");
	assert.deepEqual(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload }), { ...payload, service_tier: "priority" });
	assert.deepEqual(payload, { model: "gpt-5.6-sol", instructions: "keep", text: { verbosity: "low" }, reasoning: { effort: "high" } });
	assert.deepEqual(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload: { ...payload, model: "gpt-future" } }), { ...payload, model: "gpt-future", service_tier: "priority" });
	for (const model of [
		{ provider: "openai", api: "openai-codex-responses", id: "gpt-5.6-sol" },
		{ provider: "openai-codex", api: "openai-responses", id: "gpt-5.6-sol" },
	]) {
		runtimeA.ctx.model = model;
		await emit(runtimeA.extension, "model_select", runtimeA.ctx, { model });
		assert.equal(runtimeA.calls.extensionStatus.has("codex-fast"), false);
		await fast("status", runtimeA.ctx);
		assert.match(runtimeA.calls.notifications.at(-1).text, /开启；当前模型：不适用/);
		assert.equal(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload }), undefined);
	}
	for (const id of ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-6-astra", "gpt-future"]) {
		runtimeA.ctx.model = { provider: "openai-codex", api: "openai-codex-responses", id };
		await emit(runtimeA.extension, "model_select", runtimeA.ctx, { model: runtimeA.ctx.model });
		assert.equal(runtimeA.calls.extensionStatus.get("codex-fast"), "codex-fast");
		assert.deepEqual(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload: { model: id } }), { model: id, service_tier: "priority" });
	}
	await fast("off", runtimeA.ctx);
	assert.equal(runtimeA.calls.extensionStatus.has("codex-fast"), false);
	assert.equal(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload: { model: "gpt-6-astra" } }), undefined);
	await fast("on", runtimeA.ctx);
	await emit(runtimeA.extension, "session_start", runtimeA.ctx);
	assert.equal(runtimeA.calls.extensionStatus.has("codex-fast"), false);
	assert.equal(await emit(runtimeA.extension, "before_provider_request", runtimeA.ctx, { payload: { model: "gpt-6-astra" } }), undefined);
	const wrapper = Agent.prototype.createLoopConfig;
	const agentA = new Agent({ sessionId: "runtime-a" });
	const configA = agentA.createLoopConfig();
	if (typeof configA.finishTurn !== "function") throw new Error("runtime A hook was not installed");

	// Runtime B is created later; it must not replace A's controller.
	const runtimeB = await loadRuntime("runtime-b");
	if (runtimeB.calls.extensionStatus.has("alu-sol-tuner")) {
		throw new Error("idle tuner occupied the extension status area");
	}
	assert.equal(runtimeB.calls.extensionStatus.has("codex-fast"), false);
	assert.equal(await emit(runtimeB.extension, "before_provider_request", runtimeB.ctx, { payload }), undefined);
	const agentB = new Agent({ sessionId: "runtime-b" });
	const configB = agentB.createLoopConfig();
	if (typeof configB.finishTurn !== "function") throw new Error("runtime B hook was not installed");
	if (Agent.prototype.createLoopConfig !== wrapper) throw new Error("runtime B stacked the prototype wrapper");

	const promptResult = await emit(runtimeB.extension, "before_agent_start", runtimeB.ctx, {
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: projectRoot },
	});
	if (!promptResult?.systemPrompt.includes("## 全局工程底线（机器级注入；项目明文规则在其领域内优先）")) {
		throw new Error("engineering discipline was not injected by default");
	}
	if (!promptResult.systemPrompt.includes("## GPT-5.6 Sol 专项纪律（按模型注入）")) {
		throw new Error("Sol discipline was not injected for a Sol model");
	}
	runtimeB.ctx.model = { provider: "openai-codex", id: "other-model" };
	const nonSolPrompt = await emit(runtimeB.extension, "before_agent_start", runtimeB.ctx, {
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: projectRoot },
	});
	if (!nonSolPrompt?.systemPrompt.includes("## 全局工程底线")) {
		throw new Error("engineering discipline was gated off for a non-Sol model");
	}
	if (nonSolPrompt.systemPrompt.includes("## GPT-5.6 Sol 专项纪律")) {
		throw new Error("Sol discipline was injected for a non-Sol model");
	}
	runtimeB.ctx.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const markedPrompt = await emit(runtimeB.extension, "before_agent_start", runtimeB.ctx, {
		systemPrompt: "base prompt with GPT-5.6 Sol already present",
		systemPromptOptions: { cwd: projectRoot },
	});
	if (markedPrompt?.systemPrompt.includes("## GPT-5.6 Sol 专项纪律")) {
		throw new Error("Sol discipline marker did not prevent duplicate injection");
	}

	if (await stopAfterTurn(configB, turn(message("other-model", 300_000)))) {
		throw new Error("unsupported model was stopped");
	}
	if (await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_000)))) {
		throw new Error("250k boundary should not stop");
	}
	if (await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 300_000, false), []))) {
		throw new Error("no-tool turn was stopped");
	}

	agentB.steer({ role: "user", content: "owner queued", timestamp: Date.now() });
	if (await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_001)))) {
		throw new Error("queued owner message should suppress stop");
	}
	agentB.clearAllQueues();
	agentB.followUp({ role: "user", content: "owner follow-up", timestamp: Date.now() });
	assert.equal(await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_001))), false);
	agentB.clearAllQueues();
	runtimeB.calls.pending = true;
	assert.equal(await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_001))), false);
	runtimeB.calls.pending = false;

	// Preserve the existing hook's decision and AbortSignal; it is not native guard detection.
	const upstreamAgent = new Agent({ sessionId: "runtime-a", finishTurn: async (_turn, signal) => {
		assert.equal(signal, upstreamSignal);
		return { action: "continue" };
	} });
	const upstreamSignal = new AbortController().signal;
	assert.deepEqual(await upstreamAgent.createLoopConfig().finishTurn(turn(message("other-model", 300_000)), upstreamSignal), { action: "continue" });
	upstreamAgent.finishTurn = async () => ({ action: "end" });
	assert.deepEqual(await upstreamAgent.createLoopConfig().finishTurn(turn(message("gpt-5.6-sol", 250_001))), { action: "end" });
	await emit(runtimeA.extension, "agent_settled", runtimeA.ctx);
	assert.equal(runtimeA.calls.compactions, 0);

	// Sol and Astra tool turns above the default threshold compact and resume the task.
	for (const [index, model] of ["gpt-5.6-sol", "gpt-6-astra"].entries()) {
		runtimeA.ctx.model = { provider: "openai-codex", id: model };
		if (!(await stopAfterTurn(configA, turn(message(model, 250_001))))) {
			throw new Error(`${model} did not stop above 250k after runtime B started`);
		}
		await emit(runtimeA.extension, "agent_settled", runtimeA.ctx);
		const continuation = runtimeA.calls.messages[index];
		if (runtimeA.calls.compactions !== index + 1
			|| runtimeA.calls.messages.length !== index + 1
			|| continuation?.options?.triggerTurn !== true
			|| !continuation.message?.content?.includes("compaction completed")
			|| continuation.message?.details?.threshold !== 250_000) {
			throw new Error(`${model} did not compact and resume through its own runtime`);
		}
	}
	if (!runtimeA.calls.statusChanges.some(({ text }) => text?.includes("正在压缩"))) {
		throw new Error("active compaction was not exposed as a transient status");
	}
	if (runtimeA.calls.extensionStatus.has("alu-sol-tuner")) {
		throw new Error("completed compaction left a persistent extension status");
	}

	if (!(await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("runtime B did not stop independently");
	}
	// Turning off after a guard stop must still finish the pending continuation.
	await runtimeB.extension.commands.get("alu-agent").handler("off", runtimeB.ctx);
	runtimeB.calls.compactError = true;
	await emit(runtimeB.extension, "agent_settled", runtimeB.ctx);
	if (runtimeB.calls.compactions !== 1
		|| runtimeB.calls.messages.length !== 1
		|| runtimeB.calls.messages[0].options?.triggerTurn !== true
		|| !runtimeB.calls.messages[0].message?.content?.includes("compaction failed")) {
		throw new Error("runtime B compaction error did not continue the agent loop");
	}

	// A failed plugin-owned compaction resumes normal work. Re-enabling allows
	// the next successful tool turn to attempt compaction again.
	await runtimeB.extension.commands.get("alu-agent").handler("on", runtimeB.ctx);
	if (!(await stopAfterTurn(configB, turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("runtime B did not retry compaction after resumed tool work");
	}
	runtimeB.calls.compactError = false;
	await emit(runtimeB.extension, "agent_settled", runtimeB.ctx);
	if (runtimeB.calls.compactions !== 2
		|| runtimeB.calls.messages.length !== 2
		|| runtimeB.calls.messages[1].options?.triggerTurn !== true
		|| !runtimeB.calls.messages[1].message?.content?.includes("compaction completed")) {
		throw new Error("runtime B did not compact and continue after the next tool turn");
	}

	const configuredCwd = join(tempAgentDir, "configured-project");
	const configDir = join(configuredCwd, ".pi");
	const configFile = join(configDir, "alu-agent.json");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(tempAgentDir, "alu-agent.json"), JSON.stringify({
		disable: ["sol-discipline"],
		guardThreshold: 100,
	}));
	writeFileSync(configFile, JSON.stringify({ disable: ["all"] }));
	const configuredRuntime = await loadRuntime("runtime-configured", configuredCwd);
	const disabledPrompt = await emit(configuredRuntime.extension, "before_agent_start", configuredRuntime.ctx, {
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: configuredCwd },
	});
	if (disabledPrompt !== undefined) throw new Error("disable=all did not suppress discipline injection");
	const configuredAgent = new Agent({ sessionId: "runtime-configured" });
	const configuredLoop = configuredAgent.createLoopConfig();
	if (!(await stopAfterTurn(configuredLoop, turn(message("gpt-5.6-sol", 101))))) {
		throw new Error("global guard threshold did not combine with project disable=all");
	}
	await emit(configuredRuntime.extension, "agent_settled", configuredRuntime.ctx);
	if (configuredRuntime.calls.compactions !== 1 || configuredRuntime.calls.messages.length !== 1) {
		throw new Error("configured guard did not compact and resume");
	}

	writeFileSync(configFile, JSON.stringify({ disable: [123], guardEnabled: false, guardThreshold: 200 }));
	const unchangedPrompt = await emit(configuredRuntime.extension, "before_agent_start", configuredRuntime.ctx, {
		systemPrompt: "base prompt",
	});
	if (unchangedPrompt !== undefined) throw new Error("discipline config hot-loaded before reinitialization");
	await emit(configuredRuntime.extension, "session_start", configuredRuntime.ctx);
	const floorOnlyPrompt = await emit(configuredRuntime.extension, "before_agent_start", configuredRuntime.ctx, {
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: configuredCwd },
	});
	if (!floorOnlyPrompt?.systemPrompt.includes("## 全局工程底线")
		|| floorOnlyPrompt.systemPrompt.includes("## GPT-5.6 Sol 专项纪律")) {
		throw new Error("invalid project disable did not retain the global disable field");
	}
	const overrideAgent = new Agent({ sessionId: "runtime-configured" });
	const overrideLoop = overrideAgent.createLoopConfig();
	if (!(await stopAfterTurn(overrideLoop, turn(message("gpt-5.6-sol", 150))))) {
		throw new Error("project guard fields overrode global defaults");
	}
	// Pi's own automatic compaction has already completed: resume without a second compaction.
	await emit(configuredRuntime.extension, "session_compact", configuredRuntime.ctx, { reason: "threshold" });
	await emit(configuredRuntime.extension, "agent_settled", configuredRuntime.ctx);
	if (configuredRuntime.calls.compactions !== 1 || configuredRuntime.calls.messages.length !== 2) {
		throw new Error("native compaction did not resume directly");
	}
	writeFileSync(configFile, JSON.stringify({ disable: ["engineering-discipline"], guardThreshold: 100 }));
	await emit(configuredRuntime.extension, "session_start", configuredRuntime.ctx);
	const solOnlyPrompt = await emit(configuredRuntime.extension, "before_agent_start", configuredRuntime.ctx, {
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: configuredCwd },
	});
	if (solOnlyPrompt?.systemPrompt.includes("## 全局工程底线")
		|| !solOnlyPrompt?.systemPrompt.includes("## GPT-5.6 Sol 专项纪律")) {
		throw new Error("engineering-discipline disable category did not preserve only Sol discipline");
	}
	await emit(configuredRuntime.extension, "session_shutdown", configuredRuntime.ctx, { reason: "shutdown" });

	// Replacement registers first; stale shutdown from the old B must not delete it.
	const replacementB = await loadRuntime("runtime-b");
	await emit(runtimeB.extension, "session_shutdown", runtimeB.ctx, { reason: "reload" });
	const replacementAgentB = new Agent({ sessionId: "runtime-b" });
	const replacementConfigB = replacementAgentB.createLoopConfig();
	if (!(await stopAfterTurn(replacementConfigB, turn(message("gpt-5.6-sol", 250_001))))) {
		throw new Error("stale runtime B cleanup removed its replacement controller");
	}
	if (Agent.prototype.createLoopConfig !== wrapper) throw new Error("reload stacked or replaced the wrapper");

	// A pending instruction at settle wins over compaction, and reload invalidates old callbacks.
	const queuedRuntime = await loadRuntime("runtime-queued");
	const queuedLoop = new Agent({ sessionId: "runtime-queued" }).createLoopConfig();
	assert.equal(await stopAfterTurn(queuedLoop, turn(message("gpt-5.6-sol", 300_000))), true);
	queuedRuntime.calls.pending = true;
	await emit(queuedRuntime.extension, "agent_settled", queuedRuntime.ctx);
	assert.equal(queuedRuntime.calls.compactions, 0);
	queuedRuntime.calls.pending = false;
	queuedRuntime.calls.deferCompact = true;
	assert.equal(await stopAfterTurn(queuedLoop, turn(message("gpt-5.6-sol", 300_000))), true);
	await emit(queuedRuntime.extension, "agent_settled", queuedRuntime.ctx);
	const staleCompact = queuedRuntime.calls.compactOptions;
	await emit(queuedRuntime.extension, "session_start", queuedRuntime.ctx);
	assert.equal(await stopAfterTurn(queuedLoop, turn(message("gpt-5.6-sol", 300_000))), true);
	await emit(queuedRuntime.extension, "agent_settled", queuedRuntime.ctx);
	staleCompact.onComplete({});
	assert.equal(queuedRuntime.calls.messages.length, 0);
	queuedRuntime.calls.compactOptions.onComplete({});
	assert.equal(queuedRuntime.calls.messages.length, 1);

	// A broken guard or overwritten patch must report unavailable, including after /on.
	queuedRuntime.ctx.hasPendingMessages = () => { throw new Error("synthetic guard failure"); };
	assert.equal(await stopAfterTurn(queuedLoop, turn(message("gpt-5.6-sol", 300_000))), false);
	await queuedRuntime.extension.commands.get("alu-agent").handler("on", queuedRuntime.ctx);
	assert.match(queuedRuntime.calls.notifications.at(-1).text, /当前会话保护=不可用/);
	assert.equal(queuedRuntime.calls.notifications.at(-1).level, "error");
	Agent.prototype.createLoopConfig = original;
	try {
		const unavailable = await loadRuntime("runtime-unavailable");
		await unavailable.extension.commands.get("alu-agent").handler("status", unavailable.ctx);
		assert.match(unavailable.calls.notifications.at(-1).text, /当前会话保护=不可用/);
		assert.equal(unavailable.calls.notifications.at(-1).level, "error");
	} finally { Agent.prototype.createLoopConfig = wrapper; }
	await emit(queuedRuntime.extension, "session_shutdown", queuedRuntime.ctx, { reason: "shutdown" });

	await emit(runtimeA.extension, "session_shutdown", runtimeA.ctx, { reason: "shutdown" });
	await emit(replacementB.extension, "session_shutdown", replacementB.ctx, { reason: "shutdown" });

	console.log(
		"smoke ok: Codex Fast request tier/model switching/isolation/reset, discipline injection/gating/snapshot, global-only guard defaults, Sol/Astra stop/compact/resume, native compaction, compact error/retry, dual-runtime routing, stale cleanup, reload idempotence",
	);
	await runLifecycle({ piRoot, tempAgentDir, extensionPath, turn, message, guardOnly });
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempAgentDir, { recursive: true, force: true });
}
