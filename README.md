# NightBox Creator Cloud

NightBox contains the public website, creator workspace, operations console,
Node backend, Android client integration, SQLite persistence, and Telegram bot
services. The existing visual UI is retained while live screens read from the
backend rather than browser demo data.

## Included surfaces

- Public site: Home, Features, Events, About, Contact, FAQ and legal pages.
- Authentication: Sign in, registration and password reset.
- Creator app: Overview, Upload, My Files, Analytics, Earnings, Withdrawals,
  Events, Tickets, Bots/API and Settings.
- Admin console: Command Center, Users, File Moderation, Revenue Controls,
  Withdrawals, Reports/DMCA, Support, Events and Platform Settings.

The backend stores authentication, videos, creator links, qualified views,
country CPM, earnings, subscriptions, payments, API keys and withdrawals.
Razorpay, Bunny, GeoIP reputation, Telegram and production database credentials
must be configured through environment variables before production deployment.

## Run

Requirements: Node.js 22.13+ and npm.

On Windows, start the backend, website, and admin dashboard together with:

    powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1

Use `-Bots` only after configuring Telegram tokens in
`appcode/nightbox/telegram-bots/.env`.

    npm install
    npm run dev:web

Website and creator app:

    http://localhost:4173/
    http://localhost:4173/user/dashboard

For a separately served admin console, open another terminal:

    npm run dev:admin

Admin URL:

    http://localhost:4174/admin/login

For the local backend `.env`, use:

    admin@nightbox.local
    NightBoxLocalAdmin_2026!

Start the backend in a third terminal:

    cd appcode/nightbox/backend
    npm start

The local backend uses `http://localhost:3000` and the SQLite database at
`appcode/nightbox/backend/data/nightbox.sqlite`.

With the backend running, verify the complete creator view flow (5-second
qualification, country CPM, ledger, analytics, and automatic cleanup) with:

    npm run test:backend

## Production build

    npm run build

For a production build, provide `VITE_BACKEND_URL` from
[.env.production.example](C:/Users/shank/Documents/freelance/p4/.env.production.example).
Configure the backend from
[backend/.env.production.example](C:/Users/shank/Documents/freelance/p4/appcode/nightbox/backend/.env.production.example)
on the production host; do not commit the resulting `.env` file.
The backend production readiness endpoint also requires HTTPS origins, trusted
proxy forwarding, IP reputation checks with fail-closed behavior, Bunny
configuration, and Razorpay webhook/recurring-plan configuration.

Run the strict production gate check against the deployed backend before
cutover. It reports gate names only and never prints secret values:

    $env:BACKEND_URL = "https://api.example.com"
    npm run preflight:production

## Android

The Android app reads `BACKEND_URL` from a Gradle property or environment
variable and sends a creator-link view start plus a qualification request after
five seconds of playback. Release signing values are also environment-driven;
no keystore password is stored in Gradle source.

## Telegram bots

Copy `appcode/nightbox/telegram-bots/.env.example` to `.env`, configure the
Telegram credentials and a creator API key, then run `pm2 start ecosystem.config.js`.
The ecosystem includes the main controller, five named service bots, and the
legacy upload/conversion/hider compatibility bots.
