import {
	cancelProactiveOutboxItem,
	getGenerationJobById,
	listDueProactiveOutboxItems,
	listRecentGenerationJobs,
	markProactiveOutboxItemSent,
	queueProactiveOutboxItem,
	type ProactiveOutboxDocument,
	type SmediaMongoDatabase,
} from "./db/mongo";
import {
	getSelfModifySessionById,
	listAwaitingApprovalSessions,
} from "./db/self-modify-mongo";
import { logInfo, logWarn } from "./helpers/log";

const DEFAULT_PROACTIVE_DUE_LIMIT = 10;
const DEFAULT_STALLED_APPROVAL_SCAN_LIMIT = 10;
const DEFAULT_STALLED_APPROVAL_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_FAILED_JOB_SCAN_LIMIT = 10;
const DEFAULT_FAILED_JOB_DELAY_MS = 5 * 60 * 1000;

export interface ProactiveDispatchCycleResult {
	evaluatedSessionCount: number;
	scheduledCount: number;
	dispatchedCount: number;
	cancelledCount: number;
	skippedCount: number;
}

export async function runProactiveDispatchCycle(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	sendMessage: (item: ProactiveOutboxDocument) => Promise<boolean>;
}): Promise<ProactiveDispatchCycleResult> {
	const now = new Date();
	const scheduleResult = await scheduleStalledSelfModifyApprovalReminders({
		database: input.database,
		pluginId: input.pluginId,
		now,
	});
	const failedJobResult = await scheduleFailedGenerationJobReminders({
		database: input.database,
		pluginId: input.pluginId,
		now,
	});
	const dueItems = await listDueProactiveOutboxItems(input.database, {
		pluginId: input.pluginId,
		now,
		limit: DEFAULT_PROACTIVE_DUE_LIMIT,
	});

	let dispatchedCount = 0;
	let cancelledCount = 0;
	let skippedCount = 0;

	for (const item of dueItems) {
		const isStillValid = await validateProactiveItem(input.database, item);
		if (!isStillValid) {
			await cancelProactiveOutboxItem(input.database, {
				id: item._id!,
				reason: `${item.reason ?? "unknown"}+invalidated-before-send`,
			});
			cancelledCount += 1;
			continue;
		}

		try {
			const sent = await input.sendMessage(item);
			if (!sent) {
				skippedCount += 1;
				continue;
			}

			await markProactiveOutboxItemSent(input.database, {
				id: item._id!,
				sentAt: new Date(),
			});
			dispatchedCount += 1;
		} catch (error: unknown) {
			skippedCount += 1;
			logWarn("Failed to dispatch proactive outbox item", {
				triggerType: item.triggerType,
				channelId: item.channelId,
				dedupeKey: item.dedupeKey,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const result = {
		evaluatedSessionCount: scheduleResult.evaluatedSessionCount + failedJobResult.evaluatedSessionCount,
		scheduledCount: scheduleResult.scheduledCount + failedJobResult.scheduledCount,
		dispatchedCount,
		cancelledCount,
		skippedCount,
	};

	if (result.scheduledCount > 0 || result.dispatchedCount > 0 || result.cancelledCount > 0 || result.skippedCount > 0) {
		logInfo("Proactive dispatch cycle completed", {
			pluginId: input.pluginId,
			...result,
		});
	}

	return result;
}

async function scheduleStalledSelfModifyApprovalReminders(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	now: Date;
}): Promise<Pick<ProactiveDispatchCycleResult, "evaluatedSessionCount" | "scheduledCount">> {
	const olderThanOrEqual = new Date(input.now.getTime() - getStalledApprovalDelayMs());
	const sessions = await listAwaitingApprovalSessions(input.database, {
		pluginId: input.pluginId,
		olderThanOrEqual,
		limit: DEFAULT_STALLED_APPROVAL_SCAN_LIMIT,
	});

	let scheduledCount = 0;
	for (const session of sessions) {
		const queued = await queueProactiveOutboxItem(input.database, {
			pluginId: input.pluginId,
			dedupeKey: buildStalledApprovalDedupeKey(session.sessionId),
			triggerType: "stalled-self-modify-approval",
			sessionKey: session.sessionKey,
			guildId: session.guildId,
			channelId: session.channelId,
			userId: session.userId,
			relatedSessionId: session.sessionId,
			content: formatStalledApprovalReminder(session.sessionId, session.intent),
			reason: "awaiting-approval-stalled",
			metadata: {
				intent: session.intent,
				username: session.username,
			},
			dueAt: input.now,
			createdAt: input.now,
		});

		if (queued.created) {
			scheduledCount += 1;
		}
	}

	return {
		evaluatedSessionCount: sessions.length,
		scheduledCount,
	};
}

async function scheduleFailedGenerationJobReminders(input: {
	database: SmediaMongoDatabase;
	pluginId: string;
	now: Date;
}): Promise<Pick<ProactiveDispatchCycleResult, "evaluatedSessionCount" | "scheduledCount">> {
	const jobs = await listRecentGenerationJobs(input.database, {
		pluginId: input.pluginId,
		statuses: ["failed"],
		limit: DEFAULT_FAILED_JOB_SCAN_LIMIT,
	});

	let scheduledCount = 0;
	const minimumUpdatedAt = input.now.getTime() - getFailedJobDelayMs();
	for (const job of jobs) {
		if (!job.channelId || !job.guildId) {
			continue;
		}
		if (job.updatedAt.getTime() > minimumUpdatedAt) {
			continue;
		}

		const queued = await queueProactiveOutboxItem(input.database, {
			pluginId: input.pluginId,
			dedupeKey: buildFailedGenerationJobDedupeKey(job.jobId),
			triggerType: "failed-generation-job",
			sessionKey: buildSessionKeyIfAvailable(input.pluginId, job.guildId, job.channelId),
			guildId: job.guildId,
			channelId: job.channelId,
			userId: job.requestedByUserId ?? null,
			relatedJobId: job.jobId,
			content: formatFailedGenerationJobReminder(job.jobId, job.errorMessage, job.events[job.events.length - 1]?.message),
			reason: "generation-job-failed",
			metadata: {
				requestedByUsername: job.requestedByUsername ?? null,
				status: job.status,
			},
			dueAt: input.now,
			createdAt: input.now,
		});

		if (queued.created) {
			scheduledCount += 1;
		}
	}

	return {
		evaluatedSessionCount: jobs.length,
		scheduledCount,
	};
}

async function validateProactiveItem(
	database: SmediaMongoDatabase,
	item: ProactiveOutboxDocument,
): Promise<boolean> {
	if (item.triggerType === "stalled-self-modify-approval") {
		if (!item.relatedSessionId) {
			return false;
		}

		const session = await getSelfModifySessionById(database, item.relatedSessionId);
		return session?.state === "awaiting-approval";
	}

	if (item.triggerType === "failed-generation-job") {
		if (!item.relatedJobId) {
			return false;
		}

		const job = await getGenerationJobById(database, {
			pluginId: item.pluginId,
			jobId: item.relatedJobId,
		});
		return job?.status === "failed";
	}

	return true;
}

function buildStalledApprovalDedupeKey(sessionId: string): string {
	return `stalled-self-modify-approval:${sessionId}`;
}

function buildFailedGenerationJobDedupeKey(jobId: string): string {
	return `failed-generation-job:${jobId}`;
}

function formatStalledApprovalReminder(sessionId: string, intent: string): string {
	return [
		`Self-modify session ${sessionId} is still waiting for approval.`,
		`Requested change: ${intent.trim()}`,
		"Reply approve to execute, cancel to abort, or send feedback to revise the plan.",
	].join("\n");
}

function formatFailedGenerationJobReminder(jobId: string, errorMessage?: string | null, latestEventMessage?: string): string {
	const summary = errorMessage?.trim() || latestEventMessage?.trim() || "The latest generation job failed without a captured error summary.";
	return [
		`Generation job ${jobId} failed.`,
		`Latest error: ${summary}`,
		"If you want, I can help inspect the failure context and suggest the next recovery step.",
	].join("\n");
}

function getStalledApprovalDelayMs(): number {
	const rawValue = process.env.PROACTIVE_STALLED_APPROVAL_DELAY_MS?.trim();
	if (!rawValue) {
		return DEFAULT_STALLED_APPROVAL_DELAY_MS;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed < 60_000) {
		return DEFAULT_STALLED_APPROVAL_DELAY_MS;
	}

	return parsed;
}

function getFailedJobDelayMs(): number {
	const rawValue = process.env.PROACTIVE_FAILED_JOB_DELAY_MS?.trim();
	if (!rawValue) {
		return DEFAULT_FAILED_JOB_DELAY_MS;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed < 60_000) {
		return DEFAULT_FAILED_JOB_DELAY_MS;
	}

	return parsed;
}

function buildSessionKeyIfAvailable(pluginId: string, guildId: string, channelId: string): string {
	return `${pluginId}:${guildId}:${channelId}`;
}