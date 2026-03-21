import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileExists, readUtf8File } from "./fs";

export interface ModelAssetFiles {
	artStyleMarkdown: string;
	gameJson: string;
	soundInstructionsMarkdown: string;
	logoMarkdown: string;
}

export function getGameAssetsDir(): string {
	return path.resolve(process.cwd(), "game-assets");
}

export function getModelAssetsBasePath(gameAssetsDir: string, modelId: string): string {
	return path.join(gameAssetsDir, modelId);
}

export async function pickRandomModelId(gameAssetsDir: string): Promise<string> {
	const entries = await readdir(gameAssetsDir, { withFileTypes: true });
	const modelDirectories: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const modelDir = getModelAssetsBasePath(gameAssetsDir, entry.name);
		const hasArtStyle = await fileExists(path.join(modelDir, "art-style.md"));
		const hasGameJson = await fileExists(path.join(modelDir, "game.json"));

		if (hasArtStyle && hasGameJson) {
			modelDirectories.push(entry.name);
		}
	}

	if (modelDirectories.length === 0) {
		throw new Error(`No valid model folders found in ${gameAssetsDir}.`);
	}

	return pickRandom(modelDirectories);
}

export async function assertValidModelId(gameAssetsDir: string, modelId: string): Promise<void> {
	const modelDir = getModelAssetsBasePath(gameAssetsDir, modelId);
	const [hasArtStyle, hasGameJson] = await Promise.all([
		fileExists(path.join(modelDir, "art-style.md")),
		fileExists(path.join(modelDir, "game.json")),
	]);

	if (!hasArtStyle || !hasGameJson) {
		throw new Error(
			`Invalid modelId "${modelId}". Expected a game-assets subfolder containing art-style.md and game.json.`,
		);
	}
}

export async function loadModelAssetFiles(modelBasePath: string): Promise<ModelAssetFiles> {
	const [artStyleMarkdown, gameJson, soundInstructionsMarkdown, logoMarkdown] = await Promise.all([
		readUtf8File(path.join(modelBasePath, "art-style.md")),
		readUtf8File(path.join(modelBasePath, "game.json")),
		readUtf8File(path.join(modelBasePath, "sound_instructions.md")),
		readUtf8File(path.join(modelBasePath, "logo.md")),
	]);

	return {
		artStyleMarkdown,
		gameJson,
		soundInstructionsMarkdown,
		logoMarkdown,
	};
}

/**
 * Resolve a free-text theme name (e.g. "viking", "retro future", "mad scientist")
 * to the matching modelId folder (e.g. "ff003-viking", "ff006-retro-future").
 *
 * Scans game-assets directories lazily and caches the result for subsequent calls.
 * Returns null when no folder matches.
 */
export async function resolveModelIdByThemeName(
	gameAssetsDir: string,
	themeName: string,
): Promise<string | null> {
	const entries = await getCachedModelEntries(gameAssetsDir);
	const normalizedQuery = themeName.trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (!normalizedQuery) {
		return null;
	}

	// Exact suffix match: "viking" matches "ff003-viking"
	const exactMatch = entries.find((entry) => entry.theme === normalizedQuery);
	if (exactMatch) {
		return exactMatch.id;
	}

	// Substring match: "retro" matches "ff006-retro-future"
	const substringMatches = entries.filter(
		(entry) => entry.theme.includes(normalizedQuery) || normalizedQuery.includes(entry.theme),
	);
	if (substringMatches.length === 1) {
		return substringMatches[0].id;
	}

	// Word-boundary match: check if any word in the query appears as a segment
	const querySegments = normalizedQuery.split("-").filter((s) => s.length >= 3);
	if (querySegments.length > 0) {
		const segmentMatches = entries.filter((entry) => {
			const themeSegments = entry.theme.split("-");
			return querySegments.some((q) => themeSegments.some((t) => t === q));
		});
		if (segmentMatches.length === 1) {
			return segmentMatches[0].id;
		}
	}

	return null;
}

/**
 * Returns all valid model folder IDs (used by the router prompt to list available models).
 */
export async function listModelIds(gameAssetsDir: string): Promise<string[]> {
	const entries = await getCachedModelEntries(gameAssetsDir);
	return entries.map((e) => e.id);
}

interface ModelEntry {
	id: string;
	theme: string;
}

let cachedModelEntries: ModelEntry[] | null = null;
let cachedModelEntriesDir: string | null = null;

async function getCachedModelEntries(gameAssetsDir: string): Promise<ModelEntry[]> {
	if (cachedModelEntries && cachedModelEntriesDir === gameAssetsDir) {
		return cachedModelEntries;
	}

	const dirEntries = await readdir(gameAssetsDir, { withFileTypes: true });
	const entries: ModelEntry[] = [];

	for (const dirEntry of dirEntries) {
		if (!dirEntry.isDirectory()) {
			continue;
		}

		const match = dirEntry.name.match(/^(ff\d{3})-(.+)$/);
		if (!match) {
			continue;
		}

		const modelDir = path.join(gameAssetsDir, dirEntry.name);
		const [hasArtStyle, hasGameJson] = await Promise.all([
			fileExists(path.join(modelDir, "art-style.md")),
			fileExists(path.join(modelDir, "game.json")),
		]);

		if (hasArtStyle && hasGameJson) {
			entries.push({ id: dirEntry.name, theme: match[2].toLowerCase() });
		}
	}

	cachedModelEntries = entries;
	cachedModelEntriesDir = gameAssetsDir;
	return entries;
}

function pickRandom<T>(items: T[]): T {
	const index = Math.floor(Math.random() * items.length);
	return items[index];
}
