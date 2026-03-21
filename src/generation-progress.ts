export interface GenerationJobProgressEvent {
	stage: string;
	status: "started" | "completed" | "warning" | "failed" | "info";
	message: string;
	details?: Record<string, unknown>;
}

export type GenerationJobProgressCallback = (
	event: GenerationJobProgressEvent,
) => Promise<void> | void;

export interface GenerationJobRunOptions {
	onProgress?: GenerationJobProgressCallback;
}

export async function emitGenerationProgress(
	callback: GenerationJobProgressCallback | undefined,
	event: GenerationJobProgressEvent,
): Promise<void> {
	await callback?.(event);
}