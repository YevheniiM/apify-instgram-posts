import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// Two-phase architecture - exactly like production Apify scraper
import { profileRouter } from './profile-router.js';
import { postRouter } from './post-router.js';

await Actor.init();

// Set production logging level
log.setLevel(log.LEVELS.INFO);

// Proxy configuration will be created below

// Get input from Actor or fallback to INPUT.json for local testing
let input = await Actor.getInput();

if (!input || typeof input === 'string' || (typeof input === 'object' && !input.directUrls)) {
    // Fallback to reading INPUT.json directly for local testing
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
            includeReels: (input.includeReels ?? false),
            includeIGTV: (input.includeIGTV ?? false)
        }
    });
}

if (profileUrls.length === 0) {
    log.error('No valid Instagram URLs found in input. Please provide valid Instagram profile URLs.');
    await Actor.exit();
}

// PHASE 1: Direct URL scraper (Profile Discovery)
log.info(`[Status message]: Starting the direct URL scraper with ${profileUrls.length} direct URL(s)`);

const profileCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 1, // Conservative for profile discovery phase
    // Production session management (Apify playbook)
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions,
    // Enhanced production settings for residential proxies
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
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
    const profileUrl = input.directUrls[0];
    const usernameFromUrl = (profileUrl.match(/instagram\.com\/([^\/]+)\/?/i) || [])[1];
    const SHORTCODE_RE = /\/p\/([A-Za-z0-9_-]{5,15})\//;
    let discoveredShortcodes = postUrls
        .map((item) => {
            if (!item) return null;
            if (typeof item === 'string') return (item.match(SHORTCODE_RE) || [])[1];
            if (typeof item === 'object') {
                return item.userData?.shortcode || (typeof item.url === 'string' ? (item.url.match(SHORTCODE_RE) || [])[1] : null);
            }
            return null;
        })
        .filter(Boolean);
    // Deduplicate to avoid double-processing when Phase 1 re-runs or appends
    discoveredShortcodes = Array.from(new Set(discoveredShortcodes));

    if (usernameFromUrl && discoveredShortcodes.length > 0) {
        log.info(`Using direct batch extraction for ${usernameFromUrl}: ${discoveredShortcodes.length} posts`);

        const directBatchRequests = [{
            url: 'https://www.instagram.com/',
            userData: {
                type: 'direct_posts',
                username: usernameFromUrl,
                maxPosts: input.maxPosts || null,
                onlyPostsNewerThan: input.onlyPostsNewerThan || null,
                discoveredShortcodes,
            }
        }];

        const directPostCrawler = new CheerioCrawler({
            proxyConfiguration,
            maxConcurrency: 1, // single synthetic request
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions,
            // Prevent duplicate synthetic runs by allowing enough time to finish and disabling retries
            requestHandlerTimeoutSecs: 900, // 15 minutes to cover all batches comfortably
            maxRequestRetries: 0, // if it times out, do not rerun the synthetic request
            retryOnBlocked: true,
            requestHandler: postRouter,
            statisticsOptions: {
                logIntervalSecs: 60,
                logMessage: 'CheerioCrawler request statistics'
            }
        });

        await directPostCrawler.run(directBatchRequests);

        // Skip URL-per-post crawling because direct batch already persisted posts
        log.info('Direct batch extraction finished, skipping per-URL post crawler');

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
