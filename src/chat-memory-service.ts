import type { ResponseInputItem } from "openai/resources/responses/responses";
import { readOptionalContextMarkdown } from "./context-service";
import {
	getLatestMemoryEntry,
	getMemoryCheckpoint,
	listChatMessagesForMemoryWindow,
	listRecentShortTermSummariesForUser,
	markSessionConsolidated,
	upsertMemoryCheckpoint,
	upsertMemoryEntry,
	type ChatMessageDocument,
	type MemoryEntryDocument,
	type SmediaMongoDatabase,
} from "./db/mongo";
import { generateText, resolveAiTextModel } from "./ai/text-router";
import type { PluginContract } from "./plugin-contract";
import { logInfo, logWarn } from "./helpers/log";

const SHORT_TERM_SOURCE_LIMIT = 50;
const LONG_TERM_SOURCE_LIMIT = 50;
const MAX_SESSIONS_PER_CYCLE = 20;
const LONG_TERM_WORD_LIMIT = 3000;
const SHORT_TERM_WORD_LIMIT = 1000;
const UNSUMMARIZED_MESSAGE_LIMIT = 20;
const CROSS_SESSION_SUMMARY_LIMIT = 5;

export interface ChatMemorySnapshot {
	shortTermSummary: MemoryEntryDocument | null;
	longTermProfile: MemoryEntryDocument | null;
	unsummarizedMessages: ChatMessageDocument[];
}

export async function getChatMemorySnapshot(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	sessionKey: string;
	userId: string;
}): Promise<ChatMemorySnapshot> {
	const [shortTermSummary, longTermProfile] = await Promise.all([
		getLatestMemoryEntry(input.database, {
			pluginId: input.pluginId,
			kinds: ["short-term-summary"],
			scope: "session",
			sessionKey: input.sessionKey,
		}),
		getLatestMemoryEntry(input.database, {
			pluginId: input.pluginId,
			kinds: ["long-term-profile"],
			scope: "user",
			userId: input.userId,
		}),
	]);

	const unsummarizedMessages = shortTermSummary
		? await listChatMessagesForMemoryWindow(input.database, {
			pluginId: input.pluginId,
			sessionKey: input.sessionKey,
			kinds: ["chat", "command", "job-update"],
			afterCreatedAt: shortTermSummary.updatedAt,
			limit: UNSUMMARIZED_MESSAGE_LIMIT,
		})
		: [];

	return {
		shortTermSummary,
		longTermProfile,
		unsummarizedMessages,
	};
}

export async function formatMemoryInspect(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	sessionKey: string;
	userId: string;
}): Promise<string> {
	const snapshot = await getChatMemorySnapshot(input);
	const lines: string[] = ["**Memory Inspect**"];

	if (snapshot.shortTermSummary) {
		const age = formatRelativeAge(snapshot.shortTermSummary.updatedAt);
		const wordCount = snapshot.shortTermSummary.content.split(/\s+/).length;
		lines.push(`\n__Short-term summary__ (${wordCount} words, updated ${age}):`);
		lines.push(snapshot.shortTermSummary.content);
	} else {
		lines.push("\n__Short-term summary__: None");
	}

	if (snapshot.longTermProfile) {
		const age = formatRelativeAge(snapshot.longTermProfile.updatedAt);
		const wordCount = snapshot.longTermProfile.content.split(/\s+/).length;
		lines.push(`\n__Long-term profile__ (${wordCount} words, updated ${age}):`);
		lines.push(snapshot.longTermProfile.content);
	} else {
		lines.push("\n__Long-term profile__: None");
	}

	return lines.join("\n");
}

