import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { fileExists } from "./fs";
import { logError, logInfo, logWarn } from "./log";

const INSTAGRAM_API_BASE_URL = "https://graph.facebook.com/v23.0";
const POLL_INTERVAL_MS = 5_000;
const MAX_STATUS_POLLS = 24;
const execFileAsync = promisify(execFile);
const FFMPEG_PATH = ffmpegInstaller.path;

export interface PublishToInstagramInput {
	outputDir: string;
	caption: string;
	generationResult: unknown;
	compositedVideoPath?: string | null;
	preparedImagePath?: string | null;
	imageUrl?: string | null;
}

export interface PrepareInstagramPublishAssetsInput {
	outputDir: string;
	generationResult: unknown;
}

export interface PrepareInstagramPublishAssetsResult {
	preparedImagePath: string | null;
}

export interface InstagramPublishRecord {
	target:
		| "reel"
		| "story"
		| "image_post"
		| "facebook_page_video"
		| "facebook_page_reel"
		| "facebook_page_image_post";
	assetType: "video" | "image";
	assetPath: string;
	assetUrl: string;
	containerId?: string;
	postId?: string;
	mediaId?: string;
	status: "success" | "failed";
	error?: string;
}

export interface InstagramPublishResult {
	skipped: boolean;
	reason?: string;
	results: InstagramPublishRecord[];
}

