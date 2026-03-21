import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
	emitGenerationProgress,
	type GenerationJobProgressEvent,
	type GenerationJobRunOptions,
} from "./generation-progress";
import {
	assertValidModelId,
	getGameAssetsDir,
	getModelAssetsBasePath,
	loadModelAssetFiles,
	pickRandomModelId,
} from "./helpers/game-assets";
import {
	prepareInstagramPublishAssets,
	publishToInstagram,
	type InstagramPublishResult,
} from "./helpers/instagram";
import { runInstagramPublishOnlyFromRemoteFolder } from "./helpers/instagram-publish-only";
import { logInfo, logWarn } from "./helpers/log";
import { overlayTransparentPngOnVideo } from "./helpers/media";
import { createModelOutputDir } from "./helpers/output";
import { uploadOutputDirToS3 } from "./helpers/s3";
import {
	generateCharacterWithSceneryPost,
	generateGameFeature,
	generatePromoOverlay,
	generateModelSoundMp3,
	generateSceneryPost,
	generateSceneryWithSymbolsPost,
	generateSymbolsPost,
} from "./post-types";
import { generateCaption } from "./post-types/caption";
import {
	POST_TYPE_WEIGHTS,
	type PostGenerationMetadata,
	type PostGenerationResult,
	type PostType,
} from "./types";

export interface GenerationJobInput {
	modelId?: string;
	postType?: PostType;
	s3FolderPath?: string;
	caption?: string;
	mode?: "sound-only" | "promo-overlay";
}

export interface GenerationJobResult {
	modelId: string;
	mode: "default" | "sound-only" | "promo-overlay" | "publish-only";
	postType: PostType | null;
	outputDir: string | null;
	primaryOutputPath: string | null;
	generationResultPath: string | null;
	captionPath: string | null;
	caption: string | null;
}
export type { GenerationJobProgressEvent, GenerationJobRunOptions } from "./generation-progress";

const GAME_ASSETS_DIR = getGameAssetsDir();

const POST_TYPE_SPEC_FILES: Record<PostType, string> = {
	scenery: "post-scenery.md",
	scenery_with_symbols: "post-scenery_with_symbols.md",
	scenery_with_symbols_stories: "post-scenery_with_symbols_stories.md",
	symbols: "post-symbols.md",
	game_feature: "post-game_feature.md",
	character_with_scenery: "post-character_with_scenery.md",
};

