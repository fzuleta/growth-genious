# Growth Genius Plugin

This plugin owns the `growth-genius` runtime surface.

## Commands

- `/analytics`: fetches the preserved default GA4 report for the last 7 days
- `/analytics 30d`: fetches the preserved default report for the trailing 30 days
- `/analytics 2026-03-01 2026-03-21`: fetches the preserved default report for an explicit date range
- `/analytics metadata`: lists the GA4 dimensions and metrics available to the property
- `/analytics metadata event`: filters metadata to entries matching `event`
- `/analytics admin custom-dimensions`: lists registered custom dimensions
- `/analytics admin custom-metrics`: lists registered custom metrics
- `/analytics admin key-events`: lists configured key events
- `/analytics admin data-streams`: lists property streams
- `/analytics admin audiences`: lists audiences when the Admin API alpha surface is available for the property
- `/analytics report {...json...}`: runs an arbitrary GA4 Data API report request
- `/analytics pivot {...json...}`: runs an arbitrary GA4 pivot report request
- `/analytics funnel {...json...}`: runs an arbitrary GA4 funnel report request
- `/analytics realtime {...json...}`: runs an arbitrary GA4 realtime report request
- `/analytics help`: prints the supported command forms and examples

Report-style analytics runs also execute any configured external endpoints found in `apps/growth-genius/data/endpoints/` and send `x-api-key` using the env var named by each endpoint file's `apiKeyEnv` field.

GA-only forms that do not call external endpoints:

- `/analytics metadata ...`
- `/analytics admin ...`
- `/analytics report ...`
- `/analytics pivot ...`
- `/analytics funnel ...`
- `/analytics realtime ...`

Examples:

- `/analytics report {"days":30,"dimensions":["eventName"],"metrics":["eventCount"],"limit":25}`
- `/analytics pivot {"days":30,"dimensions":["deviceCategory","eventName"],"metrics":["eventCount"],"pivots":[{"fieldNames":["deviceCategory"],"limit":5},{"fieldNames":["eventName"],"limit":10}]}`
- `/analytics funnel {"days":30,"funnel":{"steps":[{"name":"Landing","filterExpression":{"funnelEventFilter":{"eventName":"page_view"}}},{"name":"Purchase","filterExpression":{"funnelEventFilter":{"eventName":"purchase"}}}]}}`
- `/analytics realtime {"dimensions":["eventName"],"metrics":["eventCount"],"limit":10}`

## Boundaries

- Core runtime stays outside `src/plugins/`
- Plugin source and command handlers stay under `src/plugins/growth-genius`
- App-specific context lives under `apps/growth-genius/context.md`
- Plugin outputs are written under `output/growth-genius`
- Plugin-specific env is loaded from `apps/growth-genius/growth-genius.env`
- `DISCORD_BOT_KEY` can be defined in the plugin env file for this plugin
- Google Analytics env requirements are declared by the analytics command handler

## Google Analytics Env

- `GOOGLE_ANALYTICS_PROPERTY_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## External Endpoint Config

- Place endpoint definition files in `apps/growth-genius/data/endpoints/*.json`
- Each file is one named endpoint that runs alongside report-style `/analytics` executions
- Required fields: `url`, `apiKeyEnv`
- Optional fields: `name`, `description`, `method`, `headers`, `query`, `body`, `summaryFields`, `enabled`
- `x-api-key` is always sent using the value from the env var named by `apiKeyEnv`
- String fields inside `url`, `query`, `headers`, and `body` support these templates: `{{propertyId}}`, `{{startDate}}`, `{{endDate}}`, `{{dateLabel}}`, `{{operationKind}}`, `{{presetName}}`, `{{exploreName}}`
- See `apps/growth-genius/data/endpoints/example.json` for the supported shape

Artifacts are written under `output/growth-genius/analytics/` as:

- `latest-request.json`
- `latest-response.json`
- `latest-report.json`
- `latest-summary.md`

Notes:

- `metadata` is the main way to discover all metrics, dimensions, custom definitions, and key-event-derived metrics that the property exposes through the GA4 Data API.
- The command now spans GA4 Data API report surfaces plus selected Admin API list endpoints.
- GA4 supports pivot and funnel-style exploration queries through API endpoints, but Google does not expose saved Explore boards or saved explorations as listable resources through the public APIs.
- External endpoint request and response details are merged into `latest-request.json`, `latest-response.json`, and `latest-summary.md` whenever report-style analytics runs execute them.