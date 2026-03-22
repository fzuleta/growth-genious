import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import {
	buildBotBranchName,
	checkoutBranch,
	commitAll,
	createBranch,
	deleteBranch,
	discardAllChanges,
	ensureCleanWorktree,
	getCurrentBranch,
	getDiffStat,
	hasUncommittedChanges,
} from "./helpers/git";
import { logInfo, logWarn, logError } from "./helpers/log";
import { createOpenAIClient } from "./openai/openai";
import { readOptionalContextMarkdown } from "./context-service";
import {
	appendSelfModifyToolCall,
	createSelfModifySession,
	getActiveSelfModifySession,
	getSelfModifySessionById,
	updateSelfModifyState,
	type SelfModifySessionDocument,
	type SelfModifyToolCall,
} from "./db/self-modify-mongo";
import { buildChatSessionKey, type SmediaMongoDatabase } from "./db/mongo";
import {
	PLANNING_TOOLS,
	EXECUTION_TOOLS,
	executeToolCall,
} from "./self-modify-tools";

const MAX_PLANNING_ITERATIONS = 25;
const MAX_EXECUTION_ITERATIONS = 40;
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

interface ShellCommandResult {
	success: boolean;
	output: string;
	exitCode: number | null;
}

function getAgentModel(): string {
	return process.env.OPENAI_AGENT_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4o";
}

// ── Public API ──

export interface SelfModifyStartInput {
	database: SmediaMongoDatabase;
	pluginId: string;
	guildId: string;
	channelId: string;
	userId: string;
	username: string;
	intent: string;
}

export interface SelfModifyResult {
	plan?: string;
	summary?: string;
	error?: string;
	session: SelfModifySessionDocument;
}

export async function startSelfModifySession(input: SelfModifyStartInput): Promise<SelfModifyResult> {
	const sessionKey = buildChatSessionKey({
		pluginId: input.pluginId,
		guildId: input.guildId,
		channelId: input.channelId,
	});

	const existing = await getActiveSelfModifySession(input.database, input.pluginId, input.channelId);
	if (existing) {
		return {
			error: `There is already an active self-modify session (${existing.sessionId}, state=${existing.state}). Cancel it first or wait for it to complete.`,
			session: existing,
		};
	}

	await ensureCleanWorktree();

	const originalBranch = await getCurrentBranch();
	const branchName = buildBotBranchName(input.intent.slice(0, 30));

	await createBranch(branchName);
	logInfo("Self-modify: created git branch", { branch: branchName, originalBranch });

	let session: SelfModifySessionDocument | null = null;
	try {
		session = await createSelfModifySession(input.database, {
			pluginId: input.pluginId,
			sessionId: randomUUID(),
			sessionKey,
			guildId: input.guildId,
			channelId: input.channelId,
			userId: input.userId,
			username: input.username,
			intent: input.intent,
			gitBranch: branchName,
			originalBranch,
		});

		const plan = await runPlanningLoop(input.database, session);
		return { plan, session };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (session) {
			await revertAndFail(input.database, session, message);
		} else {
			await abandonBotBranch({ originalBranch, gitBranch: branchName });
		}
		throw error;
	}
}

