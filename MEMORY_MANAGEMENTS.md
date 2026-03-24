# Memory Management Analysis

## TL;DR

- The current memory system is a practical three-layer design: raw chat history in MongoDB, per-session short-term summaries, and per-user long-term profiles.
- It is incremental, checkpoint-driven, plugin-scoped, and reasonably token-conscious. That is a solid foundation.
- The two highest-risk memory-boundary issues have now been fixed in code: main chat recall is restricted to same-user past session summaries, and long-term profile refresh only includes assistant messages explicitly linked to the target user.
- The system is more of a compact summarization pipeline than a full memory platform. It has no semantic retrieval, no versioned memory history, no confidence model, and limited observability.
- If memory quality is important, the first upgrades should be: tighten retrieval scope, fix long-term source selection, and introduce stronger memory entry typing plus better inspection tooling.

## Overall Assessment

The implementation is good enough to be useful today, and it is clearly designed with cost and prompt budget in mind. The architecture is not naive. It has explicit checkpoints, bounded source windows, deduplicating upserts, TTL-based retention for volatile data, and prompt assembly that separates stable context from recent context.

That said, the current implementation optimizes more for operational simplicity than for memory correctness. The risk is not that memory does nothing. The risk is that it sometimes remembers the wrong things, remembers them too broadly, or mixes signal across users.

## Current Architecture

### 1. Raw conversation capture

Conversation data is persisted in MongoDB through `appendChatMessage` in `src/db/mongo.ts`.

What is stored:

- Session records in `chatSessions`
- Individual messages in `chatMessages`
- Memory artifacts in `memoryEntries`
- Incremental parsing state in `memoryCheckpoints`

Relevant runtime behavior:

- Normal chat is stored.
- Assistant replies are also stored.
- Commands are stored as `kind=command`.
- Maintenance commands such as `/memory` and `/refreshmemory` are explicitly marked `memoryEligible=false`, so they do not pollute memory summaries.
- Plugin commands and some self-modify interactions are intentionally memory-eligible.

This is a sensible model: memory is derived from the full interaction stream, not just user text.

### 2. Short-term memory

Short-term memory is session-scoped and represented as a single upserted memory entry of kind `short-term-summary`.

Implementation details:

- Consolidation happens in `runChatMemoryConsolidationCycle` and `consolidateSessionMemory` in `src/chat-memory-service.ts`.
- A checkpoint of kind `session-short-term` stores `lastParsedMessageAt`.
- Source messages come from the current session only.
- Eligible message kinds are `chat`, `command`, and `job-update`.
- The source window is capped at 50 eligible messages per pass.
- The generated summary is capped at 1000 words.
- The summary is stored with participant user IDs in metadata.

This is effectively a rolling session recap, not a message-level memory store.

### 3. Long-term memory

Long-term memory is user-scoped and represented as a single upserted memory entry of kind `long-term-profile`.

Implementation details:

- Refresh happens in `maybeRefreshLongTermProfileForUser` in `src/chat-memory-service.ts`.
- A checkpoint of kind `user-long-term` stores `lastParsedMessageAt` per user.
- The system loads recent session summaries involving that user and uses them as cross-session context.
- The generated profile is capped at 3000 words.
- The result is stored once per user via upsert.

This is meant to hold durable preferences, working style, priorities, and stable patterns.

### 4. Retrieval during chat

When generating a chat reply in `src/chat-service.ts`, the prompt is assembled from several layers:

- Long-term profile
- `context.md`
- Route/evidence context when applicable
- Latest short-term summary
- Unsummarized recent messages since the last short-term summary
- Keyword-recalled memory entries
- Recent raw chat history

This layering is good. It reduces prompt bloat and keeps durable information separate from immediate context.

### 5. DB-query retrieval path

The DB-query route in `src/chat-db-query-service.ts` also uses memory artifacts as evidence:

- Current short-term summary
- Current long-term profile
- Unsummarized recent activity
- Keyword-matched memory entries

This is consistent with the chat path, although the scoping is different and in one important case safer.

## What Is Working Well

