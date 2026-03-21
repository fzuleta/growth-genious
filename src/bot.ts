import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

import {
	Client,
	GatewayIntentBits,
	type Message,
} from "discord.js";
import { generateChatReply } from "./chat-service";
import { retrieveDbRouteEvidence } from "./chat-db-query-service";
import { classifyChatRoute } from "./chat-router-service";
import {
	appendGenerationJobEvent,
	appendChatMessage,
	buildChatSessionKey,
	createOpenAiDebugInput,
	createGenerationJob,
	getGenerationJobById,
	initializeMongoDatabase,
	listRecentGenerationJobs,
	type ChatMessageKind,
	type GenerationJobDocument,
	type SmediaMongoDatabase,
	updateGenerationJob,
} from "./db/mongo";
import { runChatMemoryConsolidationCycle, formatMemoryInspect } from "./chat-memory-service";
import {
	runGenerationJob,
	isPostType,
	type GenerationJobInput,
	type GenerationJobProgressEvent,
	type GenerationJobResult,
} from "./generation-service";
import { assertValidModelId, getGameAssetsDir } from "./helpers/game-assets";
import { logError, logInfo, logWarn } from "./helpers/log";
import { retrieveWorkspaceRouteEvidence } from "./workspace-context-service";
import type { PostType } from "./types";
import { runCodeAnalysis } from "./code-analysis-service";
import {
	getActiveSelfModifySession,
	appendSelfModifyFeedback,
	updateSelfModifyState,
	ensureSelfModifyIndexes,
} from "./db/self-modify-mongo";
import {
	startSelfModifySession,
	resumeAfterApproval,
	replanExistingSession,
	buildAndRestart,
	cancelSelfModifySession,
	triggerVeilRestart,
	checkPostRestartSessions,
} from "./self-modify-service";


const BOT_COMMAND_PREFIX = "/createpost";
const JOB_STATUS_COMMAND_PREFIX = "/jobstatus";
const FAILED_JOBS_COMMAND_PREFIX = "/failedjobs";
const STATUS_COMMAND_PREFIX = "/status";
const MEMORY_REFRESH_COMMAND_PREFIX = "/refreshmemory";
const MEMORY_INSPECT_COMMAND_PREFIX = "/memory";
const DEFAULT_MAX_QUEUE_LENGTH = 10;
const DISCORD_MESSAGE_LIMIT = 2000;
const CHAT_DEBOUNCE_MS = 1500;
const MEMORY_CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_FAILED_JOBS_LIMIT = 5;
const MAX_FAILED_JOBS_LIMIT = 10;
const GAME_ASSETS_DIR = getGameAssetsDir();

interface CreatePostCommand {
	modelId?: string;
	postType?: PostType;
}

interface JobStatusCommand {
	jobId?: string;
	latest: boolean;
}

interface FailedJobsCommand {
	limit: number;
}

interface QueuedJob {
	id: string;
	request: GenerationJobInput;
	message: Message;
	requestedAt: string;
}

const botKey = process.env.DISCORD_BOT_KEY?.trim();
if (!botKey) {
	throw new Error("Missing DISCORD_BOT_KEY. The Discord bot cannot start without it.");
}

const commandUserId = process.env.DISCORD_FELI_ID?.trim();
if (!commandUserId) {
	throw new Error("Missing DISCORD_FELI_ID. Bot commands are restricted and require this user ID.");
}

const allowedChannelIds = readAllowedChannelIds(process.env);
const maxQueueLength = readMaxQueueLength(process.env.DISCORD_MAX_QUEUE_LENGTH);
let mongoDatabase: SmediaMongoDatabase | null = null;
let shutdownPromise: Promise<void> | null = null;
let memoryConsolidationTimer: NodeJS.Timeout | null = null;
const chatDebounceTimers = new Map<string, { timer: NodeJS.Timeout; messages: Message[] }>();
let memoryConsolidationPromise: Promise<{
	processedSessionCount: number;
	updatedShortTermCount: number;
	updatedLongTermCount: number;
	parsedChatMessageCount: number;
	skippedSessionCount: number;
} | null> | null = null;

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