export async function cancelSelfModifySession(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<void> {
	await updateSelfModifyState(database, session.sessionId, "cancelled");
	await abandonBotBranch(session);
}

export async function replanExistingSession(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<SelfModifyResult> {
	await updateSelfModifyState(database, session.sessionId, "planning");
	const latestSession = await getSelfModifySessionById(database, session.sessionId);
	if (!latestSession) {
		throw new Error(`Self-modify session not found: ${session.sessionId}`);
	}

	const plan = await runPlanningLoop(database, latestSession);
	return { plan, session: latestSession };
}

export async function resumeAfterApproval(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<SelfModifyResult> {
	await updateSelfModifyState(database, session.sessionId, "executing");

	try {
		const summary = await runExecutionLoop(database, session);
		return { summary, session };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		await revertAndFail(database, session, message);
		return { error: message, session };
	}
}

export async function buildAndRestart(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<{ success: boolean; output: string }> {
	await updateSelfModifyState(database, session.sessionId, "building");

	const buildResult = await runShellCommand("npm", ["run", "build"]);
	await updateSelfModifyState(database, session.sessionId, "building", { buildOutput: buildResult.output });

	if (!buildResult.success) {
		await revertAndFail(database, session, `Build failed:\n${buildResult.output}`);
		return { success: false, output: buildResult.output };
	}

	if (session.originalBranch) {
		await commitAll(`bot: ${session.intent}`);
	}

	await updateSelfModifyState(database, session.sessionId, "restarting");

	return { success: true, output: buildResult.output };
}

export async function triggerVeilRestart(): Promise<string> {
	const result = await runShellCommand("tsx", [path.join(WORKSPACE_ROOT, "src", "growth.ts"), "restart"]);
	if (!result.success) {
		throw new Error(result.output || "veil restart failed");
	}

	return result.output;
}

export async function checkPostRestartSessions(
	database: SmediaMongoDatabase,
	pluginId: string,
): Promise<SelfModifySessionDocument[]> {
	const { getRestartingSessions } = await import("./db/self-modify-mongo");
	const sessions = await getRestartingSessions(database, pluginId);
	for (const session of sessions) {
		await updateSelfModifyState(database, session.sessionId, "completed");
	}
	return sessions;
}

// ── Planning loop ──

async function runPlanningLoop(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<string> {
	const model = getAgentModel();
	const contextMarkdown = await readOptionalContextMarkdown();
	const conversationItems: ResponseInputItem[] = buildPlanningSystemPrompt(session, contextMarkdown);

	const client = createOpenAIClient();
	let plan: string | null = null;

	for (let i = 0; i < MAX_PLANNING_ITERATIONS; i++) {
		logInfo("Self-modify: planning iteration", {
			sessionId: session.sessionId,
			iteration: i + 1,
			model,
		});

		const response = await client.responses.create({
			model,
			input: conversationItems,
			tools: PLANNING_TOOLS,
		});

		const functionCalls = response.output.filter(
			(item): item is typeof item & { type: "function_call" } => item.type === "function_call",
		);

		if (functionCalls.length === 0) {
			plan = response.output_text.trim();
			break;
		}

		for (const call of response.output) {
			conversationItems.push(call as unknown as ResponseInputItem);
		}

		for (const call of functionCalls) {
			const args = JSON.parse(call.arguments) as Record<string, unknown>;
			const result = await executeToolCall(call.name, args);

			const toolCallDoc: SelfModifyToolCall = {
				tool: call.name,
				args,
				result: result.output.slice(0, 2000),
				phase: "planning",
				createdAt: new Date(),
			};
			await appendSelfModifyToolCall(database, session.sessionId, toolCallDoc, "planning");

			conversationItems.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.output,
			} as unknown as ResponseInputItem);

			if (result.isTerminal && result.terminalPayload) {
				plan = result.terminalPayload;
				break;
			}
		}

		if (plan) break;
	}

	if (!plan) {
		plan = "Planning loop exhausted max iterations without producing a plan.";
	}

	await updateSelfModifyState(database, session.sessionId, "awaiting-approval", { plan });
	return plan;
}

// ── Execution loop ──

async function runExecutionLoop(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
): Promise<string> {
	const model = getAgentModel();
	const conversationItems: ResponseInputItem[] = buildExecutionSystemPrompt(session);

	const client = createOpenAIClient();
	let summary: string | null = null;
	const filesChanged = new Set<string>();

	for (let i = 0; i < MAX_EXECUTION_ITERATIONS; i++) {
		logInfo("Self-modify: execution iteration", {
			sessionId: session.sessionId,
			iteration: i + 1,
			model,
		});

		const response = await client.responses.create({
			model,
			input: conversationItems,
			tools: EXECUTION_TOOLS,
		});

		const functionCalls = response.output.filter(
			(item): item is typeof item & { type: "function_call" } => item.type === "function_call",
		);

		if (functionCalls.length === 0) {
			summary = response.output_text.trim();
			break;
		}

		for (const call of response.output) {
			conversationItems.push(call as unknown as ResponseInputItem);
		}

		for (const call of functionCalls) {
			const args = JSON.parse(call.arguments) as Record<string, unknown>;
			const result = await executeToolCall(call.name, args);

			if (call.name === "write_file" || call.name === "edit_file") {
				const filePath = args.path as string;
				if (filePath) filesChanged.add(filePath);
			}

			const toolCallDoc: SelfModifyToolCall = {
				tool: call.name,
				args,
				result: result.output.slice(0, 2000),
				phase: "executing",
				createdAt: new Date(),
			};
			await appendSelfModifyToolCall(database, session.sessionId, toolCallDoc, "executing");

			conversationItems.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.output,
			} as unknown as ResponseInputItem);

			if (result.isTerminal && result.terminalPayload) {
				summary = result.terminalPayload;
				break;
			}
		}

		if (summary) break;
	}

	if (!summary) {
		summary = "Execution loop completed max iterations.";
	}

	await updateSelfModifyState(database, session.sessionId, "executing", {
		filesChanged: Array.from(filesChanged),
	});

	return summary;
}

// ── System prompts ──

function buildPlanningSystemPrompt(
	session: SelfModifySessionDocument,
	contextMarkdown: string | null,
): ResponseInputItem[] {
	const items: ResponseInputItem[] = [
		{
			role: "system",
			content: [
				{
					type: "input_text",
					text: [
						"You are an expert coding agent that modifies the growth-genius codebase.",
						"Your task is to explore the repository and produce a detailed implementation plan.",
						"Use the provided tools to read files, list directories, and search the codebase.",
						"When you have enough understanding, call submit_plan with a detailed markdown plan.",
						"The plan must include: what files to create/modify, what changes to make, and why.",
						"Be thorough in your exploration — understand existing patterns before proposing changes.",
						"The workspace root is a TypeScript project using tsx for development and tsc for builds.",
						"Key directories: src/ (source), workspace-template/ (workspace guidance), and top-level docs such as README.md.",
						"Do not make any changes yet — this is the planning phase only.",
					].join(" "),
				},
			],
		},
	];

	if (contextMarkdown) {
		items.push({
			role: "system",
			content: [
				{
					type: "input_text",
					text: `Project context:\n\n${contextMarkdown}`,
				},
			],
		});
	}

	const feedbackBlock = session.feedback.length > 0
		? `\n\nPrevious feedback from the user:\n${session.feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
		: "";

	items.push({
		role: "user",
		content: [
			{
				type: "input_text",
				text: `Please implement the following:\n\n${session.intent}${feedbackBlock}`,
			},
		],
	});

	return items;
}

function buildExecutionSystemPrompt(session: SelfModifySessionDocument): ResponseInputItem[] {
	const items: ResponseInputItem[] = [
		{
			role: "system",
			content: [
				{
					type: "input_text",
					text: [
						"You are an expert coding agent executing an approved implementation plan.",
						"Use the provided tools to read, write, and edit files in the codebase.",
						"Follow the plan precisely. When all changes are complete, call the done tool.",
						"Write clean, idiomatic TypeScript. Match existing codestyle (tabs, semicolons, etc).",
						"The workspace root is a TypeScript project. Build with npm run build (tsc).",
						"After making all file changes, call done with a summary of what was changed.",
					].join(" "),
				},
			],
		},
	];

	items.push({
		role: "user",
		content: [
			{
				type: "input_text",
				text: `Original request: ${session.intent}\n\nApproved plan:\n\n${session.plan}`,
			},
		],
	});

	return items;
}

// ── Helpers ──

async function revertAndFail(
	database: SmediaMongoDatabase,
	session: SelfModifySessionDocument,
	errorMessage: string,
): Promise<void> {
	logError("Self-modify: reverting due to failure", {
		sessionId: session.sessionId,
		error: errorMessage,
	});

	try {
		await abandonBotBranch(session);
	} catch (revertError: unknown) {
		logWarn("Self-modify: git revert also failed", {
			sessionId: session.sessionId,
			message: revertError instanceof Error ? revertError.message : String(revertError),
		});
	}

	await updateSelfModifyState(database, session.sessionId, "failed", { errorMessage });
}

async function abandonBotBranch(input: {
	originalBranch: string | null;
	gitBranch: string | null;
}): Promise<void> {
	if (!input.originalBranch) {
		return;
	}

	const hasChanges = await hasUncommittedChanges();
	if (hasChanges) {
		await discardAllChanges();
	}

	await checkoutBranch(input.originalBranch);
	if (input.gitBranch) {
		await deleteBranch(input.gitBranch);
	}
}

function runShellCommand(binary: string, args: string[]): Promise<ShellCommandResult> {
	return new Promise((resolve) => {
		execFile(
			binary,
			args,
			{ cwd: WORKSPACE_ROOT, maxBuffer: 1024 * 1024, timeout: 120_000 },
			(error, stdout, stderr) => {
				const output = [stdout.toString().trim(), stderr.toString().trim()].filter(Boolean).join("\n");
				const exitCode = typeof error?.code === "number" ? error.code : null;
				resolve({
					success: !error,
					output: error ? `EXIT ${error.code ?? "unknown"}:\n${output}` : output,
					exitCode,
				});
			},
		);
	});
}
