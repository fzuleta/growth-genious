import type { Collection, Document } from "mongodb";
import { loadRuntimeEnv, readActivePluginId } from "./runtime-env";
import { initializeMongoDatabase } from "./db/mongo";
import {
	SELF_MODIFY_COLLECTION_NAME,
	type SelfModifySessionDocument,
} from "./db/self-modify-mongo";

interface MigrationOptions {
	pluginId: string;
	apply: boolean;
}

interface MigrationTarget<T extends Document> {
	label: string;
	collection: Collection<T>;
	hasSessionKey: boolean;
}

async function main(): Promise<void> {
	loadRuntimeEnv();
	const options = parseOptions(process.argv.slice(2));
	const database = await initializeMongoDatabase();

	try {
		const selfModifyCollection = database.db.collection<SelfModifySessionDocument>(SELF_MODIFY_COLLECTION_NAME);
		const targets: Array<MigrationTarget<Document>> = [
			{
				label: "chatSessions",
				collection: database.collections.chatSessions as unknown as Collection<Document>,
				hasSessionKey: true,
			},
			{
				label: "chatMessages",
				collection: database.collections.chatMessages as unknown as Collection<Document>,
				hasSessionKey: true,
			},
			{
				label: "memoryEntries",
				collection: database.collections.memoryEntries as unknown as Collection<Document>,
				hasSessionKey: true,
			},
			{
				label: "memoryCheckpoints",
				collection: database.collections.memoryCheckpoints as unknown as Collection<Document>,
				hasSessionKey: true,
			},
			{
				label: "generationJobs",
				collection: database.collections.generationJobs as unknown as Collection<Document>,
				hasSessionKey: false,
			},
			{
				label: "openAiDebugInputs",
				collection: database.collections.openAiDebugInputs as unknown as Collection<Document>,
				hasSessionKey: true,
			},
			{
				label: "selfModifySessions",
				collection: selfModifyCollection as unknown as Collection<Document>,
				hasSessionKey: true,
			},
		];

		const summaries = await Promise.all(targets.map((target) => inspectTarget(target, options.pluginId)));

		console.log(`pluginId=${options.pluginId}`);
		console.log(`mode=${options.apply ? "apply" : "dry-run"}`);
		console.log(`database=${database.db.databaseName}`);
		console.log("");

		for (const summary of summaries) {
			console.log(`${summary.label}: missingPluginId=${summary.missingPluginIdCount} legacySessionKeys=${summary.legacySessionKeyCount}`);
		}

		if (!options.apply) {
			console.log("");
			console.log("Dry run only. Re-run with --apply to execute the migration.");
			return;
		}

		console.log("");
		for (const target of targets) {
			const result = await migrateTarget(target, options.pluginId);
			console.log(`${target.label}: updatedPluginId=${result.updatedPluginIdCount} rewrittenSessionKeys=${result.rewrittenSessionKeyCount}`);
		}
	} finally {
		await database.close();
	}
}

function parseOptions(argv: string[]): MigrationOptions {
	let pluginId = "";
	let apply = false;

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--apply") {
			apply = true;
			continue;
		}
		if (value === "--plugin") {
			pluginId = argv[index + 1]?.trim() ?? "";
			index += 1;
			continue;
		}
		if (value === "--help" || value === "-h") {
			printHelp();
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${value}`);
	}

	const resolvedPluginId = pluginId || readActivePluginId(process.env);
	if (!resolvedPluginId) {
		throw new Error("Could not resolve pluginId. Set PLUGIN_ID or pass --plugin.");
	}

	return {
		pluginId: resolvedPluginId,
		apply,
	};
}

function printHelp(): void {
	console.log(`Usage: npm run migrate:plugin-namespace -- [--plugin <plugin-id>] [--apply]

Options:
  --plugin <plugin-id>  Override the plugin id to backfill. Defaults to PLUGIN_ID.
  --apply               Execute the migration. Without this flag the command is dry-run only.
`);
}

async function inspectTarget(
	target: MigrationTarget<Document>,
	pluginId: string,
): Promise<{
	label: string;
	missingPluginIdCount: number;
	legacySessionKeyCount: number;
}> {
	const [missingPluginIdCount, legacySessionKeyCount] = await Promise.all([
		target.collection.countDocuments(buildMissingPluginIdFilter()),
		target.hasSessionKey
			? target.collection.countDocuments(buildLegacySessionKeyFilter(pluginId))
			: Promise.resolve(0),
	]);

	return {
		label: target.label,
		missingPluginIdCount,
		legacySessionKeyCount,
	};
}

async function migrateTarget(
	target: MigrationTarget<Document>,
	pluginId: string,
): Promise<{
	updatedPluginIdCount: number;
	rewrittenSessionKeyCount: number;
}> {
	const pluginResult = await target.collection.updateMany(buildMissingPluginIdFilter(), {
		$set: { pluginId },
	});

	let rewrittenSessionKeyCount = 0;
	if (target.hasSessionKey) {
		const sessionKeyResult = await target.collection.updateMany(
			buildLegacySessionKeyFilter(pluginId),
			[
				{
					$set: {
						sessionKey: {
							$concat: [pluginId, ":", "$sessionKey"],
						},
					},
				},
			],
		);
		rewrittenSessionKeyCount = sessionKeyResult.modifiedCount;
	}

	return {
		updatedPluginIdCount: pluginResult.modifiedCount,
		rewrittenSessionKeyCount,
	};
}

function buildMissingPluginIdFilter(): Document {
	return {
		$or: [
			{ pluginId: { $exists: false } },
			{ pluginId: null },
			{ pluginId: "" },
		],
	};
}

function buildLegacySessionKeyFilter(pluginId: string): Document {
	return {
		pluginId,
		sessionKey: {
			$type: "string",
			$regex: /^[^:]+:[^:]+$/,
			$not: new RegExp(`^${escapeRegex(pluginId)}:`),
		},
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Migration failed: ${message}`);
	process.exitCode = 1;
});