### Incremental consolidation is the right shape

Using `memoryCheckpoints` to track `lastParsedMessageAt` is the strongest part of the design. It avoids rescanning the entire conversation history on every turn and makes memory updates predictable.

### Prompt budget awareness is good

The implementation is explicitly designed to control token cost:

- Short-term and long-term memories are bounded by word limits.
- Unsummarized message bridging is capped.
- Recent history is bounded.
- Memory recall count is bounded.

This is the right direction for a production chat assistant.

### Plugin scoping is built into persistence

The `pluginId` namespace is consistently part of storage and indexing. That matters because it prevents cross-app contamination in shared Mongo deployments.

### Explicit memory eligibility is a strong control

Using `metadata.memoryEligible !== false` is a pragmatic way to keep operational commands out of summaries while still allowing high-signal commands and plugin interactions into memory.

### Short-term and long-term memory are separated clearly

The distinction is clean:

- Short-term = current session state and open threads
- Long-term = durable user profile

That separation is conceptually sound and maps well to how chat assistants should reason.

## Main Weaknesses And Risks

### 1. Main chat keyword recall was too broad

This was the most important issue, and it is now fixed.

In `generateChatReply`, memory recall uses `searchMemoryEntries` with:

- `pluginId`
- keyword list
- kinds `short-term-summary` and `long-term-profile`
- no `userId`
- no `sessionKey`
- no `scope`

That previously meant the model could recall memory entries from unrelated sessions and unrelated users inside the same plugin namespace.

Practical consequence:

- A user asking about a topic could receive context pulled from someone else's session recap or long-term profile if the keywords overlapped.

The recall path now only searches session-scoped short-term summaries for the current user and excludes the active session, while the current user's long-term profile continues to be injected directly from the snapshot.

### 2. Long-term profile refresh was mixing in assistant messages too broadly

The source query for `maybeRefreshLongTermProfileForUser` includes:

- user messages where `userId = targetUserId`
- assistant messages linked to the target user through reply metadata

Previously it did not constrain assistant messages by session, channel, or related user.

Practical consequence:

- While rebuilding one user's long-term profile, the assistant could ingest replies that were actually part of other users' conversations.
- That could create inaccurate user profiles and false preference attribution.

The implementation now only includes assistant messages where `metadata.relatedUserId` matches the target user.

### 3. Search is regex-based, not semantic

`searchMemoryEntries` is a case-insensitive regex over `content`.

That is simple and cheap, but limited:

- It misses semantically related content when wording differs.
- It can over-match generic terms.
- It gets noisier as memory volume grows.
- It provides no ranking beyond recency.

For now, this is acceptable for a small deployment. It will not age well if memory becomes central.

### 4. Memory entries are overwritten, not versioned

Both short-term and long-term memory use `upsertMemoryEntry`, which preserves only the latest record per scope/key.

Benefits:

- Cheap storage
- Simpler retrieval

Tradeoffs:

- No historical memory versions
- No audit trail for memory drift
- No easy way to compare how profiles evolved
- No offline evaluation of summarization quality over time

If you later want memory debugging or regression testing, this will become a limitation.

### 5. `chatSessions.memoryEntryIds` is drifting from reality

`createMemoryEntry` updates `chatSessions.memoryEntryIds`, but the active memory path uses `upsertMemoryEntry`.

As a result:

- the session document does not appear to stay linked to the memory entries that are actually being maintained through the automatic pipeline.

Today this is mostly a design smell because the field does not seem to be actively used elsewhere. But it is still a sign that the data model and the runtime behavior are not fully aligned.

### 6. Inspection is shallow

`/memory` currently exposes only:

- short-term summary
- long-term profile

It does not expose:

- checkpoint state
- unsummarized message count or contents
- source window boundaries
- recent consolidation failures
- keyword recall candidates

That makes it harder to debug memory quality in production.

### 7. Retention policy is inconsistent by design

Current retention behavior:

- `chatMessages`: TTL 30 days
- `chatSessions`: TTL 30 days based on `lastMessageAt`
- `short-term-summary`: TTL 60 days
- `long-term-profile`: no TTL
- `memoryCheckpoints`: no TTL

