import path from "node:path";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const execFileAsync = promisify(execFile);
const ACTIVE_SOUND_WINDOW_SECONDS = 20;
const MIN_ACTIVE_SEGMENT_SECONDS = 1.5;
const FFMPEG_PATH = ffmpegInstaller.path;
const FFPROBE_PATH = ffprobeInstaller.path;

export interface CompositeSoundOverVideoInput {
	outputDir: string;
	generationResult: unknown;
	soundFilePath?: string | null;
}

export interface CompositeSoundOverVideoResult {
	videoPath: string;
	compositedVideoPath: string;
	audioStartSeconds: number;
	clipDurationSeconds: number;
}

export interface CreateZoomVideoFromImageInput {
	imagePath: string;
	outputPath: string;
	durationSeconds?: number;
	fps?: number;
	width?: number;
	height?: number;
	maxZoom?: number;
}

export interface CompositeKeyedLogoAndCtaPngInput {
	logoPath: string;
	ctaImagePath: string;
	outputPath: string;
	width?: number;
	height?: number;
	ctaPlacement?: "top" | "bottom";
}

export interface RemoveChromaKeyFromPngInput {
	inputPath: string;
	outputPath: string;
	threshold?: number;
	keyColorHex?: string;
}

export interface CompositeTransparentLogoAndCtaPngInput {
	logoPath: string;
	ctaImagePath: string;
	outputPath: string;
	width?: number;
	height?: number;
	ctaPlacement?: "top" | "bottom";
}

export interface OverlayTransparentPngOnVideoInput {
	videoPath: string;
	overlayImagePath: string;
	outputPath: string;
}

interface MediaProbe {
	durationSeconds: number;
}

interface ActiveSpan {
	start: number;
	end: number;
}

export async function pickRandomSoundFilePath(
	modelAssetsBasePath: string,
): Promise<string | null> {
	const soundDir = path.join(modelAssetsBasePath, "sound");
	const entries = await readdir(soundDir, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return null;
		}

		throw error;
	});
	if (!entries) {
		return null;
	}
	const soundFilePaths = entries
		.filter((entry) => entry.isFile() && /\.(mp3|wav)$/i.test(entry.name))
		.map((entry) => path.join(soundDir, entry.name));

	if (soundFilePaths.length === 0) {
		return null;
	}

	return soundFilePaths[Math.floor(Math.random() * soundFilePaths.length)];
}

