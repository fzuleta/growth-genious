import {
	MongoClient,
	type Collection,
	type Db,
	type Document,
	type ObjectId,
} from "mongodb";

const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_NAME = "social-media-script";
const DEFAULT_RETENTION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SMEDIA_COLLECTION_NAMES = {
	chatSessions: "smedia-chat-sessions",
	chatMessages: "smedia-chat-messages",
	memoryEntries: "smedia-memory-entries",
	memoryCheckpoints: "smedia-memory-checkpoints",
	generationJobs: "smedia-generation-jobs",
	contextDocuments: "smedia-context-documents",
	openAiDebugInputs: "smedia-openai-debug-inputs",
} as const;

export type ChatMessageKind = "chat" | "command" | "status" | "job-update";
export type ChatAuthorRole = "user" | "assistant" | "system";
export type MemoryEntryKind =
	| "manual-note"
	| "session-summary"
	| "user-preference"
	| "brand-context"
	| "short-term-summary"
	| "middle-term-summary"
	| "long-term-profile"
	| "positive-signal";
export type MemoryEntryScope = "session" | "user" | "workspace";
export type MemoryCheckpointKind = "session-short-term" | "user-long-term";

export interface ChatSessionDocument {
	_id?: ObjectId;
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId?: string | null;
	title?: string | null;
	summary?: string | null;
	messageCount: number;
	memoryEntryIds: ObjectId[];
	createdAt: Date;
	updatedAt: Date;
	lastMessageAt: Date;
	lastConsolidatedAt?: Date | null;
	archivedAt?: Date | null;
}

export interface ChatMessageDocument {
	_id?: ObjectId;
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId?: string | null;
	discordMessageId?: string | null;
	authorRole: ChatAuthorRole;
	kind: ChatMessageKind;
	content: string;
	metadata?: Document;
	createdAt: Date;
}

