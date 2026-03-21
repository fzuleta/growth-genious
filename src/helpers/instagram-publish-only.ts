import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareInstagramPublishAssets, publishToInstagram } from "./instagram";
import { logInfo } from "./log";
import { createModelOutputDir } from "./output";
import type { PostGenerationMetadata, PostGenerationResult, PostType } from "../types";

export interface InstagramPublishOnlyInput {
	modelId?: string;
	s3FolderPath: string;
	caption?: string;
}

export interface InstagramPublishOnlyResult {
	modelId: string;
	outputDir: string;
	caption: string;
}

export async function runInstagramPublishOnlyFromRemoteFolder(
	input: InstagramPublishOnlyInput,
): Promise<InstagramPublishOnlyResult> {
	const remoteFolderUrl = ensureTrailingSlash(input.s3FolderPath);
	const remotePathParts = getRemoteFolderParts(remoteFolderUrl);
	const outputModelId = input.modelId ?? remotePathParts.modelId ?? "instagram-publish-only";
	const outputDir = await createModelOutputDir(outputModelId);
	logInfo("Instagram publish-only mode started", {
		outputDir,
		modelId: outputModelId,
		s3FolderPath: remoteFolderUrl,
	});

	const generationResultUrl = new URL("generation-result.json", remoteFolderUrl).toString();
	const generationResult = await downloadJson(generationResultUrl);
	const remoteCaption = await tryDownloadText(new URL("caption.txt", remoteFolderUrl).toString());
	const caption = input.caption ?? remoteCaption?.trim() ?? "";

	const compositeResultUrl = new URL("composite-result.json", remoteFolderUrl).toString();
	const compositeResult = await tryDownloadJson(compositeResultUrl);
	const hydratedGenerationResult = await hydrateRemoteGenerationResult({
		outputDir,
		remoteFolderUrl,
		generationResult: attachGenerationMetadata(generationResult, {
			modelId: outputModelId,
			postType: readPostTypeFromGenerationResult(generationResult),
			folderPath: outputDir,
		}),
		compositeResult,
		remotePathParts,
	});

	await writeFile(path.join(outputDir, "caption.txt"), `${caption}\n`, "utf8");
	await writeFile(
		path.join(outputDir, "generation-result.json"),
		`${JSON.stringify(hydratedGenerationResult.generationResult, null, 2)}\n`,
		"utf8",
	);
	if (hydratedGenerationResult.compositeResult) {
		await writeFile(
			path.join(outputDir, "composite-result.json"),
			`${JSON.stringify(hydratedGenerationResult.compositeResult, null, 2)}\n`,
			"utf8",
		);
	}
	await writeFile(
		path.join(outputDir, "instagram-publish-input.json"),
		`${JSON.stringify(
			{
				s3FolderPath: remoteFolderUrl,
				caption,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const instagramAssets = await prepareInstagramPublishAssets({
		outputDir,
		generationResult: hydratedGenerationResult.generationResult,
	});

	const instagramPublishResult = await publishToInstagram({
		outputDir,
		caption,
		generationResult: hydratedGenerationResult.generationResult,
		compositedVideoPath: hydratedGenerationResult.compositedVideoPath,
		preparedImagePath: instagramAssets.preparedImagePath,
	});
	logInfo("Instagram publish-only step finished", {
		outputDir,
		modelId: outputModelId,
		skipped: instagramPublishResult.skipped,
		results: instagramPublishResult.results.map((result) => ({
			target: result.target,
			status: result.status,
			postId: result.postId ?? null,
		})),
	});

	return {
		modelId: outputModelId,
		outputDir,
		caption,
	};
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function getRemoteFolderParts(remoteFolderUrl: string): {
	modelId: string | null;
	runId: string | null;
} {
	const pathnameParts = new URL(remoteFolderUrl).pathname.split("/").filter(Boolean);
	if (pathnameParts.length < 2) {
		return {
			modelId: null,
			runId: null,
		};
	}

	return {
		modelId: pathnameParts[pathnameParts.length - 2] ?? null,
		runId: pathnameParts[pathnameParts.length - 1] ?? null,
	};
}

async function downloadJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download ${url}. HTTP ${response.status}.`);
	}

	return (await response.json()) as unknown;
}

async function tryDownloadJson(url: string): Promise<unknown | null> {
	const response = await fetch(url);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`Failed to download ${url}. HTTP ${response.status}.`);
	}

	return (await response.json()) as unknown;
}

async function tryDownloadText(url: string): Promise<string | null> {
	const response = await fetch(url);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`Failed to download ${url}. HTTP ${response.status}.`);
	}

	return await response.text();
}

