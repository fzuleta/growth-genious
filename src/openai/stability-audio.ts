

import { writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_STABILITY_AUDIO_URL =
  'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio';

export type StabilityAudioOutputFormat = 'wav' | 'mp3';

export interface StabilityAudio2Request {
  prompt: string;
  negativePrompt?: string;
  duration?: number;
  seed?: number;
  outputFormat?: StabilityAudioOutputFormat;
  /**
   * Extra raw fields to forward to Stability for forwards-compatibility.
   * Useful when the API adds optional params before we formalize them here.
   */
  extraFields?: Record<string, string | number | boolean | null | undefined>;
}

export interface StabilityAudioClientOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export interface StabilityAudioResponse {
  buffer: Buffer;
  contentType: string;
  outputFormat: StabilityAudioOutputFormat;
  filename: string;
}

export interface SaveStabilityAudioOptions extends StabilityAudio2Request {
  filePath: string;
}

export class StabilityAudioError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'StabilityAudioError';
    this.status = status;
    this.body = body;
  }
}

function getApiKey(explicitApiKey?: string): string {
  const apiKey = explicitApiKey ?? process.env.STABILITY_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Missing Stability API key. Pass `apiKey` explicitly or set `STABILITY_API_KEY`.',
    );
  }

  return apiKey;
}

function normalizeOutputFormat(
  outputFormat?: StabilityAudioOutputFormat,
): StabilityAudioOutputFormat {
  return outputFormat ?? 'wav';
}

function assertPrompt(prompt: string): void {
  if (!prompt || !prompt.trim()) {
    throw new Error('`prompt` is required for Stable Audio 2 generation.');
  }
}

function appendIfPresent(formData: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  formData.append(key, String(value));
}

export function buildStableAudio2FormData(
  input: StabilityAudio2Request,
): FormData {
  assertPrompt(input.prompt);

  const formData = new FormData();
  const outputFormat = normalizeOutputFormat(input.outputFormat);

  formData.append('prompt', input.prompt.trim());
  appendIfPresent(formData, 'negative_prompt', input.negativePrompt?.trim());
  appendIfPresent(formData, 'duration', input.duration);
  appendIfPresent(formData, 'seed', input.seed);
  appendIfPresent(formData, 'output_format', outputFormat);

  if (input.extraFields) {
    for (const [key, value] of Object.entries(input.extraFields)) {
      appendIfPresent(formData, key, value);
    }
  }

  return formData;
}

async function parseErrorResponse(response: Response): Promise<never> {
  const body = await response.text();
  throw new StabilityAudioError(
    `Stable Audio 2 request failed with ${response.status} ${response.statusText}`,
    response.status,
    body,
  );
}

function inferExtension(contentType: string, fallback: StabilityAudioOutputFormat): string {
  if (contentType.includes('mpeg') || contentType.includes('mp3')) {
    return 'mp3';
  }

  if (contentType.includes('wav') || contentType.includes('wave')) {
    return 'wav';
  }

  return fallback;
}

export async function createStableAudio2(
  input: StabilityAudio2Request,
  options: StabilityAudioClientOptions = {},
): Promise<StabilityAudioResponse> {
  const apiKey = getApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_STABILITY_AUDIO_URL;
  const outputFormat = normalizeOutputFormat(input.outputFormat);

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'audio/*',
    },
    body: buildStableAudio2FormData({
      ...input,
      outputFormat,
    }),
  });

  if (!response.ok) {
    await parseErrorResponse(response);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const extension = inferExtension(contentType, outputFormat);

  return {
    buffer,
    contentType,
    outputFormat,
    filename: `stable-audio-2.${extension}`,
  };
}

export async function saveStableAudio2ToFile(
  input: SaveStabilityAudioOptions,
  options: StabilityAudioClientOptions = {},
): Promise<StabilityAudioResponse & { filePath: string }> {
  const filePath = resolve(input.filePath);
  const { filePath: _ignoredFilePath, ...request } = input;

  const audio = await createStableAudio2(request, options);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, audio.buffer);

  return {
    ...audio,
    filePath,
  };
}

export function ensureAudioExtension(
  filePath: string,
  outputFormat: StabilityAudioOutputFormat = 'wav',
): string {
  if (extname(filePath)) {
    return filePath;
  }

  return `${filePath}.${outputFormat}`;
}