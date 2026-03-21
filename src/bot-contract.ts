import type { Message } from "discord.js";
import type { ChatRouteConfidence } from "./chat-routing-types";
import type { SmediaMongoDatabase } from "./db/mongo";

export interface CustomRouteRequest {
	content: string;
	channelId: string;
	username: string;
}

export interface CustomRouteHandlerInput {
	assistantName: string;
	database: SmediaMongoDatabase;
	message: Message;
	content: string;
}

export type CustomRouteHandler = (input: CustomRouteHandlerInput) => Promise<string>;

export interface CustomRouteMatch {
	commandName?: string;
	subject: string;
	confidence?: ChatRouteConfidence;
	requestedSources?: string[];
	reason?: string;
	handle: CustomRouteHandler;
}

export interface BotContract {
	name: string;
	discordBotKey: string;
	routeCustomRequest: (input: CustomRouteRequest) => Promise<CustomRouteMatch | null> | CustomRouteMatch | null;
}

const discordBotKey = process.env.DISCORD_BOT_KEY?.trim();
if (!discordBotKey) {
	throw new Error("Missing DISCORD_BOT_KEY. The Discord bot cannot start without it.");
}

export const botContract: BotContract = {
	name: "growth-genious",
	discordBotKey,
	routeCustomRequest: async () => null,
};