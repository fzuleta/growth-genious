import type { Collection, Document, ObjectId } from "mongodb";
import type { SmediaMongoDatabase } from "./mongo";

export const SELF_MODIFY_COLLECTION_NAME = "smedia-self-modify-sessions";

export type SelfModifyState =
	| "planning"
	| "awaiting-approval"
	| "executing"
	| "building"
	| "restarting"
	| "completed"
	| "failed"
	| "cancelled";

export interface SelfModifyToolCall {
	tool: string;
	args: Record<string, unknown>;
	result?: string;
	error?: string;
	phase: "planning" | "executing";
	createdAt: Date;
}

export interface SelfModifySessionDocument {
	_id?: ObjectId;
	pluginId: string;
	sessionId: string;
	sessionKey: string;
	guildId: string;
	channelId: string;
	userId: string;
	username: string;
	state: SelfModifyState;
	intent: string;
	plan: string | null;
	gitBranch: string | null;
	originalBranch: string | null;
	feedback: string[];
	toolCalls: SelfModifyToolCall[];
	planningIterations: number;
	executionIterations: number;
	buildOutput: string | null;
	errorMessage: string | null;
	filesChanged: string[];
	createdAt: Date;
	updatedAt: Date;
}

function getCollection(database: SmediaMongoDatabase): Collection<SelfModifySessionDocument> {
	return database.db.collection<SelfModifySessionDocument>(SELF_MODIFY_COLLECTION_NAME);
}

export async function ensureSelfModifyIndexes(database: SmediaMongoDatabase): Promise<void> {
	const collection = getCollection(database);
	await Promise.allSettled([
		collection.dropIndex("channel_state_updatedAt"),
	]);
	await collection.createIndexes([
		{
			key: { sessionId: 1 },
			name: "sessionId_unique",
			unique: true,
		},
		{
			key: { pluginId: 1, channelId: 1, state: 1, updatedAt: -1 },
			name: "plugin_channel_state_updatedAt",
		},
		{
			key: { createdAt: 1 },
			name: "createdAt_ttl_7d",
			expireAfterSeconds: 7 * 24 * 60 * 60,
		},
	]);
}

export async function createSelfModifySession(
	database: SmediaMongoDatabase,
	input: {
		pluginId: string;
		sessionId: string;
		sessionKey: string;
		guildId: string;
		channelId: string;
		userId: string;
		username: string;
		intent: string;
		gitBranch: string;
		originalBranch: string;
	},
): Promise<SelfModifySessionDocument> {
	const now = new Date();
	const document: SelfModifySessionDocument = {
		pluginId: input.pluginId,
		sessionId: input.sessionId,
		sessionKey: input.sessionKey,
		guildId: input.guildId,
		channelId: input.channelId,
		userId: input.userId,
		username: input.username,
		state: "planning",
		intent: input.intent,
		plan: null,
		gitBranch: input.gitBranch,
		originalBranch: input.originalBranch,
		feedback: [],
		toolCalls: [],
		planningIterations: 0,
		executionIterations: 0,
		buildOutput: null,
		errorMessage: null,
		filesChanged: [],
		createdAt: now,
		updatedAt: now,
	};

	await getCollection(database).insertOne(document);
	return document;
}

export async function getActiveSelfModifySession(
	database: SmediaMongoDatabase,
	pluginId: string,
	channelId: string,
): Promise<SelfModifySessionDocument | null> {
	return getCollection(database).findOne(
		{
			pluginId,
			channelId,
			state: { $in: ["planning", "awaiting-approval", "executing", "building", "restarting"] as SelfModifyState[] },
		},
		{ sort: { updatedAt: -1 } },
	);
}

export async function getSelfModifySessionById(
	database: SmediaMongoDatabase,
	sessionId: string,
): Promise<SelfModifySessionDocument | null> {
	return getCollection(database).findOne({ sessionId });
}

export async function getRestartingSessions(
	database: SmediaMongoDatabase,
	pluginId: string,
): Promise<SelfModifySessionDocument[]> {
	return getCollection(database).find({ pluginId, state: "restarting" as SelfModifyState }).toArray();
}

export async function updateSelfModifyState(
	database: SmediaMongoDatabase,
	sessionId: string,
	state: SelfModifyState,
	extra?: Partial<Pick<SelfModifySessionDocument, "plan" | "buildOutput" | "errorMessage" | "filesChanged">>,
): Promise<void> {
	const update: Document = {
		$set: { state, updatedAt: new Date(), ...extra },
	};
	await getCollection(database).updateOne({ sessionId }, update);
}

export async function appendSelfModifyFeedback(
	database: SmediaMongoDatabase,
	sessionId: string,
	feedback: string,
): Promise<void> {
	await getCollection(database).updateOne(
		{ sessionId },
		{
			$push: { feedback },
			$set: { state: "planning" as SelfModifyState, updatedAt: new Date() },
		},
	);
}

export async function appendSelfModifyToolCall(
	database: SmediaMongoDatabase,
	sessionId: string,
	toolCall: SelfModifyToolCall,
	phase: "planning" | "executing",
): Promise<void> {
	const incField = phase === "planning" ? "planningIterations" : "executionIterations";
	await getCollection(database).updateOne(
		{ sessionId },
		{
			$push: { toolCalls: toolCall },
			$inc: { [incField]: 1 },
			$set: { updatedAt: new Date() },
		},
	);
}
