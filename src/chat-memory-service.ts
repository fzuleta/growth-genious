import type { ResponseInputItem } from "openai/resources/responses/responses";
import { readOptionalContextMarkdown } from "./context-service";
import {
	getLatestMemoryEntry,
	getMemoryCheckpoint,
	listChatMessagesForMemoryWindow,
	listMemoryEntries,
	markSessionConsolidated,
	upsertMemoryCheckpoint,
	upsertMemoryEntry,
	type ChatMessageDocument,
	type MemoryEntryDocument,
	type SmediaMongoDatabase,
} from "./db/mongo";
import { logInfo, logWarn } from "./helpers/log";
import { createOpenAIClient } from "./openai/openai";

const SHORT_TERM_SOURCE_LIMIT = 50;
const LONG_TERM_SOURCE_LIMIT = 50;
const MAX_SESSIONS_PER_CYCLE = 20;
const SHORT_TERM_PROMPT_LIMIT = 1;
const LONG_TERM_WORD_LIMIT = 3000;
const SHORT_TERM_WORD_LIMIT = 1000;

export interface ChatMemorySnapshot {
	shortTermSummary: MemoryEntryDocument | null;
	longTermProfile: MemoryEntryDocument | null;
}

export async function getChatMemorySnapshot(input: {
	database: SmediaMongoDatabase;
	sessionKey: string;
	userId: string;
}): Promise<ChatMemorySnapshot> {
	const [shortTermSummaries, longTermProfile] = await Promise.all([
		listMemoryEntries(input.database, {
			kinds: ["short-term-summary"],
			scope: "session",
			sessionKey: input.sessionKey,
			limit: SHORT_TERM_PROMPT_LIMIT,
		}),
		getLatestMemoryEntry(input.database, {
			kinds: ["long-term-profile"],
			scope: "user",
			userId: input.userId,
		}),
	]);

	return {
		shortTermSummary: shortTermSummaries[0] ?? null,
		longTermProfile,
	};
}