export interface MemoryEntryDocument {
	_id?: ObjectId;
	kind: MemoryEntryKind;
	scope: MemoryEntryScope;
	sessionKey?: string | null;
	guildId?: string | null;
	channelId?: string | null;
	userId?: string | null;
	title?: string | null;
	content: string;
	tags: string[];
	metadata?: Document;
	sourceSessionId?: ObjectId | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface MemoryCheckpointDocument {
	_id?: ObjectId;
	kind: MemoryCheckpointKind;
	sessionKey?: string | null;
	guildId?: string | null;
	channelId?: string | null;
	userId?: string | null;
	lastParsedMessageAt?: Date | null;
	lastSourceUpdatedAt?: Date | null;
	metadata?: Document;
	createdAt: Date;
	updatedAt: Date;
}

export interface GenerationJobDocument {
	_id?: ObjectId;
	jobId: string;
	source: "discord";
	status: "queued" | "running" | "completed" | "failed";
	guildId?: string | null;
	channelId?: string | null;
	requestMessageId?: string | null;
	requestedByUserId?: string | null;
	requestedByUsername?: string | null;
	request: {
		modelId?: string | null;
		postType?: string | null;
		s3FolderPath?: string | null;
		caption?: string | null;
		mode?: string | null;
	};
	resolved: {
		modelId?: string | null;
		postType?: string | null;
		mode?: string | null;
		outputDir?: string | null;
		primaryOutputPath?: string | null;
		generationResultPath?: string | null;
		captionPath?: string | null;
	};
	artifacts?: Document;
	errorMessage?: string | null;
	events: GenerationJobEventDocument[];
	createdAt: Date;
	updatedAt: Date;
	startedAt?: Date | null;
	completedAt?: Date | null;
}

export interface GenerationJobEventDocument {
	stage: string;
	status: "started" | "completed" | "warning" | "failed" | "info";
	message: string;
	details?: Document;
	createdAt: Date;
}

export interface ContextDocument {
	_id?: ObjectId;
	key: string;
	content: string;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface OpenAiDebugInputDocument {
	_id?: ObjectId;
	source: "freetalk" | "router";
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId?: string | null;
	username?: string | null;
	discordMessageId?: string | null;
	model: string;
	promptText: string;
	promptItems: Array<{
		role: ChatAuthorRole;
		text: string;
	}>;
	metadata?: Document;
	createdAt: Date;
}

export interface SmediaMongoCollections {
	chatSessions: Collection<ChatSessionDocument>;
	chatMessages: Collection<ChatMessageDocument>;
	memoryEntries: Collection<MemoryEntryDocument>;
	memoryCheckpoints: Collection<MemoryCheckpointDocument>;
	generationJobs: Collection<GenerationJobDocument>;
	contextDocuments: Collection<ContextDocument>;
	openAiDebugInputs: Collection<OpenAiDebugInputDocument>;
}

export interface SmediaMongoDatabase {
	client: MongoClient;
	db: Db;
	collections: SmediaMongoCollections;
	collectionNames: typeof SMEDIA_COLLECTION_NAMES;
	close: () => Promise<void>;
}

export interface MongoConfig {
	uri: string;
	databaseName: string;
	connectionSource: "MONGODB_URI" | "mongo_db_*";
}

export async function initializeMongoDatabase(env = process.env): Promise<SmediaMongoDatabase> {
	const config = readMongoConfig(env);
	const client = new MongoClient(config.uri, {
		appName: "social-media-script",
		serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
	});

	await client.connect();
	const db = client.db(config.databaseName);
	const collections = {
		chatSessions: db.collection<ChatSessionDocument>(SMEDIA_COLLECTION_NAMES.chatSessions),
		chatMessages: db.collection<ChatMessageDocument>(SMEDIA_COLLECTION_NAMES.chatMessages),
		memoryEntries: db.collection<MemoryEntryDocument>(SMEDIA_COLLECTION_NAMES.memoryEntries),
		memoryCheckpoints: db.collection<MemoryCheckpointDocument>(SMEDIA_COLLECTION_NAMES.memoryCheckpoints),
		generationJobs: db.collection<GenerationJobDocument>(SMEDIA_COLLECTION_NAMES.generationJobs),
		contextDocuments: db.collection<ContextDocument>(SMEDIA_COLLECTION_NAMES.contextDocuments),
		openAiDebugInputs: db.collection<OpenAiDebugInputDocument>(SMEDIA_COLLECTION_NAMES.openAiDebugInputs),
	};

	await ensureIndexes(collections);

	return {
		client,
		db,
		collections,
		collectionNames: SMEDIA_COLLECTION_NAMES,
		close: async () => {
			await client.close();
		},
	};
}

export function buildChatSessionKey(input: {
	guildId: string;
	channelId: string;
}): string {
	return `${input.guildId}:${input.channelId}`;
}

export async function appendChatMessage(
	database: SmediaMongoDatabase,
	input: {
		sessionKey: string;
		guildId: string;
		channelId: string;
		userId?: string | null;
		discordMessageId?: string | null;
		authorRole: ChatAuthorRole;
		kind: ChatMessageKind;
		content: string;
		metadata?: Document;
		createdAt?: Date;
	},
): Promise<void> {
	const createdAt = input.createdAt ?? new Date();
	const normalizedContent = input.content.trim();
	if (!normalizedContent) {
		return;
	}

	await Promise.all([
		database.collections.chatMessages.insertOne({
			sessionKey: input.sessionKey,
			guildId: input.guildId,
			channelId: input.channelId,
			userId: input.userId ?? null,
			discordMessageId: input.discordMessageId ?? null,
			authorRole: input.authorRole,
			kind: input.kind,
			content: normalizedContent,
			metadata: input.metadata,
			createdAt,
		}),
		database.collections.chatSessions.updateOne(
			{ sessionKey: input.sessionKey },
			{
				$setOnInsert: {
					sessionKey: input.sessionKey,
					guildId: input.guildId,
					channelId: input.channelId,
					userId: input.userId ?? null,
					title: null,
					summary: null,
					memoryEntryIds: [],
					createdAt,
				},
				$set: {
					updatedAt: createdAt,
					lastMessageAt: createdAt,
				},
				$inc: {
					messageCount: 1,
				},
			},
			{ upsert: true },
		),
	]);
}

export async function markSessionConsolidated(
	database: SmediaMongoDatabase,
	sessionKey: string,
	consolidatedAt: Date,
): Promise<void> {
	await database.collections.chatSessions.updateOne(
		{ sessionKey },
		{ $set: { lastConsolidatedAt: consolidatedAt } },
	);
}

export async function listRecentChatMessages(
	database: SmediaMongoDatabase,
	input: {
		sessionKey: string;
		limit: number;
		kinds?: ChatMessageKind[];
	},
): Promise<ChatMessageDocument[]> {
	const filter: Document = {
		sessionKey: input.sessionKey,
	};

	if (input.kinds && input.kinds.length > 0) {
		filter.kind = { $in: input.kinds };
	}

	const results = await database.collections.chatMessages
		.find(filter)
		.sort({ createdAt: -1 })
		.limit(input.limit)
		.toArray();

	return results.reverse();
}

export async function listChatMessagesForMemoryWindow(
	database: SmediaMongoDatabase,
	input: {
		sessionKey: string;
		kinds?: ChatMessageKind[];
		afterCreatedAt?: Date;
		beforeCreatedAt?: Date;
		limit?: number;
	},
): Promise<ChatMessageDocument[]> {
	const filter: Document = {
		sessionKey: input.sessionKey,
	};

	if (input.kinds && input.kinds.length > 0) {
		filter.kind = { $in: input.kinds };
	}

	if (input.afterCreatedAt || input.beforeCreatedAt) {
		filter.createdAt = {};
		if (input.afterCreatedAt) {
			filter.createdAt.$gt = input.afterCreatedAt;
		}
		if (input.beforeCreatedAt) {
			filter.createdAt.$lte = input.beforeCreatedAt;
		}
	}

	const cursor = database.collections.chatMessages.find(filter).sort({ createdAt: 1 });
	if (input.limit && input.limit > 0) {
		cursor.limit(input.limit);
	}

	return cursor.toArray();
}

export async function getLatestJobContext(
	database: SmediaMongoDatabase,
	input: {
		sessionKey: string;
	},
): Promise<{
		latestCommand: ChatMessageDocument | null;
		latestJobUpdate: ChatMessageDocument | null;
	}> {
	const [latestCommand, latestJobUpdate] = await Promise.all([
		database.collections.chatMessages.findOne(
			{
				sessionKey: input.sessionKey,
				kind: "command",
			},
			{
				sort: { createdAt: -1 },
			},
		),
		database.collections.chatMessages.findOne(
			{
				sessionKey: input.sessionKey,
				kind: "job-update",
			},
			{
				sort: { createdAt: -1 },
			},
		),
	]);

	return {
		latestCommand,
		latestJobUpdate,
	};
}

export async function createMemoryEntry(
	database: SmediaMongoDatabase,
	input: {
		kind: MemoryEntryKind;
		scope: MemoryEntryScope;
		sessionKey?: string | null;
		guildId?: string | null;
		channelId?: string | null;
		userId?: string | null;
		title?: string | null;
		content: string;
		tags?: string[];
		metadata?: Document;
		sourceSessionId?: ObjectId | null;
		createdAt?: Date;
		updatedAt?: Date;
	},
): Promise<MemoryEntryDocument> {
	const createdAt = input.createdAt ?? new Date();
	const updatedAt = input.updatedAt ?? createdAt;
	const content = input.content.trim();
	if (!content) {
		throw new Error("Cannot create an empty memory entry.");
	}

	const document: MemoryEntryDocument = {
		kind: input.kind,
		scope: input.scope,
		sessionKey: input.sessionKey ?? null,
		guildId: input.guildId ?? null,
		channelId: input.channelId ?? null,
		userId: input.userId ?? null,
		title: input.title ?? null,
		content,
		tags: normalizeTags(input.tags ?? []),
		metadata: input.metadata,
		sourceSessionId: input.sourceSessionId ?? null,
		createdAt,
		updatedAt,
	};

	const result = await database.collections.memoryEntries.insertOne(document);
	const insertedDocument: MemoryEntryDocument = {
		...document,
		_id: result.insertedId,
	};

	if (document.scope === "session" && document.sessionKey) {
		await database.collections.chatSessions.updateOne(
			{ sessionKey: document.sessionKey },
			{
				$addToSet: {
					memoryEntryIds: result.insertedId,
				},
			},
		);
	}

	return insertedDocument;
}

export async function upsertMemoryEntry(
	database: SmediaMongoDatabase,
	input: {
		kind: MemoryEntryKind;
		scope: MemoryEntryScope;
		sessionKey?: string | null;
		guildId?: string | null;
		channelId?: string | null;
		userId?: string | null;
		title?: string | null;
		content: string;
		tags?: string[];
		metadata?: Document;
		updatedAt?: Date;
	},
): Promise<MemoryEntryDocument> {
	const now = input.updatedAt ?? new Date();
	const content = input.content.trim();
	if (!content) {
		throw new Error("Cannot upsert an empty memory entry.");
	}

	const filter: Document = { kind: input.kind, scope: input.scope };
	if (input.sessionKey) {
		filter.sessionKey = input.sessionKey;
	}
	if (input.userId) {
		filter.userId = input.userId;
	}

	const result = await database.collections.memoryEntries.findOneAndUpdate(
		filter,
		{
			$setOnInsert: {
				kind: input.kind,
				scope: input.scope,
				sessionKey: input.sessionKey ?? null,
				userId: input.userId ?? null,
				sourceSessionId: null,
				createdAt: now,
			},
			$set: {
				title: input.title ?? null,
				content,
				tags: normalizeTags(input.tags ?? []),
				metadata: input.metadata,
				guildId: input.guildId ?? null,
				channelId: input.channelId ?? null,
				updatedAt: now,
			},
		},
		{
			upsert: true,
			returnDocument: "after",
		},
	);

	if (!result) {
		throw new Error("Failed to upsert memory entry.");
	}

	return result;
}

export async function createGenerationJob(
	database: SmediaMongoDatabase,
	input: {
		jobId: string;
		source: "discord";
		guildId?: string | null;
		channelId?: string | null;
		requestMessageId?: string | null;
		requestedByUserId?: string | null;
		requestedByUsername?: string | null;
		request: {
			modelId?: string | null;
			postType?: string | null;
			s3FolderPath?: string | null;
			caption?: string | null;
			mode?: string | null;
		};
		createdAt?: Date;
	},
): Promise<GenerationJobDocument> {
	const createdAt = input.createdAt ?? new Date();
	const document: GenerationJobDocument = {
		jobId: input.jobId,
		source: input.source,
		status: "queued",
		guildId: input.guildId ?? null,
		channelId: input.channelId ?? null,
		requestMessageId: input.requestMessageId ?? null,
		requestedByUserId: input.requestedByUserId ?? null,
		requestedByUsername: input.requestedByUsername ?? null,
		request: {
			modelId: input.request.modelId ?? null,
			postType: input.request.postType ?? null,
			s3FolderPath: input.request.s3FolderPath ?? null,
			caption: input.request.caption ?? null,
			mode: input.request.mode ?? null,
		},
		resolved: {},
		errorMessage: null,
		events: [
			{
				stage: "queue",
				status: "info",
				message: "Job accepted into queue.",
				details: {
					requestedModelId: input.request.modelId ?? null,
					requestedPostType: input.request.postType ?? null,
					requestedMode: input.request.mode ?? null,
					s3FolderPath: input.request.s3FolderPath ?? null,
				},
				createdAt,
			},
		],
		createdAt,
		updatedAt: createdAt,
		startedAt: null,
		completedAt: null,
	};

	const result = await database.collections.generationJobs.insertOne(document);
	return {
		...document,
		_id: result.insertedId,
	};
}

export async function updateGenerationJob(
	database: SmediaMongoDatabase,
	input: {
		jobId: string;
		status?: "queued" | "running" | "completed" | "failed";
		resolved?: {
			modelId?: string | null;
			postType?: string | null;
			mode?: string | null;
			outputDir?: string | null;
			primaryOutputPath?: string | null;
			generationResultPath?: string | null;
			captionPath?: string | null;
		};
		artifacts?: Document;
		errorMessage?: string | null;
		startedAt?: Date | null;
		completedAt?: Date | null;
		updatedAt?: Date;
	},
): Promise<void> {
	const updatedAt = input.updatedAt ?? new Date();
	const setDocument: Document = {
		updatedAt,
	};

	if (input.status) {
		setDocument.status = input.status;
	}
	if (input.resolved) {
		setDocument.resolved = input.resolved;
	}
	if (input.artifacts) {
		setDocument.artifacts = input.artifacts;
	}
	if (input.errorMessage !== undefined) {
		setDocument.errorMessage = input.errorMessage;
	}
	if (input.startedAt !== undefined) {
		setDocument.startedAt = input.startedAt;
	}
	if (input.completedAt !== undefined) {
		setDocument.completedAt = input.completedAt;
	}

	await database.collections.generationJobs.updateOne(
		{ jobId: input.jobId },
		{
			$set: setDocument,
		},
	);
}

export async function appendGenerationJobEvent(
	database: SmediaMongoDatabase,
	input: {
		jobId: string;
		stage: string;
		status: GenerationJobEventDocument["status"];
		message: string;
		details?: Document;
		createdAt?: Date;
	},
): Promise<void> {
	const createdAt = input.createdAt ?? new Date();
	await database.collections.generationJobs.updateOne(
		{ jobId: input.jobId },
		{
			$set: {
				updatedAt: createdAt,
			},
			$push: {
				events: {
					stage: input.stage.trim(),
					status: input.status,
					message: input.message.trim(),
					details: input.details,
					createdAt,
				},
			},
		},
	);
}

export async function getGenerationJobById(
	database: SmediaMongoDatabase,
	jobId: string,
): Promise<GenerationJobDocument | null> {
	return database.collections.generationJobs.findOne({ jobId: jobId.trim() });
}

export async function listRecentGenerationJobs(
	database: SmediaMongoDatabase,
	input: {
		requestedByUserId?: string;
		guildId?: string;
		channelId?: string;
		statuses?: Array<GenerationJobDocument["status"]>;
		limit: number;
	},
): Promise<GenerationJobDocument[]> {
	const filter: Document = {};

	if (input.requestedByUserId) {
		filter.requestedByUserId = input.requestedByUserId;
	}
	if (input.guildId) {
		filter.guildId = input.guildId;
	}
	if (input.channelId) {
		filter.channelId = input.channelId;
	}
	if (input.statuses && input.statuses.length > 0) {
		filter.status = { $in: input.statuses };
	}

	return database.collections.generationJobs
		.find(filter)
		.sort({ createdAt: -1 })
		.limit(input.limit)
		.toArray();
}

export async function getMemoryCheckpoint(
	database: SmediaMongoDatabase,
	input: {
		kind: MemoryCheckpointKind;
		sessionKey?: string;
		userId?: string;
	},
): Promise<MemoryCheckpointDocument | null> {
	const filter = buildMemoryCheckpointFilter(input);
	return database.collections.memoryCheckpoints.findOne(filter, {
		sort: { updatedAt: -1, createdAt: -1 },
	});
}

export async function upsertMemoryCheckpoint(
	database: SmediaMongoDatabase,
	input: {
		kind: MemoryCheckpointKind;
		sessionKey?: string | null;
		guildId?: string | null;
		channelId?: string | null;
		userId?: string | null;
		lastParsedMessageAt?: Date | null;
		lastSourceUpdatedAt?: Date | null;
		metadata?: Document;
		updatedAt?: Date;
	},
): Promise<MemoryCheckpointDocument> {
	const now = input.updatedAt ?? new Date();
	const filter = buildMemoryCheckpointFilter({
		kind: input.kind,
		sessionKey: input.sessionKey ?? undefined,
		userId: input.userId ?? undefined,
	});
	const result = await database.collections.memoryCheckpoints.findOneAndUpdate(
		filter,
		{
			$setOnInsert: {
				kind: input.kind,
				sessionKey: input.sessionKey ?? null,
				userId: input.userId ?? null,
				createdAt: now,
			},
			$set: {
				guildId: input.guildId ?? null,
				channelId: input.channelId ?? null,
				lastParsedMessageAt: input.lastParsedMessageAt ?? null,
				lastSourceUpdatedAt: input.lastSourceUpdatedAt ?? null,
				metadata: input.metadata,
				updatedAt: now,
			},
		},
		{
			upsert: true,
			returnDocument: "after",
		},
	);

	if (!result) {
		throw new Error("Failed to upsert memory checkpoint.");
	}

	return result;
}

export async function createOpenAiDebugInput(
	database: SmediaMongoDatabase,
	input: {
		source: "freetalk" | "router";
		sessionKey: string;
		guildId: string;
		channelId: string;
		userId?: string | null;
		username?: string | null;
		discordMessageId?: string | null;
		model: string;
		promptText: string;
		promptItems: Array<{
			role: ChatAuthorRole;
			text: string;
		}>;
		metadata?: Document;
		createdAt?: Date;
	},
): Promise<OpenAiDebugInputDocument> {
	const createdAt = input.createdAt ?? new Date();
	const promptText = input.promptText.trim();
	const promptItems = input.promptItems
		.map((item) => ({
			role: item.role,
			text: item.text.trim(),
		}))
		.filter((item) => item.text.length > 0);

	if (!promptText) {
		throw new Error("Cannot create an OpenAI debug record with an empty prompt.");
	}

	const document: OpenAiDebugInputDocument = {
		source: input.source,
		sessionKey: input.sessionKey,
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId ?? null,
		username: input.username ?? null,
		discordMessageId: input.discordMessageId ?? null,
		model: input.model,
		promptText,
		promptItems,
		metadata: input.metadata,
		createdAt,
	};

	const result = await database.collections.openAiDebugInputs.insertOne(document);
	return {
		...document,
		_id: result.insertedId,
	};
}

export async function listMemoryEntries(
	database: SmediaMongoDatabase,
	input: {
		kinds?: MemoryEntryKind[];
		scope?: MemoryEntryScope;
		sessionKey?: string;
		guildId?: string;
		channelId?: string;
		userId?: string;
		limit: number;
	},
): Promise<MemoryEntryDocument[]> {
	const filter = buildMemoryFilter(input);

	return database.collections.memoryEntries
		.find(filter)
		.sort({ updatedAt: -1, createdAt: -1 })
		.limit(input.limit)
		.toArray();
}

export async function searchChatMessages(
	database: SmediaMongoDatabase,
	input: {
		sessionKey?: string;
		guildId?: string;
		channelId?: string;
		userId?: string;
		keywords: string[];
		kinds?: ChatMessageKind[];
		limit: number;
	},
): Promise<ChatMessageDocument[]> {
	const cleanedKeywords = Array.from(
		new Set(input.keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0)),
	);
	if (cleanedKeywords.length === 0) {
		return [];
	}

