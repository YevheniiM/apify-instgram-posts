import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, log } from 'crawlee';

// Two-phase architecture - exactly like production Apify scraper
import { profileRouter } from './profile-router.js';
import { postRouter } from './post-router.js';

await Actor.init();

// Set production logging level
log.setLevel(log.LEVELS.INFO);

// Proxy configuration will be created below

// Get input from Actor; only fall back to INPUT.json when running locally
const env = Actor.getEnv();
let input = await Actor.getInput();

if (!input) {
    if (env?.isAtHome) {
        // In Apify cloud, do not read local INPUT.json; keep empty to trigger validation error
        log.warning('Actor.getInput() returned empty in cloud; proceeding without fallback.');
        input = {};
    } else {
        // Local dev fallback
        try {
            const fs = await import('fs');
            const inputJson = fs.readFileSync('./INPUT.json', 'utf8');
            input = JSON.parse(inputJson);
            log.info('Using INPUT.json for local testing');
        } catch (error) {
            log.error('Failed to read INPUT.json:', error.message);
            input = {};
        }
    }
}
log.info('Instagram Scraper - Two-Phase Production Architecture:', input);

// Validate input
if (!input.directUrls || !Array.isArray(input.directUrls) || input.directUrls.length === 0) {
    log.error('Invalid input: directUrls must be a non-empty array of Instagram profile URLs');
    await Actor.exit();
}

// Configure Production Residential Proxies with enhanced settings
let proxyConfiguration = null;
try {
    proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'], // must be enabled on your account
        countryCode: 'US'
    });
    if (proxyConfiguration) {
        // 🎯 FIXED: Await proxy URL to avoid logging [object Promise]
        const proxyUrl = await proxyConfiguration.newUrl();
        log.info(`Proxy in use: ${proxyUrl}`);
    }
} catch (error) {
    log.warning(`Proxy configuration failed: ${error.message}. Running without proxy.`);
}

// Production AutoscaledPool configuration (matching logs: scales 1->12+)
const maxConcurrency = 12; // Production max observed concurrency
const minConcurrency = 1;  // Production starts at 1

// Production session pool configuration (optimized for residential proxies)
const sessionPoolOptions = {
    maxPoolSize: 80, // Optimized for residential proxy rotation (from memories: 50-80)
    sessionOptions: {
        maxUsageCount: 20, // Conservative rotation for Instagram (from memories: 20-50 requests)
        maxErrorScore: 3,
        errorScoreDecrement: 0.5
    },
    persistStateKeyValueStoreId: 'instagram-session-store', // Fixed: no underscores allowed in Apify store names
    persistStateKey: 'sessions'
};

// Phase 1: Extract usernames and create profile discovery requests (Direct URL scraper)
const profileUrls = [];
const processedUsernames = new Set();

for (const url of input.directUrls) {
    if (!url.includes('instagram.com')) {
        log.warning(`Skipping non-Instagram URL: ${url}`);
        continue;
    }

    // Extract username from Instagram URL
    const usernameMatch = url.match(/instagram\.com\/([^/?]+)/);
    if (!usernameMatch) {
        log.warning(`Could not extract username from URL: ${url}`);
        continue;
    }

    const username = usernameMatch[1];

    // Skip duplicate usernames
    if (processedUsernames.has(username)) {
        log.info(`Skipping duplicate username: ${username}`);
        continue;
    }

    processedUsernames.add(username);
    log.info(`Setting up profile discovery for: ${username}`);

    // Create profile discovery request (Phase 1)
    profileUrls.push({
        url: `https://www.instagram.com/${username}/`,
        userData: {
            type: 'profile_discovery',
            username,
            originalUrl: url,
            onlyPostsNewerThan: input.onlyPostsNewerThan,
            maxPosts: input.maxPosts || null,
            includeStories: input.includeStories || false,
            includeReels: (input.includeReels ?? true),
            includeIGTV: (input.includeIGTV ?? false)
        }
    });
}

if (profileUrls.length === 0) {
    log.error('No valid Instagram URLs found in input. Please provide valid Instagram profile URLs.');
    await Actor.exit();
}

