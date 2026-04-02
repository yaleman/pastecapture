## Development

Backend dependencies:

```bash
uv sync
```

Frontend dependencies:

```bash
pnpm --dir frontend install
```

Run the API server:

```bash
uv run pastecapture --capture-dir ./captures
```

Use an environment variable instead of a flag when needed:

```bash
PASTECAPTURE_CAPTURE_DIR=./captures uv run pastecapture
```

Run the frontend in development:

```bash
pnpm --dir frontend dev
```

Build the frontend and regenerate API types:

```bash
pnpm --dir frontend build
```

Run the Playwright end-to-end tests:

```bash
pnpm --dir frontend test:e2e
```