export async function publishToInstagram({
	outputDir,
	caption,
	generationResult,
	compositedVideoPath,
	preparedImagePath,
	imageUrl,
}: PublishToInstagramInput): Promise<InstagramPublishResult> {
	const env = getSocialPublishEnv();
	if (!env) {
		const result: InstagramPublishResult = {
			skipped: true,
			reason:
				"Missing a complete publish target. Need IG_ACCESS_TOKEN + IG_ACCOUNT_ID for Instagram and/or FB_PAGE_ACCESS_TOKEN + FB_PAGE_ID for Facebook Page publishing.",
			results: [],
		};
		await saveInstagramPublishResult(outputDir, result);
		logWarn("Instagram publish skipped", { reason: result.reason });
		return result;
	}

	const selectedVideoPath = await pickVideoAssetPath(compositedVideoPath, generationResult);
	const selectedImagePath =
		preparedImagePath && (await fileExists(preparedImagePath))
			? preparedImagePath
			: await pickImageAssetPath(generationResult);
	const selectedImageUrl = imageUrl?.trim() || null;
	const publishRecords: InstagramPublishRecord[] = [];

	logInfo("Instagram publish asset selection", {
		selectedVideoPath,
		selectedImagePath,
		selectedImageUrl,
		outputDir,
	});

	if (selectedVideoPath) {
		const assetUrl = buildPublicAssetUrl(selectedVideoPath);
		await assertPublicAssetUrlReady({
			assetUrl,
			assetType: "video",
		});

		if (env.igAccountId && env.igAccessToken) {
			for (const target of ["reel", "story"] as const) {
				logInfo("Instagram publish asset URL", { target, assetPath: selectedVideoPath, assetUrl });
				try {
					const containerId = await createInstagramMediaContainer({
						igAccountId: env.igAccountId,
						accessToken: env.igAccessToken,
						target,
						videoUrl: assetUrl,
						caption,
					});
					await waitForContainerReady({
						containerId,
						accessToken: env.igAccessToken,
					});
					const postId = await publishInstagramMedia({
						igAccountId: env.igAccountId,
						creationId: containerId,
						accessToken: env.igAccessToken,
					});
					const record: InstagramPublishRecord = {
						target,
						assetType: "video",
						assetPath: selectedVideoPath,
						assetUrl,
						containerId,
						postId,
						status: "success",
					};
					publishRecords.push(record);
					logInfo("Instagram publish succeeded", { target, postId, containerId });
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					const record: InstagramPublishRecord = {
						target,
						assetType: "video",
						assetPath: selectedVideoPath,
						assetUrl,
						status: "failed",
						error: message,
					};
					publishRecords.push(record);
					logError("Instagram publish failed", { target, message });
				}
			}
		}

		if (env.fbPageId && env.fbPageAccessToken) {
			logInfo("Facebook Page publish asset URL", {
				target: "facebook_page_video",
				assetPath: selectedVideoPath,
				assetUrl,
				fbPageId: env.fbPageId,
			});
			try {
				const postId = await publishFacebookPageVideo({
					pageId: env.fbPageId,
					accessToken: env.fbPageAccessToken,
					videoUrl: assetUrl,
					caption,
				});
				const record: InstagramPublishRecord = {
					target: "facebook_page_video",
					assetType: "video",
					assetPath: selectedVideoPath,
					assetUrl,
					postId,
					status: "success",
				};
				publishRecords.push(record);
				logInfo("Facebook Page publish succeeded", {
					target: "facebook_page_video",
					postId,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const record: InstagramPublishRecord = {
					target: "facebook_page_video",
					assetType: "video",
					assetPath: selectedVideoPath,
					assetUrl,
					status: "failed",
					error: message,
				};
				publishRecords.push(record);
				logError("Facebook Page publish failed", {
					target: "facebook_page_video",
					message,
				});
			}
			try {
				const reelId = await publishFacebookPageReel({
					pageId: env.fbPageId,
					accessToken: env.fbPageAccessToken,
					videoUrl: assetUrl,
					caption,
				});
				const record: InstagramPublishRecord = {
					target: "facebook_page_reel",
					assetType: "video",
					assetPath: selectedVideoPath,
					assetUrl,
					postId: reelId,
					status: "success",
				};
				publishRecords.push(record);
				logInfo("Facebook Page publish succeeded", {
					target: "facebook_page_reel",
					postId: reelId,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const record: InstagramPublishRecord = {
					target: "facebook_page_reel",
					assetType: "video",
					assetPath: selectedVideoPath,
					assetUrl,
					status: "failed",
					error: message,
				};
				publishRecords.push(record);
				logError("Facebook Page publish failed", {
					target: "facebook_page_reel",
					message,
				});
			}
		}
	} else if (selectedImagePath || selectedImageUrl) {
		const assetUrl = selectedImageUrl ?? buildPublicAssetUrl(selectedImagePath as string);
		const assetReference = selectedImagePath ?? selectedImageUrl ?? assetUrl;
		await assertPublicAssetUrlReady({
			assetUrl,
			assetType: "image",
		});

		if (env.igAccountId && env.igAccessToken) {
			logInfo("Instagram publish asset URL", {
				target: "image_post",
				assetPath: assetReference,
				assetUrl,
			});
			try {
				const containerId = await createInstagramMediaContainer({
					igAccountId: env.igAccountId,
					accessToken: env.igAccessToken,
					target: "image_post",
					imageUrl: assetUrl,
					caption,
				});
				await waitForContainerReady({
					containerId,
					accessToken: env.igAccessToken,
				});
				const postId = await publishInstagramMedia({
					igAccountId: env.igAccountId,
					creationId: containerId,
					accessToken: env.igAccessToken,
				});
				const record: InstagramPublishRecord = {
					target: "image_post",
					assetType: "image",
					assetPath: assetReference,
					assetUrl,
					containerId,
					postId,
					status: "success",
				};
				publishRecords.push(record);
				logInfo("Instagram publish succeeded", { target: "image_post", postId, containerId });
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const record: InstagramPublishRecord = {
					target: "image_post",
					assetType: "image",
					assetPath: assetReference,
					assetUrl,
					status: "failed",
					error: message,
				};
				publishRecords.push(record);
				logError("Instagram publish failed", { target: "image_post", message });
			}
		}

		if (env.fbPageId && env.fbPageAccessToken) {
			logInfo("Facebook Page publish asset URL", {
				target: "facebook_page_image_post",
				assetPath: assetReference,
				assetUrl,
				fbPageId: env.fbPageId,
			});
			try {
				const publishResult = await publishFacebookPagePhoto({
					pageId: env.fbPageId,
					accessToken: env.fbPageAccessToken,
					imageUrl: assetUrl,
					caption,
				});
				const record: InstagramPublishRecord = {
					target: "facebook_page_image_post",
					assetType: "image",
					assetPath: assetReference,
					assetUrl,
					postId: publishResult.postId ?? undefined,
					mediaId: publishResult.photoId,
					status: "success",
				};
				publishRecords.push(record);
				logInfo("Facebook Page publish succeeded", {
					target: "facebook_page_image_post",
					postId: publishResult.postId,
					photoId: publishResult.photoId,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const record: InstagramPublishRecord = {
					target: "facebook_page_image_post",
					assetType: "image",
					assetPath: assetReference,
					assetUrl,
					status: "failed",
					error: message,
				};
				publishRecords.push(record);
				logError("Facebook Page publish failed", {
					target: "facebook_page_image_post",
					message,
				});
			}
		}
	} else {
		const result: InstagramPublishResult = {
			skipped: true,
			reason: "No publishable final asset found.",
			results: [],
		};
		await saveInstagramPublishResult(outputDir, result);
		logWarn("Instagram publish skipped", { reason: result.reason });
		return result;
	}

	const result: InstagramPublishResult = {
		skipped: false,
		results: publishRecords,
	};
	await saveInstagramPublishResult(outputDir, result);
	return result;
}

export async function prepareInstagramPublishAssets({
	outputDir,
	generationResult,
}: PrepareInstagramPublishAssetsInput): Promise<PrepareInstagramPublishAssetsResult> {
	const selectedImagePath = await pickImageAssetPath(generationResult);
	if (!selectedImagePath) {
		return { preparedImagePath: null };
	}

	const preparedImagePath = await ensureInstagramImageAsset({
		outputDir,
		sourceImagePath: selectedImagePath,
	});
	return { preparedImagePath };
}

function getSocialPublishEnv():
	| {
			igAccessToken: string | null;
			igAccountId: string | null;
			fbPageId: string | null;
			fbPageAccessToken: string | null;
	  }
	| null {
	const igAccessToken = process.env.IG_ACCESS_TOKEN?.trim() || null;
	const igAccountId = process.env.IG_ACCOUNT_ID?.trim() || null;
	const fbPageId = process.env.FB_PAGE_ID?.trim() || null;
	const fbPageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN?.trim() || null;

	const hasInstagramTarget = Boolean(igAccessToken && igAccountId);
	const hasFacebookPageTarget = Boolean(fbPageId && fbPageAccessToken);

	if (!hasInstagramTarget && !hasFacebookPageTarget) {
		return null;
	}

	return { igAccessToken, igAccountId, fbPageId, fbPageAccessToken };
}

async function pickVideoAssetPath(
	compositedVideoPath: string | null | undefined,
	generationResult: unknown,
): Promise<string | null> {
	if (compositedVideoPath && (await fileExists(compositedVideoPath))) {
		return compositedVideoPath;
	}

	const videoPath = readStringProp(readObjectProp(readObjectProp(generationResult, "final"), "videoPath"));
	if (videoPath && (await fileExists(videoPath))) {
		return videoPath;
	}

	return null;
}

async function pickImageAssetPath(generationResult: unknown): Promise<string | null> {
	const finalResult = readObjectProp(generationResult, "final");
	const candidates = [
		readStringProp(readObjectProp(finalResult, "keyframePath")),
		readStringProp(readObjectProp(finalResult, "backgroundPath")),
		readStringProp(readFirstGeneratedFilePath(finalResult)),
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidates) {
		if (await fileExists(candidate)) {
			return candidate;
		}
	}

	return null;
}

async function ensureInstagramImageAsset(input: {
	outputDir: string;
	sourceImagePath: string;
}): Promise<string> {
	const extension = path.extname(input.sourceImagePath).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") {
		return input.sourceImagePath;
	}

	const instagramAssetDir = path.join(input.outputDir, "instagram");
	const preparedImagePath = path.join(instagramAssetDir, "image-post.jpg");
	await mkdir(instagramAssetDir, { recursive: true });
	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-i",
		input.sourceImagePath,
		"-frames:v",
		"1",
		"-q:v",
		"2",
		preparedImagePath,
	]);

	return preparedImagePath;
}

function readFirstGeneratedFilePath(finalResult: unknown): unknown {
	if (!finalResult || typeof finalResult !== "object") {
		return undefined;
	}

	const files = (finalResult as { files?: unknown }).files;
	if (!Array.isArray(files) || files.length === 0) {
		return undefined;
	}

	const firstFile = files[0];
	if (!firstFile || typeof firstFile !== "object") {
		return undefined;
	}

	return (firstFile as { path?: unknown }).path;
}

function readObjectProp(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	return (value as Record<string, unknown>)[key];
}

function readStringProp(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function buildPublicAssetUrl(filePath: string): string {
	const explicitBaseUrl =
		process.env.OUTPUT_PUBLIC_BASE_URL?.trim() ?? process.env.S3_PUBLIC_BASE_URL?.trim();
	const outputBaseDir = path.resolve(process.cwd(), "output");
	const relativeKey = path.relative(outputBaseDir, filePath).split(path.sep).join("/");

	if (relativeKey.startsWith("../") || relativeKey === "..") {
		throw new Error(
			`Instagram asset must be inside the output directory. Received: ${filePath} (output base: ${outputBaseDir})`,
		);
	}

	if (explicitBaseUrl) {
		return new URL(relativeKey, ensureTrailingSlash(explicitBaseUrl)).toString();
	}

	const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
	const bucket = process.env.AWS_BUCKET?.trim() ?? process.env.DO_SPACES_BUCKET?.trim();
	if (!endpoint || !bucket) {
		throw new Error(
			"Missing public asset URL config. Set OUTPUT_PUBLIC_BASE_URL or S3_PUBLIC_BASE_URL, or provide AWS_ENDPOINT_URL plus AWS_BUCKET/DO_SPACES_BUCKET.",
		);
	}

	return new URL(relativeKey, buildBucketPublicBaseUrl(endpoint, bucket)).toString();
}

async function createInstagramMediaContainer(input: {
	igAccountId: string;
	accessToken: string;
	target: "reel" | "story" | "image_post";
	videoUrl?: string;
	imageUrl?: string;
	caption: string;
}): Promise<string> {
	const params = new URLSearchParams({
		access_token: input.accessToken,
	});

	if (input.target === "reel") {
		params.set("media_type", "REELS");
		params.set("video_url", requiredValue(input.videoUrl, "videoUrl"));
		params.set("caption", input.caption);
	} else if (input.target === "story") {
		params.set("media_type", "STORIES");
		params.set("video_url", requiredValue(input.videoUrl, "videoUrl"));
	} else {
		params.set("image_url", requiredValue(input.imageUrl, "imageUrl"));
		params.set("caption", input.caption);
	}

	const response = await fetch(`${INSTAGRAM_API_BASE_URL}/${input.igAccountId}/media`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: params.toString(),
	});

	const payload = (await response.json()) as {
		id?: string;
		error?: { message?: string; code?: number; error_subcode?: number; type?: string };
	};
	if (!response.ok || !payload.id) {
		throw new Error(
			payload.error?.message ??
				`Instagram media container request failed with status ${response.status}`,
		);
	}

	return payload.id;
}

async function waitForContainerReady(input: {
	containerId: string;
	accessToken: string;
}): Promise<void> {
	for (let index = 0; index < MAX_STATUS_POLLS; index += 1) {
		const response = await fetch(
			`${INSTAGRAM_API_BASE_URL}/${input.containerId}?${new URLSearchParams({
				fields: "status_code,status",
				access_token: input.accessToken,
			}).toString()}`,
		);
		const payload = (await response.json()) as {
			status_code?: string;
			status?: string;
			error?: { message?: string };
		};
		if (!response.ok) {
			throw new Error(payload.error?.message ?? `Instagram status poll failed with status ${response.status}.`);
		}

		const statusCode = payload.status_code?.toUpperCase();

		logInfo("Instagram media container status", {
			containerId: input.containerId,
			statusCode,
			status: payload.status,
			pollIndex: index + 1,
			maxPolls: MAX_STATUS_POLLS,
		});

		if (statusCode === "FINISHED" || statusCode === "PUBLISHED") {
			return;
		}

		if (statusCode === "ERROR" || statusCode === "EXPIRED") {
			throw new Error(`Instagram media container failed with status ${statusCode}.`);
		}

		await delay(POLL_INTERVAL_MS);
	}

	throw new Error("Instagram media container did not become ready before timeout.");
}

async function publishInstagramMedia(input: {
	igAccountId: string;
	creationId: string;
	accessToken: string;
}): Promise<string> {
	const response = await fetch(`${INSTAGRAM_API_BASE_URL}/${input.igAccountId}/media_publish`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			creation_id: input.creationId,
			access_token: input.accessToken,
		}).toString(),
	});

	const payload = (await response.json()) as {
		id?: string;
		error?: { message?: string; code?: number; error_subcode?: number; type?: string };
	};
	if (!response.ok || !payload.id) {
		throw new Error(payload.error?.message ?? `Instagram media publish failed with status ${response.status}.`);
	}

	return payload.id;
}
async function publishFacebookPagePhoto(input: {
	pageId: string;
	accessToken: string;
	imageUrl: string;
	caption: string;
}): Promise<{ photoId: string; postId: string | null }> {
	const response = await fetch(`${INSTAGRAM_API_BASE_URL}/${input.pageId}/photos`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			url: input.imageUrl,
			message: input.caption,
			access_token: input.accessToken,
		}).toString(),
	});

	const payload = (await response.json()) as {
		id?: string;
		post_id?: string;
		error?: { message?: string; code?: number; error_subcode?: number; type?: string };
	};
	if (!response.ok || (!payload.id && !payload.post_id)) {
		throw new Error(payload.error?.message ?? `Facebook Page photo publish failed with status ${response.status}.`);
	}

	return {
		photoId: payload.id ?? "",
		postId: payload.post_id ?? null,
	};
}

