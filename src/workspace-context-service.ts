import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRouteDecision, ChatRouteEvidence } from "./chat-routing-types";
import { readAgentContextDocuments } from "./context-service";

const WORKSPACE_ROOT = process.cwd();
const TOP_LEVEL_DOCS = ["README.md", "workspace-template/context.md"];
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

	const requestedFileSnippets = await loadRequestedFileSnippets(input.decision.entityHints.fileHint);
	if (requestedFileSnippets.length > 0) {
		summaryParts.push(`Loaded ${requestedFileSnippets.length} requested workspace file${requestedFileSnippets.length === 1 ? "" : "s"}.`);
		snippets.push(...requestedFileSnippets);
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

async function loadRequestedFileSnippets(fileHint?: string): Promise<ChatRouteEvidence["snippets"]> {
	if (!fileHint) {
		return [];
	}

	const normalizedHint = fileHint.trim();
	if (!normalizedHint) {
		return [];
	}

	const candidatePaths = uniqueStrings([
		normalizedHint,
		normalizedHint.startsWith("src/") ? normalizedHint : path.join("src", normalizedHint),
	]);
	const snippets: ChatRouteEvidence["snippets"] = [];

	for (const candidate of candidatePaths) {
		const filePath = path.join(WORKSPACE_ROOT, candidate);
		if (!(await fileExists(filePath))) {
			continue;
		}

		const content = (await readFile(filePath, "utf8")).trim();
		if (!content) {
			continue;
		}

		snippets.push({
			label: relativeWorkspacePath(filePath),
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
function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}