client.once("ready", () => {
	logInfo("Discord createpost bot connected", {
		botUser: client.user?.tag ?? null,
		allowedChannelIds: Array.from(allowedChannelIds),
		commandUserId,
		maxQueueLength,
		freeTalkOpenAiDebugEnabled: readBooleanEnv(process.env.DEBUG_FREETALK_OPENAI_INPUTS),
	});
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.inGuild()) {
		return;
	}

	if (!mongoDatabase) {
		logWarn("Ignoring Discord message because MongoDB is not ready", {
			messageId: message.id,
			channelId: message.channelId,
			userId: message.author.id,
		});
		return;
	}

	const content = message.content.trim();
	if (!content) {
		return;
	}

	if (allowedChannelIds.size > 0 && !allowedChannelIds.has(message.channelId)) {
		logWarn("Ignored createpost command from unauthorized channel", {
			channelId: message.channelId,
			messageId: message.id,
			userId: message.author.id,
		});
		return;
	}

	if (isBotCommand(content) && message.author.id !== commandUserId) {
		logWarn("Ignored restricted bot command from unauthorized user", {
			channelId: message.channelId,
			messageId: message.id,
			userId: message.author.id,
			content,
		});
		return;
	}

	if (content.startsWith(BOT_COMMAND_PREFIX)) {
		await persistInboundDiscordMessage(mongoDatabase, message, "command");
		try {
			const command = parseCreatePostCommand(content);
			if (command.modelId) {
				await assertValidModelId(GAME_ASSETS_DIR, command.modelId);
			}

			const queueState = await jobQueue.enqueue({
				request: command,
				message,
			});
			await createGenerationJob(mongoDatabase, {
				jobId: queueState.jobId,
				source: "discord",
				guildId: message.guildId,
				channelId: message.channelId,
				requestMessageId: message.id,
				requestedByUserId: message.author.id,
				requestedByUsername: message.author.username,
				request: {
					modelId: command.modelId ?? null,
					postType: command.postType ?? null,
					s3FolderPath: null,
					caption: null,
					mode: null,
				},
				createdAt: message.createdAt,
			});

			await replyToMessage(
				mongoDatabase,
				message,
				queueState.startsImmediately
					? `Accepted jobId=${queueState.jobId} ${formatCommandSummary(command)}. Starting now.`
					: `Accepted jobId=${queueState.jobId} ${formatCommandSummary(command)}. Queued at position ${queueState.queuePosition}.`,
				"command",
			);
		} catch (error: unknown) {
			const messageText = error instanceof Error ? error.message : String(error);
			await replyToMessage(
				mongoDatabase,
				message,
				`Rejected createpost command: ${messageText}`,
				"command",
			);
		}
		return;
	}

	if (content === STATUS_COMMAND_PREFIX) {
		await persistInboundDiscordMessage(mongoDatabase, message, "status");
		await replyToMessage(
			mongoDatabase,
			message,
			formatQueueStatus(jobQueue.getSnapshot()),
			"status",
		);
		return;
	}

	if (content.startsWith(JOB_STATUS_COMMAND_PREFIX)) {
		await persistInboundDiscordMessage(mongoDatabase, message, "status");
		try {
			const command = parseJobStatusCommand(content);
			const job = command.jobId
				? await getGenerationJobById(mongoDatabase, command.jobId)
				: await getLatestRequestedGenerationJob(mongoDatabase, message);

			if (!job) {
				await replyToMessage(
					mongoDatabase,
					message,
					command.jobId
						? `No generation job found for jobId=${command.jobId}.`
						: "No recent generation jobs found for you in this channel.",
					"status",
				);
				return;
			}

			await replyToMessage(
				mongoDatabase,
				message,
				formatGenerationJobStatus(job),
				"status",
			);
		} catch (error: unknown) {
			const messageText = error instanceof Error ? error.message : String(error);
			await replyToMessage(
				mongoDatabase,
				message,
				`Failed to inspect job status: ${messageText}`,
				"status",
			);
		}
		return;
	}

	if (content.startsWith(FAILED_JOBS_COMMAND_PREFIX)) {
		await persistInboundDiscordMessage(mongoDatabase, message, "status");
		try {
			const command = parseFailedJobsCommand(content);
			const failedJobs = await listRecentGenerationJobs(mongoDatabase, {
				requestedByUserId: message.author.id,
				guildId: message.guildId ?? undefined,
				channelId: message.channelId,
				statuses: ["failed"],
				limit: command.limit,
			});

			await replyToMessage(
				mongoDatabase,
				message,
				formatFailedJobsStatus(failedJobs, command.limit),
				"status",
			);
		} catch (error: unknown) {
			const messageText = error instanceof Error ? error.message : String(error);
			await replyToMessage(
				mongoDatabase,
				message,
				`Failed to inspect failed jobs: ${messageText}`,
				"status",
			);
		}
		return;
	}

	if (content === MEMORY_REFRESH_COMMAND_PREFIX) {
		await persistInboundDiscordMessage(mongoDatabase, message, "command");
		const refreshReply = await runManualMemoryConsolidation();
		await replyToMessage(
			mongoDatabase,
			message,
			refreshReply,
			"command",
		);
		return;
	}

	if (content === MEMORY_INSPECT_COMMAND_PREFIX) {
		await persistInboundDiscordMessage(mongoDatabase, message, "command");
		try {
			const inspectReply = await formatMemoryInspect({
				database: mongoDatabase,
				sessionKey: buildChatSessionKey({
					guildId: message.guildId as string,
					channelId: message.channelId,
				}),
				userId: message.author.id,
			});
			await replyToMessage(
				mongoDatabase,
				message,
				inspectReply,
				"command",
			);
		} catch (error: unknown) {
			const messageText = error instanceof Error ? error.message : String(error);
			await replyToMessage(
				mongoDatabase,
				message,
				`Failed to inspect memory: ${messageText}`,
				"command",
			);
		}
		return;
	}

	// Self-modify session interception: check if there's an active session awaiting approval
	if (message.author.id === commandUserId) {
		try {
			const activeSession = await getActiveSelfModifySession(mongoDatabase, message.channelId);
			if (activeSession && activeSession.state === "awaiting-approval") {
				const normalized = content.trim().toLowerCase();
				if (/^(approve|go|yes|lgtm|do it|go ahead|ship it)$/i.test(normalized)) {
					await persistInboundDiscordMessage(mongoDatabase, message, "command");
					await handleSelfModifyApproval(mongoDatabase, message, activeSession);
					return;
				}
				if (/^(cancel|no|stop|abort|nevermind)$/i.test(normalized)) {
					await persistInboundDiscordMessage(mongoDatabase, message, "command");
					await handleSelfModifyCancel(mongoDatabase, message, activeSession);
					return;
				}
				// Treat as feedback — re-plan with user input
				await persistInboundDiscordMessage(mongoDatabase, message, "chat");
				await handleSelfModifyFeedback(mongoDatabase, message, activeSession, content);
				return;
			}
		} catch (error: unknown) {
			logWarn("Self-modify session check failed", {
				channelId: message.channelId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	enqueueDebouncedChat(mongoDatabase, message);
});

function enqueueDebouncedChat(database: SmediaMongoDatabase, message: Message): void {
	const channelKey = `${message.guildId}:${message.channelId}:${message.author.id}`;
	const existing = chatDebounceTimers.get(channelKey);
	if (existing) {
		clearTimeout(existing.timer);
		existing.messages.push(message);
	} else {
		chatDebounceTimers.set(channelKey, { timer: null as unknown as NodeJS.Timeout, messages: [message] });
	}

	const entry = chatDebounceTimers.get(channelKey)!;
	entry.timer = setTimeout(() => {
		chatDebounceTimers.delete(channelKey);
		void flushDebouncedChat(database, entry.messages);
	}, CHAT_DEBOUNCE_MS);
}

async function flushDebouncedChat(database: SmediaMongoDatabase, messages: Message[]): Promise<void> {
	const lastMessage = messages[messages.length - 1]!;
	const combinedContent = messages.map((m) => m.content.trim()).join("\n");
	const sessionKey = buildChatSessionKey({
		guildId: lastMessage.guildId!,
		channelId: lastMessage.channelId,
	});

	try {
		const classification = await classifyChatRoute({
			content: combinedContent,
			channelId: lastMessage.channelId,
			username: lastMessage.author.username,
		});
		const routeDecision = classification.decision;

		if (readBooleanEnv(process.env.DEBUG_FREETALK_OPENAI_INPUTS)) {
			await persistRouterOpenAiDebugInput({
				database,
				sessionKey,
				guildId: lastMessage.guildId!,
				channelId: lastMessage.channelId,
				userId: lastMessage.author.id,
				username: lastMessage.author.username,
				discordMessageId: lastMessage.id,
				model: classification.model,
				promptInput: classification.promptInput,
				decision: routeDecision,
			});
		}

		const routeEvidence = routeDecision.route === "db-query"
			? await retrieveDbRouteEvidence({
				database,
				sessionKey,
				guildId: lastMessage.guildId!,
				channelId: lastMessage.channelId,
				userId: lastMessage.author.id,
				decision: routeDecision,
			})
			: routeDecision.route === "workspace-question"
				? await retrieveWorkspaceRouteEvidence({
					decision: routeDecision,
					content: combinedContent,
				})
				: null;

		logInfo("Debounced chat route selected", {
			channelId: lastMessage.channelId,
			userId: lastMessage.author.id,
			route: routeDecision.route,
			confidence: routeDecision.confidence,
			subject: routeDecision.subject,
			evidenceCount: routeEvidence?.snippets.length ?? 0,
		});

		// Self-modify route: start agentic code modification session
		if (routeDecision.route === "self-modify" && lastMessage.author.id === commandUserId) {
			await persistInboundChatContent(database, lastMessage, combinedContent);
			await handleSelfModifyStart(database, lastMessage, combinedContent);
			return;
		}

		if (routeDecision.route === "code-analysis" && lastMessage.author.id === commandUserId) {
			await persistInboundChatContent(database, lastMessage, combinedContent);
			await handleCodeAnalysis(database, lastMessage, combinedContent);
			return;
		}

		// If self-modify was routed but user is not authorized, downgrade to conversation
		if (routeDecision.route === "self-modify" || routeDecision.route === "code-analysis") {
			routeDecision.route = "conversation";
			routeDecision.reason = `${routeDecision.reason ?? "unknown"}+restricted-route-unauthorized`;
		}

		const reply = await generateChatReply({
			database,
			guildId: lastMessage.guildId!,
			channelId: lastMessage.channelId,
			userId: lastMessage.author.id,
			username: lastMessage.author.username,
			discordMessageId: lastMessage.id,
			content: combinedContent,
			routeDecision,
			routeEvidence,
		});
		await replyToMessage(
			database,
			lastMessage,
			reply,
			"chat",
		);
	} catch (error: unknown) {
		const messageText = error instanceof Error ? error.message : String(error);
		await replyToMessage(
			database,
			lastMessage,
			`I hit an error while answering: ${messageText}`,
			"chat",
		);
	}
}

async function handleCodeAnalysis(
	database: SmediaMongoDatabase,
	message: Message,
	request: string,
): Promise<void> {
	await replyToMessage(database, message, "Analyzing the codebase and preparing recommendations...", "chat");

	try {
		const analysis = await runCodeAnalysis({
			request,
			username: message.author.username,
			channelId: message.channelId,
		});

		await replyToMessage(database, message, analysis, "chat");
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logError("Code analysis failed", { channelId: message.channelId, error: errorMessage });
		await replyToMessage(database, message, `Code analysis failed: ${errorMessage}`, "chat");
	}
}

// ── Self-modify handlers ──

async function handleSelfModifyStart(
	database: SmediaMongoDatabase,
	message: Message,
	intent: string,
): Promise<void> {
	await replyToMessage(database, message, "Starting self-modify session... I'll explore the codebase and build a plan.", "chat");

	try {
		const result = await startSelfModifySession({
			database,
			guildId: message.guildId!,
			channelId: message.channelId,
			userId: message.author.id,
			username: message.author.username,
			intent,
		});

		if (result.error) {
			await replyToMessage(database, message, result.error, "chat");
			return;
		}

		if (result.plan) {
			const planMessage = [
				"**Implementation Plan**",
				"",
				result.plan,
				"",
				"---",
				"Reply **approve** to execute, **cancel** to abort, or provide feedback to revise the plan.",
			].join("\n");
			await replyToMessage(database, message, planMessage, "chat");
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logError("Self-modify start failed", { channelId: message.channelId, error: errorMessage });
		await replyToMessage(database, message, `Self-modify failed: ${errorMessage}`, "chat");
	}
}

async function handleSelfModifyApproval(
	database: SmediaMongoDatabase,
	message: Message,
	session: Awaited<ReturnType<typeof getActiveSelfModifySession>> & {},
): Promise<void> {
	await replyToMessage(database, message, "Approved. Executing the plan now...", "chat");

	try {
		const execResult = await resumeAfterApproval(database, session);
		if (execResult.error) {
			await replyToMessage(database, message, `Execution failed: ${execResult.error}`, "chat");
			return;
		}

		await replyToMessage(database, message, `Changes applied:\n${execResult.summary}\n\nBuilding...`, "chat");

		const buildResult = await buildAndRestart(database, session);
		if (!buildResult.success) {
			await replyToMessage(database, message, `Build failed. Changes reverted.\n\`\`\`\n${buildResult.output.slice(0, 1500)}\n\`\`\``, "chat");
			return;
		}

		await replyToMessage(database, message, "Build succeeded. Restarting via veil...", "chat");

		try {
			await triggerVeilRestart();
		} catch {
			await replyToMessage(database, message, "Build succeeded but veil restart failed. You may need to restart manually.", "chat");
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logError("Self-modify execution failed", { channelId: message.channelId, error: errorMessage });
		await replyToMessage(database, message, `Self-modify execution failed: ${errorMessage}`, "chat");
	}
}

async function handleSelfModifyCancel(
	database: SmediaMongoDatabase,
	message: Message,
	session: Awaited<ReturnType<typeof getActiveSelfModifySession>> & {},
): Promise<void> {
	try {
		await cancelSelfModifySession(database, session);
		await replyToMessage(database, message, "Self-modify session cancelled. Branch reverted.", "chat");
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await replyToMessage(database, message, `Cancel failed: ${errorMessage}`, "chat");
	}
}

async function handleSelfModifyFeedback(
	database: SmediaMongoDatabase,
	message: Message,
	session: Awaited<ReturnType<typeof getActiveSelfModifySession>> & {},
	feedback: string,
): Promise<void> {
	await replyToMessage(database, message, "Got your feedback. Re-planning...", "chat");

	try {
		await appendSelfModifyFeedback(database, session.sessionId, feedback);
		const result = await replanExistingSession(database, session);

		if (result.plan) {
			const planMessage = [
				"**Revised Plan**",
				"",
				result.plan,
				"",
				"---",
				"Reply **approve** to execute, **cancel** to abort, or provide more feedback.",
			].join("\n");
			await replyToMessage(database, message, planMessage, "chat");
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await replyToMessage(database, message, `Re-planning failed: ${errorMessage}`, "chat");
	}
}

async function handlePostRestartSessions(database: SmediaMongoDatabase): Promise<void> {
	try {
		const sessions = await checkPostRestartSessions(database);
		for (const session of sessions) {
			const channel = client.channels.cache.get(session.channelId);
			if (channel && "send" in channel) {
				await channel.send({
					content: `I'm back! Self-modify session **${session.sessionId}** completed. The changes from "${session.intent}" are live.`,
					allowedMentions: { parse: [] },
				});
			}
		}
	} catch (error: unknown) {
		logWarn("Post-restart session check failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function persistRouterOpenAiDebugInput(input: {
	database: SmediaMongoDatabase;
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId: string;
	username: string;
	discordMessageId: string;
	model: string;
	promptInput: unknown[];
	decision: {
		route: string;
		confidence: string;
		subject: string;
		requestedSources: string[];
		reason?: string;
		entityHints: {
			jobId?: string;
			modelId?: string;
			fileHint?: string;
			topicKeywords: string[];
		};
	};
}): Promise<void> {
	const promptItems = input.promptInput.flatMap((item) => {
		if (typeof item !== "object" || item === null || !("role" in item) || !("content" in item)) {
			return [];
		}

		const role = item.role;
		const content = item.content;
		if ((role !== "system" && role !== "user" && role !== "assistant") || !Array.isArray(content)) {
			return [];
		}

		const text = content
			.flatMap((entry) => {
				if (typeof entry !== "object" || entry === null || !("text" in entry)) {
					return [];
				}

				const value = entry.text;
				return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
			})
			.join("\n\n");

		return text.length > 0 ? [{ role: role as "user" | "assistant" | "system", text }] : [];
	});

	if (promptItems.length === 0) {
		return;
	}

	const promptText = promptItems.map((item) => `[${item.role}] ${item.text}`).join("\n\n");

	try {
		await createOpenAiDebugInput(input.database, {
			source: "router",
			sessionKey: input.sessionKey,
			guildId: input.guildId,
			channelId: input.channelId,
			userId: input.userId,
			username: input.username,
			discordMessageId: input.discordMessageId,
			model: input.model,
			promptText,
			promptItems,
			metadata: {
				route: input.decision.route,
				confidence: input.decision.confidence,
				subject: input.decision.subject,
				requestedSources: input.decision.requestedSources,
				reason: input.decision.reason ?? null,
				jobId: input.decision.entityHints.jobId ?? null,
				modelId: input.decision.entityHints.modelId ?? null,
				fileHint: input.decision.entityHints.fileHint ?? null,
				topicKeywords: input.decision.entityHints.topicKeywords,
			},
		});
		logInfo("Persisted router OpenAI debug input", {
			sessionKey: input.sessionKey,
			channelId: input.channelId,
			userId: input.userId,
			model: input.model,
			route: input.decision.route,
			confidence: input.decision.confidence,
			promptItemsCount: promptItems.length,
			promptLength: promptText.length,
		});
	} catch (error: unknown) {
		logWarn("Failed to persist router OpenAI debug input", {
			sessionKey: input.sessionKey,
			channelId: input.channelId,
			userId: input.userId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

void startBot();

class GenerationJobQueue {
	private readonly jobs: QueuedJob[] = [];
	private activeJob: QueuedJob | null = null;
	private stopped = false;
	private activeJobPromise: Promise<void> | null = null;

	constructor(private readonly queueLimit: number) {}

	async enqueue(input: { request: GenerationJobInput; message: Message }): Promise<{
		jobId: string;
		queuePosition: number;
		startsImmediately: boolean;
	}> {
		if (this.jobs.length >= this.queueLimit) {
			throw new Error(`Queue is full. Max queued jobs: ${this.queueLimit}.`);
		}

		if (this.stopped) {
			throw new Error("Queue is shutting down. No new jobs accepted.");
		}

		const startsImmediately = this.activeJob === null && this.jobs.length === 0;
		const job: QueuedJob = {
			id: createJobId(),
			request: input.request,
			message: input.message,
			requestedAt: new Date().toISOString(),
		};

		this.jobs.push(job);
		void this.processNext();

		return {
			jobId: job.id,
			queuePosition: this.activeJob ? this.jobs.length : 1,
			startsImmediately,
		};
	}

	getSnapshot(): {
		activeJob: QueuedJob | null;
		queuedJobs: QueuedJob[];
		queueLimit: number;
	} {
		return {
			activeJob: this.activeJob,
			queuedJobs: [...this.jobs],
			queueLimit: this.queueLimit,
		};
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
		const droppedCount = this.jobs.length;
		this.jobs.length = 0;

		if (droppedCount > 0) {
			logInfo("Dropped pending jobs from queue during shutdown", { droppedCount });
		}

		if (this.activeJobPromise) {
			logInfo("Waiting for active generation job to finish before shutdown");
			await this.activeJobPromise;
		}
	}

	private async processNext(): Promise<void> {
		if (this.stopped || this.activeJob || this.jobs.length === 0) {
			return;
		}

		const nextJob = this.jobs.shift();
		if (!nextJob) {
			return;
		}

		this.activeJob = nextJob;
		const { message, request } = nextJob;
		if (!mongoDatabase) {
			throw new Error("MongoDB is not available for queued job updates.");
		}
		const database = mongoDatabase;

		const jobWork = (async () => {
		try {
			await updateGenerationJob(database, {
				jobId: nextJob.id,
				status: "running",
				startedAt: new Date(),
				resolved: {
					modelId: request.modelId ?? null,
					postType: request.postType ?? null,
					mode: request.mode ?? (request.s3FolderPath ? "publish-only" : "default"),
					outputDir: null,
					primaryOutputPath: null,
					generationResultPath: null,
					captionPath: null,
				},
			});
			await appendGenerationJobEvent(database, {
				jobId: nextJob.id,
				stage: "job",
				status: "started",
				message: "Job started.",
				details: {
					requestedByUserId: message.author.id,
					channelId: message.channelId,
				},
			});

			await sendChannelMessage(
				database,
				message.channel,
				message,
				`Starting jobId=${nextJob.id} ${formatCommandSummary(request)} for <@${message.author.id}>.`,
				"job-update",
			);

			logInfo("Starting queued Discord generation job", {
				jobId: nextJob.id,
				requestedAt: nextJob.requestedAt,
				modelId: request.modelId,
				postType: request.postType,
				messageId: message.id,
				channelId: message.channelId,
				userId: message.author.id,
			});

			const result = await runGenerationJob(request, {
				onProgress: async (event) => {
					await persistGenerationJobProgressEvent({
						database,
						jobId: nextJob.id,
						event,
					});
				},
			});
			const artifacts = await buildGenerationJobArtifacts({ request, result });
			await updateGenerationJob(database, {
				jobId: nextJob.id,
				status: "completed",
				completedAt: new Date(),
				resolved: {
					modelId: result.modelId,
					postType: result.postType,
					mode: result.mode,
					outputDir: result.outputDir,
					primaryOutputPath: result.primaryOutputPath,
					generationResultPath: result.generationResultPath,
					captionPath: result.captionPath,
				},
				artifacts,
				errorMessage: null,
			});
			await appendGenerationJobEvent(database, {
				jobId: nextJob.id,
				stage: "job",
				status: "completed",
				message: "Job completed successfully.",
				details: {
					outputDir: result.outputDir,
					primaryOutputPath: result.primaryOutputPath,
				},
			});
			await sendChannelMessage(
				database,
				message.channel,
				message,
				formatSuccessMessage(nextJob.id, message, result, artifacts),
				"job-update",
			);
		} catch (error: unknown) {
			const messageText = error instanceof Error ? error.message : String(error);
			const failureStage = inferFailureStage(messageText);
			await updateGenerationJob(database, {
				jobId: nextJob.id,
				status: "failed",
				completedAt: new Date(),
				errorMessage: messageText,
			});
			await appendGenerationJobEvent(database, {
				jobId: nextJob.id,
				stage: failureStage,
				status: "failed",
				message: "Job failed.",
				details: {
					error: messageText,
				},
			});
			logError("Queued Discord generation job failed", {
				jobId: nextJob.id,
				modelId: request.modelId,
				postType: request.postType,
				messageId: message.id,
				channelId: message.channelId,
				userId: message.author.id,
				message: messageText,
			});
			await sendChannelMessage(
				database,
				message.channel,
				message,
				`Failed jobId=${nextJob.id} ${formatCommandSummary(request)} for <@${message.author.id}> at stage=${failureStage}: ${messageText}`,
				"job-update",
			);
		} finally {
			this.activeJob = null;
			this.activeJobPromise = null;
			void this.processNext();
		}
		})();

		this.activeJobPromise = jobWork;
		await jobWork;
	}
}

const jobQueue = new GenerationJobQueue(maxQueueLength);

async function startBot(): Promise<void> {
	try {
		mongoDatabase = await initializeMongoDatabase();
		logInfo("MongoDB storage connected", {
			databaseName: mongoDatabase.db.databaseName,
			collections: mongoDatabase.collectionNames,
			connectionSource: readMongoConnectionSource(),
		});
		startMemoryConsolidationLoop();

		await ensureSelfModifyIndexes(mongoDatabase);

		process.once("SIGINT", () => {
			void shutdownBot("SIGINT");
		});
		process.once("SIGTERM", () => {
			void shutdownBot("SIGTERM");
		});
		process.once("SIGUSR2", () => {
			void shutdownBot("SIGUSR2");
		});

		await client.login(botKey);

		// After login, check for sessions that were mid-restart
		if (mongoDatabase) {
			await handlePostRestartSessions(mongoDatabase);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logError("Discord bot startup failed", { message });
		process.exitCode = 1;
	}
}

async function shutdownBot(signal: NodeJS.Signals): Promise<void> {
	if (!shutdownPromise) {
		shutdownPromise = (async () => {
			logInfo("Shutting down bot", { signal });

			try {
				client.removeAllListeners();
				client.destroy();
			} catch (error: unknown) {
				logWarn("Discord client shutdown encountered an error", {
					signal,
					message: error instanceof Error ? error.message : String(error),
				});
			}

			for (const [key, entry] of chatDebounceTimers) {
				clearTimeout(entry.timer);
				chatDebounceTimers.delete(key);
			}

			await jobQueue.shutdown();

			if (memoryConsolidationTimer) {
				clearInterval(memoryConsolidationTimer);
				memoryConsolidationTimer = null;
			}
			if (memoryConsolidationPromise) {
				await memoryConsolidationPromise;
			}

			if (mongoDatabase) {
				try {
					await mongoDatabase.close();
				} finally {
					mongoDatabase = null;
				}
			}

			logInfo("Bot shutdown complete", { signal });
		})();
	}

	await shutdownPromise;

	if (signal === "SIGUSR2") {
		process.kill(process.pid, "SIGUSR2");
		return;
	}

	process.exit(0);
}

function startMemoryConsolidationLoop(): void {
	void runScheduledMemoryConsolidation();
	memoryConsolidationTimer = setInterval(() => {
		void runScheduledMemoryConsolidation();
	}, MEMORY_CONSOLIDATION_INTERVAL_MS);
}

async function runScheduledMemoryConsolidation(): Promise<void> {
	await executeMemoryConsolidationCycle();
}

async function runManualMemoryConsolidation(): Promise<string> {
	if (!mongoDatabase) {
		return "Memory consolidation is unavailable because MongoDB is not ready.";
	}

	if (memoryConsolidationPromise) {
		return "Memory consolidation is already running.";
	}

	const result = await executeMemoryConsolidationCycle();
	if (!result) {
		return "Memory consolidation did not start.";
	}

	return [
		"Memory consolidation finished.",
		`processedSessions=${result.processedSessionCount}`,
		`parsedChatMessages=${result.parsedChatMessageCount}`,
		`updatedShortTerm=${result.updatedShortTermCount}`,
		`updatedLongTerm=${result.updatedLongTermCount}`,
		`skippedSessions=${result.skippedSessionCount}`,
	].join("\n");
}

async function executeMemoryConsolidationCycle(): Promise<Awaited<
	ReturnType<typeof runChatMemoryConsolidationCycle>
> | null> {
	if (!mongoDatabase || memoryConsolidationPromise) {
		return null;
	}

	memoryConsolidationPromise = (async () => {
		try {
			return await runChatMemoryConsolidationCycle({
				database: mongoDatabase as SmediaMongoDatabase,
			});
		} catch (error: unknown) {
			logWarn("Scheduled chat memory consolidation failed", {
				message: error instanceof Error ? error.message : String(error),
			});
			return null;
		} finally {
		}
	})();

	try {
		return await memoryConsolidationPromise;
	} finally {
		memoryConsolidationPromise = null;
	}
}

function readMongoConnectionSource(): string {
	if (process.env.MONGODB_URI?.trim()) {
		return "MONGODB_URI";
	}

	return "mongo_db_*";
}

function isBotCommand(content: string): boolean {
	return (
		content.startsWith(BOT_COMMAND_PREFIX) ||
		content.startsWith(JOB_STATUS_COMMAND_PREFIX) ||
		content.startsWith(FAILED_JOBS_COMMAND_PREFIX) ||
		content === STATUS_COMMAND_PREFIX ||
		content === MEMORY_REFRESH_COMMAND_PREFIX ||
		content === MEMORY_INSPECT_COMMAND_PREFIX
	);
}

function parseJobStatusCommand(content: string): JobStatusCommand {
	const trimmedContent = content.trim();
	if (!trimmedContent.startsWith(JOB_STATUS_COMMAND_PREFIX)) {
		throw new Error(`Command must start with ${JOB_STATUS_COMMAND_PREFIX}.`);
	}

	const argsText = trimmedContent.slice(JOB_STATUS_COMMAND_PREFIX.length).trim();
	if (!argsText || argsText.toLowerCase() === "latest") {
		return {
			latest: true,
		};
	}

	const parsedArgs = new Map<string, string>();
	for (const token of argsText.split(/\s+/)) {
		const separatorIndex = token.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
			throw new Error(`Invalid argument \"${token}\". Expected \"latest\" or key=value.`);
		}

		const key = token.slice(0, separatorIndex).trim();
		const value = token.slice(separatorIndex + 1).trim();
		if (key !== "jobId") {
			throw new Error(`Unknown argument \"${key}\". Supported values: latest, jobId.`);
		}
		if (parsedArgs.has(key)) {
			throw new Error(`Duplicate argument \"${key}\".`);
		}
		parsedArgs.set(key, value);
	}

	const jobId = parsedArgs.get("jobId");
	if (!jobId) {
		throw new Error("Missing jobId. Use /jobstatus latest or /jobstatus jobId=<id>.");
	}

	return {
		jobId,
		latest: false,
	};
}

function parseFailedJobsCommand(content: string): FailedJobsCommand {
	const trimmedContent = content.trim();
	if (!trimmedContent.startsWith(FAILED_JOBS_COMMAND_PREFIX)) {
		throw new Error(`Command must start with ${FAILED_JOBS_COMMAND_PREFIX}.`);
	}

	const argsText = trimmedContent.slice(FAILED_JOBS_COMMAND_PREFIX.length).trim();
	if (!argsText) {
		return {
			limit: DEFAULT_FAILED_JOBS_LIMIT,
		};
	}

	const parsedArgs = new Map<string, string>();
	for (const token of argsText.split(/\s+/)) {
		const separatorIndex = token.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
			throw new Error(`Invalid argument \"${token}\". Expected key=value.`);
		}

		const key = token.slice(0, separatorIndex).trim();
		const value = token.slice(separatorIndex + 1).trim();
		if (key !== "limit") {
			throw new Error(`Unknown argument \"${key}\". Supported key: limit.`);
		}
		if (parsedArgs.has(key)) {
			throw new Error(`Duplicate argument \"${key}\".`);
		}

		parsedArgs.set(key, value);
	}

	const limitValue = parsedArgs.get("limit");
	if (!limitValue) {
		return {
			limit: DEFAULT_FAILED_JOBS_LIMIT,
		};
	}

	const limit = Number.parseInt(limitValue, 10);
	if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_FAILED_JOBS_LIMIT) {
		throw new Error(`Invalid limit \"${limitValue}\". Expected an integer between 1 and ${MAX_FAILED_JOBS_LIMIT}.`);
	}

	return { limit };
}

function parseCreatePostCommand(content: string): CreatePostCommand {
	const trimmedContent = content.trim();
	if (!trimmedContent.startsWith(BOT_COMMAND_PREFIX)) {
		throw new Error(`Command must start with ${BOT_COMMAND_PREFIX}.`);
	}

	const argsText = trimmedContent.slice(BOT_COMMAND_PREFIX.length).trim();
	if (!argsText) {
		return {};
	}

	const parsedArgs = new Map<string, string>();
	for (const token of argsText.split(/\s+/)) {
		const separatorIndex = token.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
			throw new Error(`Invalid argument \"${token}\". Expected key=value.`);
		}

		const key = token.slice(0, separatorIndex).trim();
		const value = token.slice(separatorIndex + 1).trim();
		if (key !== "modelId" && key !== "postType") {
			throw new Error(`Unknown argument \"${key}\". Supported keys: modelId, postType.`);
		}

		if (parsedArgs.has(key)) {
			throw new Error(`Duplicate argument \"${key}\".`);
		}

		parsedArgs.set(key, value);
	}

	const modelId = parsedArgs.get("modelId");
	const postTypeValue = parsedArgs.get("postType");
	if (postTypeValue && !isPostType(postTypeValue)) {
		throw new Error(`Invalid postType \"${postTypeValue}\".`);
	}
	const postType = postTypeValue && isPostType(postTypeValue) ? postTypeValue : undefined;

	return {
		modelId,
		postType,
	};
}

async function replyToMessage(
	database: SmediaMongoDatabase,
	message: Message,
	content: string,
	kind: ChatMessageKind,
): Promise<void> {
	const chunks = splitDiscordMessage(content);
	for (const chunk of chunks) {
		const sentMessage = await message.reply({
			content: chunk,
			allowedMentions: {
				repliedUser: false,
			},
		});

		await persistOutboundDiscordMessage(database, message, sentMessage, kind);
	}
}

async function sendChannelMessage(
	database: SmediaMongoDatabase,
	channel: Message["channel"],
	sourceMessage: Message,
	content: string,
	kind: ChatMessageKind,
): Promise<void> {
	try {
		if (!("send" in channel)) {
			throw new Error("Discord channel does not support sending messages.");
		}

		const chunks = splitDiscordMessage(content);
		for (const chunk of chunks) {
			const sentMessage = await channel.send({
				content: chunk,
				allowedMentions: {
					parse: [],
				},
			});

			await persistOutboundDiscordMessage(database, sourceMessage, sentMessage, kind);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logError("Failed to send Discord channel message", { message });
	}
}

async function persistInboundDiscordMessage(
	database: SmediaMongoDatabase,
	message: Message,
	kind: ChatMessageKind,
): Promise<void> {
	await appendChatMessage(database, {
		sessionKey: buildChatSessionKey({
			guildId: message.guildId as string,
			channelId: message.channelId,
		}),
		guildId: message.guildId as string,
		channelId: message.channelId,
		userId: message.author.id,
		discordMessageId: message.id,
		authorRole: "user",
		kind,
		content: message.content,
		metadata: {
			username: message.author.username,
		},
		createdAt: message.createdAt,
	});
}

async function persistInboundChatContent(
	database: SmediaMongoDatabase,
	message: Message,
	content: string,
): Promise<void> {
	await appendChatMessage(database, {
		sessionKey: buildChatSessionKey({
			guildId: message.guildId as string,
			channelId: message.channelId,
		}),
		guildId: message.guildId as string,
		channelId: message.channelId,
		userId: message.author.id,
		discordMessageId: message.id,
		authorRole: "user",
		kind: "chat",
		content,
		metadata: {
			username: message.author.username,
		},
		createdAt: message.createdAt,
	});
}

async function persistOutboundDiscordMessage(
	database: SmediaMongoDatabase,
	sourceMessage: Message,
	sentMessage: Message,
	kind: ChatMessageKind,
): Promise<void> {
	await appendChatMessage(database, {
		sessionKey: buildChatSessionKey({
			guildId: sourceMessage.guildId as string,
			channelId: sourceMessage.channelId,
		}),
		guildId: sourceMessage.guildId as string,
		channelId: sourceMessage.channelId,
		userId: client.user?.id ?? null,
		discordMessageId: sentMessage.id,
		authorRole: "assistant",
		kind,
		content: sentMessage.content,
		metadata: {
			relatedUserId: sourceMessage.author.id,
		},
		createdAt: sentMessage.createdAt,
	});
}

function formatCommandSummary(command: CreatePostCommand): string {
	return [
		"createpost",
		command.modelId ? `modelId=${command.modelId}` : "modelId=random",
		command.postType ? `postType=${command.postType}` : "postType=random",
	].join(" ");
}

function formatSuccessMessage(
	jobId: string,
	message: Message,
	result: GenerationJobResult,
	artifacts?: Record<string, unknown>,
): string {
	const details = [
		`Completed jobId=${jobId} createpost modelId=${result.modelId} postType=${result.postType ?? "n/a"} for <@${message.author.id}>.`,
	];

	if (result.outputDir) {
		details.push(`outputDir=${result.outputDir}`);
	}
	if (result.primaryOutputPath) {
		details.push(`primaryOutputPath=${result.primaryOutputPath}`);
	}
	if (result.captionPath) {
		details.push(`captionPath=${result.captionPath}`);
	}

	const assetLinks = extractDiscordAssetLinks(artifacts);
	if (assetLinks.length > 0) {
		details.push("assetLinks:");
		details.push(...assetLinks.map((link) => `${link.assetType} ${link.relativePath}=${link.publicUrl}`));
	} else if (hasCollectedAssetsWithoutPublicUrls(artifacts)) {
		details.push(
			"assetLinks=unavailable (configure OUTPUT_PUBLIC_BASE_URL or S3_PUBLIC_BASE_URL for Discord-friendly public links)",
		);
	}

	return details.join("\n");
}

function formatQueueStatus(snapshot: {
	activeJob: QueuedJob | null;
	queuedJobs: QueuedJob[];
	queueLimit: number;
}): string {
	if (!snapshot.activeJob) {
		return `Worker is idle. queued=0/${snapshot.queueLimit}`;
	}

	const lines = [
		`Worker is busy. queued=${snapshot.queuedJobs.length}/${snapshot.queueLimit}`,
		`active=jobId=${snapshot.activeJob.id} modelId=${snapshot.activeJob.request.modelId} postType=${snapshot.activeJob.request.postType} requestedAt=${snapshot.activeJob.requestedAt}`,
	];

	if (snapshot.queuedJobs.length > 0) {
		lines.push(
			`next=${snapshot.queuedJobs
				.slice(0, 3)
				.map((job) => `jobId=${job.id} modelId=${job.request.modelId} postType=${job.request.postType}`)
				.join(" | ")}`,
		);
		if (snapshot.queuedJobs.length > 3) {
			lines.push(`remaining=${snapshot.queuedJobs.length - 3}`);
		}
	}

	return lines.join("\n");
}

function formatGenerationJobStatus(job: GenerationJobDocument): string {
	const events = getGenerationJobEvents(job);
	const lines = [
		`jobId=${job.jobId}`,
		`status=${job.status}`,
		`createdAt=${job.createdAt.toISOString()}`,
		`updatedAt=${job.updatedAt.toISOString()}`,
	];

	if (job.startedAt) {
		lines.push(`startedAt=${job.startedAt.toISOString()}`);
	}
	if (job.completedAt) {
		lines.push(`completedAt=${job.completedAt.toISOString()}`);
	}
	if (job.requestedByUsername) {
		lines.push(`requestedBy=${job.requestedByUsername}`);
	}
	if (job.request.modelId) {
		lines.push(`requestedModelId=${job.request.modelId}`);
	}
	if (job.request.postType) {
		lines.push(`requestedPostType=${job.request.postType}`);
	}
	if (job.resolved.modelId) {
		lines.push(`resolvedModelId=${job.resolved.modelId}`);
	}
	if (job.resolved.postType) {
		lines.push(`resolvedPostType=${job.resolved.postType}`);
	}
	if (job.errorMessage) {
		lines.push(`error=${job.errorMessage}`);
	}
	if (job.resolved.outputDir) {
		lines.push(`outputDir=${job.resolved.outputDir}`);
	}

	lines.push("events:");
	if (events.length === 0) {
		lines.push("none");
	} else {
		for (const event of events.slice(-10)) {
			const detailSuffix = event.details ? ` details=${JSON.stringify(event.details)}` : "";
			lines.push(
				`${event.createdAt.toISOString()} stage=${event.stage} status=${event.status} message=${event.message}${detailSuffix}`,
			);
		}
	}

	return lines.join("\n");
}

function formatFailedJobsStatus(jobs: GenerationJobDocument[], limit: number): string {
	if (jobs.length === 0) {
		return "No failed generation jobs found for you in this channel.";
	}

	const lines = [`Recent failed jobs (latest ${Math.min(limit, jobs.length)}):`];
	for (const job of jobs) {
		const events = getGenerationJobEvents(job);
		const failedEvent = [...events].reverse().find((event) => event.status === "failed");
		const failureTime = (job.completedAt ?? failedEvent?.createdAt ?? job.updatedAt).toISOString();
		const requestedModelId = job.request?.modelId ?? job.resolved?.modelId ?? "random";
		const requestedPostType = job.request?.postType ?? job.resolved?.postType ?? "random";
		const errorMessage = job.errorMessage ?? readFailedEventError(failedEvent) ?? "Unknown failure";
		const stage = failedEvent?.stage ?? inferFailureStage(errorMessage);

		lines.push(
			[
				`jobId=${job.jobId}`,
				`modelId=${requestedModelId}`,
				`postType=${requestedPostType}`,
				`failedAt=${failureTime}`,
				`stage=${stage}`,
				`error=${errorMessage}`,
			].join(" "),
		);
	}

	return lines.join("\n");
}

function readAllowedChannelIds(env: NodeJS.ProcessEnv): Set<string> {
	const rawValue = env.DISCORD_ALLOWED_CHANNEL_IDS?.trim() || env.DISCORD_CHANNEL_ID?.trim() || "";
	return new Set(
		rawValue
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0),
	);
}

async function persistGenerationJobProgressEvent(input: {
	database: SmediaMongoDatabase;
	jobId: string;
	event: GenerationJobProgressEvent;
}): Promise<void> {
	try {
		await appendGenerationJobEvent(input.database, {
			jobId: input.jobId,
			stage: input.event.stage,
			status: input.event.status,
			message: input.event.message,
			details: input.event.details,
		});
	} catch (error: unknown) {
		logWarn("Failed to persist generation job progress event", {
			jobId: input.jobId,
			stage: input.event.stage,
			status: input.event.status,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function getLatestRequestedGenerationJob(
	database: SmediaMongoDatabase,
	message: Message,
): Promise<GenerationJobDocument | null> {
	const jobs = await listRecentGenerationJobs(database, {
		requestedByUserId: message.author.id,
		guildId: message.guildId ?? undefined,
		channelId: message.channelId,
		limit: 1,
	});
	return jobs[0] ?? null;
}

function inferFailureStage(message: string): string {
	const normalized = message.toLowerCase();
	if (normalized.includes("stable audio") || normalized.includes("audio") || normalized.includes("sound")) {
		return "audio";
	}
	if (normalized.includes("instagram") || normalized.includes("facebook") || normalized.includes("publish")) {
		return "publish";
	}
	if (normalized.includes("s3") || normalized.includes("bucket") || normalized.includes("public asset url")) {
		return "upload";
	}
	if (normalized.includes("caption")) {
		return "caption";
	}
	if (normalized.includes("veo") || normalized.includes("video")) {
		return "video";
	}
	return "content-generation";
}

function getGenerationJobEvents(job: GenerationJobDocument): GenerationJobDocument["events"] {
	return Array.isArray(job.events) ? job.events : [];
}

function readFailedEventError(
	event: GenerationJobDocument["events"][number] | undefined,
): string | null {
	if (!event?.details || typeof event.details !== "object") {
		return null;
	}

	const errorValue = Reflect.get(event.details, "error");
	return typeof errorValue === "string" && errorValue.trim().length > 0 ? errorValue.trim() : null;
}

function readBooleanEnv(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function readMaxQueueLength(rawValue: string | undefined): number {
	if (!rawValue) {
		return DEFAULT_MAX_QUEUE_LENGTH;
	}

	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		throw new Error(`Invalid DISCORD_MAX_QUEUE_LENGTH \"${rawValue}\". Expected a positive integer.`);
	}

	return parsedValue;
}

function createJobId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitDiscordMessage(content: string): string[] {
	if (content.length <= DISCORD_MESSAGE_LIMIT) {
		return [content];
	}

	const chunks: string[] = [];
	let remaining = content;
	while (remaining.length > 0) {
		if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
			chunks.push(remaining);
			break;
		}

		let splitIndex = remaining.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);
		if (splitIndex <= 0) {
			splitIndex = remaining.lastIndexOf(" ", DISCORD_MESSAGE_LIMIT);
		}
		if (splitIndex <= 0) {
			splitIndex = DISCORD_MESSAGE_LIMIT;
		}

		chunks.push(remaining.slice(0, splitIndex));
		remaining = remaining.slice(splitIndex).replace(/^\n/, "");
	}

	return chunks;
}

async function buildGenerationJobArtifacts(input: {
	request: GenerationJobInput;
	result: GenerationJobResult;
}): Promise<Record<string, unknown>> {
	const outputDir = input.result.outputDir;
	const promptFiles = outputDir ? await collectPromptFiles(outputDir) : [];
	const assetUrls = outputDir ? await collectAssetUrls(outputDir) : [];
	const generationResult = input.result.generationResultPath
		? await readJsonFileIfExists(input.result.generationResultPath)
		: null;
	const instagramPublishResult = outputDir
		? await readJsonFileIfExists(path.join(outputDir, "instagram-publish-result.json"))
		: null;
	const compositeResult = outputDir
		? await readJsonFileIfExists(path.join(outputDir, "composite-result.json"))
		: null;

	return {
		caption: input.result.caption,
		requestS3FolderPath: input.request.s3FolderPath ?? null,
		generationResult,
		instagramPublishResult,
		compositeResult,
		promptFiles,
		assetUrls,
	};
}

async function collectPromptFiles(outputDir: string): Promise<Array<Record<string, string>>> {
	const filePaths = await listFilesRecursive(outputDir);
	const promptPaths = filePaths.filter((filePath) => {
		const fileName = path.basename(filePath).toLowerCase();
		const extension = path.extname(fileName);
		return fileName.includes("prompt") && (extension === ".txt" || extension === ".md" || extension === ".json");
	});

	return Promise.all(
		promptPaths.map(async (filePath) => ({
			relativePath: path.relative(outputDir, filePath).split(path.sep).join("/"),
			content: await readFile(filePath, "utf8"),
		})),
	);
}

async function collectAssetUrls(outputDir: string): Promise<Array<Record<string, string | null>>> {
	const filePaths = await listFilesRecursive(outputDir);
	const assetPaths = filePaths.filter((filePath) => {
		const extension = path.extname(filePath).toLowerCase();
		return [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mp3", ".wav"].includes(extension);
	});

	return assetPaths.map((filePath) => ({
		relativePath: path.relative(outputDir, filePath).split(path.sep).join("/"),
		assetType: classifyAssetType(filePath),
		publicUrl: tryBuildPublicAssetUrl(filePath),
	}));
}

async function readJsonFileIfExists(filePath: string): Promise<unknown | null> {
	try {
		const content = await readFile(filePath, "utf8");
		return JSON.parse(content);
	} catch (error: unknown) {
		const isMissingFileError = error instanceof Error && "code" in error && error.code === "ENOENT";
		if (isMissingFileError) {
			return null;
		}
		throw error;
	}
}

async function listFilesRecursive(directoryPath: string): Promise<string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedPaths = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return listFilesRecursive(entryPath);
			}

			return [entryPath];
		}),
	);

	return nestedPaths.flat();
}

function classifyAssetType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".png":
		case ".jpg":
		case ".jpeg":
		case ".webp":
			return "image";
		case ".mp4":
			return "video";
		case ".mp3":
		case ".wav":
			return "audio";
		default:
			return "other";
	}
}

function extractDiscordAssetLinks(
	artifacts?: Record<string, unknown>,
): Array<{ relativePath: string; assetType: string; publicUrl: string }> {
	const rawAssetUrls = artifacts?.assetUrls;
	if (!Array.isArray(rawAssetUrls)) {
		return [];
	}

	const parsedLinks = rawAssetUrls
		.map((value) => parseDiscordAssetLink(value))
		.filter((value): value is { relativePath: string; assetType: string; publicUrl: string } => value !== null)
		.filter((value) => isDiscordVisibleAsset(value.relativePath, value.assetType))
		.sort((left, right) => compareDiscordAssetLinks(left, right));

	const dedupedLinks: Array<{ relativePath: string; assetType: string; publicUrl: string }> = [];
	const seenUrls = new Set<string>();
	for (const link of parsedLinks) {
		if (seenUrls.has(link.publicUrl)) {
			continue;
		}

		seenUrls.add(link.publicUrl);
		dedupedLinks.push(link);
		if (dedupedLinks.length >= 8) {
			break;
		}
	}

	return dedupedLinks;
}

function parseDiscordAssetLink(
	value: unknown,
): { relativePath: string; assetType: string; publicUrl: string } | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const relativePath = typeof record.relativePath === "string" ? record.relativePath : null;
	const assetType = typeof record.assetType === "string" ? record.assetType : null;
	const publicUrl = typeof record.publicUrl === "string" ? record.publicUrl : null;

	if (!relativePath || !assetType || !publicUrl) {
		return null;
	}

	return {
		relativePath,
		assetType,
		publicUrl,
	};
}

function isDiscordVisibleAsset(relativePath: string, assetType: string): boolean {
	if (assetType !== "image" && assetType !== "video") {
		return false;
	}

	return ![
		"selected-symbols/",
		"selected-characters/",
		"background/",
		"generated-character-seeds/",
		"metadata/",
	].some((prefix) => relativePath.startsWith(prefix));
}

function compareDiscordAssetLinks(
	left: { relativePath: string; assetType: string },
	right: { relativePath: string; assetType: string },
): number {
	const leftScore = getDiscordAssetPriority(left.relativePath, left.assetType);
	const rightScore = getDiscordAssetPriority(right.relativePath, right.assetType);
	return leftScore - rightScore || left.relativePath.localeCompare(right.relativePath);
}

function getDiscordAssetPriority(relativePath: string, assetType: string): number {
	if (assetType === "video") {
		if (/promo|with-promo-overlay/i.test(relativePath)) {
			return 0;
		}
		return 1;
	}

	if (/prepared/i.test(relativePath)) {
		return 2;
	}
	if (/keyframe/i.test(relativePath)) {
		return 3;
	}
	if (/promo/i.test(relativePath)) {
		return 4;
	}

	return 5;
}

function hasCollectedAssetsWithoutPublicUrls(artifacts?: Record<string, unknown>): boolean {
	const rawAssetUrls = artifacts?.assetUrls;
	if (!Array.isArray(rawAssetUrls)) {
		return false;
	}

	return rawAssetUrls.some((value) => {
		if (!value || typeof value !== "object") {
			return false;
		}

		const record = value as Record<string, unknown>;
		const relativePath = typeof record.relativePath === "string" ? record.relativePath : null;
		const assetType = typeof record.assetType === "string" ? record.assetType : null;
		const publicUrl = typeof record.publicUrl === "string" ? record.publicUrl : null;

		return Boolean(relativePath && assetType && !publicUrl && isDiscordVisibleAsset(relativePath, assetType));
	});
}

function tryBuildPublicAssetUrl(filePath: string): string | null {
	try {
		return buildPublicAssetUrl(filePath);
	} catch {
		return null;
	}
}

function buildPublicAssetUrl(filePath: string): string {
	const explicitBaseUrl =
		process.env.OUTPUT_PUBLIC_BASE_URL?.trim() ?? process.env.S3_PUBLIC_BASE_URL?.trim();
	const outputBaseDir = path.resolve(process.cwd(), "output");
	const relativeKey = path.relative(outputBaseDir, filePath).split(path.sep).join("/");

	if (relativeKey.startsWith("../") || relativeKey === "..") {
		throw new Error(`Asset path must be inside output directory: ${filePath}`);
	}

	if (explicitBaseUrl) {
		return new URL(relativeKey, ensureTrailingSlashValue(explicitBaseUrl)).toString();
	}

	const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
	const bucket = process.env.AWS_BUCKET?.trim() ?? process.env.DO_SPACES_BUCKET?.trim();
	if (!endpoint || !bucket) {
		throw new Error("Missing public asset URL config.");
	}

	return new URL(relativeKey, buildBucketPublicBaseUrl(endpoint, bucket)).toString();
}

function ensureTrailingSlashValue(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function buildBucketPublicBaseUrl(endpoint: string, bucket: string): string {
	const parsedEndpoint = new URL(endpoint);
	const normalizedBucket = bucket.trim();
	if (!normalizedBucket) {
		throw new Error("Missing bucket name for public asset URL.");
	}

	if (!parsedEndpoint.hostname.startsWith(`${normalizedBucket}.`)) {
		parsedEndpoint.hostname = `${normalizedBucket}.${parsedEndpoint.hostname}`;
	}

	parsedEndpoint.pathname = ensureTrailingSlashValue(parsedEndpoint.pathname);
	return parsedEndpoint.toString();
}