async function publishFacebookPageVideo(input: {
	pageId: string;
	accessToken: string;
	videoUrl: string;
	caption: string;
}): Promise<string> {
	const response = await fetch(`${INSTAGRAM_API_BASE_URL}/${input.pageId}/videos`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			file_url: input.videoUrl,
			description: input.caption,
			access_token: input.accessToken,
		}).toString(),
	});

	const payload = (await response.json()) as {
		id?: string;
		error?: { message?: string; code?: number; error_subcode?: number; type?: string };
	};
	if (!response.ok || !payload.id) {
		throw new Error(payload.error?.message ?? `Facebook Page video publish failed with status ${response.status}.`);
	}

	return payload.id;
}
async function publishFacebookPageReel(input: {
	pageId: string;
	accessToken: string;
	videoUrl: string;
	caption: string;
}): Promise<string> {
	const response = await fetch(`${INSTAGRAM_API_BASE_URL}/${input.pageId}/video_reels`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			video_url: input.videoUrl,
			description: input.caption,
			access_token: input.accessToken,
		}).toString(),
	});

	const payload = (await response.json()) as {
		id?: string;
		reel_id?: string;
		video_id?: string;
		error?: { message?: string; code?: number; error_subcode?: number; type?: string };
	};
	if (!response.ok || (!payload.id && !payload.reel_id && !payload.video_id)) {
		throw new Error(payload.error?.message ?? `Facebook Page reel publish failed with status ${response.status}.`);
	}

	return payload.reel_id ?? payload.video_id ?? payload.id ?? "";
}

