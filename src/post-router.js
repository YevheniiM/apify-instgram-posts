import { createCheerioRouter, Dataset } from 'crawlee';
import moment from 'moment';
import { discoverPosts, isValidShortcode } from './post-discovery.js';
import { SHORTCODE_DOC_ID } from './constants.js';

// Create router for direct post extraction (single-phase architecture)
export const postRouter = createCheerioRouter();

// Production GraphQL document IDs (updated July 2025)
const INSTAGRAM_DOCUMENT_IDS = {
    USER_POSTS: '7950326061742207', // For user timeline posts (from production logs)
    SHORTCODE_MEDIA: SHORTCODE_DOC_ID, // For individual posts by shortcode (updated July 2025)
    BATCH_SHORTCODE_MEDIA: SHORTCODE_DOC_ID // For batch post retrieval
};

// Production-scale throttling and delay management
class SmartThrottling {
    constructor() {
        this.requestCounts = new Map();
        this.lastRequestTime = new Map();
        this.blockCounts = new Map();
    }

    async applySmartDelay(sessionId, isBlocked = false) {
        const now = Date.now();
        const lastRequest = this.lastRequestTime.get(sessionId) || 0;
        const timeSinceLastRequest = now - lastRequest;

        this.requestCounts.set(sessionId, (this.requestCounts.get(sessionId) || 0) + 1);
        this.lastRequestTime.set(sessionId, now);

        if (isBlocked) {
            this.blockCounts.set(sessionId, (this.blockCounts.get(sessionId) || 0) + 1);
        }

        // Dynamic delay: 1-3 seconds base + penalties
        const baseDelay = 1000 + Math.random() * 2000; // 1-3 seconds
        const blockPenalty = (this.blockCounts.get(sessionId) || 0) * 1000;
        const frequencyPenalty = timeSinceLastRequest < 500 ? 1000 : 0;

        const totalDelay = Math.min(baseDelay + blockPenalty + frequencyPenalty, 8000); // Max 8s

        if (totalDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, totalDelay));
        }

        return totalDelay;
    }

    getSessionStats(sessionId) {
        return {
            requests: this.requestCounts.get(sessionId) || 0,
            blocks: this.blockCounts.get(sessionId) || 0,
            lastRequest: this.lastRequestTime.get(sessionId) || 0
        };
    }
}

// Global throttling manager
const throttling = new SmartThrottling();

// Advanced Cookie Management for production-scale scraping
class CookieManager {
    constructor() {
        this.cookiePools = new Map();
        this.cookieUsage = new Map();
        this.blockedCookies = new Set();
        this.domainCookies = new Map();
    }

    async initializeCookies() {
        // Try to load real Instagram cookies from environment or file
        const realCookies = await this.loadRealCookies();

        if (realCookies.length > 0) {
            console.log(`✅ Loaded ${realCookies.length} real Instagram cookie sets`);
            for (const cookieSet of realCookies) {
                this.cookiePools.set(cookieSet.id, cookieSet);
            }
        } else {
            console.log(`⚠️  No real Instagram cookies found. Using placeholder cookies (will likely fail)`);
            console.log(`📝 To add real cookies, create a file: cookies.json with format:`);
            console.log(`[{"sessionid": "your_sessionid", "csrftoken": "your_csrftoken", "mid": "your_mid"}]`);

            // Fallback to placeholder cookies
            const baseCookies = [
                {
                    id: 'cookie_set_1',
                    cookies: {
                        'mid': 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                        'csrftoken': 'missing',
                        'ig_did': 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'
                    },
                    usage: 0,
                    lastUsed: 0,
                    blocked: false
                }
            ];

            for (const cookieSet of baseCookies) {
                this.cookiePools.set(cookieSet.id, cookieSet);
            }
        }

        this.initializeDomainCookies();
        return this.cookiePools.size;
    }

