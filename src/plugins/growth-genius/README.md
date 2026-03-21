# Growth Genius Plugin

This plugin owns the `growth-genius` runtime surface.

## Commands

- `/analytics`: fetches a GA4 report for the default last 7 days
- `/analytics 30d`: fetches a GA4 report for the trailing 30 days
- `/analytics 2026-03-01 2026-03-21`: fetches a GA4 report for an explicit date range

## Boundaries

- Core runtime stays outside `src/plugins/`
- Plugin source and command handlers stay under `src/plugins/growth-genius`
- Plugin outputs are written under `output/growth-genius`
- Plugin-specific env is loaded from `apps/growth-genius/growth-genius.env`
- `DISCORD_BOT_KEY` can be defined in the plugin env file for this plugin
- Google Analytics env requirements are declared by the analytics command handler

## Google Analytics Env

- `GOOGLE_ANALYTICS_PROPERTY_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Artifacts are written under `output/growth-genius/analytics/` as:

- `latest-request.json`
- `latest-report.json`
- `latest-summary.md`