This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Database

PostgreSQL runs in its own Docker container dedicated to this project: `scrape-postgres`
(started via `docker compose up -d`, see `docker-compose.yml`), separate from other projects'
containers so it's not sharing a database instance with unrelated apps. Connection settings are
in `.env.local` (`devuser`/`devpass`, port `5433` on the host to avoid clashing with other local
Postgres instances on the default `5432`).

The container has `restart: unless-stopped`, so it comes back on its own — but only once
**Docker Desktop itself is running** (Docker Desktop → Settings → General → "Start Docker
Desktop when you sign in" is enabled, so it should start automatically after login/reboot). If
pages show empty lists or API routes 500 with a DB connection error, check `docker ps` lists
`scrape-postgres` as `Up` before assuming it's a code bug.

`lib/db.ts` builds its Postgres pool once at module load using `.env.local` values, so after
changing DB connection settings you need to fully restart `npm run dev` — Next.js reloading
`.env.local` alone won't re-create the pool. (`lib/ai.ts`'s Anthropic client already builds a
fresh client per call for this same reason, since API keys get rotated more often.)

## CAPTCHA solving (optional)

Automated login (`lib/scraper.ts`'s `loginIfNeeded`, used by headless re-scrapes) can auto-solve
a CAPTCHA challenge on the login form via [2Captcha](https://2captcha.com) if you set
`TWOCAPTCHA_API_KEY` in `.env.local`. Supports reCAPTCHA v2, hCaptcha, and simple image captchas.
Leave it blank to skip silently — normal login (and the manual "로그인 창 열기" flow, where you
solve any CAPTCHA yourself in the visible browser window) keeps working without it. 2Captcha
charges per solve, so only add a key if you've actually hit a CAPTCHA wall.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
