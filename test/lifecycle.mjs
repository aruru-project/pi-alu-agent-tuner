import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Real Pi SDK, command dispatch, resource loader, /new runtime replacement and
// /reload lifecycle. Model lookup and UI are substitutes; no credentials or LLM calls.
export async function runLifecycle({ piRoot, tempAgentDir, extensionPath, turn, message }) {
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
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const factory = async (options) => {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd, agentDir: tempAgentDir, settingsManager,
			additionalExtensionPaths: [extensionPath],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = { getModel: () => model };
		const result = await createAgentSession({ ...options, settingsManager, resourceLoader, modelRuntime, model, tools: [] });
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
	const shouldStop = (runtime, tokens) => runtime.host.session.agent.createLoopConfig()
		.shouldStopAfterTurn(turn(message("gpt-5.6-sol", tokens)));
	try {
		// User's A/B example: local switches and threshold writes affect only A.
		const a = await makeHost();
		const b = await makeHost();
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
		const newPrompt = await a.host.session.extensionRunner.emitBeforeAgentStart("hello", undefined, "base prompt");
		assert.match(newPrompt.systemPrompt, /## 全局工程底线/);
		assert.match(newPrompt.systemPrompt, /## GPT-5.6 Sol 专项纪律/);
		assert.match((await fastCommand(b, "on")).text, /开启；当前模型：适用/);
		const oldB = b.host.session;
		assert.equal((await b.host.newSession()).cancelled, false);
		assert.notEqual(b.host.session, oldB);
		await status(b, false, "800,000");
		assert.equal(b.fastStatuses.has("codex-fast"), false);
		assert.deepEqual(await fastPayload(b), { model: "gpt-5.6-sol", text: { verbosity: "low" } });
		assert.equal(oldB.agent.createLoopConfig().shouldStopAfterTurn, undefined);

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
			const result = await a.host.session.extensionRunner.emitBeforeAgentStart("hello", undefined, "base prompt");
			assert.match(result.systemPrompt, /## 全局工程底线/);
			assert.match(result.systemPrompt, /## GPT-5.6 Sol 专项纪律/);
		}
		await status(a, true, "900");
		assert.equal(await shouldStop(a, 901), true);
		await a.host.newSession();
		await status(a, false, "450,000");
		const result = await a.host.session.extensionRunner.emitBeforeAgentStart("hello", undefined, "base prompt");
		assert.equal(result, undefined);

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
