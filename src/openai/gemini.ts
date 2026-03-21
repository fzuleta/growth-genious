

import { GoogleGenAI, VideoGenerationReferenceImage } from '@google/genai';

export type GeminiPromptModel = 'gemini-3.1-pro-preview' | 'gemini-3-flash-preview';
export type GeminiImageModel =
  | 'gemini-2.5-flash-image'
  | 'gemini-3.1-flash-image-preview'
  | 'gemini-3-pro-image-preview';
export type GeminiVideoModel = 'veo-3.1-generate-preview';
export type GeminiAspectRatio = '16:9' | '9:16' | '1:1';
export type GeminiVideoResolution = '720p' | '1080p' | '4k';
export type GeminiReferenceType = 'asset' | 'style' | 'character';

export interface GeminiClientOptions {
  apiKey?: string;
}

export interface GeneratePromptOptions {
  model?: GeminiPromptModel;
  systemInstruction?: string;
  input: string;
  temperature?: number;
  responseMimeType?: string;
}

export interface GenerateImageOptions {
  model?: GeminiImageModel;
  prompt: string;
  mimeType?: string;
}

export interface GeminiImageData {
  imageBytes: string;
  mimeType: string;
}

export interface GeminiReferenceImage {
  image: GeminiImageData;
  referenceType?: GeminiReferenceType;
}

export interface GenerateVideoOptions {
  model?: GeminiVideoModel;
  prompt: string;
  image?: GeminiImageData;
  aspectRatio?: GeminiAspectRatio;
  resolution?: GeminiVideoResolution;
  referenceImages?: VideoGenerationReferenceImage[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface GenerateImageThenVideoOptions {
  imageModel?: GeminiImageModel;
  videoModel?: GeminiVideoModel;
  prompt: string;
  mimeType?: string;
  aspectRatio?: GeminiAspectRatio;
  resolution?: GeminiVideoResolution;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface GeneratedPromptResult {
  text: string;
  raw: unknown;
}

export interface GeneratedImageResult {
  image: GeminiImageData;
  raw: unknown;
}

export interface GeneratedVideoResult {
  file: unknown;
  operation: unknown;
  raw: unknown;
}

const DEFAULT_PROMPT_MODEL: GeminiPromptModel = 'gemini-3.1-pro-preview';
const DEFAULT_IMAGE_MODEL: GeminiImageModel = 'gemini-3.1-flash-image-preview';
const DEFAULT_VIDEO_MODEL: GeminiVideoModel = 'veo-3.1-generate-preview';
const DEFAULT_IMAGE_MIME_TYPE = 'image/png';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function createGeminiClient(options: GeminiClientOptions = {}): GoogleGenAI {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Pass apiKey explicitly or set GEMINI_API_KEY in the environment.');
  }

  return new GoogleGenAI({ apiKey });
}

export async function generatePrompt(
  options: GeneratePromptOptions,
  client = createGeminiClient(),
): Promise<GeneratedPromptResult> {
  const response = await client.models.generateContent({
    model: options.model ?? DEFAULT_PROMPT_MODEL,
    contents: options.input,
    config: {
      systemInstruction: options.systemInstruction,
      temperature: options.temperature,
      responseMimeType: options.responseMimeType,
    },
  });

  const text = getResponseText(response);
  if (!text) {
    throw new Error('Gemini prompt generation returned no text.');
  }

  return {
    text,
    raw: response,
  };
}

export async function generateImage(
  options: GenerateImageOptions,
  client = createGeminiClient(),
): Promise<GeneratedImageResult> {
  const response = await client.models.generateContent({
    model: options.model ?? DEFAULT_IMAGE_MODEL,
    contents: options.prompt,
    config: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  const image = extractGeneratedImage(response, options.mimeType ?? DEFAULT_IMAGE_MIME_TYPE);

  return {
    image,
    raw: response,
  };
}

export async function generateVideo(
  options: GenerateVideoOptions,
  client = createGeminiClient(),
): Promise<GeneratedVideoResult> {
  let operation = await client.models.generateVideos({
    model: options.model ?? DEFAULT_VIDEO_MODEL,
    prompt: options.prompt,
    image: options.image,
    config: {
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      referenceImages: options.referenceImages,
    },
  });

  operation = await waitForVideoOperation(operation, client, {
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
  });

  const generatedVideo = extractGeneratedVideo(operation);

  if (!generatedVideo) {
    throw new Error('Veo completed but no generated video was returned.');
  }

  return {
    file: generatedVideo.video,
    operation,
    raw: operation,
  };
}

export async function generateImageThenVideo(
  options: GenerateImageThenVideoOptions,
  client = createGeminiClient(),
): Promise<{ image: GeneratedImageResult; video: GeneratedVideoResult }> {
  const image = await generateImage(
    {
      model: options.imageModel,
      prompt: options.prompt,
      mimeType: options.mimeType,
    },
    client,
  );

  const video = await generateVideo(
    {
      model: options.videoModel,
      prompt: options.prompt,
      image: image.image,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
    },
    client,
  );

  return { image, video };
}

export function bufferToGeminiImageData(buffer: Buffer, mimeType = DEFAULT_IMAGE_MIME_TYPE): GeminiImageData {
  return {
    imageBytes: buffer.toString('base64'),
    mimeType,
  };
}

export function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

async function waitForVideoOperation(
  initialOperation: any,
  client: GoogleGenAI,
  options: { pollIntervalMs?: number; timeoutMs?: number },
): Promise<any> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let operation = initialOperation;

  while (!operation?.done) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Veo video generation after ${timeoutMs}ms.`);
    }

    await sleep(pollIntervalMs);
    operation = await client.operations.getVideosOperation({ operation });
  }

  const errorMessage = operation?.error?.message;
  if (errorMessage) {
    throw new Error(`Veo video generation failed: ${errorMessage}`);
  }

  return operation;
}

function extractGeneratedImage(response: any, fallbackMimeType: string): GeminiImageData {
  const generatedImage = response?.generatedImages?.[0]?.image;
  if (generatedImage?.imageBytes) {
    return {
      imageBytes: generatedImage.imageBytes,
      mimeType: generatedImage.mimeType ?? fallbackMimeType,
    };
  }

  const parts = response?.candidates?.[0]?.content?.parts ?? response?.parts ?? [];
  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (inlineData?.data) {
      return {
        imageBytes: inlineData.data,
        mimeType: inlineData.mimeType ?? inlineData.mime_type ?? fallbackMimeType,
      };
    }
  }

  throw new Error('Gemini image generation returned no image bytes.');
}

function extractGeneratedVideo(operation: any): any {
  return operation?.response?.generatedVideos?.[0] ?? operation?.generatedVideos?.[0] ?? null;
}

function getResponseText(response: any): string {
  if (typeof response?.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  const parts = response?.candidates?.[0]?.content?.parts ?? response?.parts ?? [];
  const text = parts
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}