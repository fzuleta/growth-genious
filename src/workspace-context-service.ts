import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRouteDecision, ChatRouteEvidence } from "./chat-routing-types";
import { readAgentContextDocuments } from "./context-service";
import { getGameAssetsDir, resolveModelIdByThemeName } from "./helpers/game-assets";

const WORKSPACE_ROOT = process.cwd();
const GAME_ASSETS_DIR = getGameAssetsDir();
const TOP_LEVEL_DOCS = ["README.md", "fb-ig-tokengen.md"];
const MODEL_DEFAULT_FILES = ["game.json", "art-style.md"];
const MAX_SNIPPET_LENGTH = 1600;

export async function retrieveWorkspaceRouteEvidence(input: {
	decision: ChatRouteDecision;
	content: string;
}): Promise<ChatRouteEvidence> {
	if (input.decision.route !== "workspace-question") {
		throw new Error(`Workspace evidence requested for unsupported route ${input.decision.route}.`);
	}

	const snippets: ChatRouteEvidence["snippets"] = [];
	const summaryParts: string[] = [];
	const agentDocuments = await readAgentContextDocuments();
	if (agentDocuments.length > 0) {
		const primaryAgentDocument = agentDocuments[0]!;
		summaryParts.push(`Loaded ${agentDocuments.length} agent context document${agentDocuments.length === 1 ? "" : "s"}.`);
		snippets.push({
			label: `Agent context from ${primaryAgentDocument.fileName}`,
			content: truncate(primaryAgentDocument.content),
			sourceType: "workspace",
			sourcePath: relativeWorkspacePath(primaryAgentDocument.filePath),
		});
	}

	const modelId = input.decision.entityHints.modelId
		?? extractModelId(input.content)
		?? await resolveModelIdByThemeName(GAME_ASSETS_DIR, input.content).catch(() => undefined);
	if (modelId) {
		const modelSnippets = await loadModelDocumentSnippets(modelId, input.decision.entityHints.fileHint);
		if (modelSnippets.length > 0) {
			summaryParts.push(`Loaded ${modelSnippets.length} game-assets document${modelSnippets.length === 1 ? "" : "s"} for ${modelId}.`);
			snippets.push(...modelSnippets);
		}
	}

	const topLevelDocSnippets = await loadTopLevelDocSnippets(input.decision.entityHints.fileHint);
	if (topLevelDocSnippets.length > 0) {
		summaryParts.push(`Loaded ${topLevelDocSnippets.length} top-level documentation file${topLevelDocSnippets.length === 1 ? "" : "s"}.`);
		snippets.push(...topLevelDocSnippets);
	}

	return {
		route: "workspace-question",
		subject: input.decision.subject,
		summary: summaryParts.length > 0 ? summaryParts.join(" ") : "No approved workspace documents matched this request.",
		snippets,
	};
}

async function loadModelDocumentSnippets(modelId: string, fileHint?: string): Promise<ChatRouteEvidence["snippets"]> {
	const modelDir = path.join(GAME_ASSETS_DIR, modelId);
	const candidateFiles = uniqueStrings(fileHint ? [fileHint, ...MODEL_DEFAULT_FILES] : MODEL_DEFAULT_FILES);
	const snippets: ChatRouteEvidence["snippets"] = [];

	for (const fileName of candidateFiles) {
		const filePath = path.join(modelDir, fileName);
		if (!(await fileExists(filePath))) {
			continue;
		}

		const content = (await readFile(filePath, "utf8")).trim();
		if (!content) {
			continue;
		}

		snippets.push({
			label: `${modelId}/${fileName}`,
			content: truncate(content),
			sourceType: "workspace",
			sourcePath: relativeWorkspacePath(filePath),
		});
	}

	if (snippets.length > 0) {
		return snippets;
	}

	const entries = await readdir(modelDir, { withFileTypes: true }).catch((): Array<{ isFile: () => boolean; name: string }> => []);
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || snippets.length >= 2) {
			continue;
		}

		const filePath = path.join(modelDir, entry.name);
		const content = (await readFile(filePath, "utf8")).trim();
		if (!content) {
			continue;
		}

		snippets.push({
			label: `${modelId}/${entry.name}`,
			content: truncate(content),
			sourceType: "workspace",
			sourcePath: relativeWorkspacePath(filePath),
		});
	}

	return snippets;
}

async function loadTopLevelDocSnippets(fileHint?: string): Promise<ChatRouteEvidence["snippets"]> {
	const prioritized = fileHint ? [fileHint, ...TOP_LEVEL_DOCS] : [...TOP_LEVEL_DOCS];
	const snippets: ChatRouteEvidence["snippets"] = [];

	for (const fileName of uniqueStrings(prioritized)) {
		const filePath = path.join(WORKSPACE_ROOT, fileName);
		if (!(await fileExists(filePath))) {
			continue;
		}

		const content = (await readFile(filePath, "utf8")).trim();
		if (!content) {
			continue;
		}

		snippets.push({
			label: fileName,
			content: truncate(content),
			sourceType: "workspace",
			sourcePath: relativeWorkspacePath(filePath),
		});

		if (snippets.length >= 2) {
			break;
		}
	}

	return snippets;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function truncate(text: string): string {
	return text.length <= MAX_SNIPPET_LENGTH ? text : `${text.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
}

function relativeWorkspacePath(filePath: string): string {
	return path.relative(WORKSPACE_ROOT, filePath) || path.basename(filePath);
}

function extractModelId(content: string): string | undefined {
	const match = content.match(/\bff\d{3}-[a-z0-9-]+\b/i);
	return match ? match[0].toLowerCase() : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}