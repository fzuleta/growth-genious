# Social Media Script

Generates one social media asset for a game model, saves it under `output/`, uploads the result set to S3-compatible storage, and optionally publishes it to Instagram.

## How it works

1. Picks a game from `game-assets/<model-id>/` and a post type (`scenery`, `symbols`, `game_feature`, etc.).
2. Loads that model's inputs: `game.json`, `art-style.md`, `logo.md`, `sound_instructions.md`, and symbol assets.
3. Uses OpenAI/Gemini/Stability helpers to generate visuals, caption, and soundtrack.
4. Composites audio over the generated video when applicable.
5. Builds or reuses a cached promo overlay, then applies it over the finished base video with ffmpeg.
6. Writes all artifacts to `output/<model-id>/<run-id>/`.
6. Uploads that output folder to S3-compatible storage.
7. If Instagram env vars are present, publishes the final asset as a reel/story/image post.

## Project shape

- `src/index.ts`: main pipeline
- `src/generation-service.ts`: shared generation service used by CLI and bot
- `src/bot.ts`: Discord message bot with serialized job queue
- `src/post-types/`: post-specific generators
- `src/openai/`: AI media clients
- `src/helpers/`: output, media, S3, Instagram, logging
- `game-assets/`: per-game prompts and source assets
- `output/`: generated runs

## Run

```bash
npm install
npm start
```

Watch mode for local development:

```bash
npm run dev
```

This runs `tsx src/index.ts` under `nodemon` and reloads when files change under `src/` or `game-assets/`.

Optional CLI flags:

```bash
npm start -- modelId=ff013-santa postType=scenery
```

Sound-only generation (writes a fresh MP3 to `game-assets/<modelId>/sound`):

```bash
npm run start -- modelId=ff032-fortunes-veil mode=sound-only
```

Promo overlay generation (strict CTA + logo keyed into a transparent PNG):

```bash
npm run start -- modelId=ff032-fortunes-veil mode=promo-overlay
```

This mode:

- Uses `game-assets/<modelId>/` as the base directory.
- Creates `game-assets/<modelId>/logo.png` if missing with a strict chroma-key green background, using `game-assets/<modelId>/logo.md` as the authoritative logo prompt.
- Uses one CTA from `game-assets/cta_phrases.txt` and names the saved overlay after that CTA text.
- Generates a smaller top-band CTA plate using `art-style.md` as prompt authority and only the selected CTA phrase.
- Removes chroma key from generated CTA/logo into transparent PNG intermediates.
- Composites the transparent CTA + transparent logo into the current run folder and also saves the final overlay in `game-assets/<modelId>/promo-overlays/`.
- Generates a new overlay while the model has fewer than 10 CTA-named cached overlays; after that it reuses one of the existing cached overlays.

Regular generation mode also applies a promo overlay automatically:

- The base video is generated first with no promo overlay embedded in model generation.
- ffmpeg then overlays the cached/generated transparent promo PNG onto the finished base video as a post-process.

## Required env

