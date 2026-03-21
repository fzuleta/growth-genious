import { getChatMemorySnapshot } from "./chat-memory-service";
import {
	getGenerationJobById,
	getLatestJobContext,
	listChatMessagesForMemoryWindow,
	listMemoryEntries,
	listRecentGenerationJobs,
	searchChatMessages,
	type ChatMessageDocument,
	type GenerationJobDocument,
	type MemoryEntryDocument,
	type SmediaMongoDatabase,
} from "./db/mongo";
import type { ChatRouteDecision, ChatRouteEvidence } from "./chat-routing-types";

const MAX_CHAT_MESSAGES = 12;
const MAX_JOBS = 5;
const MAX_KEYWORD_MATCH_MESSAGES = 8;
const MAX_MEMORY_ENTRIES = 4;
const MAX_SNIPPET_LENGTH = 1400;

export async function retrieveDbRouteEvidence(input: {
	database: SmediaMongoDatabase;
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId: string;
	decision: ChatRouteDecision;
}): Promise<ChatRouteEvidence> {
	if (input.decision.route !== "db-query") {
		throw new Error(`DB evidence requested for unsupported route ${input.decision.route}.`);
	}

	const snippets: ChatRouteEvidence["snippets"] = [];
	const summaryParts: string[] = [];
	const [memorySnapshot, recentMessages, userMemoryEntries, sessionMemoryEntries, latestJobContext, jobs, keywordMessages] = await Promise.all([
		getChatMemorySnapshot({
			database: input.database,
			sessionKey: input.sessionKey,
			userId: input.userId,
		}),
		listChatMessagesForMemoryWindow(input.database, {
			sessionKey: input.sessionKey,
			kinds: ["chat", "command", "job-update", "status"],
			limit: MAX_CHAT_MESSAGES,
		}),
		listMemoryEntries(input.database, {
			scope: "user",
			userId: input.userId,
			limit: MAX_MEMORY_ENTRIES,
		}),
		listMemoryEntries(input.database, {
			scope: "session",
			sessionKey: input.sessionKey,
			limit: MAX_MEMORY_ENTRIES,
		}),
		getLatestJobContext(input.database, {
			sessionKey: input.sessionKey,
		}),
		loadRelevantJobs(input),
		searchKeywordMessages(input),
	]);

	if (jobs.length > 0) {
		summaryParts.push(`Loaded ${jobs.length} recent generation job record${jobs.length === 1 ? "" : "s"}.`);
		snippets.push(...jobs.map(formatJobSnippet));
	} else {
		summaryParts.push("No recent generation job records matched this request.");
	}

	if (latestJobContext.latestCommand || latestJobContext.latestJobUpdate) {
		summaryParts.push("Loaded the latest recorded command/job update context from chat history.");
		snippets.push({
			label: "Latest recorded job context",
			content: truncate(formatLatestJobContext(latestJobContext)),
			sourceType: "db",
		});
	}

	if (memorySnapshot.shortTermSummary) {
		summaryParts.push("Loaded the current short-term conversation summary.");
		snippets.push({
			label: "Short-term conversation summary",
			content: truncate(memorySnapshot.shortTermSummary.content),
			sourceType: "db",
			metadata: {
				updatedAt: memorySnapshot.shortTermSummary.updatedAt.toISOString(),
			},
		});
	}

	if (memorySnapshot.longTermProfile) {
		summaryParts.push("Loaded the long-term user profile.");
		snippets.push({
			label: "Long-term user profile",
			content: truncate(memorySnapshot.longTermProfile.content),
			sourceType: "db",
			metadata: {
				updatedAt: memorySnapshot.longTermProfile.updatedAt.toISOString(),
			},
		});
	}

	if (userMemoryEntries.length > 0) {
		summaryParts.push(`Loaded ${userMemoryEntries.length} user memory entr${userMemoryEntries.length === 1 ? "y" : "ies"}.`);
		snippets.push(...userMemoryEntries.map((entry) => formatMemorySnippet(entry, "User memory entry")));
	}

	if (sessionMemoryEntries.length > 0) {
		summaryParts.push(`Loaded ${sessionMemoryEntries.length} session memory entr${sessionMemoryEntries.length === 1 ? "y" : "ies"}.`);
		snippets.push(...sessionMemoryEntries.map((entry) => formatMemorySnippet(entry, "Session memory entry")));
	}

	if (recentMessages.length > 0) {
		summaryParts.push(`Loaded ${recentMessages.length} recent messages from this session.`);
		snippets.push({
			label: "Recent conversation messages",
			content: truncate(formatMessages(recentMessages)),
			sourceType: "db",
		});
	}

	if (keywordMessages.length > 0) {
		summaryParts.push(`Loaded ${keywordMessages.length} keyword-matched chat messages.`);
		snippets.push({
			label: "Keyword-matched messages",
			content: truncate(formatMessages(keywordMessages)),
			sourceType: "db",
		});
	}

	return {
		route: "db-query",
		subject: input.decision.subject,
		summary: summaryParts.join(" "),
		snippets,
	};
}

