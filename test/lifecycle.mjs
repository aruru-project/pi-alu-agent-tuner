import assert from "node:assert/strict";
import { runUsageChecks, usageAuth } from "./codex-usage.mjs";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Real Pi SDK, command dispatch, resource loader, /new runtime replacement and
// /reload lifecycle. Model lookup and UI are substitutes; no credentials or LLM calls.
export async function runLifecycle({ piRoot, tempAgentDir, extensionPath, turn, message, guardOnly = false }) {
	const load = (file) => import(pathToFileURL(join(piRoot, "dist/core", file)));
	const { createAgentSession } = await load("sdk.js");
	const { createAgentSessionRuntime } = await load("agent-session-runtime.js");
	const { DefaultResourceLoader } = await load("resource-loader.js");
	const { SettingsManager } = await load("settings-manager.js");
	const { SessionManager } = await load("session-manager.js");
	const cwd = join(tempAgentDir, "lifecycle-project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const file = join(tempAgentDir, "alu-agent.json");
	const writeConfig = (config) => writeFileSync(file, JSON.stringify(config));
	const readConfig = () => JSON.parse(readFileSync(file, "utf8"));
	writeConfig({ guardEnabled: false, guardThreshold: 450000, disable: ["sol-discipline"], unrelated: { keep: "yes" } });
	writeFileSync(join(cwd, ".pi/alu-agent.json"), JSON.stringify({ guardEnabled: true, guardThreshold: 10, disable: [] }));
	const model = {
		id: "gpt-5.6-sol", name: "test Sol", provider: "openai-codex", api: "openai-codex-responses",
		reasoning: false, input: ["text"], contextWindow: 2000000, maxTokens: 1000,
		baseUrl: "https://chatgpt.com/backend-api",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const factory = async (options) => {
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd, agentDir: tempAgentDir, settingsManager,
			additionalExtensionPaths: [extensionPath],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = {
			getModel: () => model, getPhysicalModel: () => model, getModels: () => [model],
			getAuth: async () => ({ auth: usageAuth }),
			hasConfiguredAuth: () => true, isUsingOAuth: () => false, checkAuth: async () => ({}),
		};
		const result = await createAgentSession({
			...options, settingsManager, resourceLoader, modelRuntime, model, tools: ["noop"],
			customTools: [{ name: "noop", label: "noop", description: "Synthetic local tool",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			}],
		});
		return { ...result, services: { cwd: options.cwd, agentDir: tempAgentDir, settingsManager, resourceLoader, modelRuntime }, diagnostics: [] };
	};
	const hosts = [];
	const makeHost = async () => {
		const notifications = [];
		const fastStatuses = new Map();
		const host = await createAgentSessionRuntime(factory, {
			cwd, agentDir: tempAgentDir, sessionManager: SessionManager.inMemory(cwd),
		});
		hosts.push(host);
		const bind = (session) => session.bindExtensions({
			uiContext: {
				notify: (text, level) => notifications.push({ text, level }),
				setStatus: (key, text) => {
					if (text === undefined) fastStatuses.delete(key);
					else fastStatuses.set(key, text);
				},
			},
			onError: (error) => { throw new Error(JSON.stringify(error)); },
		});
		host.setRebindSession(bind);
		await bind(host.session);
		return { host, notifications, fastStatuses };
	};
	const command = async (runtime, text) => {
		runtime.notifications.length = 0;
		await runtime.host.session.prompt(`/alu-agent ${text}`);
		return runtime.notifications;
	};
	const status = async (runtime, enabled, threshold) => {
		const notices = await command(runtime, "status");
		assert.match(notices.at(-1).text, new RegExp(`当前会话保护=${enabled ? "开启" : "关闭"}，当前阈值=${threshold} tokens`));
		assert.match(notices.at(-1).text, /启动、\/reload、\/new/);
		assert.match(notices.at(-1).text, /^阿露 Agent 调教：/);
	};
	const fastCommand = async (runtime, text) => {
		runtime.notifications.length = 0;
		await runtime.host.session.prompt(`/codex-fast ${text}`);
		return runtime.notifications.at(-1);
	};
	const fastPayload = (runtime) => runtime.host.session.extensionRunner.emitBeforeProviderRequest({ model: "gpt-5.6-sol", text: { verbosity: "low" } });
	const beforeStart = async (session) => {
		const result = await session.extensionRunner.emitBeforeAgentStart("hello", undefined, { cwd, forceSystemPrompt: "base prompt" });
		const prompt = result.systemPromptOptions.forceSystemPrompt;
		return prompt === "base prompt" ? undefined : { systemPrompt: prompt };
	};
	const shouldStop = async (runtime, tokens) => {
		const completed = turn(message("gpt-5.6-sol", tokens));
		// Direct protocol checks still dispatch Pi's real persisted turn_end boundary.
		for (const msg of completed.newMessages) runtime.host.session.sessionManager.appendMessage(msg);
		return (await runtime.host.session.agent.createLoopConfig().finishTurn(completed))?.action === "end";
	};
	try {
		// User's A/B example: local switches and threshold writes affect only A.
		const a = await makeHost();
		const b = await makeHost();
		if (!guardOnly) await runUsageChecks({ runtime: a, model });
		await status(a, false, "450,000");
		await status(b, false, "450,000");
		assert.equal(a.fastStatuses.has("codex-fast"), false);
		assert.deepEqual(await fastPayload(a), { model: "gpt-5.6-sol", text: { verbosity: "low" } });
		assert.match((await fastCommand(a, "status")).text, /关闭；当前模型：适用/);
		assert.match((await fastCommand(a, "on")).text, /开启；当前模型：适用/);
		assert.equal(a.fastStatuses.get("codex-fast"), "codex-fast");
		assert.deepEqual(await fastPayload(a), { model: "gpt-5.6-sol", text: { verbosity: "low" }, service_tier: "priority" });
		assert.deepEqual(await fastPayload(b), { model: "gpt-5.6-sol", text: { verbosity: "low" } });
		assert.equal(b.fastStatuses.has("codex-fast"), false);
		assert.equal((await fastCommand(a, "on extra")).level, "error");
		assert.equal(a.fastStatuses.get("codex-fast"), "codex-fast");
		assert.equal(await shouldStop(a, 900000), false);
		// Saving defaults preserves the other configuration fields.
		await command(a, "default off");
		assert.deepEqual(readConfig(), { guardEnabled: false, guardThreshold: 450000, disable: ["sol-discipline"], unrelated: { keep: "yes" } });
		await command(a, "on");
		await command(a, "threshold 800k");
		await status(a, true, "800,000");
		await status(b, false, "450,000");
		assert.deepEqual(readConfig(), { guardEnabled: false, guardThreshold: 800000, disable: ["sol-discipline"], unrelated: { keep: "yes" } });
		assert.equal(await shouldStop(a, 800000), false);
		assert.equal(await shouldStop(a, 800001), true);
		assert.equal(await shouldStop(b, 900000), false);

		// These are the actual methods called by Pi's /reload and /new UI commands.
		await a.host.session.reload();
		await status(a, false, "800,000");
		assert.equal(a.fastStatuses.has("codex-fast"), false);
		assert.deepEqual(await fastPayload(a), { model: "gpt-5.6-sol", text: { verbosity: "low" } });
		const newPrompt = await beforeStart(a.host.session);
		assert.match(newPrompt.systemPrompt, /## 全局工程底线/);
		assert.match(newPrompt.systemPrompt, /## GPT-5.6 Sol 专项纪律/);
		assert.match((await fastCommand(b, "on")).text, /开启；当前模型：适用/);
		const oldB = b.host.session;
		assert.equal((await b.host.newSession()).cancelled, false);
		assert.notEqual(b.host.session, oldB);
		await status(b, false, "800,000");
		assert.equal(b.fastStatuses.has("codex-fast"), false);
		assert.deepEqual(await fastPayload(b), { model: "gpt-5.6-sol", text: { verbosity: "low" } });
		assert.equal(oldB.agent.createLoopConfig().finishTurn, oldB.agent.finishTurn);

		// default on saves for future initialization while current off stays off.
		await command(a, "default on");
		await status(a, false, "800,000");
		await status(b, false, "800,000");
		const c = await makeHost();
		await status(c, true, "800,000");
		await command(c, "off");
		assert.equal(await shouldStop(c, 900000), false);
		assert.equal(readConfig().guardEnabled, true);
		await command(a, "default off");
		await command(a, "threshold 1.05m");
		await status(a, false, "1,050,000");
		assert.equal(readConfig().guardThreshold, 1050000);
		await status(c, false, "800,000");
		for (const [input, expected] of [["450k", 450000], ["1.001K", 1001], ["900", 900]]) {
			await command(a, `threshold ${input}`);
			assert.equal(readConfig().guardThreshold, expected);
		}
		// Invalid tokens are a documented command boundary; saving must be explicit.
		for (const input of ["0", "-1", "0.1", "1e6", "Infinity", "9007199254740992", "450k extra"]) {
			assert.equal((await command(a, `threshold ${input}`)).at(-1).level, "error");
			assert.equal(readConfig().guardThreshold, 900);
		}

		// External file edits affect neither guard nor discipline on subsequent turns.
		await command(a, "on");
		writeConfig({ guardEnabled: false, guardThreshold: 450000, disable: ["all"] });
		writeFileSync(join(cwd, ".pi/alu-agent.json"), JSON.stringify({ disable: ["all"] }));
		for (let i = 0; i < 2; i++) {
			const result = await beforeStart(a.host.session);
			assert.match(result.systemPrompt, /## 全局工程底线/);
			assert.match(result.systemPrompt, /## GPT-5.6 Sol 专项纪律/);
		}
		await status(a, true, "900");
		assert.equal(await shouldStop(a, 901), true);
		await a.host.newSession();
		await status(a, false, "450,000");
		const result = await beforeStart(a.host.session);
		assert.equal(result, undefined);

		// Exercise the actual 0.99 AgentSession loop, summarizer, projection rebuild,
		// queued messages and sendMessage-triggered continuation. Only provider I/O is fake.
		const { AssistantMessageEventStream } = await import(pathToFileURL(join(piRoot, "../pi-ai/dist/utils/event-stream.js")));
		writeConfig({ guardEnabled: true, guardThreshold: 900 });
		const d = await makeHost();
		d.host.services.settingsManager.setCompactionEnabled(false);
		const run = async (queue) => {
			await d.host.session.reload();
			const session = d.host.session;
			// Force a real manual compaction cut point while keeping native auto-compaction off.
			d.host.services.settingsManager.getCompactionSettings = () => ({ enabled: false, reserveTokens: 1024, keepRecentTokens: 1 });
			session.sessionManager.appendMessage({ role: "user", content: "earlier task", timestamp: Date.now() });
			session.sessionManager.appendMessage(message("gpt-5.6-sol", 20, false));
			const seen = [];
			let summaries = 0;
			const outputs = [message("gpt-5.6-sol", 901), message("gpt-5.6-sol", 20, false)];
			if (queue === "followUp") {
				const followUpReply = message("gpt-5.6-sol", 20, false);
				followUpReply.content = [{ type: "text", text: "finished queued instruction" }];
				outputs.push(followUpReply);
			}
			outputs[1].content = [{ type: "text", text: queue ? "finished queued task" : "finished original task" }];
			session.agent.streamFunction = (_model, ctx) => {
				const summarizing = JSON.stringify(ctx.messages[0]).includes("context summarization assistant");
				let reply;
				if (summarizing) {
					summaries++;
					reply = message("gpt-5.6-sol", 20, false);
					reply.content = [{ type: "text", text: "synthetic compacted task summary" }];
				} else {
					seen.push(ctx);
					reply = outputs.shift();
				}
				assert.ok(reply, "unexpected provider request");
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "start", partial: reply });
				stream.push({ type: "done", reason: reply.stopReason, message: reply });
				return stream;
			};
			let queued = false;
			session.agent.beforeToolCall = async () => {
				if (queue && !queued) {
					queued = true;
					await session[queue]("owner queued instruction");
				}
			};
			let timeout;
			let unsubscribe;
			const done = new Promise((resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("guard loop did not settle")), 5000);
				unsubscribe = session.subscribe((event) => {
					if (event.type === "agent_settled" && outputs.length === 0) resolve();
				});
			});
			try {
				await session.prompt("continue original task");
				await done;
				const branch = session.sessionManager.getBranch();
				assert.equal(session.messages.findLast((m) => m.role === "assistant").stopReason, "stop");
				assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError));
				if (queue) {
					assert.ok(JSON.stringify(seen.at(-1).messages).includes("owner queued instruction"));
					assert.equal(branch.filter((entry) => entry.type === "compaction").length, 0);
				} else {
					assert.ok(branch.some((entry) => entry.type === "compaction" && entry.summary.startsWith("synthetic compacted task summary")), JSON.stringify(d.notifications));
					assert.ok(session.messages.some((m) => m.role === "custom" && m.content.includes("compaction completed")));
					assert.ok(summaries > 0);
					assert.ok(JSON.stringify(seen[1].messages).includes("synthetic compacted task summary"));
				}
			} finally {
				clearTimeout(timeout);
				unsubscribe?.();
			}
		};
		await run();
		await d.host.newSession();
		await run("steer");
		await d.host.newSession();
		await run("followUp");
		console.log("guard loop ok (real Pi 0.99 SDK): finishTurn boundaries, tool execution, default compaction summarizer/session rebuild, automatic continuation, steering/follow-up preserved across reload/new; synthetic provider stream only");

		// Malformed config and a real filesystem write failure report failure, retaining current values.
		writeFileSync(file, "{broken");
		assert.equal((await command(a, "threshold 800k")).at(-1).level, "error");
		assert.equal(readFileSync(file, "utf8"), "{broken");
		await status(a, false, "450,000");
		writeConfig({ guardEnabled: false, guardThreshold: 450000 });
		if (process.getuid?.() === 0) throw new Error("run smoke as a non-root user to exercise filesystem permission failure");
		chmodSync(tempAgentDir, 0o500);
		try {
			assert.equal((await command(a, "default on")).at(-1).level, "error");
			assert.equal((await command(a, "threshold 800k")).at(-1).level, "error");
			assert.deepEqual(readConfig(), { guardEnabled: false, guardThreshold: 450000 });
			await status(a, false, "450,000");
		} finally {
			chmodSync(tempAgentDir, 0o700);
		}
		rmSync(file);
		// Missing configuration can be created by a command without changing the current switch.
		await command(a, "default on");
		assert.deepEqual(readConfig(), { guardEnabled: true });
		await status(a, false, "450,000");
		assert.match((await command(a, "help")).at(-1).text, /\/alu-agent default on\|off/);
		console.log("lifecycle ok (real Pi SDK): /codex-fast request hook and /reload /new memory reset, /alu-agent, alu-agent.json global/project config, A/B isolation, command dispatch/default writes, exact token inputs, no per-turn hot load, /reload and /new reinitialize, save failures, field preservation");
	} finally {
		for (const host of hosts) await host.dispose();
	}
}
