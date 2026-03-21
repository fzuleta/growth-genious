import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const AGENT_CONTEXT_DIR = path.resolve(process.cwd(), "agent");

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
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));

		const documents = await Promise.all(
			markdownFiles.map(async (fileName) => {
				const filePath = path.join(AGENT_CONTEXT_DIR, fileName);
				const content = (await readFile(filePath, "utf8")).trim();
				if (!content) {
					return null;
				}

				return {
					fileName,
					filePath,
					content,
				};
			}),
		);

		return documents.filter((document): document is ContextMarkdownDocument => document !== null);
	} catch (error: unknown) {
		const isMissingFileError =
			error instanceof Error && "code" in error && error.code === "ENOENT";
		if (isMissingFileError) {
			return [];
		}

		throw error;
	}
}

export async function readOptionalContextMarkdown(): Promise<string | null> {
	const documents = await readAgentContextDocuments();
	if (documents.length === 0) {
		return null;
	}

	const mergedContext = documents
		.map((document) => [`# ${document.fileName}`, document.content].join("\n\n"))
		.join("\n\n");
	return mergedContext.length > 0 ? mergedContext : null;
}