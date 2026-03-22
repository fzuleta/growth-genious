# Growth Genius

Discord-based workspace assistant core for repository Q&A, code analysis, memory-backed chat, controlled self-modification, and app-scoped command routing.

## What remains in this repo

- `src/bot.ts`: Discord bot entrypoint
- `src/plugin-contract.ts`: runtime plugin contract for identity, directories, env requirements, and command routing
- `src/plugin-loader.ts`: active plugin loading and startup validation
- `src/plugins/`: plugin-owned commands and docs
- `src/chat-service.ts`: grounded chat prompt assembly and reply generation
- `src/chat-router-service.ts`: route classification for conversation, DB lookup, workspace retrieval, code analysis, and self-modify
- `src/chat-db-query-service.ts`: evidence retrieval from MongoDB-backed history and memory
- `src/workspace-context-service.ts`: evidence retrieval from repository docs and workspace files
- `src/self-modify-service.ts`: plan, approval, execution, build, and restart workflow
- `src/self-modify-tools.ts`: restricted tool surface for self-modify and code-analysis agents
- `src/db/`: MongoDB persistence for chat, memory, and self-modify state
- `workspace-template/context.md`: base workspace guidance used by the assistant

Legacy social-media generation code has been removed from the active runtime surface.

## Run

```bash
npm install
npm start
```

Local watch mode:

```bash
npm run dev
```

## Discord bot behavior

The bot treats normal messages in allowed channels as direct requests.

Built-in commands:

```text
/status
/refreshmemory
/memory
```

Current bot behavior:

- Answers repository and workspace questions using retrieved evidence when needed.
- Stores inbound and outbound chat in MongoDB.
- Maintains short-term and long-term memory summaries.
- Supports a restricted self-modify flow for the authorized user.
- Supports read-only code analysis requests for the authorized user.
- Can short-circuit the default router through plugin commands and an optional plugin-defined route callback.

## Core Vs Plugins

- Core runtime lives in the top-level `src/` services such as the bot, router, chat, memory, db, and self-modify services.
- Plugin implementations live under `src/plugins/`.
- Plugin-specific env lives under `apps/<plugin-folder>/`.
- The runtime supports exactly one active plugin per repo download so freechat routing and memory stay scoped to a single app purpose.
- App-level decision-tree extensions are supported through plugin-owned commands and an optional `routeRequest` callback that runs before the shared classifier.

## Plugin Contract

The active runtime contract lives in `src/plugin-contract.ts`, and the current builtin plugin implementation lives in `src/plugins/growth-genius/`.

Current required fields:

- `id`: stable plugin identifier used for directories and routing
- `name`: assistant identity used by the bot and prompts
- `discordBotKey`: bot token, resolved at runtime from `DISCORD_BOT_KEY` after base and plugin env files are loaded
- `envFilePath`: plugin-specific env file path, typically `apps/{plugin-folder}/{id}.env`
- `rootDir`: plugin-owned source/doc directory
- `outputDir`: plugin-owned artifact directory
- `requiredEnv`: plugin-level env requirements
- `commands`: plugin-owned slash-style commands such as `/analytics`
- `customRoutes`: declarative app-level routes that the shared classifier can target with `route=custom`
- `routeRequest(input)`: optional callback invoked after command matching and before the default router heuristics/LLM classifier

Current contract shape:

```ts
export interface PluginContract {
	id: string;
	name: string;
	discordBotKey: string;
	envFilePath: string;
	rootDir: string;
	outputDir: string;
	requiredEnv: string[];
	commands: PluginCommand[];
	customRoutes?: PluginCustomRoute[];
	routeRequest?: (input: PluginRouteRequest) => Promise<PluginRouteMatch | null> | PluginRouteMatch | null;
}
```

## Current Plugin

- Plugin id: `growth-genius`
- Plugin root: `src/plugins/growth-genius`
- Plugin output: `output/growth-genius`
- Plugin env: `apps/growth-genius/growth-genius.env`
- Example plugin command: `/analytics`

The `/analytics` command is implemented inside the plugin folder, validates Google Analytics env requirements, calls the GA4 Data API, and writes artifacts under `output/growth-genius/analytics/`.

Accepted forms:

- `/analytics`
- `/analytics 30d`
- `/analytics 2026-03-01 2026-03-21`

## Plugin Env Files

- Base shared env stays in `.env`
- Plugin-specific env is loaded from `apps/{plugin-folder}/{plugin-id}.env`
- Legacy fallback still works for `apps/{plugin-id}.env`
- Plugin env values override `.env` values for the active plugin
- `DISCORD_BOT_KEY` may be defined in either `.env` or the active plugin env file
- Exactly one plugin is active per repo download, selected by `PLUGIN_ID`.

Example for the current app:

```bash
apps/growth-genius/growth-genius.env
```

Plugin selection env:

- `PLUGIN_ID`: active plugin id
- `APP_ID`: legacy alias for `PLUGIN_ID`

`ENABLED_PLUGINS` is no longer supported.

## App Context

- Shared agent context can live under `agent/*.md`.
- App-specific operating context lives under `apps/<plugin-folder>/context.md`.
- App-specific reference docs can live under the plugin root, for example `src/plugins/growth-genius/README.md`.
- The primary operating context merges the active app context with shared agent docs, while workspace retrieval can separately load app docs as evidence.

## App-Level Routing

- Use `commands` for explicit slash-style app commands such as `/analytics`.
- Use `customRoutes` for declarative app-specific branches that the shared classifier can target with `route=custom`.
- Use `routeRequest` for imperative or highly dynamic routing that should run before the shared heuristic/LLM classifier.
- This keeps the shared decision tree centralized while allowing the active app to own selected branches of the routing behavior.

## New App Workflow

To repurpose a cloned repo for a new app purpose:

1. Create a new plugin module under `src/plugins/<plugin-id>/`.
2. Create an app folder under `apps/<plugin-id>/` with `<plugin-id>.env` and `context.md`.
3. Register the plugin explicitly in `src/plugins/index.ts`.
4. Set `PLUGIN_ID=<plugin-id>` in `.env` or the deployment environment.
5. Start the bot and confirm startup logs show the intended active plugin.

Starter scaffold files live under `workspace-template/app-template/`.

## Required env

- `OPENAI_API_KEY`
- `DISCORD_BOT_KEY`
- `DISCORD_FELI_ID`

## Optional env

- `DISCORD_ALLOWED_CHANNEL_IDS`
- `DISCORD_CHANNEL_ID`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `DEBUG_FREETALK_OPENAI_INPUTS`
- `GOOGLE_ANALYTICS_PROPERTY_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `mongo_db_user`
- `mongo_db_password`
- `mongo_db_host`
- `mongo_db_tls`

If `MONGODB_URI` is not set, the bot builds a connection string from the `mongo_db_*` variables.

## macOS service wrapper

The bundled `veil` CLI manages the bot as a macOS `launchd` agent.

One-time setup:

```bash
npm install
npm run build
npm link
veil install
```

Useful commands:

```bash
veil start
veil stop
veil restart
veil status
veil update
veil uninstall
```

## Notes

- Enable the Message Content intent for the Discord bot in the developer portal.
- The MongoDB schema still retains historical job-related collections for compatibility with existing stored data.
- If you are upgrading from pre-plugin namespacing data, run the migration in dry-run mode first: `npm run migrate:plugin-namespace -- --plugin growth-genius`, then execute it with `--apply` once the counts look correct.