async function saveInstagramPublishResult(
	outputDir: string,
	result: InstagramPublishResult,
): Promise<void> {
	await writeFile(
		path.join(outputDir, "instagram-publish-result.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		"utf8",
	);
}

function requiredValue(value: string | undefined, name: string): string {
	if (!value) {
		throw new Error(`Missing required Instagram value: ${name}`);
	}

	return value;
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function buildBucketPublicBaseUrl(endpoint: string, bucket: string): string {
	const parsedEndpoint = new URL(endpoint);
	const normalizedBucket = bucket.trim();
	if (!normalizedBucket) {
		throw new Error("Missing bucket name for public asset URL.");
	}

	if (!parsedEndpoint.hostname.startsWith(`${normalizedBucket}.`)) {
		parsedEndpoint.hostname = `${normalizedBucket}.${parsedEndpoint.hostname}`;
	}

	parsedEndpoint.pathname = ensureTrailingSlash(parsedEndpoint.pathname);
	return parsedEndpoint.toString();
}

async function assertPublicAssetUrlReady(input: {
	assetUrl: string;
	assetType: "image" | "video";
}): Promise<void> {
	const response = await fetch(input.assetUrl, {
		method: "GET",
		headers: {
			Range: "bytes=0-0",
		},
	});
	if (!response.ok) {
		throw new Error(
			`Instagram asset preflight failed with status ${response.status} for ${input.assetUrl}`,
		);
	}

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	const expectedPrefix = `${input.assetType}/`;
	if (!contentType.startsWith(expectedPrefix)) {
		throw new Error(
			`Instagram asset preflight expected content-type starting with ${expectedPrefix} but received ${contentType || "unknown"} for ${input.assetUrl}`,
		);
	}

	logInfo("Instagram asset preflight passed", {
		assetUrl: input.assetUrl,
		assetType: input.assetType,
		contentType,
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