export async function formatMemoryInspect(input: {
	database: SmediaMongoDatabase;
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
				contextMarkdown,
				sessionKey: session.sessionKey,
				guildId: session.guildId,
				channelId: session.channelId,
				sessionLastMessageAt: session.lastMessageAt,
			});

			if (result.sessionConsolidatedAt) {
				await markSessionConsolidated(
					input.database,
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
		kind: "session-short-term",
		sessionKey: input.sessionKey,
	});
	const sourceWindow = await listChatMessagesForMemoryWindow(input.database, {
		sessionKey: input.sessionKey,
		kinds: ["chat"],
		afterCreatedAt: checkpoint?.lastParsedMessageAt ?? undefined,
		limit: SHORT_TERM_SOURCE_LIMIT + 1,
	});
	const hasMoreSourceMessages = sourceWindow.length > SHORT_TERM_SOURCE_LIMIT;
	const sourceMessages = hasMoreSourceMessages
		? sourceWindow.slice(0, SHORT_TERM_SOURCE_LIMIT)
		: sourceWindow;

	if (sourceMessages.length === 0) {
		await upsertMemoryCheckpoint(input.database, {
			kind: "session-short-term",
			sessionKey: input.sessionKey,
			guildId: input.guildId,
			channelId: input.channelId,
			lastParsedMessageAt: checkpoint?.lastParsedMessageAt ?? null,
			lastSourceUpdatedAt: input.sessionLastMessageAt,
			metadata: {
				messageCount: 0,
				hasMoreSourceMessages: false,
			},
			updatedAt: input.sessionLastMessageAt,
		});

		return {
			updatedShortTerm: false,
			updatedLongTermCount: 0,
			parsedChatMessageCount: 0,
			sessionConsolidatedAt: input.sessionLastMessageAt,
		};
	}

	const latestShortTerm = await getLatestMemoryEntry(input.database, {
		kinds: ["short-term-summary"],
		scope: "session",
		sessionKey: input.sessionKey,
	});
	const summaryContent = await summarizeShortTermMemory({
		contextMarkdown: input.contextMarkdown,
		existingSummary: latestShortTerm?.content ?? null,
		messages: sourceMessages,
	});

	const previousWords = latestShortTerm ? latestShortTerm.content.split(/\s+/).length : 0;
	const newWords = summaryContent.split(/\s+/).length;
	logInfo("Short-term memory consolidation metrics", {
		sessionKey: input.sessionKey,
		previousWords,
		newWords,
		sourceMessageCount: sourceMessages.length,
		wordLimit: SHORT_TERM_WORD_LIMIT,
	});
	const createdAt = sourceMessages[sourceMessages.length - 1]?.createdAt ?? new Date();
	const participants = collectParticipants(sourceMessages);

	await upsertMemoryEntry(input.database, {
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
			contextMarkdown: input.contextMarkdown,
			userId,
			username,
			supportingShortTermSummary: summaryContent,
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
	contextMarkdown: string | null;
	userId: string;
	username: string;
	supportingShortTermSummary: string;
	guildId: string;
	channelId: string;
}): Promise<boolean> {
	const checkpoint = await getMemoryCheckpoint(input.database, {
		kind: "user-long-term",
		userId: input.userId,
	});
	const sourceMessages = await input.database.collections.chatMessages
		.find({
			kind: "chat",
			$or: [
				{ authorRole: "user", userId: input.userId },
				{ authorRole: "assistant" },
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

	if (sourceMessages.length === 0) {
		return false;
	}

	const latestProfile = await getLatestMemoryEntry(input.database, {
		kinds: ["long-term-profile"],
		scope: "user",
		userId: input.userId,
	});
	const profileContent = await summarizeLongTermProfile({
		contextMarkdown: input.contextMarkdown,
		existingProfile: latestProfile?.content ?? null,
		messages: sourceMessages,
		username: input.username,
		supportingShortTermSummary: input.supportingShortTermSummary,
	});

	const previousWords = latestProfile ? latestProfile.content.split(/\s+/).length : 0;
	const newWords = profileContent.split(/\s+/).length;
	logInfo("Long-term profile consolidation metrics", {
		userId: input.userId,
		previousWords,
		newWords,
		sourceMessageCount: sourceMessages.length,
		wordLimit: LONG_TERM_WORD_LIMIT,
	});
	const createdAt = sourceMessages[sourceMessages.length - 1]?.createdAt ?? new Date();

	await upsertMemoryEntry(input.database, {
		kind: "long-term-profile",
		scope: "user",
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId,
		title: `User profile for ${input.username}`,
		content: profileContent,
		tags: ["long-term", "profile"],
		metadata: {
			windowStartedAt: sourceMessages[0]?.createdAt.toISOString() ?? null,
			windowEndedAt: createdAt.toISOString(),
			sourceMessageCount: sourceMessages.length,
		},
		updatedAt: createdAt,
	});

	await upsertMemoryCheckpoint(input.database, {
		kind: "user-long-term",
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId,
		lastParsedMessageAt: createdAt,
		metadata: {
			username: input.username,
			sourceMessageCount: sourceMessages.length,
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
		"- Include decisions, constraints, current asks, and active job context when relevant.",
		"- In Preferences And Opinions, only include durable preferences or explicit opinions about the user, the job, the work, quality bar, priorities, or process.",
		"- Ignore trivial banter.",
		"- Prefer compressed phrases over full sentences when meaning stays clear.",
		"- Drop low-value detail, repetition, examples, and narrative glue.",
		"- Keep only information worth paying tokens for in future chats.",
		input.contextMarkdown ? `Operating context:\n${input.contextMarkdown}` : "Operating context:\nNone",
		input.existingSummary ? `Existing short-term memory:\n${input.existingSummary}` : "Existing short-term memory:\nNone",
		`New conversation batch:\n${formatMessagesForPrompt(input.messages)}`,
	].join("\n\n");

	const text = await requestText(prompt);
	return trimToWordLimit(text, SHORT_TERM_WORD_LIMIT);
}

async function summarizeLongTermProfile(input: {
	contextMarkdown: string | null;
	existingProfile: string | null;
	messages: ChatMessageDocument[];
	username: string;
	supportingShortTermSummary: string;
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
		"- Do not invent facts.",
		"- Merge with the existing profile and remove stale or weak points when unsupported.",
		"- Prefer compressed phrases over full sentences when meaning stays clear.",
		"- Remove low-value context, examples, restatements, and narrative filler.",
		"- Keep only information worth paying tokens for repeatedly across future chats.",
		input.contextMarkdown ? `Operating context:\n${input.contextMarkdown}` : "Operating context:\nNone",
		input.existingProfile ? `Existing long-term profile:\n${input.existingProfile}` : "Existing long-term profile:\nNone",
		`Latest session short-term memory:\n${input.supportingShortTermSummary}`,
		`New conversation batch (user + assistant):\n${formatMessagesForPrompt(input.messages)}`,
	].join("\n\n");

	const text = await requestText(prompt);
	return trimToWordLimit(text, LONG_TERM_WORD_LIMIT);
}

async function requestText(prompt: string): Promise<string> {
	const client = createOpenAIClient();
	const response = await client.responses.create({
		model: getChatMemoryModel(),
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

	const text = response.output_text.trim();
	if (!text) {
		throw new Error("OpenAI did not return memory output.");
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
			const label =
				message.authorRole === "assistant"
					? "assistant"
					: username
						? `user:${username}`
						: "user";
			return `[${message.createdAt.toISOString()}] ${label}: ${message.content}`;
		})
		.join("\n");
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

function getChatMemoryModel(): string {
	return process.env.OPENAI_CHAT_MEMORY_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
}