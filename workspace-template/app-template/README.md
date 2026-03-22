# App Template

Use these files as the minimum scaffold for a new app in a cloned repo.

## Files

- `plugin-index.ts`: plugin module to register under `src/plugins/<plugin-id>/index.ts`
- `commands/example.ts`: starter command showing the app command contract
- `context.md`: app-specific operating context for the active app
- `app.env.example`: app-specific env template to copy to `apps/<plugin-id>/<plugin-id>.env`

## Setup

1. Copy `plugin-index.ts` to `src/plugins/<plugin-id>/index.ts`.
2. Copy `commands/example.ts` to `src/plugins/<plugin-id>/commands/example.ts`.
3. Copy `context.md` to `apps/<plugin-id>/context.md`.
4. Copy `app.env.example` to `apps/<plugin-id>/<plugin-id>.env` and fill the values.
5. Register the new plugin in `src/plugins/index.ts`.
6. Set `PLUGIN_ID=<plugin-id>` in the runtime environment.

## Routing Guidance

- Put slash-style commands in `commands`.
- Put classifier-visible app routes in `customRoutes`.
- Put highly dynamic route decisions in `routeRequest`.

The shared router stays in core; the app owns only its declared extensions.