function formatRelativeAge(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMinutes = Math.floor(diffMs / 60_000);
	if (diffMinutes < 1) {
		return "just now";
	}
	if (diffMinutes < 60) {
		return `${diffMinutes}m ago`;
	}
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

export async function runChatMemoryConsolidationCycle(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	plugin?: PluginContract | null;
}): Promise<{
	processedSessionCount: number;
	updatedShortTermCount: number;
	updatedLongTermCount: number;
	parsedChatMessageCount: number;
	skippedSessionCount: number;
}> {
	const contextMarkdown = await readOptionalContextMarkdown();
	const sessions = await input.database.collections.chatSessions
		.find({
			pluginId: input.pluginId,
			messageCount: { $gt: 0 },
			$or: [
				{ lastConsolidatedAt: { $exists: false } },
				{ lastConsolidatedAt: null },
				{ $expr: { $gt: ["$lastMessageAt", "$lastConsolidatedAt"] } },
			],
		})
		.sort({ updatedAt: -1 })
		.limit(MAX_SESSIONS_PER_CYCLE)
		.toArray();

	let updatedShortTermCount = 0;
	let updatedLongTermCount = 0;
	let parsedChatMessageCount = 0;
	let skippedSessionCount = 0;

	for (const session of sessions) {
		try {
			const result = await consolidateSessionMemory({
				database: input.database,
				pluginId: input.pluginId,
				plugin: input.plugin,
				contextMarkdown,
				sessionKey: session.sessionKey,
				guildId: session.guildId,
				channelId: session.channelId,
				sessionLastMessageAt: session.lastMessageAt,
			});

			if (result.sessionConsolidatedAt) {
				await markSessionConsolidated(
					input.database,
					input.pluginId,
					session.sessionKey,
					result.sessionConsolidatedAt,
				);
			}

			if (!result.updatedShortTerm) {
				continue;
			}

			updatedShortTermCount += 1;
			updatedLongTermCount += result.updatedLongTermCount;
			parsedChatMessageCount += result.parsedChatMessageCount;
		} catch (error: unknown) {
			skippedSessionCount += 1;
			logWarn("Chat memory consolidation skipped a session due to an error", {
				sessionKey: session.sessionKey,
				channelId: session.channelId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	logInfo("Chat memory consolidation cycle completed", {
		processedSessionCount: sessions.length,
		updatedShortTermCount,
		updatedLongTermCount,
		parsedChatMessageCount,
		skippedSessionCount,
	});

	return {
		processedSessionCount: sessions.length,
		updatedShortTermCount,
		updatedLongTermCount,
		parsedChatMessageCount,
		skippedSessionCount,
	};
}

async function consolidateSessionMemory(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	plugin?: PluginContract | null;
	contextMarkdown: string | null;
	sessionKey: string;
	guildId: string;
	channelId: string;
	sessionLastMessageAt: Date;
}): Promise<{
	updatedShortTerm: boolean;
	updatedLongTermCount: number;
	parsedChatMessageCount: number;
	sessionConsolidatedAt: Date | null;
}> {
	const checkpoint = await getMemoryCheckpoint(input.database, {
		pluginId: input.pluginId,
		kind: "session-short-term",
		sessionKey: input.sessionKey,
	});
	const sourceWindow = await listChatMessagesForMemoryWindow(input.database, {
		pluginId: input.pluginId,
		sessionKey: input.sessionKey,
		kinds: ["chat", "command", "job-update"],
		afterCreatedAt: checkpoint?.lastParsedMessageAt ?? undefined,
		limit: SHORT_TERM_SOURCE_LIMIT + 1,
	});
	const eligibleSourceWindow = sourceWindow.filter(isMemoryEligibleMessage);
	const hasMoreSourceMessages = eligibleSourceWindow.length > SHORT_TERM_SOURCE_LIMIT;
	const sourceMessages = hasMoreSourceMessages
		? eligibleSourceWindow.slice(0, SHORT_TERM_SOURCE_LIMIT)
		: eligibleSourceWindow;
	const latestSeenMessageAt = sourceWindow[sourceWindow.length - 1]?.createdAt ?? null;

	if (sourceMessages.length === 0) {
		await upsertMemoryCheckpoint(input.database, {
			pluginId: input.pluginId,
			kind: "session-short-term",
			sessionKey: input.sessionKey,
			guildId: input.guildId,
			channelId: input.channelId,
			lastParsedMessageAt: latestSeenMessageAt ?? checkpoint?.lastParsedMessageAt ?? null,
			lastSourceUpdatedAt: input.sessionLastMessageAt,
			metadata: {
				messageCount: sourceWindow.length,
				memoryEligibleMessageCount: 0,
				hasMoreSourceMessages: false,
			},
			updatedAt: latestSeenMessageAt ?? input.sessionLastMessageAt,
		});

		return {
			updatedShortTerm: false,
			updatedLongTermCount: 0,
			parsedChatMessageCount: 0,
			sessionConsolidatedAt: input.sessionLastMessageAt,
		};
	}

	const latestShortTerm = await getLatestMemoryEntry(input.database, {
		pluginId: input.pluginId,
		kinds: ["short-term-summary"],
		scope: "session",
		sessionKey: input.sessionKey,
	});
	const summaryContent = await summarizeShortTermMemory({
		plugin: input.plugin,
		contextMarkdown: input.contextMarkdown,
		existingSummary: latestShortTerm?.content ?? null,
		messages: sourceMessages,
	});

	const previousWords = latestShortTerm ? latestShortTerm.content.split(/\s+/).length : 0;
	const newWords = summaryContent.split(/\s+/).length;
	const qualityCoverage = measureKeywordCoverage(sourceMessages, summaryContent);
	logInfo("Short-term memory consolidation metrics", {
		sessionKey: input.sessionKey,
		previousWords,
		newWords,
		sourceMessageCount: sourceMessages.length,
		wordLimit: SHORT_TERM_WORD_LIMIT,
		keywordCoverage: qualityCoverage.coverageRatio,
		keywordsFound: qualityCoverage.found,
		keywordsMissed: qualityCoverage.missed,
	});
	const createdAt = sourceMessages[sourceMessages.length - 1]?.createdAt ?? new Date();
	const participants = collectParticipants(sourceMessages);

	await upsertMemoryEntry(input.database, {
		pluginId: input.pluginId,
		kind: "short-term-summary",
		scope: "session",
		sessionKey: input.sessionKey,
		guildId: input.guildId,
		channelId: input.channelId,
		title: `Session memory ${input.channelId}`,
		content: summaryContent,
		tags: ["short-term", "chat-memory"],
		metadata: {
			windowStartedAt: sourceMessages[0]?.createdAt.toISOString() ?? null,
			windowEndedAt: createdAt.toISOString(),
			messageCount: sourceMessages.length,
			participantUserIds: Array.from(participants.keys()),
		},
		updatedAt: createdAt,
	});

	await upsertMemoryCheckpoint(input.database, {
		pluginId: input.pluginId,
		kind: "session-short-term",
		sessionKey: input.sessionKey,
		guildId: input.guildId,
		channelId: input.channelId,
		lastParsedMessageAt: createdAt,
		lastSourceUpdatedAt: input.sessionLastMessageAt,
		metadata: {
			messageCount: sourceMessages.length,
			hasMoreSourceMessages,
		},
		updatedAt: createdAt,
	});

	let updatedLongTermCount = 0;
	for (const [userId, username] of participants.entries()) {
		const updated = await maybeRefreshLongTermProfileForUser({
			database: input.database,
			pluginId: input.pluginId,
			plugin: input.plugin,
			contextMarkdown: input.contextMarkdown,
			userId,
			username,
			guildId: input.guildId,
			channelId: input.channelId,
		});
		if (updated) {
			updatedLongTermCount += 1;
		}
	}

	return {
		updatedShortTerm: true,
		updatedLongTermCount,
		parsedChatMessageCount: sourceMessages.length,
		sessionConsolidatedAt: hasMoreSourceMessages ? createdAt : input.sessionLastMessageAt,
	};
}

async function maybeRefreshLongTermProfileForUser(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	plugin?: PluginContract | null;
	contextMarkdown: string | null;
	userId: string;
	username: string;
	guildId: string;
	channelId: string;
}): Promise<boolean> {
	const checkpoint = await getMemoryCheckpoint(input.database, {
		pluginId: input.pluginId,
		kind: "user-long-term",
		userId: input.userId,
	});
	const sourceMessages = await input.database.collections.chatMessages
		.find({
			pluginId: input.pluginId,
			kind: { $in: ["chat", "command"] },
			$or: [
				{ authorRole: "user", userId: input.userId },
				{ authorRole: "assistant", "metadata.relatedUserId": input.userId },
			],
			...(checkpoint?.lastParsedMessageAt
				? {
					createdAt: { $gt: checkpoint.lastParsedMessageAt },
				}
				: {}),
		})
		.sort({ createdAt: 1 })
		.limit(LONG_TERM_SOURCE_LIMIT)
		.toArray();
	const eligibleSourceMessages = sourceMessages.filter(isMemoryEligibleMessage);

	if (eligibleSourceMessages.length === 0) {
		const latestSeenMessageAt = sourceMessages[sourceMessages.length - 1]?.createdAt ?? checkpoint?.lastParsedMessageAt ?? new Date();
		await upsertMemoryCheckpoint(input.database, {
			pluginId: input.pluginId,
			kind: "user-long-term",
			guildId: input.guildId,
			channelId: input.channelId,
			userId: input.userId,
			lastParsedMessageAt: latestSeenMessageAt,
			metadata: {
				username: input.username,
				sourceMessageCount: sourceMessages.length,
				memoryEligibleMessageCount: 0,
			},
			updatedAt: latestSeenMessageAt,
		});
		return false;
	}

	const [latestProfile, recentSessionSummaries] = await Promise.all([
		getLatestMemoryEntry(input.database, {
			pluginId: input.pluginId,
			kinds: ["long-term-profile"],
			scope: "user",
			userId: input.userId,
		}),
		listRecentShortTermSummariesForUser(input.database, {
			pluginId: input.pluginId,
			userId: input.userId,
			limit: CROSS_SESSION_SUMMARY_LIMIT,
		}),
	]);

	const crossSessionContext = recentSessionSummaries.length > 0
		? recentSessionSummaries
			.map((entry) => `[session=${entry.sessionKey ?? "unknown"} updated=${entry.updatedAt.toISOString()}]\n${entry.content}`)
			.join("\n\n---\n\n")
		: null;

	const profileContent = await summarizeLongTermProfile({
		plugin: input.plugin,
		contextMarkdown: input.contextMarkdown,
		existingProfile: latestProfile?.content ?? null,
		messages: eligibleSourceMessages,
		username: input.username,
		crossSessionContext,
	});

	const previousWords = latestProfile ? latestProfile.content.split(/\s+/).length : 0;
	const newWords = profileContent.split(/\s+/).length;
	logInfo("Long-term profile consolidation metrics", {
		userId: input.userId,
		previousWords,
		newWords,
		sourceMessageCount: sourceMessages.length,
		crossSessionSummaryCount: recentSessionSummaries.length,
		wordLimit: LONG_TERM_WORD_LIMIT,
	});
	const createdAt = eligibleSourceMessages[eligibleSourceMessages.length - 1]?.createdAt ?? new Date();

	await upsertMemoryEntry(input.database, {
		pluginId: input.pluginId,
		kind: "long-term-profile",
		scope: "user",
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId,
		title: `User profile for ${input.username}`,
		content: profileContent,
		tags: ["long-term", "profile"],
		metadata: {
			windowStartedAt: eligibleSourceMessages[0]?.createdAt.toISOString() ?? null,
			windowEndedAt: createdAt.toISOString(),
			sourceMessageCount: eligibleSourceMessages.length,
		},
		updatedAt: createdAt,
	});

	await upsertMemoryCheckpoint(input.database, {
		pluginId: input.pluginId,
		kind: "user-long-term",
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId,
		lastParsedMessageAt: createdAt,
		metadata: {
			username: input.username,
			sourceMessageCount: eligibleSourceMessages.length,
		},
		updatedAt: createdAt,
	});

	return true;
}

function collectParticipants(messages: ChatMessageDocument[]): Map<string, string> {
	const participants = new Map<string, string>();

	for (const message of messages) {
		if (message.authorRole !== "user" || !message.userId) {
			continue;
		}

		const metadataUsername =
			typeof message.metadata?.username === "string" && message.metadata.username.trim()
				? message.metadata.username.trim()
				: null;
		participants.set(message.userId, metadataUsername ?? participants.get(message.userId) ?? "User");
	}

	return participants;
}

async function summarizeShortTermMemory(input: {
	plugin?: PluginContract | null;
	contextMarkdown: string | null;
	existingSummary: string | null;
	messages: ChatMessageDocument[];
}): Promise<string> {
	const prompt = [
		"You maintain short-term memory for a Discord assistant.",
		"Use the provided operating context to decide what matters, but do not repeat the context unless needed for clarity.",
		"Update the memory with the new transcript only.",
		`Keep the final output under ${SHORT_TERM_WORD_LIMIT} words.`,
		"Optimize aggressively for low token input in future prompts.",
		"Write compact markdown with these headings exactly:",
		"## Current State",
		"## Open Threads",
		"## Preferences And Opinions",
		"Rules:",
		"- Stay concise and factual.",
		"- Preserve the assistant role and priorities implied by the context.",
		"- Include decisions, constraints, current asks, active job context, command outcomes, and analytics findings when relevant.",
		"- In Preferences And Opinions, only include durable preferences or explicit opinions about the user, the job, the work, quality bar, priorities, or process.",
		"- Ignore trivial banter.",
		"- Treat command interactions as high-signal only when they reveal intent, decisions, requested outputs, reporting needs, findings, or execution state.",
		"- Do not waste space on raw command syntax, boilerplate status output, file path lists, or large numeric tables unless they matter to the next turn.",
		"- Compress analytics interactions into what was asked, what was learned, and what remains open.",
		"- Prefer compressed phrases over full sentences when meaning stays clear.",
		"- Drop low-value detail, repetition, examples, and narrative glue.",
		"- Keep only information worth paying tokens for in future chats.",
		input.contextMarkdown ? `Operating context:\n${input.contextMarkdown}` : "Operating context:\nNone",
		input.existingSummary ? `Existing short-term memory:\n${input.existingSummary}` : "Existing short-term memory:\nNone",
		`New conversation batch:\n${formatMessagesForPrompt(input.messages)}`,
	].join("\n\n");

	const text = await requestText(prompt, input.plugin);
	return trimToWordLimit(text, SHORT_TERM_WORD_LIMIT);
}

async function summarizeLongTermProfile(input: {
	plugin?: PluginContract | null;
	contextMarkdown: string | null;
	existingProfile: string | null;
	messages: ChatMessageDocument[];
	username: string;
	crossSessionContext: string | null;
}): Promise<string> {
	const prompt = [
		"You maintain a durable long-term profile for future conversations with the user.",
		`The user is ${input.username}.`,
		"Use the operating context to decide what is strategically important, but keep the result focused on the user.",
		`Keep the final output under ${LONG_TERM_WORD_LIMIT} words.`,
		"Optimize aggressively for low token input in future prompts.",
		"Write compact markdown with these headings exactly:",
		"## Working Relationship",
		"## Enduring Preferences",
		"## Opinions About Self And Job",
		"## Current Priorities",
		"Rules:",
		"- Keep only durable, repeated, or high-signal facts.",
		"- Explicitly allow personal opinions when the user states opinions about themselves, the job, the work, the team, priorities, or standards.",
		"- Command and analytics interactions matter only if they reveal stable preferences: reporting habits, favored metrics, preferred outputs, workflow expectations, quality bar, or repeated goals.",
		"- Exclude one-off commands, transient report results, and routine operational chatter unless they imply an enduring priority or preference.",
		"- Do not invent facts.",
		"- Merge with the existing profile and remove stale or weak points when unsupported.",
		"- Prefer compressed phrases over full sentences when meaning stays clear.",
		"- Remove low-value context, examples, restatements, and narrative filler.",
		"- Keep only information worth paying tokens for repeatedly across future chats.",
		"- Use the cross-session recaps to detect patterns that span multiple conversations or channels.",
		input.contextMarkdown ? `Operating context:\n${input.contextMarkdown}` : "Operating context:\nNone",
		input.existingProfile ? `Existing long-term profile:\n${input.existingProfile}` : "Existing long-term profile:\nNone",
		input.crossSessionContext ? `Recent session recaps (across all channels):\n${input.crossSessionContext}` : "Recent session recaps:\nNone",
		`New conversation batch (user + assistant):\n${formatMessagesForPrompt(input.messages)}`,
	].join("\n\n");

	const text = await requestText(prompt, input.plugin);
	return trimToWordLimit(text, LONG_TERM_WORD_LIMIT);
}

async function requestText(prompt: string, plugin?: PluginContract | null): Promise<string> {
	const response = await generateText({
		task: "memory",
		model: getChatMemoryModel(plugin),
		plugin: plugin ?? undefined,
		input: [
			{
				role: "system",
				content: [
					{
						type: "input_text",
						text: "You produce compact markdown memory artifacts for a Discord assistant. Follow the requested format exactly and avoid fluff.",
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: prompt,
					},
				],
			},
		] as ResponseInputItem[],
	});

	const text = response.text;
	if (!text) {
		throw new Error("The configured AI provider did not return memory output.");
	}

	return text;
}

function formatMessagesForPrompt(messages: ChatMessageDocument[]): string {
	return messages
		.map((message) => {
			const username =
				typeof message.metadata?.username === "string" && message.metadata.username.trim()
					? message.metadata.username.trim()
					: null;
			const commandName =
				typeof message.metadata?.commandName === "string" && message.metadata.commandName.trim()
					? message.metadata.commandName.trim()
					: null;
			const label =
				message.authorRole === "assistant"
					? "assistant"
					: username
						? `user:${username}`
						: "user";
			const kindLabel = message.kind === "chat" ? null : `kind=${message.kind}`;
			const commandLabel = commandName ? `command=${commandName}` : null;
			return [
				`[${message.createdAt.toISOString()}] ${label}`,
				kindLabel,
				commandLabel,
				`: ${message.content}`,
			]
				.filter((value): value is string => value !== null)
				.join(" ");
		})
		.join("\n");
}

function isMemoryEligibleMessage(message: ChatMessageDocument): boolean {
	return message.metadata?.memoryEligible !== false;
}

function trimToWordLimit(text: string, limit: number): string {
	const normalized = text.trim();
	if (!normalized) {
		return normalized;
	}

	const words = normalized.split(/\s+/);
	if (words.length <= limit) {
		return normalized;
	}

	return `${words.slice(0, limit).join(" ")}...`;
}

function getChatMemoryModel(plugin?: PluginContract | null): string {
	return resolveAiTextModel("memory", { plugin });
}

const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "shall", "can", "need", "dare", "ought",
	"to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
	"into", "through", "during", "before", "after", "above", "below",
	"between", "out", "off", "over", "under", "again", "further", "then",
	"once", "here", "there", "when", "where", "why", "how", "all", "each",
	"every", "both", "few", "more", "most", "other", "some", "such", "no",
	"not", "only", "own", "same", "so", "than", "too", "very", "just",
	"because", "but", "and", "or", "if", "while", "about", "up", "it",
	"its", "this", "that", "these", "those", "i", "me", "my", "we", "our",
	"you", "your", "he", "him", "his", "she", "her", "they", "them", "their",
	"what", "which", "who", "whom", "this", "that", "am", "also", "like",
]);

function extractKeywords(text: string): Set<string> {
	const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
	const keywords = new Set<string>();
	for (const w of words) {
		if (w.length >= 3 && !STOPWORDS.has(w)) {
			keywords.add(w);
		}
	}
	return keywords;
}

function measureKeywordCoverage(
	sourceMessages: ChatMessageDocument[],
	summary: string,
): { coverageRatio: number; found: number; missed: number } {
	const sourceText = sourceMessages.map((m) => m.content).join(" ");
	const sourceKeywords = extractKeywords(sourceText);
	const summaryKeywords = extractKeywords(summary);

	if (sourceKeywords.size === 0) {
		return { coverageRatio: 1, found: 0, missed: 0 };
	}

	let found = 0;
	let missed = 0;
	for (const kw of sourceKeywords) {
		if (summaryKeywords.has(kw)) {
			found++;
		} else {
			missed++;
		}
	}

	return {
		coverageRatio: Math.round((found / sourceKeywords.size) * 100) / 100,
		found,
		missed,
	};
}