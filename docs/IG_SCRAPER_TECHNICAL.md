## Instagram Scraper – Technical Architecture and Operations (Production, Oct 2025)

This document explains how the Instagram scraper in this repository achieves a ~99% success rate. It focuses on concrete, actionable technical details: entry points, authentication, request patterns, throttling, data extraction, error handling, anti-bot tactics, fragility risks, troubleshooting, and maintenance.


## Architecture Overview

- Two‑phase design
  - Phase 1: Profile discovery (single-threaded)
    - Entry: src/main.js → CheerioCrawler(profileRouter)
    - Goal: derive userId and discover post shortcodes robustly; persist to Key-Value Store POST_URLS
  - Phase 2: Post extraction (parallel)
    - Entry: src/main.js → CheerioCrawler(postRouter)
    - Goal: fetch post details via GraphQL/mobile API; push to Dataset
- Concurrency
  - Phase 1: maxConcurrency = 1 (low risk profile bootstrap)
  - Phase 2: maxConcurrency = 12 with autoscaling
- Session pool (Apify/Crawlee)
  - Persisted session store; conservative rotation on auth/ratelimit signals
- Proxies
  - Uses Apify Residential proxy group; rotates with session retirement

Key wiring (entry points):
<augment_code_snippet path="src/main.js" mode="EXCERPT">
````javascript
// Phase 1: profile discovery
const profileCrawler = new CheerioCrawler({
  maxConcurrency: 1,
  useSessionPool: true,
  sessionPoolOptions,
  requestHandler: profileRouter,
});
````
</augment_code_snippet>

<augment_code_snippet path="src/main.js" mode="EXCERPT">
````javascript
// Phase 2: post extraction (batches via RequestQueue)
const postBatchCrawler = new CheerioCrawler({
  maxConcurrency, useSessionPool: true,
  requestHandler: postRouter,
});
````
</augment_code_snippet>


## Critical Success Factors (what makes it work at 99%)

### 1) Instagram authentication model implemented correctly

- Cookie strategies
  - Guest cookie factory (no credentials): create 30+ cookie sets by visiting https://www.instagram.com/; cache and rotate.
  - Optional authenticated cookie sets from cookies.json or env (sessionid, ds_user_id, csrftoken). These are preferred when present.
- Dynamic tokens per session (rotated by IG)
  - X-IG-WWW-Claim (per session)
  - X-ASBD-ID (per session)
  - X-FB-LSD (short TTL)
- TokenRefresher maintains fresh tokens with 15‑minute TTL; falls back safely if missing.

Examples:
<augment_code_snippet path="src/post-router.js" mode="EXCERPT">
````javascript
const guestJar = await this.createGuestCookieJar();
// cookies, wwwClaim, asbdId, lsd (+ lsdUntil)
this.cookiePools.set(cookieSet.id, cookieSet);
````
</augment_code_snippet>

<augment_code_snippet path="src/session-utils.js" mode="EXCERPT">
````javascript
const cached = this.tokenCache.get(sessionId);
if (cached && cached.expiresAt > now) return cached;
const headResponse = await axios.get('https://www.instagram.com/', { headers });
let wwwClaim = headResponse.headers['x-ig-set-www-claim'] || '0';
let asbdId  = headResponse.headers['x-ig-set-asbd-id'] || '129477';
````
</augment_code_snippet>

- Required cookies for authenticated sets: sessionid, ds_user_id, csrftoken. For guest sets, csrftoken + mid + ig_did are essential, mid can be generated.

### 2) Correct headers and request patterns

- Universal headers that matter
  - X-IG-App-ID: 936619743392459
  - X-ASBD-ID: dynamic (fallback: 129477)
  - X-IG-WWW-Claim: dynamic (some requests intentionally omit for success)
  - X-FB-LSD: from manifest/login; TTL ~12–15 min
  - X-CSRFToken: from cookie (when present)
  - User-Agent: realistic desktop Chrome 120+; for mobile endpoints use Instagram iOS UA
  - sec-ch-ua hints; Referer; Cache-Control no-cache

<augment_code_snippet path="src/post-router.js" mode="EXCERPT">
````javascript
const headers = {
  'X-IG-App-ID': '936619743392459',
  'X-ASBD-ID': asbdId,
  'Cookie': getCookieHeader(cookieSet.cookies),
  'Referer': `https://www.instagram.com/p/${shortcode}/`,
};
````
</augment_code_snippet>

- GET GraphQL preference (2025): GET https://www.instagram.com/graphql/query/ with doc_id and variables; omits some headers that trigger blocks; LSD often omitted for single‑post on cloud IPs.

<augment_code_snippet path="src/post-discovery.js" mode="EXCERPT">
````javascript
const graphqlUrl = new URL('https://www.instagram.com/graphql/query/');
graphqlUrl.searchParams.set('doc_id', IG_CONSTANTS.USER_TIMELINE_DOC_ID);
graphqlUrl.searchParams.set('variables', JSON.stringify({ id, first, after }));
````
</augment_code_snippet>

