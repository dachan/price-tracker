# Price Tracker

Core app only:
- Next.js web app (`apps/web`)
- Worker scheduler (`apps/worker`)
- Shared extraction/check logic (`packages/extraction`)
- Prisma/PostgreSQL (`packages/db`)

## Local Run

1. Install deps:

```bash
npm install
```

2. Configure env:

```bash
cp .env.example .env
```

3. Ensure PostgreSQL is running and `DATABASE_URL` is valid.

4. Sync schema:

```bash
npm run db:generate
npx dotenv -e .env -- npm run db:push
```

5. Start app + worker:

```bash
npm run dev:web
npm run dev:worker
```

Web UI: [http://localhost:3000](http://localhost:3000)

## PM2 (optional)

```bash
pm2 start npm --name price-tracker-web -- run start:web
pm2 start npm --name price-tracker-worker -- run start:worker
pm2 save
pm2 startup
```