export async function compositeSoundOverVideo({
	outputDir,
	generationResult,
	soundFilePath,
}: CompositeSoundOverVideoInput): Promise<CompositeSoundOverVideoResult | null> {
	const videoPath = getVideoPathFromGenerationResult(generationResult);
	if (!videoPath || !soundFilePath) {
		return null;
	}

	await Promise.all([assertFileExists(videoPath), assertFileExists(soundFilePath)]);

	const [videoProbe, soundProbe] = await Promise.all([
		probeMedia(videoPath),
		probeMedia(soundFilePath),
	]);
	if (videoProbe.durationSeconds <= 0 || soundProbe.durationSeconds <= 0) {
		return null;
	}

	const clipDurationSeconds = Math.max(
		0.5,
		Math.min(videoProbe.durationSeconds, soundProbe.durationSeconds),
	);
	const audioStartSeconds = await pickActiveAudioStart({
		audioPath: soundFilePath,
		audioDurationSeconds: soundProbe.durationSeconds,
		clipDurationSeconds,
	});
	const compositedVideoPath = path.join(
		path.dirname(videoPath),
		`${path.basename(videoPath, path.extname(videoPath))}-with-sfx.mp4`,
	);

	await mkdir(path.dirname(compositedVideoPath), { recursive: true });
	await runComposite({
		videoPath,
		soundFilePath,
		compositedVideoPath,
		audioStartSeconds,
		clipDurationSeconds,
	});
	await writeFile(
		path.join(outputDir, "composite-result.json"),
		`${JSON.stringify(
			{
				videoPath,
				compositedVideoPath,
				audioStartSeconds,
				clipDurationSeconds,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	return {
		videoPath,
		compositedVideoPath,
		audioStartSeconds,
		clipDurationSeconds,
	};
}

export async function createZoomVideoFromImage({
	imagePath,
	outputPath,
	durationSeconds = 8,
	fps = 30,
	width = 1080,
	height = 1920,
	maxZoom = 1.08,
}: CreateZoomVideoFromImageInput): Promise<void> {
	await assertFileExists(imagePath);
	await mkdir(path.dirname(outputPath), { recursive: true });

	const frameCount = Math.max(1, Math.round(durationSeconds * fps));
	const safeMaxZoom = Math.max(1, maxZoom);
	const zoomDelta = Math.max(0, safeMaxZoom - 1);
	const overscaledWidth = roundUpToEven(width * safeMaxZoom);
	const overscaledHeight = roundUpToEven(height * safeMaxZoom);
	const zoomExpression =
		frameCount === 1
			? safeMaxZoom.toFixed(6)
			: `min(${safeMaxZoom.toFixed(6)},1+(${zoomDelta.toFixed(6)}*n/${frameCount - 1}))`;
	const filterComplex = [
		`scale=${overscaledWidth}:${overscaledHeight}:force_original_aspect_ratio=increase:flags=lanczos`,
		`crop=w='trunc(${width}/${zoomExpression}/2)*2':h='trunc(${height}/${zoomExpression}/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2':exact=1`,
		`scale=${width}:${height}:flags=lanczos`,
		"format=yuv420p",
	].join(",");

	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-loop",
		"1",
		"-i",
		imagePath,
		"-filter_complex",
		filterComplex,
		"-t",
		durationSeconds.toString(),
		"-r",
		fps.toString(),
		"-an",
		outputPath,
	]);
}

export async function compositeKeyedLogoAndCtaPng({
	logoPath,
	ctaImagePath,
	outputPath,
	width = 1024,
	height = 1536,
	ctaPlacement = "bottom",
}: CompositeKeyedLogoAndCtaPngInput): Promise<void> {
	await Promise.all([assertFileExists(logoPath), assertFileExists(ctaImagePath)]);
	await mkdir(path.dirname(outputPath), { recursive: true });

	const ctaY = ctaPlacement === "top" ? "80" : "H-h-220";
	const filterComplex = [
		"[0:v]format=rgba,colorchannelmixer=aa=0[base]",
		"[1:v]format=rgba,colorkey=0x00FF00:0.11:0.0,scale=w='min(220,iw)':h=-1[logo]",
		"[2:v]format=rgba,colorkey=0x00FF00:0.09:0.0[cta]",
		`[base][cta]overlay=x=(W-w)/2:y=${ctaY}:format=auto[tmp]`,
		"[tmp][logo]overlay=x=W-w-36:y=H-h-36:format=auto[outv]",
	].join(";");

	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black@0.0:s=${width}x${height}:r=1:d=1`,
		"-i",
		logoPath,
		"-i",
		ctaImagePath,
		"-filter_complex",
		filterComplex,
		"-map",
		"[outv]",
		"-frames:v",
		"1",
		"-c:v",
		"png",
		"-pix_fmt",
		"rgba",
		outputPath,
	]);
}

export async function removeChromaKeyFromPng({
	inputPath,
	outputPath,
	threshold = 0.18,
	keyColorHex,
}: RemoveChromaKeyFromPngInput): Promise<void> {
	await assertFileExists(inputPath);
	await mkdir(path.dirname(outputPath), { recursive: true });
	const resolvedKeyColorHex = keyColorHex ?? (await sampleBackgroundKeyColorHex(inputPath));

	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-i",
		inputPath,
		"-filter_complex",
		`[0:v]format=rgba,colorkey=${resolvedKeyColorHex}:${threshold.toFixed(3)}:0.02[outv]`,
		"-map",
		"[outv]",
		"-frames:v",
		"1",
		"-c:v",
		"png",
		"-pix_fmt",
		"rgba",
		outputPath,
	]);
}

async function sampleBackgroundKeyColorHex(filePath: string): Promise<string> {
	const cornerCrops = [
		"crop=64:64:0:0",
		"crop=64:64:iw-64:0",
		"crop=64:64:0:ih-64",
		"crop=64:64:iw-64:ih-64",
	];
	const cornerSamples = await Promise.all(
		cornerCrops.map((crop) => sampleAverageRgbFromCrop(filePath, crop)),
	);

	const average = cornerSamples.reduce(
		(accumulator, sample) => ({
			r: accumulator.r + sample.r,
			g: accumulator.g + sample.g,
			b: accumulator.b + sample.b,
		}),
		{ r: 0, g: 0, b: 0 },
	);

	return rgbToHex({
		r: Math.round(average.r / cornerSamples.length),
		g: Math.round(average.g / cornerSamples.length),
		b: Math.round(average.b / cornerSamples.length),
	});
}

