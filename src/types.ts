export const POST_TYPE_WEIGHTS = {
  scenery: 14,
  scenery_with_symbols: 35,
  scenery_with_symbols_stories: 7,
  symbols: 10,
  game_feature: 4,
  character_with_scenery: 30,
} as const;

export type PostType = keyof typeof POST_TYPE_WEIGHTS;

export interface PromptSection {
  title: string;
  cacheHint: "stable" | "ephemeral";
  content: string;
}

export interface PreparedPromptRequest {
  model: string;
  modelId: string;
  postType: PostType;
  generatedAt: string;
  promptSections: PromptSection[];
  prompt: string;
}

export interface PostTypeModuleInput {
  modelId: string;
  specMarkdown: string;
}

export interface PostTypeModule {
  buildPromptSections: (input: PostTypeModuleInput) => PromptSection[];
}

export interface PostGenerationMetadata {
  modelId: string;
  postType: PostType;
  folderPath: string;
}

export interface PostGenerationResult<TRaw = unknown, TFinal = unknown> {
  raw: TRaw;
  final: TFinal;
  metadata?: PostGenerationMetadata;
}