    async loadRealCookies() {
        const realCookies = [];

        try {
            // Method 1: Try to load from cookies.json file
            const fs = await import('fs');
            const path = await import('path');

            const cookieFilePath = path.resolve('./cookies.json');
            if (fs.existsSync(cookieFilePath)) {
                const cookieData = JSON.parse(fs.readFileSync(cookieFilePath, 'utf8'));

                if (Array.isArray(cookieData)) {
                    for (let i = 0; i < cookieData.length; i++) {
                        const cookies = cookieData[i];
                        if (cookies.sessionid && cookies.csrftoken) {
                            realCookies.push({
                                id: `real_cookie_set_${i + 1}`,
                                cookies: {
                                    'sessionid': cookies.sessionid,
                                    'csrftoken': cookies.csrftoken,
                                    'mid': cookies.mid || 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                                    'ig_did': cookies.ig_did || 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
                                    'ds_user_id': cookies.ds_user_id || '',
                                    'rur': cookies.rur || '',
                                    'shbid': cookies.shbid || '',
                                    'shbts': cookies.shbts || ''
                                },
                                usage: 0,
                                lastUsed: 0,
                                blocked: false
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`Could not load cookies from file: ${error.message}`);
        }

        // Method 2: Try to load from environment variables
        if (realCookies.length === 0) {
            const sessionid = process.env.INSTAGRAM_SESSIONID;
            const csrftoken = process.env.INSTAGRAM_CSRFTOKEN;
            const mid = process.env.INSTAGRAM_MID;

            if (sessionid && csrftoken) {
                realCookies.push({
                    id: 'env_cookie_set_1',
                    cookies: {
                        'sessionid': sessionid,
                        'csrftoken': csrftoken,
                        'mid': mid || 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                        'ig_did': process.env.INSTAGRAM_IG_DID || 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'
                    },
                    usage: 0,
                    lastUsed: 0,
                    blocked: false
                });
            }
        }

        return realCookies;
    }

    initializeDomainCookies() {
        this.domainCookies.set('www.instagram.com', {
            allowedCookies: ['mid', 'csrftoken', 'ig_did', 'sessionid', 'ds_user_id'],
            requiredCookies: ['mid', 'csrftoken']
        });

        this.domainCookies.set('i.instagram.com', {
            allowedCookies: ['mid', 'csrftoken', 'ig_did'],
            requiredCookies: ['mid']
        });
    }

    getCookiesForRequest() {
        const availableCookies = Array.from(this.cookiePools.values())
            .filter(cs => !cs.blocked && cs.usage < 1000)
            .sort((a, b) => a.usage - b.usage);

        if (availableCookies.length === 0) {
            return null;
        }

        const selectedCookieSet = availableCookies[0];
        selectedCookieSet.usage += 1;
        selectedCookieSet.lastUsed = Date.now();

        return selectedCookieSet;
    }

    getCookieStringForDomain(cookieSet, domain) {
        if (!cookieSet || !domain) return '';

        const domainConfig = this.domainCookies.get(domain);
        if (!domainConfig) {
            return this.getCookieString(cookieSet);
        }

        const filteredCookies = {};
        for (const [key, value] of Object.entries(cookieSet.cookies)) {
            if (domainConfig.allowedCookies.includes(key) && value !== 'missing') {
                filteredCookies[key] = value;
            }
        }

        return Object.entries(filteredCookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    getCookieString(cookieSet) {
        if (!cookieSet) return '';
        return Object.entries(cookieSet.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    markAsBlocked(cookieSetId) {
        const cookieSet = this.cookiePools.get(cookieSetId);
        if (cookieSet) {
            cookieSet.blocked = true;
            this.blockedCookies.add(cookieSetId);
        }
    }

    updateCsrfToken(cookieSetId, csrfToken) {
        const cookieSet = this.cookiePools.get(cookieSetId);
        if (cookieSet) {
            cookieSet.cookies.csrftoken = csrfToken;
        }
    }
}

// Global cookie manager
const cookieManager = new CookieManager();

// Export for use in other modules
export { cookieManager };

// Production GraphQL endpoint for user posts pagination (from logs)
async function fetchUserPostsViaGraphQL(userId, after = null, first = 12, log, session) {
    const axios = (await import('axios')).default;

    // Exact URL pattern from production logs
    const graphqlUrl = new URL('https://www.instagram.com/graphql/query/');
    const variables = {
        id: userId,
        first: first,
        ...(after && { after: after })
    };

    graphqlUrl.searchParams.set('doc_id', INSTAGRAM_DOCUMENT_IDS.USER_POSTS);
    graphqlUrl.searchParams.set('variables', JSON.stringify(variables));

    const cookieSet = cookieManager.getCookiesForRequest();
    if (!cookieSet) {
        throw new Error('No available cookies for GraphQL request');
    }

    // Get dynamic tokens from session userData (extracted during profile discovery)
    const wwwClaim = session.userData?.wwwClaim || '0';
    const asbdId = session.userData?.asbdId || '129477';

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-CSRFToken': cookieSet.cookies.csrftoken,
        'X-IG-App-ID': '936619743392459', // Required anti-bot header
        'X-ASBD-ID': asbdId, // Dynamic per-session token (March 2025+)
        'X-IG-WWW-Claim': wwwClaim, // Dynamic per-session token (March 2025+)
        'X-Instagram-AJAX': '1',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': Object.entries(cookieSet.cookies).map(([key, value]) => `${key}=${value}`).join('; '),
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com'
    };

    try {
        const response = await axios.get(graphqlUrl.toString(), {
            headers,
            timeout: 30000,
            validateStatus: () => true
        });

        if ([403, 429, 401].includes(response.status)) {
            log.warning(`Request blocked, retrying it again with different session`);
            session.retire();
            throw new Error(`Request blocked (${response.status}), session retired.`);
        }

        return response.data;

    } catch (error) {
        // Production proxy error handling (matching logs exactly)
        if (error.code === 'ECONNRESET') {
            log.warning(`Detected a session error, rotating session...`);
            log.warning(`The proxy server rejected the request with status code 595 (ECONNRESET)`);
            session.retire();
        } else if (error.code === 'UPSTREAM502' || error.message.includes('590')) {
            log.warning(`The proxy server rejected the request with status code 590 (UPSTREAM502)`);
            session.retire();
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            log.warning(`Timeout awaiting 'request' for 30000ms`);
            session.retire();
        }
        throw error;
    }
}

// Extract single post via GraphQL API (matching production behavior)
async function extractSinglePostViaGraphQL(shortcode, username, originalUrl, log, session, userData = {}) {
    const axios = (await import('axios')).default;
    const maxRetries = 3;

    const cookieSet = cookieManager.getCookiesForRequest();
    if (!cookieSet) {
        return { shortcode, error: 'No available cookies', data: null };
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Use GET GraphQL endpoint to avoid LSD requirement (March 2025+ approach)
            const graphqlUrl = 'https://www.instagram.com/graphql/query/';
            const variables = { shortcode };

            // Build GET URL with query parameters (no LSD needed)
            const params = new URLSearchParams({
                doc_id: INSTAGRAM_DOCUMENT_IDS.SHORTCODE_MEDIA,
                variables: JSON.stringify(variables)
            });

            const fullUrl = `${graphqlUrl}?${params}`;

            // Get dynamic tokens from userData (passed from profile discovery)
            const wwwClaim = userData?.wwwClaim || '0';
            const asbdId = userData?.asbdId || '129477';

            log.info(`🔑 Post ${shortcode} using tokens: WWW-Claim="${wwwClaim}", ASBD-ID="${asbdId}" (from profile discovery)`);

            const productionHeaders = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'X-CSRFToken': cookieSet.cookies.csrftoken,
                'X-IG-App-ID': '936619743392459', // Required anti-bot header
                'X-ASBD-ID': asbdId, // Dynamic per-session token (March 2025+)
                'X-IG-WWW-Claim': wwwClaim, // Dynamic per-session token (March 2025+)
                'X-Instagram-AJAX': '1',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': Object.entries(cookieSet.cookies).map(([key, value]) => `${key}=${value}`).join('; '),
                'Referer': `https://www.instagram.com/${username}/`
            };

            const timeout = 10000 + (attempt - 1) * 5000;

            const response = await axios.get(fullUrl, {
                headers: productionHeaders,
                timeout,
                validateStatus: () => true,
                maxRedirects: 2
            });

            // Handle specific error cases that require retries
            if (response.status === 401) {
                if (attempt < maxRetries) {
                    log.warning(`Post ${shortcode} unauthorized (attempt ${attempt}) - retrying with new session`);
                    cookieManager.markAsBlocked(cookieSet.id);
                    throw new Error(`Unauthorized - retry needed`);
                }
                return { shortcode, error: `HTTP 401 after ${maxRetries} attempts`, data: null };
            }

            // Handle specific production error codes
            if (response.status === 403) {
                log.warning(`Request blocked, retrying it again with different session`);
                session.retire();
                throw new Error(`Request blocked (403), session retired.`);
            }

            if (response.status === 429) {
                log.warning(`Request blocked, retrying it again with different session`);
                session.retire();
                throw new Error(`Request blocked (429), session retired.`);
            }

            if (response.status === 590) {
                log.warning(`The proxy server rejected the request with status code 590 (UPSTREAM502)`);
                session.retire();
                throw new Error(`Proxy error (590), session retired.`);
            }

            if (response.status === 595) {
                log.warning(`Detected a session error, rotating session...`);
                log.warning(`The proxy server rejected the request with status code 595 (ECONNRESET)`);
                session.retire();
                throw new Error(`Connection reset (595), session retired.`);
            }

            const jsonResponse = response.data;

            // Log response status for monitoring
            log.info(`🔍 Post ${shortcode} response status: ${response.status}, data keys: ${Object.keys(jsonResponse || {}).join(', ')}`);

            if (jsonResponse.errors) {
                if (attempt < maxRetries) {
                    log.warning(`Post ${shortcode} GraphQL errors (attempt ${attempt}): ${JSON.stringify(jsonResponse.errors)}`);
                    throw new Error(`GraphQL errors - retry needed`);
                }
                return { shortcode, error: 'GraphQL errors after retries', data: null };
            }

            const post = jsonResponse?.data?.xdt_shortcode_media;
            if (!post) {
                if (attempt < maxRetries) {
                    log.warning(`Post ${shortcode} no data (attempt ${attempt}) - retrying`);
                    throw new Error(`No post data - retry needed`);
                }
                return { shortcode, error: 'No post data after retries', data: null };
            }

            // Extract post data
            const postData = await extractPostDataFromGraphQL(post, username, originalUrl, log);

            if (attempt > 1) {
                log.info(`Post ${shortcode} succeeded on attempt ${attempt}`);
            }

            return { shortcode, error: null, data: postData };

        } catch (error) {
            if (attempt === maxRetries) {
                log.error(`Post ${shortcode} failed after ${maxRetries} attempts:`, error.message);
                return { shortcode, error: error.message, data: null };
            }

            // Production retry delay pattern (exponential backoff)
            const baseDelay = 1000; // 1 second base
            const retryDelay = baseDelay * Math.pow(2, attempt - 1); // 1s, 2s, 4s

            log.info(`Retrying post ${shortcode} in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

// Initialize cookie manager on first use
let cookieManagerInitialized = false;

// Phase 2: Post extraction handler - processes individual post URLs
postRouter.addDefaultHandler(async ({ request, response, $, log, crawler, session }) => {
    const { type, username, originalUrl, onlyPostsNewerThan, maxPosts, includeReels, includeIGTV } = request.userData;

    // Initialize cookie manager if not done
    if (!cookieManagerInitialized) {
        await cookieManager.initializeCookies();
        cookieManagerInitialized = true;
        log.info('Cookie manager initialized for post extraction');
    }

    // Apply smart throttling before request
    const sessionId = session.id;
    const delayApplied = await throttling.applySmartDelay(sessionId);

    log.info(`Phase 2: Post extraction for ${request.url} (session: ${sessionId}, delay: ${delayApplied}ms)`);

    // Handle blocked requests with session rotation (matching production logs)
    if (response.statusCode === 403 || response.statusCode === 429) {
        log.warning(`Request blocked, retrying it again with different session`);
        session.retire();
        throw new Error(`Request blocked (${response.statusCode}), session retired.`);
    }

    // Extract shortcode from post URL
    const shortcodeMatch = request.url.match(/\/p\/([^\/\?]+)/);
    if (!shortcodeMatch) {
        log.error(`Could not extract shortcode from URL: ${request.url}`);
        return;
    }

    const shortcode = shortcodeMatch[1];

    // BEFORE – bail out early if the shortcode is bad
    if (!isValidShortcode(shortcode)) {
        log.debug(`${shortcode} rejected – invalid`);
        return;
    }

    // Use production GraphQL API for post extraction with dynamic tokens
    const postData = await extractSinglePostViaGraphQL(shortcode, username, originalUrl, log, session, request.userData);

    if (postData && postData.data) {
        await Dataset.pushData(postData.data);
        log.info(`Successfully extracted post: ${shortcode}`);
    } else {
        log.warning(`Failed to extract post: ${shortcode}`);
    }

    try {
        // Check if this is a direct_posts request (from main.js)
        if (type === 'direct_posts') {
            log.info(`Starting advanced post discovery for ${username}...`);

            // Use the production post discovery system (pure HTTP requests)
            const discoveryOptions = {
                maxPosts: maxPosts || null, // Extract ALL posts if not specified
                methods: ['directapi', 'search', 'graph'], // Production methods: direct API, search, GraphQL
                fallbackToKnown: false,
                onlyPostsNewerThan: onlyPostsNewerThan
            };

            const discoveredShortcodes = await discoverPosts(username, discoveryOptions, log, session, cookieManager, throttling);

            if (discoveredShortcodes.length > 0) {
                log.info(`Discovered ${discoveredShortcodes.length} posts for ${username} using advanced discovery`);

                // Process discovered shortcodes in batches for maximum speed
                let postsProcessed = 0;
                const batchSize = 10; // Process 10 posts per batch
                const totalBatches = Math.ceil(discoveredShortcodes.length / batchSize);

                log.info(`Processing ${discoveredShortcodes.length} posts in ${totalBatches} batches of ${batchSize}`);

                for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                    if (maxPosts && postsProcessed >= maxPosts) {
                        log.info(`Reached maxPosts limit (${maxPosts}), stopping`);
                        break;
                    }

                    const startIndex = batchIndex * batchSize;
                    const endIndex = Math.min(startIndex + batchSize, discoveredShortcodes.length);
                    const batchShortcodes = discoveredShortcodes.slice(startIndex, endIndex);

                    // Limit batch to remaining posts needed
                    const remainingPosts = maxPosts ? Math.min(maxPosts - postsProcessed, batchShortcodes.length) : batchShortcodes.length;
                    const limitedBatch = batchShortcodes.slice(0, remainingPosts);

                    try {
                        log.info(`📦 Processing batch ${batchIndex + 1}/${totalBatches}: ${limitedBatch.length} posts`);

                        // Use batch processing for maximum speed
                        const batchResults = await fetchPostsBatch(limitedBatch, username, originalUrl, onlyPostsNewerThan, log, sessionId);

                        // Save all successful results
                        for (const postData of batchResults) {
                            if (postData) {
                                await Dataset.pushData(postData);
                                postsProcessed++;
                                log.info(`Saved post ${postData.shortCode} from ${username} (${postData.type}, ${postData.likesCount} likes)`);
                            }
                        }

                        log.info(`Batch ${batchIndex + 1} completed: ${batchResults.length}/${limitedBatch.length} posts saved (total: ${postsProcessed})`);

                        // Time-range filtering: Stop if no more posts within the wanted time range
                        if (onlyPostsNewerThan && batchResults.length === 0) {
                            log.info(`No more posts within the wanted time range, finishing`);
                            break;
                        }

                        // Smart delay between batches
                        if (batchIndex < totalBatches - 1) {
                            const batchDelay = 500 + Math.random() * 500; // 0.5-1 second between batches
                            await new Promise(resolve => setTimeout(resolve, batchDelay));
                        }

                    } catch (error) {
                        log.error(`Error processing batch ${batchIndex + 1}:`, error.message);
                        // Continue with next batch
                    }
                }

                log.info(`Successfully processed ${postsProcessed} posts for ${username} using direct extraction`);

                // Calculate success rate
                const successRate = ((postsProcessed / discoveredShortcodes.length) * 100).toFixed(1);
                log.info(`Success Rate: ${successRate}% (${postsProcessed}/${discoveredShortcodes.length} posts)`);

                return; // Finished processing this profile
            } else {
                log.warning(`Advanced post discovery found no posts for ${username}`);
            }
        }

        // Fallback: If we reach here, something went wrong with discovery
        log.warning(`No posts discovered for ${username}, skipping`);

    } catch (error) {
        log.error(`Error in direct post extraction for ${username}:`, error.message);

        // Apply block delay if needed
        if (error.message.includes('blocked') || error.message.includes('403') || error.message.includes('429')) {
            await throttling.applySmartDelay(sessionId, true);
            session.retire();
        }
    }
});

// Enhanced batch post retrieval function with individual post retries
async function fetchPostsBatch(shortcodes, username, originalUrl, onlyPostsNewerThan, log, sessionId = null) {
    const axios = (await import('axios')).default;
    const batchSize = Math.min(shortcodes.length, 10); // Process up to 10 posts per batch
    const results = [];

    // Apply smart throttling for batch requests
    if (sessionId) {
        await throttling.applySmartDelay(sessionId);
    }

    // Get optimal cookie set for this request
    const cookieSet = cookieManager.getCookiesForRequest();
    if (!cookieSet) {
        log.warning(`No available cookies for batch ${shortcodes.slice(0, 3).join(',')}... - skipping`);
        return [];
    }

    log.info(`Fetching batch of ${batchSize} posts: ${shortcodes.slice(0, 3).join(',')}${batchSize > 3 ? '...' : ''}`);

    // Enhanced individual post fetching with retry logic
    const fetchSinglePostWithRetry = async (shortcode, maxRetries = 3) => {
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Fetching post ${shortcode} (attempt ${attempt}/${maxRetries})

                // Use production GraphQL endpoint (matching logs exactly)
                const graphqlUrl = 'https://www.instagram.com/api/graphql';
                const graphqlPayload = {
                    variables: JSON.stringify({ shortcode }),
                    doc_id: INSTAGRAM_DOCUMENT_IDS.SHORTCODE_MEDIA
                };

                // Get fresh cookie set for retries if needed
                const currentCookieSet = attempt === 1 ? cookieSet : cookieManager.getCookiesForRequest();
                if (!currentCookieSet) {
                    throw new Error('No available cookies for retry');
                }

                // Production-grade headers with domain-specific cookie management
                const productionHeaders = {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookieManager.getCookieStringForDomain(currentCookieSet, 'www.instagram.com'),
                    'X-IG-App-ID': '936619743392459',
                    'X-FB-LSD': 'AVqbxe3J_YA',
                    'X-ASBD-ID': '129477',
                    'X-CSRFToken': currentCookieSet.cookies.csrftoken || 'missing',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Referer': `https://www.instagram.com/${username}/`
                };

                // Increase timeout on retries (10s -> 15s -> 20s) for better reliability
                const timeout = 10000 + (attempt - 1) * 5000;

                const response = await axios.post(graphqlUrl, graphqlPayload, {
                    headers: productionHeaders,
                    timeout,
                    validateStatus: () => true,
                    maxRedirects: 2
                });

                // Handle specific error cases that require retries
                if (response.status === 401) {
                    if (attempt < maxRetries) {
                        log.warning(`Post ${shortcode} unauthorized (attempt ${attempt}) - retrying with new session`);
                        // Mark current cookie as potentially blocked
                        cookieManager.markAsBlocked(currentCookieSet.id);
                        throw new Error(`Unauthorized - retry needed`);
                    }
                    return { shortcode, error: `HTTP 401 after ${maxRetries} attempts`, data: null };
                }

                if (response.status === 403) {
                    if (attempt < maxRetries) {
                        log.warning(`Post ${shortcode} forbidden (attempt ${attempt}) - retrying with new session`);
                        cookieManager.markAsBlocked(currentCookieSet.id);
                        throw new Error(`Forbidden - retry needed`);
                    }
                    return { shortcode, error: `HTTP 403 after ${maxRetries} attempts`, data: null };
                }

                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        log.warning(`Post ${shortcode} rate limited (attempt ${attempt}) - retrying with delay`);
                        // Apply exponential backoff for rate limiting
                        const delay = 2000 * Math.pow(2, attempt - 1);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        throw new Error(`Rate limited - retry needed`);
                    }
                    return { shortcode, error: `HTTP 429 after ${maxRetries} attempts`, data: null };
                }

                if (response.status !== 200) {
                    if (attempt < maxRetries && [500, 502, 503, 504].includes(response.status)) {
                        log.warning(`Post ${shortcode} server error ${response.status} (attempt ${attempt}) - retrying`);
                        throw new Error(`Server error ${response.status} - retry needed`);
                    }
                    return { shortcode, error: `HTTP ${response.status}`, data: null };
                }

                const jsonResponse = response.data;
                if (jsonResponse.errors) {
                    if (attempt < maxRetries) {
                        log.warning(`Post ${shortcode} GraphQL errors (attempt ${attempt}) - retrying`);
                        throw new Error(`GraphQL errors - retry needed`);
                    }
                    return { shortcode, error: 'GraphQL errors after retries', data: null };
                }

                const post = jsonResponse?.data?.xdt_shortcode_media;
                if (!post) {
                    if (attempt < maxRetries) {
                        log.warning(`Post ${shortcode} no data (attempt ${attempt}) - retrying`);
                        throw new Error(`No post data - retry needed`);
                    }
                    return { shortcode, error: 'No post data after retries', data: null };
                }

                // Apply date filtering
                if (onlyPostsNewerThan && post.taken_at_timestamp) {
                    const postTimestamp = moment.unix(post.taken_at_timestamp);
                    if (postTimestamp.isBefore(moment(onlyPostsNewerThan))) {
                        return { shortcode, error: 'Filtered by date', data: null };
                    }
                }

                // Extract post data
                const postData = await extractPostDataFromGraphQL(post, username, originalUrl, log);

                if (attempt > 1) {
                    log.info(`Post ${shortcode} succeeded on attempt ${attempt}`);
                }

                return { shortcode, error: null, data: postData };

            } catch (error) {
                lastError = error;

                if (attempt === maxRetries) {
                    log.warning(`Post ${shortcode} failed after ${maxRetries} attempts: ${error.message}`);
                    break;
                }

                // Enhanced retryable error detection
                const isRetryable = error.message.includes('timeout') ||
                                  error.message.includes('retry needed') ||
                                  error.message.includes('ECONNRESET') ||
                                  error.message.includes('ETIMEDOUT') ||
                                  error.message.includes('ENOTFOUND') ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('exceeded') ||
                                  error.code === 'ECONNRESET' ||
                                  error.code === 'ETIMEDOUT' ||
                                  error.code === 'ENOTFOUND';

                if (!isRetryable) {
                    log.warning(`Post ${shortcode} non-retryable error: ${error.message}`);
                    break;
                }

                // Enhanced delay with exponential backoff for timeout errors
                let delay = 1000 + (attempt - 1) * 1000; // Base: 1s, 2s, 3s

                // Apply longer delays for timeout errors
                if (error.message.includes('timeout') || error.message.includes('exceeded')) {
                    delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s for timeouts
                    log.warning(`Post ${shortcode} timeout detected - applying extended delay: ${delay}ms`);
                }

                // Post ${shortcode} waiting ${delay}ms before retry ${attempt + 1}
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        return { shortcode, error: lastError?.message || 'Unknown error', data: null };
    };

    try {
        // Process posts in parallel with individual retry logic
        const batchPromises = shortcodes.slice(0, batchSize).map(shortcode =>
            fetchSinglePostWithRetry(shortcode)
        );

        // Wait for all batch requests to complete
        const batchResults = await Promise.allSettled(batchPromises);

        // Process results
        let successCount = 0;
        let errorCount = 0;

        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value.data) {
                results.push(result.value.data);
                successCount++;
            } else {
                errorCount++;
                if (result.status === 'rejected') {
                    // Batch promise rejected: ${result.reason}
                } else if (result.value?.error) {
                    // Post ${result.value.shortcode} failed: ${result.value.error}
                }
            }
        }

        log.info(`Batch completed: ${successCount} success, ${errorCount} errors (${shortcodes.slice(0, 3).join(',')}...)`);
        return results;

    } catch (error) {
        log.error(`Error in batch processing:`, error.message);
        return [];
    }
}

// Function to extract post data from the new GraphQL response structure
// Adapted to match the specific field requirements from the Instagram Post Scraper Fields Guide
async function extractPostDataFromGraphQL(post, username, originalUrl, log) {
    try {
        // Extract basic post information (matching required fields)
        const postData = {
            // Core Post Fields - Basic Post Information
            id: post.id,
            type: getPostType(post), // "Video", "Sidecar", "Image"
            shortCode: post.shortcode, // Note: using shortCode (camelCase) as specified
            url: `https://www.instagram.com/p/${post.shortcode}/`,
            timestamp: moment.unix(post.taken_at_timestamp).toISOString(),

            // Content Fields
            caption: post.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            alt: post.accessibility_caption || null,
            hashtags: [], // Will be populated below
            mentions: [], // Will be populated below
            sponsors: [], // Will be populated below

            // Engagement Metrics
            likesCount: post.edge_media_preview_like?.count || 0,
            commentsCount: post.edge_media_to_comment?.count || 0,
            videoViewCount: post.video_view_count || 0,

            // Media Content
            displayUrl: post.display_url,
            images: [post.display_url], // Default to display URL, will be updated for carousels
            videoUrl: post.video_url || null,
            videoDuration: post.video_duration ? post.video_duration * 1000 : null, // Convert to milliseconds as specified
            dimensionsHeight: post.dimensions?.height || 0,
            dimensionsWidth: post.dimensions?.width || 0,

            // Business/Sponsored Content
            paidPartnership: post.is_paid_partnership || false,
            isSponsored: post.is_sponsored_tag || false,

            // Additional metadata for compatibility
            inputUrl: originalUrl,
            username: username
        };

        // Handle carousel posts (Sidecar) - extract all images
        if (post.__typename === 'GraphSidecar' && post.edge_sidecar_to_children) {
            const allImages = [];

            for (const edge of post.edge_sidecar_to_children.edges) {
                const item = edge.node;
                allImages.push(item.display_url);

                // For video items in carousel, also add video URL
                if (item.is_video && item.video_url) {
                    postData.videoUrl = item.video_url; // Use first video found
                    postData.videoDuration = item.video_duration ? item.video_duration * 1000 : null;
                    postData.videoViewCount = item.video_view_count || 0;
                }
            }

            postData.images = allImages;
        }

        // Extract hashtags and mentions from caption
        if (postData.caption) {
            // Extract hashtags (without #)
            postData.hashtags = (postData.caption.match(/#[\w]+/g) || []).map(tag => tag.substring(1));

            // Extract mentions (without @)
            postData.mentions = (postData.caption.match(/@[\w.]+/g) || []).map(mention => mention.substring(1));
        }

        // Extract sponsors from tagged users (business accounts)
        if (post.edge_media_to_tagged_user?.edges) {
            postData.sponsors = post.edge_media_to_tagged_user.edges
                .filter(edge => edge.node.user.is_business_account || edge.node.user.is_verified)
                .map(edge => edge.node.user.username);
        }

        // Log successful extraction
        log.info(`Extracted post data for ${postData.shortCode}: ${postData.type}, ${postData.likesCount} likes`);
        return postData;

    } catch (error) {
        log.error(`Error extracting post data:`, error.message);
        return null;
    }
}

// Helper functions for data extraction
// Updated to match the exact post type values specified in the requirements
function getPostType(post) {
    // Check for carousel/sidecar posts first
    if (post.__typename === 'GraphSidecar' || (post.edge_sidecar_to_children?.edges?.length > 1)) {
        return 'Sidecar';
    }

    // Check for video posts
    if (post.is_video) {
        return 'Video';
    }

    // Default to image
    return 'Image';
}