	const filter: Document = {
		content: {
			$regex: cleanedKeywords.map(escapeRegex).join("|"),
			$options: "i",
		},
	};

	if (input.sessionKey) {
		filter.sessionKey = input.sessionKey;
	}
	if (input.guildId) {
		filter.guildId = input.guildId;
	}
	if (input.channelId) {
		filter.channelId = input.channelId;
	}
	if (input.userId) {
		filter.userId = input.userId;
	}
	if (input.kinds && input.kinds.length > 0) {
		filter.kind = { $in: input.kinds };
	}

	return database.collections.chatMessages
		.find(filter)
		.sort({ createdAt: -1 })
		.limit(input.limit)
		.toArray();
}

export async function getLatestMemoryEntry(
	database: SmediaMongoDatabase,
	input: {
		kinds?: MemoryEntryKind[];
		scope?: MemoryEntryScope;
		sessionKey?: string;
		guildId?: string;
		channelId?: string;
		userId?: string;
	},
): Promise<MemoryEntryDocument | null> {
	const filter = buildMemoryFilter(input);

	return database.collections.memoryEntries.findOne(filter, {
		sort: { updatedAt: -1, createdAt: -1 },
	});
}

export function readMongoConfig(env = process.env): MongoConfig {
	const uri = env.MONGODB_URI?.trim();
	const databaseName =
		env.MONGODB_DB_NAME?.trim() ||
		env.mongo_db_name?.trim() ||
		DEFAULT_DATABASE_NAME;

	if (uri) {
		return {
			uri,
			databaseName,
			connectionSource: "MONGODB_URI",
		};
	}

	const mongoDbUser = env.mongo_db_user?.trim();
	const mongoDbPassword = env.mongo_db_password?.trim();
	const mongoDbHost = env.mongo_db_host?.trim();
	const mongoDbTls = env.mongo_db_tls?.trim();

	if (!mongoDbUser || !mongoDbPassword || !mongoDbHost) {
		throw new Error(
			"Missing MongoDB config. Set MONGODB_URI or provide mongo_db_user, mongo_db_password, and mongo_db_host.",
		);
	}

	return {
		uri: buildMongoUri({
			user: mongoDbUser,
			password: mongoDbPassword,
			host: mongoDbHost,
			tls: parseMongoTls(mongoDbTls),
		}),
		databaseName,
		connectionSource: "mongo_db_*",
	};
}

function buildMongoUri(input: {
	user: string;
	password: string;
	host: string;
	tls: boolean;
}): string {
	const schemeMatch = input.host.match(/^(mongodb(?:\+srv)?:\/\/)/);
	const protocol = schemeMatch?.[1] ?? "mongodb://";
	const normalizedHost = input.host.replace(/^mongodb(\+srv)?:\/\//, "");
	const auth = `${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}@`;
	const separator = normalizedHost.includes("?") ? "&" : "?";
	return `${protocol}${auth}${normalizedHost}${separator}tls=${input.tls ? "true" : "false"}`;
}

function parseMongoTls(value: string | undefined): boolean {
	if (!value) {
		return true;
	}

	const normalized = value.toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "no", "off"].includes(normalized)) {
		return false;
	}