- `OPENAI_API_KEY`
- S3 upload: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL`, and `AWS_BUCKET` or `DO_SPACES_BUCKET`

## Optional env

- Instagram publish: `IG_ACCESS_TOKEN`, `IG_ACCOUNT_ID`, `FB_PAGE_ID`
- Public asset URL override: `OUTPUT_PUBLIC_BASE_URL` or `S3_PUBLIC_BASE_URL`

## Discord bot service

Start the bot:

```bash
npm run start:bot
```

Watch mode for the bot:

```bash
npm run dev:bot
```

`dev:bot` watches `.env`, so changing bot env flags like `DEBUG_FREETALK_OPENAI_INPUTS` restarts the bot automatically during local development.

The bot listens for normal Discord messages in the configured channel and only reacts to this format:

```text
/createpost modelId=ff013-santa postType=scenery
```

You can omit either field and the bot will reuse the CLI fallback behavior:

```text
/createpost
/createpost modelId=ff013-santa
/createpost postType=scenery
```

Queue status command:

```text
/status
```

Recent failed jobs command:

```text
/failedjobs
/failedjobs limit=3
```

Current bot behavior:

- Accepts optional `modelId` and `postType` arguments on `/createpost`.
- If `modelId` is omitted, the bot picks a random valid model.
- If `postType` is omitted, the bot picks a weighted-random post type.
- Rejects malformed or unknown arguments.
- Runs exactly one generation job at a time.
- Queues additional requests up to a configurable max queue length.
- Replies in-channel when the job is accepted, started, completed, or failed.
- Replies to `/status` with the current active job and queue depth.
- Replies to `/failedjobs` with your most recent failed generation jobs in the current channel.
- Treats any other text message in an allowed channel as a direct question for the bot and answers with ChatGPT.
- Persists inbound and outbound channel messages in MongoDB for later lookup.
- Loads every markdown file in `agent/` and sends the combined result with every freeflow chat prompt.

Additional bot env:

- `DISCORD_BOT_KEY`: bot token used for login.
- `DISCORD_ALLOWED_CHANNEL_IDS`: comma-separated list of channel ids allowed to trigger `/createpost`.
- `DISCORD_CHANNEL_ID`: optional fallback single allowed channel if `DISCORD_ALLOWED_CHANNEL_IDS` is not set.
- `DISCORD_MAX_QUEUE_LENGTH`: optional max queued jobs, defaults to `10`.
- `MONGODB_URI`: optional full MongoDB connection string.
- `MONGODB_DB_NAME`: optional MongoDB database name. Defaults to `social-media-script`.
- `DEBUG_FREETALK_OPENAI_INPUTS`: optional debug flag. When truthy (`true`, `1`, `yes`, `on`), the bot stores the text-only FreeTalk prompt payload sent to OpenAI in MongoDB.

If you change this flag outside `npm run dev:bot`, restart the bot process so the updated env is loaded.
- `mongo_db_user`: MongoDB username used when `MONGODB_URI` is not set.
- `mongo_db_password`: MongoDB password used when `MONGODB_URI` is not set.
- `mongo_db_host`: MongoDB host string, for example `host:27017` or a cluster host.
- `mongo_db_tls`: MongoDB TLS flag, accepts `true` or `false`. Defaults to `true`.

If `MONGODB_URI` is not set, the bot builds a connection string from `mongo_db_user`, `mongo_db_password`, `mongo_db_host`, and `mongo_db_tls`.

## macOS service wrapper

For a Mac-native long-running bot, use the bundled `veil` CLI. It wraps the existing Discord bot in a user `launchd` agent, which means:

- the bot starts automatically after login or reboot
- macOS restarts it if it crashes
- you can manage it with `veil start`, `veil stop`, `veil status`, and `veil update`

One-time setup from the repo root:

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

Notes:

- `veil install` writes a LaunchAgent plist to `~/Library/LaunchAgents/com.fezuone.veil.bot.plist`.
- service logs go to `~/Library/Logs/veil/bot.log` and `~/Library/Logs/veil/bot-error.log`.
- the service runs the compiled `dist/bot.js` directly with your current Node executable instead of using `npm run start:bot`.
- keep your `.env` in the repo root; the service uses the repo as its working directory so `dotenv` continues to load it.
- `veil update` runs `npm install`, rebuilds the project, and restarts the service if it is installed.

MongoDB collections are created automatically and always use the `smedia-` prefix:

- `smedia-chat-sessions`
- `smedia-chat-messages`
- `smedia-memory-entries`
- `smedia-context-documents`
- `smedia-openai-debug-inputs` when `DEBUG_FREETALK_OPENAI_INPUTS` is enabled

The FreeTalk debug collection stores text-only request data such as the flattened prompt text, per-message prompt items, model, session/channel/user identifiers, and creation timestamp. It does not store image or video payloads.

Discord setup notes:

- Enable the Message Content intent for the bot in the Discord developer portal, or Discord will not provide the command text.
- The leading `/` is treated as a normal message prefix here, not a Discord slash command.

## Chat context

Store the bot's stable identity and operating guidance as markdown files in `agent/`.

- Every top-level `.md` file in that folder is loaded on every freeflow chat request in alphabetical order.
- Keep those files concise and durable: who the team is, tone, guardrails, product framing, and important operational rules.
- Use MongoDB for evolving chat/session memory, not for this static foundation.
