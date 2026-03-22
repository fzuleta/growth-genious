import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getBuiltinPluginById } from "./plugins";
import { getPluginEnvFilePath, readActivePluginId } from "./runtime-env";

const WORKSPACE_ROOT = process.cwd();
const AGENT_CONTEXT_DIR = path.resolve(WORKSPACE_ROOT, "agent");
const APP_CONTEXT_DOCS = ["context.md"];
const PLUGIN_CONTEXT_DOCS = ["README.md"];

export interface ContextMarkdownDocument {
	fileName: string;
	filePath: string;
	content: string;
}

export async function readAgentContextDocuments(): Promise<ContextMarkdownDocument[]> {
	try {
		const entries = await readdir(AGENT_CONTEXT_DIR, { withFileTypes: true });
		const markdownFiles = entries
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => path.join(AGENT_CONTEXT_DIR, entry.name))
			.sort((left, right) => left.localeCompare(right));

		return await readMarkdownDocuments(markdownFiles);
	} catch (error: unknown) {
		const isMissingFileError =
			error instanceof Error && "code" in error && error.code === "ENOENT";
		if (isMissingFileError) {
			return [];
		}

		throw error;
	}
}

export async function readActivePluginContextDocuments(env: NodeJS.ProcessEnv = process.env): Promise<ContextMarkdownDocument[]> {
	const pluginId = readActivePluginId(env);
	const plugin = getBuiltinPluginById(pluginId);
	const appDir = path.dirname(path.resolve(WORKSPACE_ROOT, getPluginEnvFilePath(pluginId)));
	const candidatePaths = [
		...APP_CONTEXT_DOCS.map((fileName) => path.join(appDir, fileName)),
		...(plugin ? PLUGIN_CONTEXT_DOCS.map((fileName) => path.resolve(WORKSPACE_ROOT, plugin.rootDir, fileName)) : []),
	];

	return readMarkdownDocuments(candidatePaths);
}

export async function readOptionalContextMarkdown(): Promise<string | null> {
	const [appDocuments, agentDocuments] = await Promise.all([
		readActivePluginContextDocuments(),
		readAgentContextDocuments(),
	]);
	const documents = [...appDocuments, ...agentDocuments];
	if (documents.length === 0) {
		return null;
	}

	const mergedContext = documents
		.map((document) => [`# ${document.fileName}`, document.content].join("\n\n"))
		.join("\n\n");
	return mergedContext.length > 0 ? mergedContext : null;
}

async function readMarkdownDocuments(filePaths: string[]): Promise<ContextMarkdownDocument[]> {
	const documents = await Promise.all(
		filePaths.map(async (filePath) => {
			try {
				const content = (await readFile(filePath, "utf8")).trim();
				if (!content) {
					return null;
				}

				return {
					fileName: relativeWorkspacePath(filePath),
					filePath,
					content,
				};
			} catch (error: unknown) {
				const isMissingFileError =
					error instanceof Error && "code" in error && error.code === "ENOENT";
				if (isMissingFileError) {
					return null;
				}

				throw error;
			}
		}),
	);

	return documents.filter((document): document is ContextMarkdownDocument => document !== null);
}

function relativeWorkspacePath(filePath: string): string {
	return path.relative(WORKSPACE_ROOT, filePath) || path.basename(filePath);
}