// Check if Phase 1 already completed in a previous run (migration resume)
const existingPostUrlsKV = await Actor.getValue('POST_URLS') || [];
const phase1AlreadyCompleted = Array.isArray(existingPostUrlsKV) && existingPostUrlsKV.length > 0;

if (!phase1AlreadyCompleted) {

// PHASE 1: Direct URL scraper (Profile Discovery)
log.info(`[Status message]: Starting the direct URL scraper with ${profileUrls.length} direct URL(s)`);
// Compute dynamic request handler timeout for Phase 1 (profile discovery)
// - Estimate based on maxPosts (12 posts per Mobile API page, ~2.5s per page)
// - Clamp to 5 hours maximum
// - Respect Actor remaining time if available (leave buffer)
const MAX_HANDLER_TIMEOUT_SECS = 5 * 60 * 60; // 5 hours
const POSTS_PER_BATCH = 12;
const SECS_PER_BATCH = 2.5; // conservative average including network and parsing
const BASE_OVERHEAD_SECS = 120; // setup + wrap-up buffer

const requestedMaxPosts = Number(input?.maxPosts) || 10000; // default goal for large profiles
const estimatedBatches = Math.max(1, Math.ceil(requestedMaxPosts / POSTS_PER_BATCH));
const estimatedTimeoutSecs = Math.ceil((estimatedBatches * SECS_PER_BATCH) + BASE_OVERHEAD_SECS);

// Clamp between 10 minutes and 5 hours
let profileRequestTimeoutSecs = Math.min(Math.max(estimatedTimeoutSecs, 600), MAX_HANDLER_TIMEOUT_SECS);

// Respect Actor remaining time if available
try {
    const env = Actor.getEnv();
    if (env?.timeoutSecs && env?.startedAt) {
        const startedAtMs = new Date(env.startedAt).getTime();
        const elapsedSecs = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
        const remainingSecs = Math.max(0, env.timeoutSecs - elapsedSecs);
        const SAFETY_BUFFER_SECS = 120; // leave time for shutdown and Phase 2 handoff
        const allowedSecs = Math.max(60, remainingSecs - SAFETY_BUFFER_SECS);
        profileRequestTimeoutSecs = Math.min(profileRequestTimeoutSecs, allowedSecs);
    }
} catch {}

log.info(`Profile discovery timeout configured: ${profileRequestTimeoutSecs}s (requested maxPosts=${requestedMaxPosts})`);


const profileCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 1, // Conservative for profile discovery phase
    // Production session management (Apify playbook)
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions,
    // Enhanced production settings for residential proxies
    // Dynamic timeout based on maxPosts, clamped to Actor remaining time and 5h max
    requestHandlerTimeoutSecs: profileRequestTimeoutSecs,
    maxRequestRetries: 0,
    retryOnBlocked: true,
    requestHandler: profileRouter,
    // Enable production statistics logging
    statisticsOptions: {
        logIntervalSecs: 60, // Match production logging interval
        logMessage: 'CheerioCrawler request statistics'
    },
    // AutoscaledPool configuration for profile phase
    autoscaledPoolOptions: {
        minConcurrency: 1,
        maxConcurrency: 1, // Keep profile discovery single-threaded
        desiredConcurrency: 1
    },
    failedRequestHandler: async ({ request, error, session }) => {
        log.error(`Profile discovery failed: ${request.url}`, error.message);

        // Enhanced production session rotation with rate limiting backoff
        if (error.message.includes('blocked') || error.message.includes('403') || error.message.includes('429')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Request blocked, retrying it again with different session`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();

            // Add exponential backoff for rate limiting (production optimization)
            if (error.message.includes('429')) {
                const delay = Math.min(30000, 1000 * Math.pow(2, request.retryCount || 0));
                log.info(`Rate limited - applying exponential backoff: ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } else if (error.message.includes('timeout') || error.message.includes('ECONNRESET')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Timeout awaiting 'request' for 30000ms`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        } else if (error.message.includes('590') || error.message.includes('UPSTREAM502')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. The proxy server rejected the request with status code 590 (UPSTREAM502)`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        } else if (error.message.includes('595') || error.message.includes('ECONNRESET')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Detected a session error, rotating session...`);
            log.warning(`The proxy server rejected the request with status code 595 (ECONNRESET)`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        }
    }
});

// Run Phase 1: Profile Discovery
await profileCrawler.run(profileUrls);
} else {
    log.info('Phase 1 already complete, skipping to Phase 2');
}


// The statistics are already logged automatically by CheerioCrawler
// No need to manually log them again

log.info(`[Status message]: Direct URL scraper finished`);

// PHASE 2: Posts scraper (Post Extraction)
// Get discovered post URLs from the profile phase
const postUrls = await Actor.getValue('POST_URLS') || [];

if (postUrls.length === 0) {
    log.warning('No post URLs discovered in Phase 1. Exiting.');
    await Actor.exit();
}

log.info(`[Status message]: Starting posts scraper with ${postUrls.length} direct URL(s)`);
log.info(`[Status message]: Starting the post scraper with ${postUrls.length} post URL(s)`);

// NEW: Prefer direct batch extraction via GraphQL (with robust fallback) to reduce cost
try {
    const SHORTCODE_RE = /\/p\/([A-Za-z0-9_-]{5,15})\//;

    // Group discovered shortcodes by originating username (from Phase 1)
    const byUser = new Map(); // username -> { shortcodes: Set<string>, originalUrl: string|null }
    const unknownShortcodes = new Set();

    for (const item of postUrls) {
        if (!item) continue;
        let sc = null;
        let un = null;
        let orig = null;
        if (typeof item === 'string') {
            sc = (item.match(SHORTCODE_RE) || [])[1] || null;
        } else if (typeof item === 'object') {
            sc = item.userData?.shortcode || (typeof item.url === 'string' ? ((item.url.match(SHORTCODE_RE) || [])[1] || null) : null);
            un = item.userData?.username || null;
            orig = item.userData?.originalUrl || (un ? `https://www.instagram.com/${un}/` : null);
        }
        if (!sc) continue;
        if (un) {
            const entry = byUser.get(un) || { shortcodes: new Set(), originalUrl: orig || null };
            entry.shortcodes.add(sc);
            if (!entry.originalUrl && orig) entry.originalUrl = orig;
            byUser.set(un, entry);
        } else {
            unknownShortcodes.add(sc);
        }
    }

    // If we have any grouped users, enqueue batches per user; otherwise fallback to legacy single-username path
    if (byUser.size > 0 || unknownShortcodes.size > 0) {
        const requestQueue = await RequestQueue.open();
        const batchSize = 25;
        let totalEnqueued = 0;

        // Enqueue per known username
        for (const [username, entry] of byUser.entries()) {
            const scList = Array.from(entry.shortcodes);
            log.info(`Using direct batch extraction for ${username}: ${scList.length} posts`);
            for (let i = 0; i < scList.length; i += batchSize) {
                const slice = scList.slice(i, i + batchSize);
                const batchIndex = Math.floor(i / batchSize);
                const result = await requestQueue.addRequest({
                    url: `https://www.instagram.com/?batch=${username}-${batchIndex}`,
                    uniqueKey: `batch_posts:${username}:${batchIndex}`,
                    userData: {
                        type: 'batch_posts',
                        username,
                        shortcodes: slice,
                        maxPosts: input.maxPosts || null,
                        onlyPostsNewerThan: input.onlyPostsNewerThan || null,
                        originalUrl: entry.originalUrl || null,
                    }
                });
                if (!(result?.wasAlreadyPresent || result?.wasAlreadyHandled)) totalEnqueued++;
            }
        }

        // If there are shortcodes without username (should be rare), process them under a synthetic group
        if (unknownShortcodes.size > 0) {
            const scList = Array.from(unknownShortcodes);
            const syntheticUsername = (input.directUrls?.[0]?.match(/instagram\.com\/([^\/]+)\/?/i) || [])[1] || 'unknown';
            log.info(`Using direct batch extraction for ${syntheticUsername} (unknown attribution): ${scList.length} posts`);
            for (let i = 0; i < scList.length; i += batchSize) {
                const slice = scList.slice(i, i + batchSize);
                const batchIndex = Math.floor(i / batchSize);
                const result = await requestQueue.addRequest({
                    url: `https://www.instagram.com/?batch=${syntheticUsername}-${batchIndex}`,
                    uniqueKey: `batch_posts:${syntheticUsername}:${batchIndex}`,
                    userData: {
                        type: 'batch_posts',
                        username: syntheticUsername,
                        shortcodes: slice,
                        maxPosts: input.maxPosts || null,
                        onlyPostsNewerThan: input.onlyPostsNewerThan || null,
                        originalUrl: input.directUrls?.[0] || null,
                    }
                });
                if (!(result?.wasAlreadyPresent || result?.wasAlreadyHandled)) totalEnqueued++;
            }
        }

        log.info(`Phase 2 queueing: enqueued ${totalEnqueued} batch requests of up to ${batchSize} posts each across ${byUser.size} profile(s).`);

        const postBatchCrawler = new CheerioCrawler({
            proxyConfiguration,
            maxConcurrency, // allow parallel batches
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions,
            requestQueue,
            requestHandlerTimeoutSecs: 180,
            maxRequestRetries: 2,
            retryOnBlocked: true,
            requestHandler: postRouter,
            statisticsOptions: {
                logIntervalSecs: 60,
                logMessage: 'CheerioCrawler request statistics'
            }
        });

        await postBatchCrawler.run();

        log.info('Post batch extraction finished');
        log.info('🎉 All done, shutting down');
        await Actor.exit();
    }
} catch (e) {
    log.warning(`Direct batch extraction path failed to initialize, falling back to per-URL crawling: ${e.message}`);
}

