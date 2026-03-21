import { addLogTransport, type LogEvent, type LogTransport } from "./log";
import { safeStringify } from "./log-format";

export interface ConfigureLogTransportsResult {
	discordEnabled: boolean;
	reason?: string;
}

export interface DiscordLogPublisher {
	flush: () => Promise<void>;
}

interface DiscordTransportConfig {
	botKey: string;
	guildId: string;
	channelId: string;
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MAX_CONTENT_LENGTH = 2000;

let discordLogPublisher: DiscordLogPublisher | null = null;

export function configureLogTransportsFromEnv(env = process.env): ConfigureLogTransportsResult {
	const botKey = env.DISCORD_BOT_KEY?.trim();
	const guildId = env.DISCORD_GUILD_ID?.trim();
	const channelId = env.DISCORD_CHANNEL_ID?.trim();

	if (!botKey && !guildId && !channelId) {
		discordLogPublisher = null;
		return {
			discordEnabled: false,
			reason: "discord env vars are not set",
		};
	}

	if (!botKey || !guildId || !channelId) {
		discordLogPublisher = null;
		return {
			discordEnabled: false,
			reason:
				"incomplete discord config; expected DISCORD_BOT_KEY, DISCORD_GUILD_ID, and DISCORD_CHANNEL_ID",
		};
	}

	const discordTransport = createDiscordLogTransport({
		botKey,
		guildId,
		channelId,
	});
	discordLogPublisher = {
		flush: discordTransport.flush,
	};

	addLogTransport(
		discordTransport,
	);

	return { discordEnabled: true };
}

export async function publishBufferedDiscordLogs(): Promise<void> {
	if (!discordLogPublisher) {
		return;
	}

	await discordLogPublisher.flush();
}

export function createDiscordLogTransport(config: DiscordTransportConfig):
	LogTransport & DiscordLogPublisher {
	const endpoint = `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(config.channelId)}/messages`;
	let queue: Promise<void> = Promise.resolve();
	const bufferedMessages: string[] = [];

	const sendDiscordMessage = async (content: string): Promise<void> => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bot ${config.botKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				content,
				allowed_mentions: {
					parse: [],
				},
			}),
		});

		if (!response.ok) {
			const responseBody = await response.text();
			throw new Error(
				`Discord API request failed: ${response.status} ${response.statusText} ${responseBody}`,
			);
		}
	};

	const flushBufferedMessages = async (): Promise<void> => {
		if (bufferedMessages.length === 0) {
			return;
		}

		const messagesToSend = buildDiscordPayloads(bufferedMessages);
		for (const content of messagesToSend) {
			await sendDiscordMessage(content);
		}

		bufferedMessages.length = 0;
	};

	const transport = (event: LogEvent) => {
		queue = queue.then(async () => {
			bufferedMessages.push(formatDiscordMessage(event));
		});

		return queue;
	};

	transport.flush = () => {
		queue = queue.then(async () => {
			await flushBufferedMessages();
		});

		return queue;
	};

	return transport;
}

function buildDiscordPayloads(messages: string[]): string[] {
	const payloads: string[] = [];
	let currentChunk = "";

	for (const message of messages) {
		const nextChunk = currentChunk ? `${currentChunk}\n\n${message}` : message;
		if (nextChunk.length <= DISCORD_MAX_CONTENT_LENGTH) {
			currentChunk = nextChunk;
			continue;
		}

		if (currentChunk) {
			payloads.push(currentChunk);
			currentChunk = "";
		}

		if (message.length <= DISCORD_MAX_CONTENT_LENGTH) {
			currentChunk = message;
			continue;
		}

		let start = 0;
		while (start < message.length) {
			const end = Math.min(start + DISCORD_MAX_CONTENT_LENGTH, message.length);
			payloads.push(message.slice(start, end));
			start = end;
		}
	}

	if (currentChunk) {
		payloads.push(currentChunk);
	}

	return payloads;
}

function formatDiscordMessage(event: LogEvent): string {
	const header = `[${event.level.toUpperCase()}] ${event.message}`;
	const context = event.context === undefined
		? ""
		: `Details:\n\`\`\`json\n${safeStringify(event.context)}\n\`\`\``;
	const rawMessage = [header, context].filter(Boolean).join("\n");

	if (rawMessage.length <= DISCORD_MAX_CONTENT_LENGTH) {
		return rawMessage;
	}

	return `${rawMessage.slice(0, DISCORD_MAX_CONTENT_LENGTH - 3)}...`;
}