- Mobile API for discovery and profile bootstrap
  - https://i.instagram.com/api/v1/users/web_profile_info/?username=USERNAME
  - Mobile UA mitigates web HTML obfuscation and login interstitials

<augment_code_snippet path="src/profile-router.js" mode="EXCERPT">
````javascript
const headers = { 'User-Agent': 'Instagram 300.0.0.0 iOS', 'X-IG-App-ID': IG_APP_ID };
const resp = await axios.get(`${MOBILE_PROFILE_API}${username}`, { headers });
````
</augment_code_snippet>

### 3) Throttling, rate limiting, and rotation logic

- SmartThrottling per session: randomized base delay + penalties for blocks/frequency; max delay capped.
- Session retirement on 401/403/429/timeout/proxy errors(590/595); cookies get marked blocked and cooled down 30 minutes.
- Batch sizes tuned: discovery first=12; batch post fetches 10–25.

<augment_code_snippet path="src/post-router.js" mode="EXCERPT">
````javascript
const base = 1000 + Math.random()*2000;
const blockPenalty = blocks*1000;
const totalDelay = Math.min(base + blockPenalty + freqPenalty, 8000);
````
</augment_code_snippet>

### 4) Robust retries and fallbacks

- Central RetryManager in post-discovery with exponential backoff, session/cookie rotation, proactive CSRF refresh on repeated 401s, and token refresh every ~25 requests.
- Multi‑path extraction pipeline (preferred → fallback):
  1) Mobile API discovery for shortcodes
  2) GraphQL GET timeline (doc_id USER_POSTS)
  3) Single‑post GraphQL GET (doc_id SHORTCODE_MEDIA)
  4) HTML parsing for last‑ditch recovery

<augment_code_snippet path="src/post-discovery.js" mode="EXCERPT">
````javascript
if (response.status === 401 || response.status === 403) {
  session.retire();
  cookieManager.markAsBlocked(guestCookieSet.id);
  throw new Error('Request blocked');
}
````
</augment_code_snippet>

### 5) Accurate data extraction

- GraphQL field xdt_shortcode_media mapped to normalized post object with the following fields:
  - Core: id, type (Image/Video/Sidecar), shortCode, url, timestamp
  - Content: caption, alt, hashtags, mentions, sponsors
  - Engagement: likesCount, commentsCount, videoViewCount
  - Media: displayUrl, images (array), videoUrl, videoDuration (ms)
  - Dimensions: dimensionsHeight, dimensionsWidth
  - Business: paidPartnership, isSponsored
  - Context: username, inputUrl

<augment_code_snippet path="src/routes.js" mode="EXCERPT">
````javascript
const post = jsonResponse?.data?.xdt_shortcode_media;
const postData = await extractPostDataFromGraphQL(post, username, originalUrl, log);
````
</augment_code_snippet>


## Instagram‑Specific Implementation Details

- Cookies used
  - csrftoken: CSRF header value for some requests
  - sessionid: user session (optional, if authenticated cookie set present)
  - ds_user_id: user id (with sessionid)
  - mid: device cookie; generated for guests when missing
  - ig_did: device id cookie
  - rur: region routing (optional)

- Tokens
  - X-IG-WWW-Claim: per‑session; extracted from response headers/meta
  - X-ASBD-ID: per‑session; extracted from response headers (fallback 129477)
  - X-FB-LSD: short TTL; from manifest.json/login

- Endpoints and parameters
  - Timeline (GET): https://www.instagram.com/graphql/query/?doc_id=7950326061742207&variables={"id","first","after"}
  - Single post (GET): https://www.instagram.com/graphql/query/?doc_id=8845758582119845&variables={"shortcode"}
  - Batch post (POST alt): https://www.instagram.com/api/graphql (variables, doc_id, lsd)
  - Mobile profile info: https://i.instagram.com/api/v1/users/web_profile_info/?username=USERNAME

- Required/typical headers
  - X-IG-App-ID: 936619743392459
  - X-ASBD-ID: dynamic; X-IG-WWW-Claim: dynamic; X-FB-LSD: present when needed
  - X-Requested-With: XMLHttpRequest (selectively)
  - User-Agent: Chrome 120+ or Instagram iOS UA
  - Referer: profile or post URL; Cookie: built per domain


## Fragility Points & Breaking Changes

- GraphQL doc_ids change periodically
  - SHORTCODE_DOC_ID currently: 8845758582119845 (src/constants.js)
  - USER_POSTS doc_id used for timeline: 7950326061742207 (src/post-router.js, src/post-discovery.js)
- Token semantics
  - WWW‑Claim and ASBD‑ID increasingly enforced per session; claim sometimes must be omitted on single‑post calls (observed higher success)
  - LSD retrieval patterns/paths change (manifest/login regex)
- Response structure changes
  - xdt_shortcode_media fields; edge_owner_to_timeline_media shape; null data responses when blocked
- Mobile API volatility
  - Paths and required UA can change; rate limits differ from web
- Rate limit thresholds
  - Implicit; tune SmartThrottling and batch sizes if 429 increases
- Proxy upstream errors
  - 590/595 need continued handling and session rotation


## Troubleshooting Guide

