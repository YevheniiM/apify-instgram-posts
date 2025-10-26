import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, log, Dataset } from 'crawlee';

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
    maxPoolSize: 30, // Reduced to 30 to cut overhead while staying robust
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

// Discovery state check (per-username) - only skip Phase 1 when completed === true AND DISC_ looks sane
const discoveryState = await Actor.getValue('DISCOVERY_STATE') || {};
const usernames = profileUrls.map(r => r.userData.username);
let needPhase1 = false;
for (const un of usernames) {
    const state = discoveryState?.[un] || {};
    const completed = state?.completed === true;
    const discList = (await Actor.getValue(`DISC_${un}`)) || [];
    const expected = Number(state?.expectedCount) || null;
    // Sanity: if DISC_ is empty or suspiciously small vs expected (or below a small threshold), force Phase 1
    const looksTooSmall = expected ? (discList.length < Math.min(Math.floor(expected * 0.6), 100)) : (discList.length < 20);
    if (!completed || discList.length === 0 || looksTooSmall) {
        needPhase1 = true;
        break;
    }
}

if (needPhase1) {

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

// PHASE 2: Batch post extraction using RequestQueue (consuming discovery results)
const phase2QueueName = `phase-2-${(Actor.getEnv()?.actorRunId || 'local')}`;
const requestQueue = await RequestQueue.open(phase2QueueName);
const batchSize = 25;
let totalEnqueued = 0;

for (const url of input.directUrls) {
    const m = url.match(/instagram\.com\/([^\/?]+)/i);
    if (!m) continue;
    const username = m[1];
    const scList = (await Actor.getValue(`DISC_${username}`)) || [];
    if (!Array.isArray(scList) || scList.length === 0) {
        log.warning(`No discovered shortcodes found for ${username}.`);
        continue;
    }
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
                originalUrl: `https://www.instagram.com/${username}/`,
                maxPosts: input.maxPosts || null,
                onlyPostsNewerThan: input.onlyPostsNewerThan || null,
            }
        });
        if (!(result?.wasAlreadyPresent || result?.wasAlreadyHandled)) totalEnqueued++;
    }
}

log.info(`Phase 2 queueing: enqueued ${totalEnqueued} batch requests (idempotent)`);

const postBatchCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
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

// Reconciliation pass: re-enqueue missing shortcodes for a final single-post pass
let missingTotal = 0;
for (const url of input.directUrls) {
    const m = url.match(/instagram\.com\/([^\/\?]+)/i);
    if (!m) continue;
    const username = m[1];
    const discovered = (await Actor.getValue(`DISC_${username}`)) || [];
    const extracted = (await Actor.getValue(`EXTR_${username}`)) || [];
    const extractedSet = new Set(extracted);
    const missing = discovered.filter(sc => !extractedSet.has(sc));
    if (missing.length > 0) {
        missingTotal += missing.length;
        log.info(`Re-enqueueing ${missing.length} missing posts for ${username} (final pass)`);
        for (const sc of missing) {
            await requestQueue.addRequest({
                url: `https://www.instagram.com/p/${sc}/`,
                uniqueKey: `single_post:${username}:${sc}`,
                userData: { type: 'post_extraction', username, shortcode: sc, originalUrl: `https://www.instagram.com/${username}/` }
            });
        }
    }
}

// Run final single-post pass only if we actually enqueued missing items
if (missingTotal > 0) {
    const postFallbackCrawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions,
        requestQueue,
        requestHandlerTimeoutSecs: 60,
        maxRequestRetries: 3,
        retryOnBlocked: true,
        requestHandler: postRouter,
        statisticsOptions: { logIntervalSecs: 60, logMessage: 'CheerioCrawler request statistics' },
    });
    await postFallbackCrawler.run();
} else {
    log.info('No missing posts detected; skipping postFallbackCrawler.');
}

// Completeness monitoring: emit profile_summary
const discoveryState2 = await Actor.getValue('DISCOVERY_STATE') || {};
for (const url of input.directUrls) {
    const m = url.match(/instagram\.com\/([^\/\?]+)/i);
    if (!m) continue;
    const username = m[1];
    const expectedCount = discoveryState2?.[username]?.expectedCount ?? null;
    const discovered = (await Actor.getValue(`DISC_${username}`)) || [];
    const extracted = (await Actor.getValue(`EXTR_${username}`)) || [];
    const missingCount = Math.max(0, discovered.length - extracted.length);
    const missingSample = missingCount > 0 ? discovered.filter(sc => !(new Set(extracted)).has(sc)).slice(0, 10) : [];
    await Dataset.pushData({
        type: 'profile_summary',
        username,
        expectedCount,
        discoveredCount: discovered.length,
        extractedCount: extracted.length,
        missingCount,
        missingSample,
        scrapedAt: new Date().toISOString(),
    });
}

log.info('🎉 All done, shutting down');
await Actor.exit();
