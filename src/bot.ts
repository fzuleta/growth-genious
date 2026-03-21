import dotenv from "dotenv";
dotenv.config();

import {
	Client,
	GatewayIntentBits,
	type Message,
} from "discord.js";
import { botContract } from "./bot-contract";
import { generateChatReply } from "./chat-service";
import { retrieveDbRouteEvidence } from "./chat-db-query-service";
import { classifyChatRoute } from "./chat-router-service";
import {
	appendChatMessage,
	buildChatSessionKey,
	createOpenAiDebugInput,
	initializeMongoDatabase,
	type ChatMessageKind,
	type SmediaMongoDatabase,
} from "./db/mongo";
import { runChatMemoryConsolidationCycle, formatMemoryInspect } from "./chat-memory-service";
import { logError, logInfo, logWarn } from "./helpers/log";
import { retrieveWorkspaceRouteEvidence } from "./workspace-context-service";
import { runCodeAnalysis } from "./code-analysis-service";
import {
	getActiveSelfModifySession,
	appendSelfModifyFeedback,
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
const STATUS_COMMAND_PREFIX = "/status";
const MEMORY_REFRESH_COMMAND_PREFIX = "/refreshmemory";
const MEMORY_INSPECT_COMMAND_PREFIX = "/memory";
const DISCORD_MESSAGE_LIMIT = 2000;
const CHAT_DEBOUNCE_MS = 1500;
const MEMORY_CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1000;

const commandUserId = process.env.DISCORD_FELI_ID?.trim();
if (!commandUserId) {
	throw new Error("Missing DISCORD_FELI_ID. Bot commands are restricted and require this user ID.");
}

const allowedChannelIds = readAllowedChannelIds(process.env);
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
	logInfo("Discord workspace assistant connected", {
		assistantName: botContract.name,
		botUser: client.user?.tag ?? null,
		allowedChannelIds: Array.from(allowedChannelIds),
		commandUserId,
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
		logWarn("Ignored Discord message from unauthorized channel", {
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

	if (content === STATUS_COMMAND_PREFIX) {
		await persistInboundDiscordMessage(mongoDatabase, message, "status");
		await replyToMessage(
			mongoDatabase,
			message,
			await formatBotStatus(mongoDatabase, message.channelId),
			"status",
		);
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
			contract: botContract,
		});
		const routeDecision = classification.decision;
		const customRouteHandler = classification.customRouteHandler;

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

		if (routeDecision.route === "custom" && customRouteHandler) {
			await persistInboundChatContent(database, lastMessage, combinedContent);
			const customReply = await customRouteHandler({
				assistantName: botContract.name,
				database,
				message: lastMessage,
				content: combinedContent,
			});
			if (customReply.trim().length > 0) {
				await replyToMessage(database, lastMessage, customReply, "chat");
			}
			return;
		}

		// If self-modify was routed but user is not authorized, downgrade to conversation
		if (routeDecision.route === "self-modify" || routeDecision.route === "code-analysis") {
			routeDecision.route = "conversation";
			routeDecision.reason = `${routeDecision.reason ?? "unknown"}+restricted-route-unauthorized`;
		}

		const reply = await generateChatReply({
			database,
			assistantName: botContract.name,
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

		await client.login(botContract.discordBotKey);

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
		content === STATUS_COMMAND_PREFIX ||
		content === MEMORY_REFRESH_COMMAND_PREFIX ||
		content === MEMORY_INSPECT_COMMAND_PREFIX
	);
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

async function formatBotStatus(database: SmediaMongoDatabase, channelId: string): Promise<string> {
	const activeSession = await getActiveSelfModifySession(database, channelId);
	const lines = [
		`${botContract.name} is online.`,
		`memoryConsolidation=${memoryConsolidationPromise ? "running" : "idle"}`,
		"customRouter=installed",
	];

	if (activeSession) {
		lines.push(
			`selfModify=sessionId=${activeSession.sessionId} state=${activeSession.state} branch=${activeSession.gitBranch}`,
		);
	} else {
		lines.push("selfModify=idle");
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

function readBooleanEnv(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
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