1) Detect breaking change quickly
- Symptoms: sudden 403/429 across the board, consistent 401s even with new sessions, GraphQL returns data: null, HTML extremely short/login interstitials
- Action: check logs for status codes and messages; compare against expected header construction

2) Identify failing component
- Auth failure (401): CSRF/LSD missing or stale; cookies blocked → rotate session and refresh CSRF/LSD
- Block/ratelimit (403/429): reduce concurrency, enlarge delays; rotate cookie/session; ensure Referer and UA present
- GraphQL doc_id change: 200 with errors array or unexpected structure → verify/re‑capture doc_id; update constants
- HTML path broken: profile discovery falling back → prefer Mobile API path

3) Refresh tokens/cookies/headers
- Force LSD refresh
<augment_code_snippet path="src/session-utils.js" mode="EXCERPT">
````javascript
session.userData.lsd = await fetchFreshLsd(session, log);
session.userData.lsdUntil = Date.now() + 15*60*1000;
````
</augment_code_snippet>

- Refresh CSRF
<augment_code_snippet path="src/session-utils.js" mode="EXCERPT">
````javascript
const csrf = await refreshCsrfToken(session, log);
if (csrf) log.debug('Refreshed CSRF token');
````
</augment_code_snippet>

- Ensure fresh WWW‑Claim/ASBD‑ID via TokenRefresher
<augment_code_snippet path="src/session-utils.js" mode="EXCERPT">
````javascript
const { wwwClaim, asbdId, lsd } = await tokenRefresher.ensureFresh(session, cookieSet);
````
</augment_code_snippet>

4) Update doc ids when IG changes
- Edit src/constants.js SHORTCODE_DOC_ID
- Update USER_POSTS doc_id values in post‑discovery.js/post‑router.js

5) Validate fixes fast
- Run small set against a public profile with low activity
- Check Dataset outputs for expected fields and counts
- Monitor logs for drop in 401/403/429

6) Logging and debugging
- Keep INFO logs in prod; enable DEBUG temporarily around header/tokens in post‑discovery/post‑router


## Maintenance Recommendations

- Token hygiene
  - Proactively refresh WWW‑Claim/ASBD‑ID (~every 25 GraphQL calls) and LSD (~12–15 minutes)
- Doc id monitoring
  - Re‑capture doc_ids monthly or on scrape failure spikes; centralize in src/constants.js and IG_CONSTANTS
- Header evolution
  - Track UA updates quarterly; keep Chrome stable channel; maintain mobile UA for API calls
- Pool sizing & rotation
  - Keep 30+ guest jars; rotate on 401/403/429; auto‑unblock after 30 minutes
- Throttling tuning
  - Start conservative, increase gradually; ensure jitter to avoid sync patterns
- Tests/Smoke
  - Add small smoke run to CI against cached KV data or mock responses; verify extraction schema does not regress
- Operational hygiene
  - Use Apify autoscaling; exit Actor explicitly after completion; persist progress for resume


## Concrete References (where to change things)

- GraphQL doc ids
<augment_code_snippet path="src/constants.js" mode="EXCERPT">
````javascript
export const SHORTCODE_DOC_ID = '8845758582119845';
````
</augment_code_snippet>

- Timeline doc id for discovery
<augment_code_snippet path="src/post-discovery.js" mode="EXCERPT">
````javascript
USER_TIMELINE_DOC_ID: '7950326061742207'
````
</augment_code_snippet>

- Single‑post header variant strategy
<augment_code_snippet path="src/post-router.js" mode="EXCERPT">
````javascript
if (attempt === 1) variant = 'no_lsd_claim_csrf_client_hints';
else if (attempt === 2) variant = 'no_lsd_claim_csrf';
// ... then base (with LSD)
````
</augment_code_snippet>

- Session rotation on block
<augment_code_snippet path="src/main.js" mode="EXCERPT">
````javascript
if (error.message.includes('403') || error.message.includes('429')) {
  session.retire();
}
````
</augment_code_snippet>

- Mobile API bootstrap
<augment_code_snippet path="src/profile-router.js" mode="EXCERPT">
````javascript
const user = (await getProfileInfoViaAPI(username, session, log))?.id;
session.userData.userId = user || session.userData.userId;
````
</augment_code_snippet>


## Quick Runbook

- Local run
  - npm install && npm start
  - Or: apify run --input-file INPUT.json
- Minimal input
  - directUrls: ["https://www.instagram.com/<username>/"], optional maxPosts, onlyPostsNewerThan
- Debug tips
  - Temporarily lower concurrency, enable DEBUG logs in routers, target a small public profile, review headers emitted


## Appendix: Error code map (what we do)

- 401 Unauthorized → rotate session, mark cookie blocked, refresh CSRF/LSD, backoff [2s,3s,5s,8s,13s]
- 403 Forbidden → rotate session, mark cookie blocked, exponential backoff
- 429 Too Many Requests → rotate session, exponential backoff with jitter, reduce batch
- 590/595 Proxy upstream/reset → retire session, retry
- Timeout/ECONNRESET → retire session, retry with extended timeout, jitter

