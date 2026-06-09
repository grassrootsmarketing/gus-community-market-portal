# Gus Community Market Portal

A demo scheduling portal for community markets. Single-file static site (`index.html`) — no build step.

## Local development

Open `index.html` directly in a browser, or run a tiny local server from the project root:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then visit http://localhost:8000.

## Deploy

This repo is configured for Vercel as a static site (see `vercel.json`).

### First-time setup
1. Push this repo to GitHub (see below).
2. In Vercel, click **Add New Project** → **Import Git Repository** → pick this repo.
3. Framework preset: **Other**. Root directory: `./`. Build command: leave blank. Output directory: leave blank.
4. Click **Deploy**.

After that, every push to `main` auto-deploys, and every PR gets a preview URL.

## Project structure

```
.
├── index.html      # The whole app (HTML + CSS + JS inline)
├── vercel.json     # Vercel static-site config (clean URLs)
├── .gitignore
└── README.md
```
