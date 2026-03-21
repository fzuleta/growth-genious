

import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';

export type OpenAIClientOptions = {
  apiKey?: string;
  organization?: string;
  project?: string;
};

export type ImageModel = 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini';
export type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type ImageBackground = 'auto' | 'opaque' | 'transparent';

export type VideoModel = 'sora-2' | 'sora-2-pro';
export type VideoSeconds = 4 | 8 | 12;
export type VideoSize = '720x1280' | '1280x720' | '1024x1792' | '1792x1024';
export type VideoVariant = 'video' | 'thumbnail' | 'spritesheet';

export type GenerateImageInput = {
  prompt: string;
  model?: ImageModel;
  size?: ImageSize;
  quality?: ImageQuality;
  outputFormat?: ImageOutputFormat;
  background?: ImageBackground;
  n?: number;
  user?: string;
};

export type EditImageInput = {
  prompt: string;
  imagePaths: string[];
  model?: ImageModel;
  size?: ImageSize;
  quality?: ImageQuality | 'standard';
  outputFormat?: ImageOutputFormat;
  background?: ImageBackground;
  inputFidelity?: 'high' | 'low';
  n?: number;
  user?: string;
};

export type GeneratedImageFile = {
  index: number;
  path: string;
  mimeType: string;
  revisedPrompt?: string;
};

export type GenerateImageResult = {
  createdAt: number | null;
  outputFormat: ImageOutputFormat;
  files: GeneratedImageFile[];
  raw: unknown;
};

export type GenerateVideoInput = {
  prompt: string;
  model?: VideoModel;
  size?: VideoSize;
  seconds?: VideoSeconds;
  referenceImagePath?: string;
};

export type PollVideoOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type DownloadVideoAssetsInput = {
  videoId: string;
  outputDir: string;
  basename?: string;
  includeThumbnail?: boolean;
  includeSpritesheet?: boolean;
};

export type DownloadedVideoAssets = {
  videoPath: string;
  thumbnailPath?: string;
  spritesheetPath?: string;
};

const DEFAULT_IMAGE_MODEL: ImageModel = 'gpt-image-1.5';
const DEFAULT_VIDEO_MODEL: VideoModel = 'sora-2';
const DEFAULT_IMAGE_FORMAT: ImageOutputFormat = 'png';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function createOpenAIClient(options: OpenAIClientOptions = {}): OpenAI {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Pass apiKey explicitly or set it in the environment.');
  }

  return new OpenAI({
    apiKey,
    organization: options.organization ?? process.env.OPENAI_ORG_ID,
    project: options.project ?? process.env.OPENAI_PROJECT_ID,
  });
}

export async function generateImages(
  client: OpenAI,
  input: GenerateImageInput,
  outputDir: string,
): Promise<GenerateImageResult> {
  await fs.mkdir(outputDir, { recursive: true });

  const outputFormat = input.outputFormat ?? DEFAULT_IMAGE_FORMAT;

  const response = await client.images.generate({
    model: input.model ?? DEFAULT_IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size ?? '1536x1024',
    quality: input.quality ?? 'high',
    output_format: outputFormat,
    background: input.background ?? 'opaque',
    n: input.n ?? 1,
    user: input.user,
  });

  const files: GeneratedImageFile[] = [];

  for (const [index, image] of (response.data ?? []).entries()) {
    if (!image?.b64_json) {
      throw new Error(`Image ${index} did not include b64_json content.`);
    }

    const filePath = path.join(outputDir, `image-${String(index + 1).padStart(2, '0')}.${outputFormat}`);
    const buffer = Buffer.from(image.b64_json, 'base64');
    await fs.writeFile(filePath, buffer);

    files.push({
      index,
      path: filePath,
      mimeType: getImageMimeType(outputFormat),
      revisedPrompt: image.revised_prompt ?? undefined,
    });
  }

  return {
    createdAt: typeof response.created === 'number' ? response.created : null,
    outputFormat,
    files,
    raw: response,
  };
}

export async function editImages(
  client: OpenAI,
  input: EditImageInput,
  outputDir: string,
): Promise<GenerateImageResult> {
  await fs.mkdir(outputDir, { recursive: true });

  if (input.imagePaths.length === 0) {
    throw new Error('editImages requires at least one input image.');
  }

  const outputFormat = input.outputFormat ?? DEFAULT_IMAGE_FORMAT;
  const uploadedImages = await Promise.all(
    input.imagePaths.map(async (imagePath) =>
      toFile(await fs.readFile(imagePath), path.basename(imagePath), {
        type: getMimeTypeFromPath(imagePath),
      }),
    ),
  );

  const response = await client.images.edit({
    model: input.model ?? DEFAULT_IMAGE_MODEL,
    image: uploadedImages.length === 1 ? uploadedImages[0] : uploadedImages,
    prompt: input.prompt,
    size: input.size ?? '1024x1536',
    quality: input.quality ?? 'high',
    output_format: outputFormat,
    background: input.background ?? 'opaque',
    input_fidelity: input.inputFidelity ?? 'high',
    n: input.n ?? 1,
    user: input.user,
  });

  const files: GeneratedImageFile[] = [];

  for (const [index, image] of (response.data ?? []).entries()) {
    if (!image?.b64_json) {
      throw new Error(`Image ${index} did not include b64_json content.`);
    }

    const filePath = path.join(outputDir, `image-${String(index + 1).padStart(2, '0')}.${outputFormat}`);
    const buffer = Buffer.from(image.b64_json, 'base64');
    await fs.writeFile(filePath, buffer);

    files.push({
      index,
      path: filePath,
      mimeType: getImageMimeType(outputFormat),
      revisedPrompt: image.revised_prompt ?? undefined,
    });
  }

  return {
    createdAt: typeof response.created === 'number' ? response.created : null,
    outputFormat,
    files,
    raw: response,
  };
}