This can be reasonable, but it means long-term profiles can outlive the raw evidence used to build them. That may be intentional, but it should be considered explicitly rather than implicitly accepted.

### 8. Long-term keyword recall is inconsistently scoped across code paths

There is an asymmetry:

- In the main chat path, keyword recall is too broad and can pull other users' long-term profiles.
- In the DB-query path, `searchMemoryEntries` is called with `userId`, but that filter uses `metadata.participantUserIds`.

Since long-term profiles do not store `participantUserIds`, that filter effectively favors session summaries and may exclude long-term profiles from keyword search.

So the system is currently inconsistent in opposite ways:

- one path is too open
- one path is too narrow

## Design Intent Versus Actual Behavior

The intended model appears to be:

- Session memory should summarize what is happening now.
- Long-term memory should summarize durable patterns about one user.
- Recall should bring back relevant prior context.

The current actual behavior is closer to this:

- Session memory mostly works as intended.
- Long-term memory is structurally right but has source contamination risk.
- Recall works, but the scoping rules are not strict enough to trust it fully.

That means the system is already useful, but not yet trustworthy enough to be treated as high-integrity memory.

## Recommended Priorities

### Priority 1: Fix retrieval scope in the main chat path

Change keyword recall so it cannot pull unrelated users' memory by default.

Reasonable options:

- Restrict recall to the current session's short-term summary plus the current user's long-term profile.
- Or split recall into two explicit searches: session-scoped recap search and current-user long-term search.
- Only allow broader cross-session recall if you intentionally opt into it.

This is the highest-value fix.

### Priority 2: Fix long-term profile source selection

The long-term profile builder should not consume arbitrary assistant messages across the entire plugin.

Better source rules would be:

- only user messages by the target user
- plus assistant replies from sessions where that user participated
- or assistant replies whose metadata clearly maps them to that user/session

Without this change, long-term memory can be directionally wrong.

### Priority 3: Improve observability

Extend `/memory` or add a deeper inspect mode that shows:

- short-term summary age and source window
- long-term profile age and last refresh window
- checkpoint timestamps
- unsummarized message count
- latest consolidation metrics
- top recall candidates for the current query

If memory is important, this tooling will pay for itself quickly.

### Priority 4: Introduce memory entry provenance and evaluation hooks

Add metadata that makes memory easier to trust and debug:

- source message count
- source message IDs or window IDs
- consolidation model used
- quality metrics beyond keyword coverage
- confidence or stability markers

The current keyword coverage metric is a useful start, but it is not sufficient as a quality signal.

### Priority 5: Decide whether you want a summary system or a memory system

Right now the implementation is primarily a summary system.

If you want a true memory system, likely next capabilities are:

- explicit fact extraction
- semantic retrieval or hybrid retrieval
- versioned memory history
- memory invalidation or decay rules
- stronger user/session privacy boundaries

If you want to stay lightweight, that is also valid. But then the code and docs should frame it as compact recap plus user profile, not as generalized memory.

## Recommended Data Model Direction

If I were evolving this design, I would keep the current layers but make the contracts stricter:

1. Raw events
- append-only chat and command log

2. Session recap
- single active short-term summary per session
- optional recap history table if you want debugging

3. User profile
- single active long-term profile per user
- built only from user-linked evidence

4. Explicit recall units
- extracted facts, preferences, constraints, and ongoing topics
- each with provenance and optional expiration

That hybrid model gives you cheap prompting plus better retrieval precision.

## Final Verdict

The current implementation is a strong first-generation memory pipeline.

What is already good:

- incremental consolidation
- bounded prompt construction
- session versus user separation
- plugin namespacing
- explicit memory eligibility

What prevents it from being fully reliable:

- recall scoping is too loose in the main chat path
- long-term source selection is too broad
- retrieval is regex-only
- debugging and provenance are still thin

If memory is an important product capability for you, I would not replace this design. I would harden it.

The foundation is worth keeping. The next step is to make it trustworthy.