	throw new Error(`Invalid mongo_db_tls \"${value}\". Expected true/false.`);
}

function buildMemoryFilter(input: {
	kinds?: MemoryEntryKind[];
	scope?: MemoryEntryScope;
	sessionKey?: string;
	guildId?: string;
	channelId?: string;
	userId?: string;
}): Document {
	const filter: Document = {};

	if (input.kinds && input.kinds.length > 0) {
		filter.kind = { $in: input.kinds };
	}
	if (input.scope) {
		filter.scope = input.scope;
	}
	if (input.sessionKey) {
		filter.sessionKey = input.sessionKey;
	}
	if (input.guildId) {
		filter.guildId = input.guildId;
	}
	if (input.channelId) {
		filter.channelId = input.channelId;
	}
	if (input.userId) {
		filter.userId = input.userId;
	}

	return filter;
}

function buildMemoryCheckpointFilter(input: {
	kind: MemoryCheckpointKind;
	sessionKey?: string;
	userId?: string;
}): Document {
	const filter: Document = {
		kind: input.kind,
	};

	if (input.sessionKey) {
		filter.sessionKey = input.sessionKey;
		return filter;
	}

	if (input.userId) {
		filter.userId = input.userId;
		return filter;
	}

	throw new Error("Memory checkpoint filter requires sessionKey or userId.");
}

