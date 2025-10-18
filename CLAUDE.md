# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This repo contains a production-grade Instagram scraper on Apify/Crawlee with a two-phase pipeline and a ~99% success rate when configured as documented.

## Quick links
- Technical reference (required reading): docs/IG_SCRAPER_TECHNICAL.md
- Entrypoints and routers: src/main.js, src/profile-router.js, src/post-router.js, src/routes.js
- Session/cookies/tokens: src/session-utils.js
- Constants (doc IDs, timeouts, session pool): src/constants.js

## Build and Development Commands
```bash
# Install dependencies
npm install

# Run locally (reads INPUT.json by default)
npm start

# Run with custom input
apify run --input-file INPUT.json

# Code quality
npm run format         # Prettier
npm run format:check
npm run lint           # ESLint
npm run lint:fix

# Deploy to Apify
apify login
apify push
```

## How to work with this project (for Claude)
- Prefer minimal, surgical edits. Use existing abstractions (CookieManager, TokenRefresher, SmartThrottling).
- Keep doc IDs centralized and in sync across files. When updating:
  - src/constants.js → SHORTCODE_DOC_ID
  - src/post-discovery.js → timeline doc id(s)
  - src/routes.js → INSTAGRAM_DOCUMENT_IDS (single/batch/timeline)
- Don’t add dependencies unless explicitly asked. Use existing stack (apify, crawlee, axios, moment).
- Safe runs are OK: lint, format, local actor runs. Do NOT commit/push or install deps without approval.
- Validate changes with a short run (one public profile, small maxPosts) and inspect Dataset + logs.

## Architecture Overview
Two-phase pipeline:
- Phase 1: Profile discovery (single-threaded)
  - Router: src/profile-router.js
  - Derives userId; discovers post shortcodes. Uses mobile API/GraphQL + fallbacks.
- Phase 2: Post extraction (parallel)
  - Router: src/post-router.js and helpers in src/routes.js
  - Fetches detailed post data via GraphQL; batch-processing with retries.

Key orchestration: src/main.js
- Configures proxy, session pool, and routes
- Queues batch requests of discovered shortcodes

## Critical files
- src/main.js – Orchestration for both phases
- src/profile-router.js – Profile bootstrap, token extraction
- src/post-discovery.js – Discovery methods, RetryManager, timeline pagination
- src/post-router.js – Single/batch post fetch, CookieManager, throttling
- src/routes.js – Batch fetch implementation, post data shaping
- src/session-utils.js – TokenRefresher, guest cookie factory, LSD/CSRF helpers
- src/constants.js – SHORTCODE_DOC_ID, TIMEOUTS, SESSION_CONFIG

## Inputs / Outputs
Input (INPUT.json) accepts:
- directUrls: array of Instagram profile URLs (required)
- onlyPostsNewerThan: ISO timestamp (optional)
- maxPosts: integer
- includeReels, includeIGTV, includeStories (stories experimental)

Output (Dataset): normalized post records with fields like type, postType, username, shortcode, id, url, displayUrl, mediaUrls, caption, hashtags, mentions, likesCount, commentsCount, viewsCount, takenAt, dimensions, location, taggedUsers, etc. Carousels include carouselItems.

## Instagram specifics you must respect
- Cookies: csrftoken, mid, ig_did (+ sessionid & ds_user_id if authenticated). Guest cookie pools are rotated and cooled down when blocked.
- Tokens: X-IG-WWW-Claim, X-ASBD-ID, X-FB-LSD (short TTL). Managed via TokenRefresher with ~15 min TTL.
- Headers: X-IG-App-ID=936619743392459, realistic desktop UA (or iOS UA for mobile endpoints), Referer, and selective use/omission of LSD/WWW-Claim depending on endpoint.
- GraphQL doc IDs: they change. Update constants and keep all call sites synchronized. See docs/IG_SCRAPER_TECHNICAL.md for current values and procedures.

## Throttling and rotation (high-level)
- SmartThrottling: randomized base delay with penalties for rapid requests and blocks; capped delay.
- Session/cookie rotation: retire on 401/403/429; cookies marked blocked get 30-minute cooldown.
- Batch sizes: discovery uses small pages (~12); post batches typically 10–25 with parallelism up to ~12.

## Error handling (signals and actions)
- 401 Unauthorized → refresh CSRF/LSD, retire session, mark cookie blocked, retry with backoff.
- 403/429 Blocked/Ratelimited → retire session, mark cookie blocked, exponential backoff with jitter, reduce batch if persistent.
- 5xx/Timeout/ECONNRESET → exponential backoff + retry; rotate session if repeated.

## Common workflows for changes
1) Updating GraphQL doc IDs
- Edit src/constants.js SHORTCODE_DOC_ID.
- Update timeline/single/batch IDs in src/post-discovery.js and src/routes.js (INSTAGRAM_DOCUMENT_IDS).
- Run a small validation and confirm Dataset entries are non-empty and error rates low.

2) Adjusting headers/tokens
- Use TokenRefresher (src/session-utils.js) to obtain fresh WWW-Claim/ASBD-ID/LSD.
- For single-post GraphQL, try header variants if encountering systematic 401/403.

3) Tuning throttling/concurrency
- Start conservative (lower concurrency, smaller batches), then increase.
- Watch logs for 401/403/429 spikes and backoff accordingly.

## Validation checklist (before/after edits)
- Lint: npm run lint
- Quick run: apify run --input-file INPUT.json (1 profile, small maxPosts)
- Inspect logs: verify few/no 401/403/429; look for retries stabilizing.
- Inspect Dataset: fields populated (caption, mediaUrls, counts). Carousels have items.

## Maintenance notes
- Re-capture doc IDs monthly or on failure spikes; keep them centralized and synchronized.
- Refresh token logic proactively (~15 min LSD, ~25 GraphQL calls for claim/asbd refresh).
- Keep UA strings current (Chrome stable; iOS UA for mobile endpoints).
- Maintain sufficient guest cookie pool; 30-minute cooldown on blocked sets.

## Troubleshooting quick map
- data: null or empty GraphQL → doc_id drift or auth tokens missing → update IDs / refresh tokens.
- Persistent 401 → CSRF/LSD invalid or cookies blocked → rotate + refresh.
- Frequent 429 → reduce concurrency/batch, extend delays, rotate sessions.
- Proxy 590/595 → rotate sessions; treat like transient network errors.

## Notes
- Success rate target: ~99% under residential proxies, with configured rotation and throttling.
- Source of truth for operational details is docs/IG_SCRAPER_TECHNICAL.md. Keep this file aligned.