async function hydrateRemoteGenerationResult(input: {
	outputDir: string;
	remoteFolderUrl: string;
	generationResult: unknown;
	compositeResult: unknown;
	remotePathParts: { modelId: string | null; runId: string | null };
}): Promise<{
	generationResult: unknown;
	compositeResult: unknown;
	compositedVideoPath: string | null;
}> {
	const generationResult = cloneJsonValue(input.generationResult);
	const compositeResult = cloneJsonValue(input.compositeResult);
	const finalResult = readMutableObject(readObjectProp(generationResult, "final"));

	if (finalResult) {
		await hydrateGenerationFilePath({
			container: finalResult,
			key: "videoPath",
			outputDir: input.outputDir,
			remoteFolderUrl: input.remoteFolderUrl,
			remotePathParts: input.remotePathParts,
		});
		await hydrateGenerationFilePath({
			container: finalResult,
			key: "keyframePath",
			outputDir: input.outputDir,
			remoteFolderUrl: input.remoteFolderUrl,
			remotePathParts: input.remotePathParts,
		});
		await hydrateGenerationFilePath({
			container: finalResult,
			key: "backgroundPath",
			outputDir: input.outputDir,
			remoteFolderUrl: input.remoteFolderUrl,
			remotePathParts: input.remotePathParts,
		});

		const files = readArrayProp(finalResult, "files");
		if (files) {
			for (const fileEntry of files) {
				const fileObject = readMutableObject(fileEntry);
				if (!fileObject) {
					continue;
				}
				await hydrateGenerationFilePath({
					container: fileObject,
					key: "path",
					outputDir: input.outputDir,
					remoteFolderUrl: input.remoteFolderUrl,
					remotePathParts: input.remotePathParts,
				});
			}
		}
	}

	let compositedVideoPath: string | null = null;
	const compositeObject = readMutableObject(compositeResult);
	if (compositeObject) {
		compositedVideoPath = await hydrateGenerationFilePath({
			container: compositeObject,
			key: "compositedVideoPath",
			outputDir: input.outputDir,
			remoteFolderUrl: input.remoteFolderUrl,
			remotePathParts: input.remotePathParts,
		});
		await hydrateGenerationFilePath({
			container: compositeObject,
			key: "videoPath",
			outputDir: input.outputDir,
			remoteFolderUrl: input.remoteFolderUrl,
			remotePathParts: input.remotePathParts,
		});
	}

	return {
		generationResult,
		compositeResult,
		compositedVideoPath,
	};
}

async function hydrateGenerationFilePath(input: {
	container: Record<string, unknown>;
	key: string;
	outputDir: string;
	remoteFolderUrl: string;
	remotePathParts: { modelId: string | null; runId: string | null };
}): Promise<string | null> {
	const sourcePath = input.container[input.key];
	if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
		return null;
	}

	const relativePath = deriveRemoteRelativePath(sourcePath, input.remotePathParts);
	const localPath = path.join(input.outputDir, relativePath);
	const remoteAssetUrl = new URL(relativePath, input.remoteFolderUrl).toString();
	await downloadFile(remoteAssetUrl, localPath);
	input.container[input.key] = localPath;
	return localPath;
}

function deriveRemoteRelativePath(
	sourcePath: string,
	remotePathParts: { modelId: string | null; runId: string | null },
): string {
	const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
	const outputMarker = "/output/";
	const outputIndex = normalizedSourcePath.lastIndexOf(outputMarker);
	if (outputIndex === -1) {
		return path.basename(normalizedSourcePath);
	}

	const outputRelativePath = normalizedSourcePath.slice(outputIndex + outputMarker.length);
	const runPrefix =
		remotePathParts.modelId && remotePathParts.runId
			? `${remotePathParts.modelId}/${remotePathParts.runId}/`
			: null;
	if (runPrefix && outputRelativePath.startsWith(runPrefix)) {
		return outputRelativePath.slice(runPrefix.length);
	}

	return outputRelativePath.split("/").slice(-2).join("/");
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download asset ${url}. HTTP ${response.status}.`);
	}

	const arrayBuffer = await response.arrayBuffer();
	await mkdir(path.dirname(destinationPath), { recursive: true });
	await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

function cloneJsonValue<T>(value: T): T {
	if (value === null || value === undefined) {
		return value;
	}

	return JSON.parse(JSON.stringify(value)) as T;
}

function readObjectProp(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	return (value as Record<string, unknown>)[key];
}

function readArrayProp(value: unknown, key: string): unknown[] | null {
	const property = readObjectProp(value, key);
	return Array.isArray(property) ? property : null;
}

function readMutableObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function attachGenerationMetadata(
	generationResult: unknown,
	metadata: PostGenerationMetadata,
): PostGenerationResult {
	const generationResultObject = readMutableObject(generationResult);
	if (
		!generationResultObject ||
		!("raw" in generationResultObject) ||
		!("final" in generationResultObject)
	) {
		throw new Error("Invalid generation-result.json payload.");
	}

	return {
		...(generationResultObject as unknown as PostGenerationResult),
		metadata,
	};
}

function readPostTypeFromGenerationResult(generationResult: unknown): PostType {
	const metadata = readMutableObject(readObjectProp(generationResult, "metadata"));
	const postType = metadata?.postType;
	if (isPostType(postType)) {
		return postType;
	}

	return "scenery";
}

function isPostType(value: unknown): value is PostType {
	return (
		value === "scenery" ||
		value === "scenery_with_symbols" ||
		value === "scenery_with_symbols_stories" ||
		value === "symbols" ||
		value === "game_feature" ||
		value === "character_with_scenery"
	);
}