// Fallback: per-URL crawling (existing behavior)
const postCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency, // Production max: 12
    // Production session management (Apify playbook)
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions,
    // Enhanced production settings for residential proxies
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 3,
    retryOnBlocked: true,
    requestHandler: postRouter,
    // Enable production statistics logging (matching exact format)
    statisticsOptions: {
        logIntervalSecs: 60, // Match production: every 60 seconds
        logMessage: 'CheerioCrawler request statistics'
    },
    // AutoscaledPool configuration matching production logs
    autoscaledPoolOptions: {
        minConcurrency: 8, // Start with higher concurrency
        maxConcurrency: maxConcurrency, // Scales up to 12
        desiredConcurrency: 10, // Start with moderate concurrency
        scaleUpStepRatio: 0.2, // Faster scaling up
        scaleDownStepRatio: 0.05, // Conservative scale down
        maybeRunIntervalSecs: 0.5, // Frequent scaling decisions
        loggingIntervalSecs: 60, // Match production logging interval
        snapshotterOptions: {
            eventLoopSnapshotIntervalSecs: 0.5,
            maxBlockedMillis: 100
        }
    },
    failedRequestHandler: async ({ request, error, session }) => {
        log.error(`Post extraction failed: ${request.url}`, error.message);

        // Enhanced production session rotation with rate limiting backoff
        if (error.message.includes('blocked') || error.message.includes('403') || error.message.includes('429')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Request blocked, retrying it again with different session`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();

            // Add exponential backoff for rate limiting (production optimization)
            if (error.message.includes('429')) {
                const delay = Math.min(30000, 1000 * Math.pow(2, request.retryCount || 0));
                log.info(`Rate limited - applying exponential backoff: ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } else if (error.message.includes('timeout') || error.message.includes('ECONNRESET')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Timeout awaiting 'request' for 30000ms`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        } else if (error.message.includes('590') || error.message.includes('UPSTREAM502')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. The proxy server rejected the request with status code 590 (UPSTREAM502)`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        } else if (error.message.includes('595') || error.message.includes('ECONNRESET')) {
            log.warning(`CheerioCrawler: Reclaiming failed request back to the list or queue. Detected a session error, rotating session...`);
            log.warning(`The proxy server rejected the request with status code 595 (ECONNRESET)`);
            log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
            session.retire();
        }
    }
});

// Run Phase 2: Post Extraction
await postCrawler.run(postUrls);

// The statistics are already logged automatically by CheerioCrawler
// No need to manually log them again

// 🎯 CRITICAL FIX: Stop the actor cleanly to prevent infinite runtime costs
log.info('🎉 All done, shutting down');
await Actor.exit(); // Guarantees container stops billing
