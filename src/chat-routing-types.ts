export type ChatRoute = "conversation" | "db-query" | "workspace-question" | "self-modify" | "code-analysis";

export type ChatRouteConfidence = "low" | "medium" | "high";

export interface ChatRouteDecision {
	route: ChatRoute;
	confidence: ChatRouteConfidence;
	subject: string;
	requestedSources: string[];
	entityHints: {
		jobId?: string;
		modelId?: string;
		fileHint?: string;
		topicKeywords: string[];
		selfModifyIntent?: string;
	};
	reason?: string;
}

export interface ChatEvidenceSnippet {
	label: string;
	content: string;
	sourceType: "db" | "workspace";
	sourcePath?: string;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface ChatRouteEvidence {
	route: Exclude<ChatRoute, "conversation" | "self-modify" | "code-analysis">;
	subject: string;
	summary: string;
	snippets: ChatEvidenceSnippet[];
}