function normalizeTags(tags: string[]): string[] {
	return Array.from(
		new Set(
			tags
				.map((tag) => tag.trim().toLowerCase())
				.filter((tag) => tag.length > 0),
		),
	);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureIndexes(collections: SmediaMongoCollections): Promise<void> {
	await Promise.allSettled([
		collections.memoryEntries.dropIndex("session_short_term_ttl_30d"),
		collections.memoryCheckpoints.dropIndex("session_short_term_checkpoint_ttl_30d"),
	]);

	await Promise.all([
		collections.chatSessions.createIndexes([
			{
				key: { sessionKey: 1 },
				name: "sessionKey_unique",
				unique: true,
			},
			{
				key: { guildId: 1, channelId: 1, updatedAt: -1 },
				name: "guild_channel_updatedAt",
			},
			{
				key: { lastMessageAt: 1 },
				name: "lastMessageAt_ttl_30d",
				expireAfterSeconds: DEFAULT_RETENTION_TTL_SECONDS,
			},
		]),
		collections.chatMessages.createIndexes([
			{
				key: { sessionKey: 1, createdAt: -1 },
				name: "sessionKey_createdAt",
			},
			{
				key: { guildId: 1, channelId: 1, createdAt: -1 },
				name: "guild_channel_createdAt",
			},
			{
				key: { createdAt: -1 },
				name: "createdAt_desc",
			},
			{
				key: { createdAt: 1 },
				name: "createdAt_ttl_30d",
				expireAfterSeconds: DEFAULT_RETENTION_TTL_SECONDS,
			},
		]),
		collections.memoryEntries.createIndexes([
			{
				key: { kind: 1, updatedAt: -1 },
				name: "kind_updatedAt",
			},
			{
				key: { scope: 1, updatedAt: -1 },
				name: "scope_updatedAt",
			},
			{
				key: { sessionKey: 1, kind: 1, updatedAt: -1 },
				name: "sessionKey_kind_updatedAt",
				sparse: true,
			},
			{
				key: { userId: 1, kind: 1, updatedAt: -1 },
				name: "userId_kind_updatedAt",
				sparse: true,
			},
			{
				key: { sourceSessionId: 1 },
				name: "sourceSessionId",
				sparse: true,
			},
		]),
		collections.memoryCheckpoints.createIndexes([
			{
				key: { kind: 1, sessionKey: 1 },
				name: "kind_sessionKey_unique",
				unique: true,
				partialFilterExpression: { sessionKey: { $exists: true, $type: "string" } },
			},
			{
				key: { kind: 1, userId: 1 },
				name: "kind_userId_unique",
				unique: true,
				partialFilterExpression: { userId: { $exists: true, $type: "string" } },
			},
			{
				key: { updatedAt: -1 },
				name: "updatedAt_desc",
			},
		]),
		collections.generationJobs.createIndexes([
			{
				key: { jobId: 1 },
				name: "jobId_unique",
				unique: true,
			},
			{
				key: { status: 1, updatedAt: -1 },
				name: "status_updatedAt",
			},
			{
				key: { "resolved.modelId": 1, completedAt: -1 },
				name: "resolved_modelId_completedAt",
				sparse: true,
			},
			{
				key: { "resolved.postType": 1, completedAt: -1 },
				name: "resolved_postType_completedAt",
				sparse: true,
			},
			{
				key: { requestedByUserId: 1, createdAt: -1 },
				name: "requestedByUserId_createdAt",
				sparse: true,
			},
			{
				key: { guildId: 1, channelId: 1, createdAt: -1 },
				name: "guild_channel_createdAt",
				sparse: true,
			},
			{
				key: { createdAt: -1 },
				name: "createdAt_desc",
			},
		]),
		collections.contextDocuments.createIndexes([
			{
				key: { key: 1 },
				name: "key_unique",
				unique: true,
			},
			{
				key: { active: 1, updatedAt: -1 },
				name: "active_updatedAt",
			},
		]),
		collections.openAiDebugInputs.createIndexes([
			{
				key: { source: 1, createdAt: -1 },
				name: "source_createdAt",
			},
			{
				key: { sessionKey: 1, createdAt: -1 },
				name: "sessionKey_createdAt",
			},
			{
				key: { createdAt: -1 },
				name: "createdAt_desc",
			},
			{
				key: { createdAt: 1 },
				name: "createdAt_ttl_30d",
				expireAfterSeconds: DEFAULT_RETENTION_TTL_SECONDS,
			},
		]),
	]);
}