# Growth Genious

Discord-based workspace assistant for repository Q&A, code analysis, memory-backed chat, and controlled self-modification.

## What remains in this repo

- `src/bot.ts`: Discord bot entrypoint
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