async function sampleAverageRgbFromCrop(
	filePath: string,
	cropExpression: string,
): Promise<{ r: number; g: number; b: number }> {
	const stdout = await execFileBuffer(FFMPEG_PATH, [
		"-v",
		"error",
		"-i",
		filePath,
		"-vf",
		`${cropExpression},scale=1:1:flags=area,format=rgb24`,
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		"pipe:1",
	]);

	if (stdout.length < 3) {
		throw new Error(`Failed to sample key color from ${filePath}.`);
	}

	return {
		r: stdout[0],
		g: stdout[1],
		b: stdout[2],
	};
}

async function execFileBuffer(command: string, args: string[]): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		execFile(command, args, { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(stdout as Buffer);
		});
	});
}

function rgbToHex(input: { r: number; g: number; b: number }): string {
	return `0x${toHexByte(input.r)}${toHexByte(input.g)}${toHexByte(input.b)}`;
}

function toHexByte(value: number): string {
	return clamp(Math.round(value), 0, 255).toString(16).toUpperCase().padStart(2, "0");
}

export async function compositeTransparentLogoAndCtaPng({
	logoPath,
	ctaImagePath,
	outputPath,
	width = 1024,
	height = 1536,
	ctaPlacement = "bottom",
}: CompositeTransparentLogoAndCtaPngInput): Promise<void> {
	await Promise.all([assertFileExists(logoPath), assertFileExists(ctaImagePath)]);
	await mkdir(path.dirname(outputPath), { recursive: true });

	const ctaY = ctaPlacement === "top" ? "36" : "H-h-320";
	const filterComplex = [
		"[0:v]format=rgba,colorchannelmixer=aa=0[base]",
		"[1:v]format=rgba,scale=w='min(253,iw*1.4)':h=-1[logo]",
		"[2:v]format=rgba,scale=w='min(713,iw*1.4)':h=-1[cta]",
		`[base][cta]overlay=x=(W-w)/2:y=${ctaY}:format=auto[tmp]`,
		"[tmp][logo]overlay=x=W-w-36:y=H-h-36:format=auto[outv]",
	].join(";");

	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black@0.0:s=${width}x${height}:r=1:d=1`,
		"-i",
		logoPath,
		"-i",
		ctaImagePath,
		"-filter_complex",
		filterComplex,
		"-map",
		"[outv]",
		"-frames:v",
		"1",
		"-c:v",
		"png",
		"-pix_fmt",
		"rgba",
		outputPath,
	]);
}

export async function overlayTransparentPngOnVideo({
	videoPath,
	overlayImagePath,
	outputPath,
}: OverlayTransparentPngOnVideoInput): Promise<void> {
	await Promise.all([assertFileExists(videoPath), assertFileExists(overlayImagePath)]);
	await mkdir(path.dirname(outputPath), { recursive: true });
	const videoProbe = await probeMedia(videoPath);

	if (videoProbe.durationSeconds <= 0) {
		throw new Error(`Unable to determine video duration for ${videoPath}.`);
	}

	await execFileAsync(FFMPEG_PATH, [
		"-y",
		"-i",
		videoPath,
		"-loop",
		"1",
		"-i",
		overlayImagePath,
		"-filter_complex",
		"[1:v][0:v]scale2ref=w=main_w:h=main_h[overlay][base];[base][overlay]overlay=0:0:format=auto:repeatlast=1:eof_action=repeat[outv]",
		"-map",
		"[outv]",
		"-map",
		"0:a?",
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"copy",
		"-t",
		videoProbe.durationSeconds.toFixed(3),
		outputPath,
	]);
}

function roundUpToEven(value: number): number {
	return Math.max(2, Math.ceil(value / 2) * 2);
}

function getVideoPathFromGenerationResult(generationResult: unknown): string | null {
	if (!generationResult || typeof generationResult !== "object") {
		return null;
	}

	const finalResult = (generationResult as { final?: unknown }).final;
	if (!finalResult || typeof finalResult !== "object") {
		return null;
	}

	const videoPath = (finalResult as { videoPath?: unknown }).videoPath;
	return typeof videoPath === "string" && videoPath.length > 0 ? videoPath : null;
}

async function assertFileExists(filePath: string): Promise<void> {
	await access(filePath);
}

async function probeMedia(filePath: string): Promise<MediaProbe> {
	const { stdout } = await execFileAsync(FFPROBE_PATH, [
		"-v",
		"error",
		"-show_entries",
		"format=duration:stream=codec_type",
		"-of",
		"json",
		filePath,
	]);
	const parsed = JSON.parse(stdout) as {
		format?: { duration?: string };
		streams?: Array<{ codec_type?: string }>;
	};
	const durationSeconds = Number(parsed.format?.duration ?? 0);

	return {
		durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
	};
}

async function pickActiveAudioStart(input: {
	audioPath: string;
	audioDurationSeconds: number;
	clipDurationSeconds: number;
}): Promise<number> {
	const maxStart = Math.max(0, input.audioDurationSeconds - input.clipDurationSeconds);
	if (maxStart === 0) {
		return 0;
	}

	const randomStart = Math.random() * maxStart;
	const searchMin = Math.max(0, randomStart - ACTIVE_SOUND_WINDOW_SECONDS);
	const searchMax = Math.min(maxStart, randomStart + ACTIVE_SOUND_WINDOW_SECONDS);
	const activeSpans = await detectActiveAudioSpans(input.audioPath, input.audioDurationSeconds);
	const matchingSpan = pickBestSpan(activeSpans, {
		searchMin,
		searchMax,
		clipDurationSeconds: input.clipDurationSeconds,
	});

	return matchingSpan ?? clamp(randomStart, 0, maxStart);
}

async function detectActiveAudioSpans(
	audioPath: string,
	audioDurationSeconds: number,
): Promise<ActiveSpan[]> {
	const { stderr } = await execFileAsync(FFMPEG_PATH, [
		"-hide_banner",
		"-i",
		audioPath,
		"-af",
		"silencedetect=noise=-35dB:d=0.35",
		"-f",
		"null",
		"-",
	]);
	const silenceStarts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) =>
		Number(match[1]),
	);
	const silenceEnds = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) =>
		Number(match[1]),
	);
	const silences: ActiveSpan[] = [];
	for (let index = 0; index < Math.max(silenceStarts.length, silenceEnds.length); index += 1) {
		const start = silenceStarts[index] ?? 0;
		const end = silenceEnds[index] ?? audioDurationSeconds;
		silences.push({
			start: clamp(start, 0, audioDurationSeconds),
			end: clamp(end, 0, audioDurationSeconds),
		});
	}

	const activeSpans: ActiveSpan[] = [];
	let cursor = 0;
	for (const silence of silences.sort((left, right) => left.start - right.start)) {
		if (silence.start > cursor) {
			activeSpans.push({ start: cursor, end: silence.start });
		}
		cursor = Math.max(cursor, silence.end);
	}
	if (cursor < audioDurationSeconds) {
		activeSpans.push({ start: cursor, end: audioDurationSeconds });
	}

	return activeSpans.filter((span) => span.end - span.start >= MIN_ACTIVE_SEGMENT_SECONDS);
}

function pickBestSpan(
	activeSpans: ActiveSpan[],
	input: { searchMin: number; searchMax: number; clipDurationSeconds: number },
): number | null {
	const candidates = activeSpans
		.map((span) => {
			const earliestStart = Math.max(span.start, input.searchMin);
			const latestStart = Math.min(span.end - input.clipDurationSeconds, input.searchMax);
			if (latestStart < earliestStart) {
				return null;
			}

			return {
				earliestStart,
				latestStart,
				width: latestStart - earliestStart,
			};
		})
		.filter((candidate): candidate is { earliestStart: number; latestStart: number; width: number } => candidate !== null)
		.sort((left, right) => right.width - left.width);

	if (candidates.length === 0) {
		return null;
	}

	const best = candidates[0];
	return best.earliestStart + Math.random() * Math.max(0, best.latestStart - best.earliestStart);
}

async function runComposite(input: {
	videoPath: string;
	soundFilePath: string;
	compositedVideoPath: string;
	audioStartSeconds: number;
	clipDurationSeconds: number;
}): Promise<void> {
	const filterComplex = [
		`[1:a]atrim=start=${input.audioStartSeconds}:duration=${input.clipDurationSeconds},asetpts=PTS-STARTPTS,volume=0.55[aout]`,
	].join(";");

	const args = [
		"-y",
		"-i",
		input.videoPath,
		"-i",
		input.soundFilePath,
		"-filter_complex",
		filterComplex,
		"-map",
		"0:v:0",
		"-map",
		"[aout]",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-shortest",
		input.compositedVideoPath,
	];

	await execFileAsync(FFMPEG_PATH, args);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