export async function runGenerationJob(
	input: GenerationJobInput,
	options: GenerationJobRunOptions = {},
): Promise<GenerationJobResult> {
	const reportProgress = async (event: GenerationJobProgressEvent): Promise<void> => {
		await emitGenerationProgress(options.onProgress, event);
	};

	if (input.s3FolderPath) {
		await reportProgress({
			stage: "publish-only",
			status: "started",
			message: "Starting publish-only flow from remote folder.",
			details: {
				s3FolderPath: input.s3FolderPath,
				requestedModelId: input.modelId ?? null,
			},
		});
		const publishOnlyResult = await runInstagramPublishOnlyFromRemoteFolder({
			modelId: input.modelId,
			s3FolderPath: input.s3FolderPath,
			caption: input.caption,
		});
		await reportProgress({
			stage: "publish-only",
			status: "completed",
			message: "Publish-only flow completed.",
			details: {
				modelId: publishOnlyResult.modelId,
				outputDir: publishOnlyResult.outputDir,
			},
		});

		return {
			modelId: publishOnlyResult.modelId,
			mode: "publish-only",
			postType: null,
			outputDir: publishOnlyResult.outputDir,
			primaryOutputPath: null,
			generationResultPath: path.join(publishOnlyResult.outputDir, "generation-result.json"),
			captionPath: path.join(publishOnlyResult.outputDir, "caption.txt"),
			caption: publishOnlyResult.caption,
		};
	}

	if (input.mode === "sound-only") {
		if (!input.modelId) {
			throw new Error('Missing modelId for mode=sound-only. Pass modelId=<game-model-id>.');
		}

		await reportProgress({
			stage: "sound",
			status: "started",
			message: "Generating model sound asset.",
			details: {
				modelId: input.modelId,
			},
		});
		await assertValidModelId(GAME_ASSETS_DIR, input.modelId);
		const modelAssetsBasePath = getModelAssetsBasePath(GAME_ASSETS_DIR, input.modelId);
		const { soundInstructionsMarkdown } = await loadModelAssetFiles(modelAssetsBasePath);
		const filePath = await generateModelSoundMp3({
			modelAssetsBasePath,
			soundInstructionsMarkdown,
		});
		await reportProgress({
			stage: "sound",
			status: "completed",
			message: "Model sound asset generated.",
			details: {
				modelId: input.modelId,
				filePath,
			},
		});
		logInfo("Sound-only generation finished", {
			modelId: input.modelId,
			filePath,
		});

		return {
			modelId: input.modelId,
			mode: "sound-only",
			postType: null,
			outputDir: path.dirname(filePath),
			primaryOutputPath: filePath,
			generationResultPath: null,
			captionPath: null,
			caption: null,
		};
	}

	if (input.mode === "promo-overlay") {
		if (!input.modelId) {
			throw new Error('Missing modelId for mode=promo-overlay. Pass modelId=<game-model-id>.');
		}

		await reportProgress({
			stage: "promo-overlay",
			status: "started",
			message: "Generating promo overlay assets.",
			details: {
				modelId: input.modelId,
			},
		});
		await assertValidModelId(GAME_ASSETS_DIR, input.modelId);
		const modelAssetsBasePath = getModelAssetsBasePath(GAME_ASSETS_DIR, input.modelId);
		const outputDir = await createModelOutputDir(input.modelId);
		const { artStyleMarkdown, logoMarkdown } = await loadModelAssetFiles(modelAssetsBasePath);
		const promoOverlayResult = await generatePromoOverlay({
			modelId: input.modelId,
			modelAssetsBasePath,
			gameAssetsDir: GAME_ASSETS_DIR,
			outputDir,
			artStyleMarkdown,
			logoMarkdown,
		});
		logInfo("Promo overlay mode finished", {
			modelId: promoOverlayResult.modelId,
			logoPath: promoOverlayResult.logoPath,
			ctaPhrase: promoOverlayResult.ctaPhrase,
			ctaPlacement: promoOverlayResult.ctaPlacement,
			ctaImagePath: promoOverlayResult.ctaImagePath,
			transparentLogoPath: promoOverlayResult.transparentLogoPath,
			transparentCtaImagePath: promoOverlayResult.transparentCtaImagePath,
			outputPath: promoOverlayResult.outputPath,
			modelPromoOverlayPath: promoOverlayResult.modelPromoOverlayPath,
			metadataPath: promoOverlayResult.metadataPath,
		});
		await reportProgress({
			stage: "promo-overlay",
			status: "completed",
			message: "Promo overlay generated.",
			details: {
				modelId: promoOverlayResult.modelId,
				outputPath: promoOverlayResult.outputPath,
				metadataPath: promoOverlayResult.metadataPath,
			},
		});

		return {
			modelId: input.modelId,
			mode: "promo-overlay",
			postType: null,
			outputDir,
			primaryOutputPath: promoOverlayResult.outputPath,
			generationResultPath: null,
			captionPath: null,
			caption: null,
		};
	}

	const modelId = input.modelId ?? (await pickRandomModelId(GAME_ASSETS_DIR));
	const postType = input.postType ?? pickWeightedPostType();
	await reportProgress({
		stage: "selection",
		status: "completed",
		message: "Selected generation target.",
		details: {
			modelId,
			postType,
			modelIdSource: input.modelId ? "input" : "random",
			postTypeSource: input.postType ? "input" : "weighted_random",
		},
	});
	logInfo("Selected generation target", {
		modelId,
		postType,
		modelIdSource: input.modelId ? "input" : "random",
		postTypeSource: input.postType ? "input" : "weighted_random",
	});

	await assertValidModelId(GAME_ASSETS_DIR, modelId);
	const modelAssetsBasePath = getModelAssetsBasePath(GAME_ASSETS_DIR, modelId);
	await reportProgress({
		stage: "asset-load",
		status: "started",
		message: "Loading model assets.",
		details: {
			modelId,
			modelAssetsBasePath,
		},
	});
	logInfo("Loading model assets", { modelAssetsBasePath });
	const {
		artStyleMarkdown,
		gameJson,
		soundInstructionsMarkdown,
		logoMarkdown,
	} = await loadModelAssetFiles(modelAssetsBasePath);
	logInfo("Model assets loaded", {
		hasArtStyle: artStyleMarkdown.length > 0,
		hasGameJson: gameJson.length > 0,
		hasSoundInstructions: soundInstructionsMarkdown.length > 0,
		hasLogoMarkdown: logoMarkdown.length > 0,
	});
	await reportProgress({
		stage: "asset-load",
		status: "completed",
		message: "Model assets loaded.",
		details: {
			modelId,
			modelAssetsBasePath,
			hasArtStyle: artStyleMarkdown.length > 0,
			hasGameJson: gameJson.length > 0,
			hasSoundInstructions: soundInstructionsMarkdown.length > 0,
			hasLogoMarkdown: logoMarkdown.length > 0,
		},
	});

	const game = JSON.parse(gameJson) as unknown;
	const outputDir = await createModelOutputDir(modelId);
	logInfo("Output directory created", { outputDir });
	await reportProgress({
		stage: "output-dir",
		status: "completed",
		message: "Output directory created.",
		details: {
			outputDir,
			modelId,
		},
	});

	let generationResult: PostGenerationResult;
	await reportProgress({
		stage: "content-generation",
		status: "started",
		message: "Generating post content.",
		details: {
			modelId,
			postType,
		},
	});
	logInfo("Generating post content", { postType });
	switch (postType) {
		case "game_feature":
			generationResult = await generateGameFeature({
				modelId,
				outputDir,
				artStyleMarkdown,
				game,
				soundInstructionsMarkdown,
				logoMarkdown,
				modelAssetsBasePath,
				onProgress: options.onProgress,
			});
			break;
		case "symbols":
			generationResult = await generateSymbolsPost({
				modelId,
				outputDir,
				artStyleMarkdown,
				modelAssetsBasePath,
				soundInstructionsMarkdown,
				onProgress: options.onProgress,
			});
			break;
		case "scenery":
			generationResult = await generateSceneryPost({
				modelId,
				outputDir,
				artStyleMarkdown,
				modelAssetsBasePath,
				soundInstructionsMarkdown,
				onProgress: options.onProgress,
			});
			break;
		case "scenery_with_symbols":
		case "scenery_with_symbols_stories":
			generationResult = await generateSceneryWithSymbolsPost({
				modelId,
				outputDir,
				artStyleMarkdown,
				modelAssetsBasePath,
				soundInstructionsMarkdown,
				onProgress: options.onProgress,
			});
			break;
		case "character_with_scenery":
			generationResult = await generateCharacterWithSceneryPost({
				modelId,
				outputDir,
				artStyleMarkdown,
				modelAssetsBasePath,
				soundInstructionsMarkdown,
				onProgress: options.onProgress,
			});
			break;
	}
	logInfo("Post content generated", { postType });
	await reportProgress({
		stage: "content-generation",
		status: "completed",
		message: "Post content generated.",
		details: {
			modelId,
			postType,
			primaryOutputPath: readGenerationResultVideoPath(generationResult),
		},
	});
	for (const warning of collectGenerationWarnings(generationResult)) {
		await reportProgress(warning);
	}

	const generatedVideoPath = readGenerationResultVideoPath(generationResult);
	if (generatedVideoPath) {
		await reportProgress({
			stage: "promo-overlay",
			status: "started",
			message: "Generating promo overlay for final video.",
			details: {
				modelId,
				postType,
				baseVideoPath: generatedVideoPath,
			},
		});
		try {
			const promoOverlayResult = await generatePromoOverlay({
				modelId,
				modelAssetsBasePath,
				gameAssetsDir: GAME_ASSETS_DIR,
				outputDir,
				artStyleMarkdown,
				logoMarkdown,
			});
			const promoVideoPath = path.join(
				path.dirname(generatedVideoPath),
				`${path.basename(generatedVideoPath, path.extname(generatedVideoPath))}-with-promo-overlay.mp4`,
			);
			await overlayTransparentPngOnVideo({
				videoPath: generatedVideoPath,
				overlayImagePath: promoOverlayResult.outputPath,
				outputPath: promoVideoPath,
			});
			generationResult = attachPromoOverlayResult(generationResult, {
				baseVideoPath: generatedVideoPath,
				promoVideoPath,
				promoOverlayPath: promoOverlayResult.outputPath,
				modelPromoOverlayPath: promoOverlayResult.modelPromoOverlayPath,
				promoOverlayCtaText: promoOverlayResult.ctaPhrase,
				promoOverlaySelectedExisting: promoOverlayResult.selectedExisting,
			});
			logInfo("Promo overlay integrated into regular flow", {
				modelId,
				postType,
				baseVideoPath: generatedVideoPath,
				promoVideoPath,
				promoOverlayPath: promoOverlayResult.outputPath,
				promoOverlayCtaText: promoOverlayResult.ctaPhrase,
				promoOverlaySelectedExisting: promoOverlayResult.selectedExisting,
			});
			await reportProgress({
				stage: "promo-overlay",
				status: "completed",
				message: "Promo overlay integrated into final video.",
				details: {
					modelId,
					postType,
					promoVideoPath,
					promoOverlayPath: promoOverlayResult.outputPath,
				},
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn("Promo overlay integration failed; continuing with base video", {
				modelId,
				postType,
				message,
			});
			await reportProgress({
				stage: "promo-overlay",
				status: "warning",
				message: "Promo overlay integration failed; continuing with base video.",
				details: {
					modelId,
					postType,
					error: message,
				},
			});
		}
	} else {
		logWarn("Promo overlay integration skipped because no final video was generated", {
			modelId,
			postType,
		});
		await reportProgress({
			stage: "promo-overlay",
			status: "warning",
			message: "Promo overlay skipped because no final video was generated.",
			details: {
				modelId,
				postType,
			},
		});
	}

	generationResult = attachGenerationMetadata(generationResult, {
		modelId,
		postType,
		folderPath: outputDir,
	});

	const generationResultPath = path.join(outputDir, "generation-result.json");
	await writeFile(
		generationResultPath,
		`${JSON.stringify(generationResult, null, 2)}\n`,
		"utf8",
	);
	logInfo("Generation result saved", { generationResultPath });
	await reportProgress({
		stage: "result-save",
		status: "completed",
		message: "Generation result metadata saved.",
		details: {
			generationResultPath,
			outputDir,
		},
	});

	await reportProgress({
		stage: "caption",
		status: "started",
		message: "Generating caption.",
		details: {
			modelId,
			postType,
		},
	});
	logInfo("Generating caption", { postType });
	const caption = await generateCaption({
		modelId,
		postType,
		game,
	});
	const captionPath = path.join(outputDir, "caption.txt");
	await writeFile(captionPath, `${caption}\n`, "utf8");
	logInfo("Caption generated", { caption });
	logInfo("Caption saved", { captionPath });
	await reportProgress({
		stage: "caption",
		status: "completed",
		message: "Caption generated.",
		details: {
			captionPath,
			captionLength: caption.length,
		},
	});

	await reportProgress({
		stage: "publish-assets",
		status: "started",
		message: "Preparing publish assets.",
		details: {
			outputDir,
		},
	});
	const instagramAssets = await prepareInstagramPublishAssets({
		outputDir,
		generationResult,
	});
	logInfo("Instagram publish assets prepared", {
		preparedImagePath: instagramAssets.preparedImagePath,
	});
	await reportProgress({
		stage: "publish-assets",
		status: "completed",
		message: "Publish assets prepared.",
		details: {
			preparedImagePath: instagramAssets.preparedImagePath,
		},
	});

	await reportProgress({
		stage: "upload",
		status: "started",
		message: "Uploading output directory to S3.",
		details: {
			outputDir,
			modelId,
		},
	});
	logInfo("Uploading output directory to S3", { outputDir, modelId });
	await uploadOutputDirToS3({ modelId, outputDir });
	logInfo("Upload completed", { outputDir, modelId });
	await reportProgress({
		stage: "upload",
		status: "completed",
		message: "Output directory uploaded to S3.",
		details: {
			outputDir,
			modelId,
		},
	});

	await reportProgress({
		stage: "publish",
		status: "started",
		message: "Publishing generated assets.",
		details: {
			outputDir,
			modelId,
			postType,
		},
	});
	logInfo("Publishing to Instagram", { outputDir, modelId, postType });
	const instagramPublishResult = await publishToInstagram({
		outputDir,
		caption,
		generationResult,
		compositedVideoPath: null,
		preparedImagePath: instagramAssets.preparedImagePath,
	});
	logInfo("Instagram publish step finished", {
		outputDir,
		modelId,
		postType,
		skipped: instagramPublishResult.skipped,
		results: instagramPublishResult.results.map((result) => ({
			target: result.target,
			status: result.status,
			postId: result.postId ?? null,
		})),
	});
	for (const event of buildPublishProgressEvents(instagramPublishResult)) {
		await reportProgress(event);
	}

	logInfo("Social media generation finished", { outputDir, modelId, postType });
	await reportProgress({
		stage: "job",
		status: "completed",
		message: "Generation job completed.",
		details: {
			outputDir,
			modelId,
			postType,
		},
	});

	return {
		modelId,
		mode: "default",
		postType,
		outputDir,
		primaryOutputPath: readGenerationResultVideoPath(generationResult),
		generationResultPath,
		captionPath,
		caption,
	};
}

export function parseCliArgs(argv: string[]): GenerationJobInput {
	const parsedArgs: GenerationJobInput = {};

	for (const arg of argv) {
		if (arg.startsWith("modelId=")) {
			const modelId = arg.slice("modelId=".length).trim();
			if (modelId.length > 0) {
				parsedArgs.modelId = modelId;
			}
			continue;
		}

		if (arg.startsWith("postType=")) {
			const postType = arg.slice("postType=".length).trim();
			if (isPostType(postType)) {
				parsedArgs.postType = postType;
				continue;
			}

			throw new Error(
				`Invalid postType \"${postType}\". Expected one of: ${Object.keys(POST_TYPE_SPEC_FILES).join(", ")}.`,
			);
		}

		if (arg.startsWith("s3FolderPath=")) {
			const s3FolderPath = arg.slice("s3FolderPath=".length).trim();
			if (s3FolderPath.length > 0) {
				parsedArgs.s3FolderPath = s3FolderPath;
			}
			continue;
		}

		if (arg.startsWith("caption=")) {
			parsedArgs.caption = arg.slice("caption=".length).trim();
			continue;
		}

		if (arg === "soundOnly=true") {
			parsedArgs.mode = "sound-only";
			continue;
		}

		if (arg === "promoOverlay=true") {
			parsedArgs.mode = "promo-overlay";
			continue;
		}

		if (arg.startsWith("mode=")) {
			const mode = arg.slice("mode=".length).trim();
			if (mode === "sound-only" || mode === "promo-overlay") {
				parsedArgs.mode = mode;
				continue;
			}

			throw new Error(`Invalid mode "${mode}". Expected: sound-only, promo-overlay.`);
		}
	}

	return parsedArgs;
}

export function isPostType(value: string): value is PostType {
	return value in POST_TYPE_SPEC_FILES;
}

function pickWeightedPostType(randomValue = Math.random()): PostType {
	const entries = Object.entries(POST_TYPE_WEIGHTS) as Array<[PostType, number]>;
	const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
	const threshold = randomValue * totalWeight;

	let cumulativeWeight = 0;
	for (const [postType, weight] of entries) {
		cumulativeWeight += weight;
		if (threshold < cumulativeWeight) {
			return postType;
		}
	}

	return entries[entries.length - 1][0];
}

function readGenerationResultVideoPath(generationResult: PostGenerationResult): string | null {
	if (!generationResult.final || typeof generationResult.final !== "object") {
		return null;
	}

	const videoPath = (generationResult.final as Record<string, unknown>).videoPath;
	return typeof videoPath === "string" && videoPath.length > 0 ? videoPath : null;
}

function attachPromoOverlayResult(
	generationResult: PostGenerationResult,
	input: {
		baseVideoPath: string;
		promoVideoPath: string;
		promoOverlayPath: string;
		modelPromoOverlayPath: string;
		promoOverlayCtaText: string;
		promoOverlaySelectedExisting: boolean;
	},
): PostGenerationResult {
	const currentRaw =
		generationResult.raw && typeof generationResult.raw === "object"
			? (generationResult.raw as Record<string, unknown>)
			: {};
	const currentFinal =
		generationResult.final && typeof generationResult.final === "object"
			? (generationResult.final as Record<string, unknown>)
			: {};
	const existingSourceVideoPath = currentFinal.sourceVideoPath;

	return {
		...generationResult,
		raw: {
			...currentRaw,
			promoOverlay: {
				promoOverlayPath: input.promoOverlayPath,
				modelPromoOverlayPath: input.modelPromoOverlayPath,
				promoOverlayCtaText: input.promoOverlayCtaText,
				promoOverlaySelectedExisting: input.promoOverlaySelectedExisting,
				promoVideoPath: input.promoVideoPath,
			},
		},
		final: {
			...currentFinal,
			videoPath: input.promoVideoPath,
			sourceVideoPath:
				typeof existingSourceVideoPath === "string" && existingSourceVideoPath.length > 0
					? existingSourceVideoPath
					: input.baseVideoPath,
			promoOverlayPath: input.promoOverlayPath,
			modelPromoOverlayPath: input.modelPromoOverlayPath,
			promoOverlayCtaText: input.promoOverlayCtaText,
			promoOverlaySelectedExisting: input.promoOverlaySelectedExisting,
			promoVideoPath: input.promoVideoPath,
			baseVideoPath: input.baseVideoPath,
		},
	};
}

function attachGenerationMetadata(
	generationResult: PostGenerationResult,
	metadata: PostGenerationMetadata,
): PostGenerationResult {
	return {
		...generationResult,
		metadata,
	};
}

function collectGenerationWarnings(generationResult: PostGenerationResult): GenerationJobProgressEvent[] {
	const warnings: GenerationJobProgressEvent[] = [];
	const raw = generationResult.raw && typeof generationResult.raw === "object"
		? (generationResult.raw as Record<string, unknown>)
		: null;
	const final = generationResult.final && typeof generationResult.final === "object"
		? (generationResult.final as Record<string, unknown>)
		: null;
	const videoError = typeof raw?.videoError === "string" ? raw.videoError : null;
	if (videoError) {
		warnings.push({
			stage: inferWarningStage(videoError),
			status: "warning",
			message: "A generation stage failed, and the job continued with a reduced output.",
			details: {
				error: videoError,
				videoPath: typeof final?.videoPath === "string" ? final.videoPath : null,
				outputDir: typeof final?.outputDir === "string" ? final.outputDir : null,
			},
		});
	}

	if (final && final.videoPath === null) {
		warnings.push({
			stage: "video",
			status: "warning",
			message: "No final video was produced for this job.",
			details: {
				outputDir: typeof final.outputDir === "string" ? final.outputDir : null,
			},
		});
	}

	return dedupeProgressWarnings(warnings);
}

function buildPublishProgressEvents(result: InstagramPublishResult): GenerationJobProgressEvent[] {
	const events: GenerationJobProgressEvent[] = [];
	if (result.skipped) {
		events.push({
			stage: "publish",
			status: "warning",
			message: "Publishing was skipped.",
			details: {
				reason: result.reason ?? null,
			},
		});
		return events;
	}

	const failedTargets = result.results.filter((record) => record.status === "failed");
	if (failedTargets.length > 0) {
		events.push({
			stage: "publish",
			status: "warning",
			message: "One or more publish targets failed.",
			details: {
				failedTargets: failedTargets.map((record) => ({
					target: record.target,
					assetType: record.assetType,
					error: record.error ?? null,
				})),
			},
		});
	}

	events.push({
		stage: "publish",
		status: "completed",
		message: "Publishing stage completed.",
		details: {
			resultCount: result.results.length,
			successCount: result.results.filter((record) => record.status === "success").length,
			failureCount: failedTargets.length,
		},
	});

	return events;
}

function inferWarningStage(message: string): string {
	const normalized = message.toLowerCase();
	if (normalized.includes("audio") || normalized.includes("sound") || normalized.includes("stable audio")) {
		return "audio";
	}
	if (normalized.includes("video") || normalized.includes("veo")) {
		return "video";
	}
	return "content-generation";
}

function dedupeProgressWarnings(events: GenerationJobProgressEvent[]): GenerationJobProgressEvent[] {
	const seen = new Set<string>();
	return events.filter((event) => {
		const key = JSON.stringify([event.stage, event.status, event.message, event.details ?? null]);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}