async function loadRelevantJobs(input: {
	database: SmediaMongoDatabase;
	guildId: string;
	channelId: string;
	userId: string;
	decision: ChatRouteDecision;
}): Promise<GenerationJobDocument[]> {
	if (input.decision.entityHints.jobId) {
		const matched = await getGenerationJobById(input.database, input.decision.entityHints.jobId);
		return matched ? [matched] : [];
	}

	const jobs = await listRecentGenerationJobs(input.database, {
		requestedByUserId: input.userId,
		guildId: input.guildId,
		channelId: input.channelId,
		limit: MAX_JOBS,
	});

	const keywordMatches = filterJobsByHints(jobs, input.decision);
	if (keywordMatches.length > 0) {
		return keywordMatches;
	}

	if (jobs.length > 0) {
		return jobs;
	}

	return listRecentGenerationJobs(input.database, {
		guildId: input.guildId,
		channelId: input.channelId,
		limit: MAX_JOBS,
	});
}

async function searchKeywordMessages(input: {
	database: SmediaMongoDatabase;
	sessionKey: string;
	decision: ChatRouteDecision;
}): Promise<ChatMessageDocument[]> {
	if (input.decision.entityHints.topicKeywords.length === 0) {
		return [];
	}

	return searchChatMessages(input.database, {
		sessionKey: input.sessionKey,
		keywords: input.decision.entityHints.topicKeywords,
		kinds: ["chat", "command", "job-update", "status"],
		limit: MAX_KEYWORD_MATCH_MESSAGES,
	});
}

function filterJobsByHints(jobs: GenerationJobDocument[], decision: ChatRouteDecision): GenerationJobDocument[] {
	const keywords = decision.entityHints.topicKeywords.map((keyword) => keyword.toLowerCase());
	const modelId = decision.entityHints.modelId?.toLowerCase();
	if (!modelId && keywords.length === 0) {
		return [];
	}

	return jobs.filter((job) => {
		const haystack = JSON.stringify(job).toLowerCase();
		if (modelId && haystack.includes(modelId)) {
			return true;
		}
		return keywords.some((keyword) => haystack.includes(keyword));
	});
}

function formatLatestJobContext(input: {
	latestCommand: ChatMessageDocument | null;
	latestJobUpdate: ChatMessageDocument | null;
}): string {
	const lines: string[] = [];
	if (input.latestCommand) {
		lines.push(`latestCommandAt=${input.latestCommand.createdAt.toISOString()}`);
		lines.push(`latestCommand=${input.latestCommand.content}`);
	}
	if (input.latestJobUpdate) {
		lines.push(`latestJobUpdateAt=${input.latestJobUpdate.createdAt.toISOString()}`);
		lines.push(`latestJobUpdate=${input.latestJobUpdate.content}`);
	}
	return lines.join("\n");
}

function formatMemorySnippet(entry: MemoryEntryDocument, labelPrefix: string): ChatRouteEvidence["snippets"][number] {
	return {
		label: `${labelPrefix} (${entry.kind})`,
		content: truncate(entry.content),
		sourceType: "db",
		metadata: {
			scope: entry.scope,
			updatedAt: entry.updatedAt.toISOString(),
		},
	};
}

function formatJobSnippet(job: GenerationJobDocument): ChatRouteEvidence["snippets"][number] {
	const events = Array.isArray(job.events) ? job.events : [];
	const lines = [
		`jobId=${job.jobId}`,
		`status=${job.status}`,
		`createdAt=${job.createdAt.toISOString()}`,
		`updatedAt=${job.updatedAt.toISOString()}`,
	];

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
	if (events.length > 0) {
		lines.push(`eventCount=${events.length}`);
		for (const event of events.slice(-5)) {
			const detailSuffix = event.details ? ` details=${JSON.stringify(event.details)}` : "";
			lines.push(
				`event=${event.createdAt.toISOString()} stage=${event.stage} status=${event.status} message=${event.message}${detailSuffix}`,
			);
		}
	}
	if (job.resolved.primaryOutputPath) {
		lines.push(`primaryOutputPath=${job.resolved.primaryOutputPath}`);
	}

	return {
		label: `Generation job ${job.jobId}`,
		content: truncate(lines.join("\n")),
		sourceType: "db",
	};
}

function formatMessages(messages: ChatMessageDocument[]): string {
	return messages
		.map((message) => {
			const userPart = message.userId ? ` userId=${message.userId}` : "";
			return `${message.createdAt.toISOString()} [${message.authorRole}/${message.kind}]${userPart} ${message.content}`;
		})
		.join("\n");
}

function truncate(text: string): string {
	return text.length <= MAX_SNIPPET_LENGTH ? text : `${text.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
}