export async function createVideo(
  client: OpenAI,
  input: GenerateVideoInput,
): Promise<unknown> {
  if (input.referenceImagePath) {
    const referenceFile = await toFile(
      fs.open(input.referenceImagePath).then(async (handle) => {
        try {
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      }),
      path.basename(input.referenceImagePath),
      { type: getMimeTypeFromPath(input.referenceImagePath) },
    );

    return client.videos.create({
      model: input.model ?? DEFAULT_VIDEO_MODEL,
      prompt: input.prompt,
      size: input.size ?? '1280x720',
      seconds: String(input.seconds ?? 8) as `${VideoSeconds}`,
      input_reference: referenceFile,
    });
  }

  return client.videos.create({
    model: input.model ?? DEFAULT_VIDEO_MODEL,
    prompt: input.prompt,
    size: input.size ?? '1280x720',
    seconds: String(input.seconds ?? 8) as `${VideoSeconds}`,
  });
}

export async function waitForVideoCompletion(
  client: OpenAI,
  videoId: string,
  options: PollVideoOptions = {},
): Promise<unknown> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (true) {
    const video = await client.videos.retrieve(videoId);
    const status = readVideoStatus(video);

    if (status === 'completed') {
      return video;
    }

    if (status === 'failed' || status === 'cancelled') {
      throw new Error(getVideoFailureMessage(video));
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for video ${videoId} after ${timeoutMs}ms.`);
    }

    await sleep(pollIntervalMs);
  }
}

export async function createVideoAndWait(
  client: OpenAI,
  input: GenerateVideoInput,
  options: PollVideoOptions = {},
): Promise<unknown> {
  const created = (await createVideo(client, input)) as { id?: string };

  if (!created?.id) {
    throw new Error('Video creation did not return an id.');
  }

  return waitForVideoCompletion(client, created.id, options);
}

export async function downloadVideoAssets(
  client: OpenAI,
  input: DownloadVideoAssetsInput,
): Promise<DownloadedVideoAssets> {
  await fs.mkdir(input.outputDir, { recursive: true });

  const base = input.basename ?? input.videoId;
  const videoPath = path.join(input.outputDir, `${base}.mp4`);
  await downloadVideoVariant(client, input.videoId, 'video', videoPath);

  let thumbnailPath: string | undefined;
  if (input.includeThumbnail) {
    thumbnailPath = path.join(input.outputDir, `${base}.thumbnail.webp`);
    await downloadVideoVariant(client, input.videoId, 'thumbnail', thumbnailPath);
  }

  let spritesheetPath: string | undefined;
  if (input.includeSpritesheet) {
    spritesheetPath = path.join(input.outputDir, `${base}.spritesheet.jpg`);
    await downloadVideoVariant(client, input.videoId, 'spritesheet', spritesheetPath);
  }

  return {
    videoPath,
    thumbnailPath,
    spritesheetPath,
  };
}

async function downloadVideoVariant(
  client: OpenAI,
  videoId: string,
  variant: VideoVariant,
  outputPath: string,
): Promise<void> {
  const content = await client.videos.downloadContent(videoId, { variant });
  const arrayBuffer = await content.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

function getImageMimeType(format: ImageOutputFormat): string {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function getMimeTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error(`Unsupported reference image extension: ${extension}`);
  }
}

function readVideoStatus(video: unknown): string | undefined {
  if (!video || typeof video !== 'object') {
    return undefined;
  }

  const status = Reflect.get(video, 'status');
  return typeof status === 'string' ? status : undefined;
}

function getVideoFailureMessage(video: unknown): string {
  if (!video || typeof video !== 'object') {
    return 'Video generation failed.';
  }

  const status = Reflect.get(video, 'status');
  const error = Reflect.get(video, 'error');
  const message = error && typeof error === 'object' ? Reflect.get(error, 'message') : undefined;

  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  if (typeof status === 'string' && status.trim()) {
    return `Video generation ended with status: ${status}`;
  }

  return 'Video generation failed.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
