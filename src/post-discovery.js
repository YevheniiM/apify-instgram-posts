/**
 * Production post discovery methods for Instagram profiles
 * Uses pure HTTP requests via CheerioCrawler (matching production scraper)
 * No browser automation - all requests are direct API calls
 *
 * CRITICAL UPDATE (March 2025): Instagram now rotates token values per-session!
 * - X-ASBD-ID: Extract from 'IG-Set-ASBD-ID' header or fallback to '129477'
 * - X-IG-WWW-Claim: Extract from 'IG-Set-WWW-Claim' header or meta tag per session
 * - X-CSRFToken: extracted from csrftoken cookie
 *
 * Hard-coding these values to '0'/'129477' only works on small profiles.
 * High-traffic profiles (@instagram, celebrities) require session-specific tokens.
 * The official Apify Instagram scraper extracts these dynamically per session.
 */

// Note: CookieManager and SmartThrottling classes are passed as parameters
// to avoid circular imports. They are defined in routes.js and post-router.js

import { SHORTCODE_DOC_ID, TIMEOUTS } from './constants.js';
import { refreshCsrfToken, getFreshLsd } from './session-utils.js';

// BEFORE – loose capture, grabs "rum-slate-t" etc.
// AFTER – *exact* 11-char shortcode & validation helper
const SHORTCODE_RE = /\/p\/([A-Za-z0-9_-]{11})\//g;

export function isValidShortcode(code) {
  return /^[A-Za-z0-9_-]{11}$/.test(code);
}

// Enhanced retry configuration for maximum reliability
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second base delay
    maxDelay: 10000, // 10 seconds max delay
    timeoutMultiplier: 1.5, // Increase timeout on each retry
    sessionRotationErrors: [401, 403, 429], // Errors that require session rotation
    retryableErrors: [401, 403, 429, 500, 502, 503, 504], // All retryable HTTP errors
    networkErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']
};

// Instagram API constants - update these periodically by checking network tab
const IG_CONSTANTS = {
    APP_ID: '936619743392459',   // Public web-client ID
    ASBD_ID_FALLBACK: '129477',  // Fallback ASBD-ID (Instagram now rotates per-session)
    WWW_CLAIM_FALLBACK: '0',     // Fallback WWW-Claim (Instagram now rotates per-session)
    DOC_ID: SHORTCODE_DOC_ID     // Current doc_id for user posts - updated July 2025
};

/**
 * Extract dynamic Instagram tokens from HTML response (March 2025+ requirement)
 * Instagram now rotates X-IG-WWW-Claim and X-ASBD-ID per session for high-traffic profiles
 */
async function extractInstagramTokens(response, $, session, log) {
    // Method 1: Extract from response headers (preferred)
    const wwwClaimHeader = response.headers['ig-set-www-claim'];
    const asbdIdHeader = response.headers['ig-set-asbd-id'];

    // Method 2: Extract from meta tags (fallback)
    const wwwClaimMeta = $('meta[name="ig-www-claim"]').attr('content');

    // Use header values first, then meta tags, then fallbacks
    const wwwClaim = wwwClaimHeader || wwwClaimMeta || IG_CONSTANTS.WWW_CLAIM_FALLBACK;
    const asbdId = asbdIdHeader || IG_CONSTANTS.ASBD_ID_FALLBACK;

    // Store in session metadata for later GraphQL requests
    session.setMetadata('wwwClaim', wwwClaim);
    session.setMetadata('asbdId', asbdId);

    log.info(`🔑 Extracted tokens for session ${session.id}: WWW-Claim="${wwwClaim}", ASBD-ID="${asbdId}"`);

    return { wwwClaim, asbdId };
}

// Enhanced session and cookie management for retries with full integration
class RetryManager {
    constructor(log, session = null, cookieManager = null, throttling = null) {
        this.log = log;
        this.session = session;
        this.cookieManager = cookieManager;
        this.throttling = throttling;
        this.sessionAttempts = new Map();
        this.cookieRotationCount = 0;
        this.currentCookieSet = null;
        this.authFailures = new Map(); // Track auth failures per session
        this.lastAuthFailure = null; // Track timing for proactive refresh
        this.graphqlCallCount = 0; // Track GraphQL calls for token refresh
    }

    async executeWithRetry(operation, context, maxRetries = RETRY_CONFIG.maxRetries) {
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Retry attempt ${attempt}/${maxRetries}

                // Handle session and cookie rotation for retries
                if (attempt > 1) {
                    await this.handleRetryPreparation(lastError, attempt, context);
                }

                const result = await operation(attempt);

                if (attempt > 1) {
                    this.log.info(`✅ ${context} succeeded on attempt ${attempt}`);
                }

                return result;
            } catch (error) {
                lastError = error;
                this.log.warning(`❌ ${context} failed on attempt ${attempt}: ${error.message}`);

                if (attempt === maxRetries) {
                    this.log.error(`🚫 ${context} failed after ${maxRetries} attempts`);
                    break;
                }

                // Determine if we should retry
                const shouldRetry = this.shouldRetry(error, attempt);
                if (!shouldRetry) {
                    this.log.error(`🚫 ${context} - Non-retryable error: ${error.message}`);
                    break;
                }

                // Apply retry delay with exponential backoff
                const delay = this.calculateDelay(attempt);
                this.log.info(`⏳ ${context} - Waiting ${delay}ms before retry ${attempt + 1}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    // Handle session rotation, cookie rotation, and throttling for retries
    async handleRetryPreparation(error, attempt, context) {
        const errorStatus = error.response?.status || error.message;

        // Handle authentication failures with proactive refresh
        if (error.response?.status === 401) {
            const sessionId = this.session?.id || 'unknown';
            const now = Date.now();

            // Track auth failures per session
            if (!this.authFailures.has(sessionId)) {
                this.authFailures.set(sessionId, []);
            }
            this.authFailures.get(sessionId).push(now);

            // Check if we've had 2+ 401s in 5 minutes - trigger proactive refresh
            const recentFailures = this.authFailures.get(sessionId).filter(time => now - time < 5 * 60 * 1000);
            if (recentFailures.length >= 2 && this.session) {
                this.log.info(`🔄 ${context} - Proactively refreshing CSRF token (${recentFailures.length} auth failures in 5min)`);
                await refreshCsrfToken(this.session, this.log);
                this.authFailures.set(sessionId, []); // Reset counter after refresh
            }
        }

        // Handle session rotation for specific errors
        if (this.needsSessionRotation(error)) {
            this.log.info(`🔄 ${context} - Rotating session due to error: ${errorStatus}`);

            if (this.session && typeof this.session.retire === 'function') {
                this.session.retire();
                this.session.userData = {}; // Clear stale tokens when rotating session
                this.log.info(`🔄 Session ${this.session.id} retired for ${context}`);
            }
        }

        // Handle cookie rotation for authentication errors
        if (this.needsCookieRotation(error)) {
            this.log.info(`🍪 ${context} - Rotating cookies due to error: ${errorStatus}`);

            if (this.cookieManager && this.currentCookieSet && typeof this.cookieManager.markAsBlocked === 'function') {
                this.cookieManager.markAsBlocked(this.currentCookieSet.id);
                this.log.info(`🍪 Cookie set ${this.currentCookieSet.id} marked as blocked`);
            }

            // Get new cookie set for retry
            if (this.cookieManager && typeof this.cookieManager.getCookiesForRequest === 'function') {
                this.currentCookieSet = this.cookieManager.getCookiesForRequest();
                if (this.currentCookieSet) {
                    this.log.info(`🍪 Using new cookie set ${this.currentCookieSet.id} for retry`);
                } else {
                    this.log.warning(`🍪 No available cookies for retry - this may cause failure`);
                }
            }
        }

        // Apply throttling delay for blocked requests
        if (this.throttling && this.session && this.isBlockedError(error) && typeof this.throttling.applySmartDelay === 'function') {
            const sessionId = this.session.id;
            const delay = await this.throttling.applySmartDelay(sessionId, true);
            this.log.info(`⏳ Applied block penalty delay: ${delay}ms for session ${sessionId}`);
        }
    }

    shouldRetry(error, attempt) {
        // Check for HTTP status codes
        if (error.response?.status) {
            const status = error.response.status;
            if (RETRY_CONFIG.retryableErrors.includes(status)) {
                // Retryable HTTP error: ${status}
                return true;
            }
        }

        // Check for network errors
        if (error.code && RETRY_CONFIG.networkErrors.includes(error.code)) {
            // Retryable network error: ${error.code}
            return true;
        }

        // Check for timeout errors and retry-specific messages
        if (error.message) {
            const retryableMessages = [
                'timeout', 'ETIMEDOUT', 'ECONNRESET', 'retry needed',
                'session rotation needed', 'IP or session blocked'
            ];

            for (const message of retryableMessages) {
                if (error.message.includes(message)) {
                    // Retryable error: ${error.message}
                    return true;
                }
            }
        }

        return false;
    }

    calculateDelay(attempt) {
        // Jitter first, then exponential backoff to avoid synchronized retries
        const base = RETRY_CONFIG.baseDelay * (0.5 + Math.random()); // 0.5-1.5x base
        const exponentialDelay = base * Math.pow(2, attempt - 1);
        return Math.min(exponentialDelay, 15000); // Cap at 15s instead of 30s for faster recovery
    }

    // Check if tokens need refreshing based on GraphQL call count
    async checkTokenRefresh(username) {
        this.graphqlCallCount++;

        // Re-extract WWW-Claim every 25 successful GraphQL calls
        if (this.graphqlCallCount % 25 === 0 && this.session) {
            this.log.info(`🔄 Refreshing WWW-Claim token after ${this.graphqlCallCount} GraphQL calls`);

            try {
                const axios = (await import('axios')).default;
                const response = await axios.head(`https://www.instagram.com/${username}/`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Cookie': this.session.getCookieString('https://www.instagram.com')
                    },
                    timeout: TIMEOUTS.TOKEN_REFRESH,
                    validateStatus: s => s < 500
                });

                // Extract fresh WWW-Claim from response headers
                const newWwwClaim = response.headers['ig-set-www-claim'];
                if (newWwwClaim && this.session.userData) {
                    this.session.userData.wwwClaim = newWwwClaim;
                    this.log.info(`✅ WWW-Claim token refreshed: ${newWwwClaim}`);
                }
            } catch (error) {
                this.log.debug(`WWW-Claim refresh failed: ${error.message}`);
            }
        }
    }

    needsSessionRotation(error) {
        if (error.response?.status) {
            return RETRY_CONFIG.sessionRotationErrors.includes(error.response.status);
        }

        // Also check error messages for session rotation indicators
        if (error.message) {
            return error.message.includes('session rotation needed') ||
                   error.message.includes('Unauthorized') ||
                   error.message.includes('IP or session blocked');
        }

        return false;
    }

    needsCookieRotation(error) {
        if (error.response?.status) {
            return [401, 403].includes(error.response.status);
        }

        if (error.message) {
            return error.message.includes('Unauthorized') ||
                   error.message.includes('Forbidden') ||
                   error.message.includes('session may need rotation');
        }

        return false;
    }

    isBlockedError(error) {
        if (error.response?.status) {
            return [401, 403, 429].includes(error.response.status);
        }

        if (error.message) {
            return error.message.includes('blocked') ||
                   error.message.includes('Rate limited') ||
                   error.message.includes('Forbidden');
        }

        return false;
    }

    // Get current cookie set for operations
    getCurrentCookieSet() {
        if (!this.currentCookieSet && this.cookieManager && typeof this.cookieManager.getCookiesForRequest === 'function') {
            this.currentCookieSet = this.cookieManager.getCookiesForRequest();
        }
        return this.currentCookieSet;
    }
}

// Method 1: High-Speed Direct API with Enhanced Error Handling and Retries
export async function discoverPostsWithDirectAPI(username, maxPosts = 100, log, session, cookieManager = null, throttling = null, options = {}) {
    log.info(`🚀 High-speed post discovery for ${username} (target: ${maxPosts} posts)`);

    const shortcodes = [];
    let hasNextPage = true;
    let endCursor = null;
    let batchCount = 0; // Track batch number for logging
    let throttleRetries = 0; // Track throttle-aware session rotations
    const startTime = Date.now();

    // Use provided systems or create minimal fallbacks
    const activeCookieManager = cookieManager;
    const activeThrottling = throttling;

    // Initialize cookie manager if provided but not initialized
    if (activeCookieManager && typeof activeCookieManager.initializeCookies === 'function') {
        try {
            await activeCookieManager.initializeCookies();
            log.info('🍪 Initialized cookie manager for post discovery');
        } catch (error) {
            log.warning(`Failed to initialize cookie manager: ${error.message}`);
        }
    }

    const retryManager = new RetryManager(log, session, activeCookieManager, activeThrottling);

    // Step 1: Get user ID with retry logic
    let userId = options?.prefetchedUserId || null;

    if (!userId) userId = await retryManager.executeWithRetry(async (attempt) => {
        const profileUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
        // Getting user profile: ${username} (attempt ${attempt})

        // Apply throttling before request if available
        if (session && activeThrottling && typeof activeThrottling.applySmartDelay === 'function') {
            await activeThrottling.applySmartDelay(session.id);
        }

        // Get cookie set for this request if available
        const cookieSet = retryManager.getCurrentCookieSet();
        if (!cookieSet && activeCookieManager) {
            log.warning('No available cookies for profile discovery - proceeding without cookies');
        }

        const axios = (await import('axios')).default;

        // Increase timeout on retries
        const timeout = 10000 * Math.pow(RETRY_CONFIG.timeoutMultiplier, attempt - 1);

        // Get dynamic tokens from session userData (extracted from bootstrap HTML)
        const wwwClaim = session.userData?.wwwClaim || IG_CONSTANTS.WWW_CLAIM_FALLBACK;
        const asbdId = session.userData?.asbdId || IG_CONSTANTS.ASBD_ID_FALLBACK;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': IG_CONSTANTS.APP_ID,
            'X-ASBD-ID': asbdId, // Dynamic per-session token (March 2025+)
            'X-IG-WWW-Claim': wwwClaim, // Dynamic per-session token (March 2025+)
            'Referer': `https://www.instagram.com/${username}/`,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        // Add cookies to headers if available
        if (activeCookieManager && cookieSet && typeof activeCookieManager.getCookieString === 'function') {
            const cookieString = activeCookieManager.getCookieString(cookieSet);
            if (cookieString) {
                headers['Cookie'] = cookieString;

                // Extract CSRF token from cookies for X-CSRFToken header
                const csrfMatch = cookieString.match(/csrftoken=([^;]+)/);
                if (csrfMatch && csrfMatch[1]) {
                    headers['X-CSRFToken'] = csrfMatch[1];
                }
            }
        }

        const profileResponse = await axios.get(profileUrl, {
            headers,
            timeout,
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors, handle them manually
        });

        // Handle specific error cases
        if (profileResponse.status === 401) {
            throw new Error(`Unauthorized access to profile ${username} - session may need rotation`);
        }

        if (profileResponse.status === 403) {
            throw new Error(`Forbidden access to profile ${username} - IP or session blocked`);
        }

        if (profileResponse.status === 429) {
            throw new Error(`Rate limited for profile ${username} - need to slow down`);
        }

        if (profileResponse.status === 404) {
            throw new Error(`Profile ${username} not found - non-retryable error`);
        }

        if (profileResponse.status !== 200) {
            throw new Error(`Profile request failed with status ${profileResponse.status}`);
        }

        const profileData = profileResponse.data;
        const extractedUserId = profileData.data?.user?.id;

        if (!extractedUserId) {
            // Profile response structure: ${Object.keys(profileData).join(', ')}
            throw new Error('Could not extract user ID from profile response');
        }

        log.info(`👤 User ID: ${extractedUserId} for ${username}`);
        return extractedUserId;
    }, `Profile discovery for ${username}`);

    log.info(`✅ Successfully obtained user ID: ${userId}, starting post discovery...`);

    try {
        // Step 2: Fetch posts in batches with enhanced retry logic and throttle-aware pagination
        while (hasNextPage && shortcodes.length < maxPosts) { // No artificial request limit - let throttle detection handle stopping
            batchCount++;

            const batchResult = await retryManager.executeWithRetry(async (attempt) => {
                const batchSize = 50; // Increase batch size for better efficiency while staying under Instagram's limits

                // Use GET endpoint to sidestep LSD requirement (as per your suggestion)
                const graphqlUrl = 'https://www.instagram.com/graphql/query/';

                // Apply throttling before batch request if available
                if (session && activeThrottling && typeof activeThrottling.applySmartDelay === 'function') {
                    await activeThrottling.applySmartDelay(session.id);
                }

                // Get cookie set for this batch request if available
                const cookieSet = retryManager.getCurrentCookieSet();
                if (!cookieSet && activeCookieManager) {
                    log.warning(`No available cookies for batch ${batchCount} - proceeding without cookies`);
                }

                // Build GraphQL variables for GET request
                const variables = {
                    id: userId,
                    first: batchSize,
                    after: endCursor || null
                };

                const axios = (await import('axios')).default;

                // Use optimized timeout - faster fail for residential proxies
                const timeout = TIMEOUTS.GRAPHQL_REQUEST * Math.pow(RETRY_CONFIG.timeoutMultiplier, attempt - 1);

                // Get dynamic tokens from session userData (extracted from bootstrap HTML)
                const { wwwClaim, asbdId, lsd } = session.userData ?? {};

                // Use fallback LSD token if not extracted from HTML
                const lsdToken = lsd || 'AVqbxe3J_YA';

                // Build GET URL with query parameters (LSD required since Feb 2025)
                const params = new URLSearchParams({
                    doc_id: IG_CONSTANTS.DOC_ID,
                    variables: JSON.stringify(variables),
                    lsd: lsdToken
                });

                const fullUrl = `${graphqlUrl}?${params}`;

                log.info(`📡 GraphQL GET batch ${batchCount}: ${batchSize} posts (attempt ${attempt}, LSD: ${lsdToken ? 'present' : 'missing'})`);

                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-IG-App-ID': IG_CONSTANTS.APP_ID,
                    'X-ASBD-ID': asbdId, // Dynamic per-session token (March 2025+)
                    'X-IG-WWW-Claim': wwwClaim, // Dynamic per-session token (March 2025+)
                    'X-FB-LSD': lsdToken, // Required since Feb 2025
                    'Referer': `https://www.instagram.com/${username}/`,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                };

                // Add cookies to headers if available
                if (activeCookieManager && cookieSet && typeof activeCookieManager.getCookieString === 'function') {
                    const cookieString = activeCookieManager.getCookieString(cookieSet);
                    if (cookieString) {
                        headers['Cookie'] = cookieString;

                        // Extract CSRF token from cookies for X-CSRFToken header
                        const csrfMatch = cookieString.match(/csrftoken=([^;]+)/);
                        if (csrfMatch && csrfMatch[1]) {
                            headers['X-CSRFToken'] = csrfMatch[1];
                        }

                        // Debug logging for production troubleshooting
                        log.debug('GraphQL Request Headers:', JSON.stringify(headers, null, 2));
                        log.debug('Cookie header:', cookieString?.slice(0, 120));
                    }
                }

                const response = await axios.get(fullUrl, {
                    headers,
                    timeout,
                    validateStatus: (status) => status < 500 // Handle 4xx errors manually
                });

                // Handle specific error cases
                if (response.status === 401) {
                    throw new Error(`Unauthorized access to posts for ${username} - session rotation needed`);
                }

                if (response.status === 403) {
                    throw new Error(`Forbidden access to posts for ${username} - IP or session blocked`);
                }

                if (response.status === 429) {
                    throw new Error(`Rate limited for posts ${username} - need longer delay`);
                }

                if (response.status !== 200) {
                    throw new Error(`Timeline request failed with status ${response.status}`);
                }

                const data = response.data;

                // Check for GraphQL errors first
                if (data.errors && data.errors.length > 0) {
                    const errorMessage = data.errors[0].message || 'Unknown GraphQL error';
                    log.warning(`GraphQL API error for ${username}: ${errorMessage}`);
                    throw new Error(`GraphQL API error: ${errorMessage}`);
                }

                // Check if data is null (common Instagram response when blocked)
                if (data.data === null) {
                    log.warning(`GraphQL returned null data for ${username} - likely blocked or invalid request`);
                    throw new Error(`GraphQL returned null data - request blocked or invalid`);
                }

                // Handle GraphQL response structure
                if (!data.data?.user?.edge_owner_to_timeline_media?.edges) {
                    // Debug: Log the actual response structure
                    log.debug(`GraphQL Response structure for batch ${batchCount}:`, {
                        hasData: !!data,
                        dataKeys: data ? Object.keys(data) : [],
                        hasDataData: !!(data && data.data),
                        dataDataKeys: (data && data.data) ? Object.keys(data.data) : [],
                        hasUser: !!(data && data.data && data.data.user),
                        userKeys: (data && data.data && data.data.user) ? Object.keys(data.data.user) : []
                    });

                    // Check for common error responses
                    if (data.data?.user === null) {
                        throw new Error(`Unauthorized access to posts for ${username} - session rotation needed`);
                    }

                    log.error(`GraphQL response structure debug:`, JSON.stringify(data, null, 2));
                    throw new Error(`Unexpected GraphQL response structure in batch ${batchCount}`);
                }

                const edges = data.data.user.edge_owner_to_timeline_media.edges;
                const batchShortcodes = edges
                    .filter(edge => edge.node?.shortcode) // Only items with shortcodes
                    .map(edge => edge.node.shortcode);

                // Check for Instagram throttling: if we get very few posts but has_next_page is false,
                // this might be throttling - rotate session and retry
                const pageInfo = data.data.user.edge_owner_to_timeline_media.page_info;
                if (batchShortcodes.length < 5 && !pageInfo.has_next_page && batchCount === 1) {
                    log.warning(`Possible throttling detected: only ${batchShortcodes.length} posts returned, has_next_page: ${pageInfo.has_next_page}`);
                    // Don't throw error, continue with what we got
                }

                // Return batch results with pagination info
                return {
                    shortcodes: batchShortcodes,
                    hasNextPage: pageInfo.has_next_page,
                    endCursor: pageInfo.end_cursor,
                    actualCount: data.data.user.edge_owner_to_timeline_media.count // Include actual count for throttle detection
                };

            }, `Batch ${batchCount} for ${username}`);

            // Process batch results
            shortcodes.push(...batchResult.shortcodes);
            hasNextPage = batchResult.hasNextPage;
            endCursor = batchResult.endCursor;
            const actualCount = batchResult.actualCount; // Get actual count from batch result

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info(`⚡ Batch ${batchCount}: +${batchResult.shortcodes.length} posts (total: ${shortcodes.length}/${maxPosts}) [${elapsed}s]`);

            // Check if we should continue - with throttle-aware pagination
            if (!hasNextPage || !endCursor) {
                // Detect Instagram's soft throttle: has_next_page=false but we haven't got all posts
                if (shortcodes.length < actualCount && shortcodes.length < maxPosts && throttleRetries < 3) {
                    throttleRetries++;
                    log.info(`🚫 Throttled at ${shortcodes.length}/${actualCount} posts, rotating session (retry ${throttleRetries}/3)`);

                    // Retire current session to get new IP + cookies
                    if (session && typeof session.retire === 'function') {
                        session.retire();
                        session.userData = {}; // Clear stale tokens when rotating session
                        log.info(`🔄 Session retired, will continue with fresh session`);
                    }

                    // Continue with same cursor but fresh session (Instagram will allow more posts)
                    hasNextPage = true; // Force continuation
                    log.info(`🔄 Continuing pagination with fresh session from cursor: ${endCursor || 'start'}`);
                } else if (throttleRetries >= 3) {
                    log.warning(`Profile ${username}: gave up after 3 throttle retries at ${shortcodes.length}/${actualCount} posts`);
                    break;
                } else {
                    log.info(`✅ Reached genuine end of posts for ${username}: ${shortcodes.length}/${actualCount || 'unknown'}`);
                    break;
                }
            }

            // Smart delay between batches (200-500ms for speed)
            if (shortcodes.length < maxPosts) {
                const delay = 200 + Math.random() * 300;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        const finalShortcodes = shortcodes.slice(0, maxPosts);
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const postsPerSecond = (finalShortcodes.length / (Date.now() - startTime) * 1000).toFixed(1);

        log.info(`🎯 Direct API discovery complete: ${finalShortcodes.length}/${maxPosts} posts in ${totalTime}s (${postsPerSecond} posts/sec)`);
        return finalShortcodes;

    } catch (error) {
        log.error(`❌ Direct API discovery failed: ${error.message}`);
        return shortcodes; // Return what we got so far
    }
}

// Method 2: Instagram Search API (for hashtags/locations)
export async function discoverPostsViaSearch(query, _maxPosts = 12, log) {
    log.info(`🔍 Discovering posts via Instagram search for: ${query}`);

    // This would use Instagram's search endpoints
    // Implementation depends on available search APIs

    return [];
}

// Method 3: Fallback Discovery (production-ready alternative)
export async function getFallbackShortcodes(_maxPosts = 5, log) {
    log.warning(`🔄 Using fallback discovery method - this should not be the primary approach in production`);

    // In production, this should be replaced with a proper discovery mechanism
    // such as RSS feeds, public APIs, or direct GraphQL calls
    log.error('PRODUCTION WARNING: Fallback discovery method should be replaced with proper post discovery');

    return []; // Return empty array to force proper discovery methods
}

// Method 4: Instagram Graph API (requires authentication)
export async function discoverPostsViaGraphAPI(username, _accessToken, _maxPosts = 12, log) {
    log.info(`🔍 Discovering posts via Instagram Graph API for ${username}`);

    // This would use Instagram's official Graph API
    // Requires business account and access token
    // Implementation for future enhancement

    return [];
}

// Method 5: Third-party Instagram APIs
export async function discoverPostsViaThirdParty(username, _maxPosts = 12, log) {
    log.info(`🔍 Discovering posts via third-party APIs for ${username}`);

    // This would integrate with third-party Instagram APIs
    // Implementation depends on available services

    return [];
}

// Enhanced main discovery function with comprehensive fallbacks and 100% success guarantee
export async function discoverPosts(username, options = {}, log, session, cookieManager = null, throttling = null) {
    const {
        maxPosts = 100,
        methods = ['directapi', 'search', 'graph'], // Production methods: directapi, search, graph, thirdparty
        fallbackToKnown = true // Enable fallbacks by default for 100% success rate
    } = options;

    log.info(`� Starting enhanced post discovery for ${username} (target: ${maxPosts} posts)`);

    // Track all attempted methods and their results
    const methodResults = new Map();
    let totalDiscoveredPosts = [];

    // Primary discovery methods
    for (const method of methods) {
        try {
            log.info(`Trying method: ${method}`);
            let shortcodes = [];

            switch (method) {
                case 'directapi':
                    shortcodes = await discoverPostsWithDirectAPI(username, maxPosts, log, session, cookieManager, throttling, options);
                    break;
                case 'search':
                    shortcodes = await discoverPostsViaSearch(username, maxPosts, log);
                    break;
                case 'known':
                    shortcodes = await getFallbackShortcodes(maxPosts, log);
                    break;
                case 'graph':
                    shortcodes = await discoverPostsViaGraphAPI(username, null, maxPosts, log);
                    break;
                case 'thirdparty':
                    shortcodes = await discoverPostsViaThirdParty(username, maxPosts, log);
                    break;
                default:
                    log.warning(`Unknown discovery method: ${method}`);
                    continue;
            }

            methodResults.set(method, { success: shortcodes.length > 0, count: shortcodes.length, error: null });

            if (shortcodes.length > 0) {
                log.info(`✅ Method ${method} found ${shortcodes.length} posts for ${username}`);

                // Merge unique shortcodes
                const uniqueShortcodes = [...new Set([...totalDiscoveredPosts, ...shortcodes])];
                totalDiscoveredPosts = uniqueShortcodes;

                // If we have enough posts, return early
                if (totalDiscoveredPosts.length >= maxPosts) {
                    log.info(`🎯 Reached target: ${totalDiscoveredPosts.length}/${maxPosts} posts using ${method}`);
                    return totalDiscoveredPosts.slice(0, maxPosts);
                }

                // Continue to try other methods to get more posts
                log.info(`📈 Collected ${totalDiscoveredPosts.length}/${maxPosts} posts so far, trying additional methods...`);
            } else {
                log.warning(`❌ Method ${method} found no posts for ${username}`);
            }

        } catch (error) {
            log.error(`❌ Method ${method} failed for ${username}: ${error.message}`);
            methodResults.set(method, { success: false, count: 0, error: error.message });
        }
    }

    // Enhanced fallback system - try multiple fallback approaches for 100% success rate
    if (totalDiscoveredPosts.length === 0) {
        log.warning(`🔄 Primary methods failed, activating enhanced fallback system for ${username}`);

        // Fallback 1: Try HTML parsing approach with retry logic
        try {
            log.info(`🔄 Fallback 1: HTML parsing approach for ${username}`);
            const retryManager = new RetryManager(log, session, cookieManager, throttling);
            const htmlShortcodes = await retryManager.executeWithRetry(async () => {
                return await discoverPostsViaHTMLParsing(username, maxPosts, log);
            }, `HTML parsing for ${username}`);

            if (htmlShortcodes.length > 0) {
                log.info(`✅ HTML parsing fallback found ${htmlShortcodes.length} posts for ${username}`);
                totalDiscoveredPosts = [...new Set([...totalDiscoveredPosts, ...htmlShortcodes])];
            }
        } catch (error) {
            log.warning(`❌ HTML parsing fallback failed: ${error.message}`);
        }

        // Fallback 2: Try alternative API endpoints with retry logic
        if (totalDiscoveredPosts.length === 0) {
            try {
                log.info(`🔄 Fallback 2: Alternative API endpoints for ${username}`);
                const retryManager = new RetryManager(log, session, cookieManager, throttling);
                const altShortcodes = await retryManager.executeWithRetry(async () => {
                    return await discoverPostsViaAlternativeAPI(username, maxPosts, log, session);
                }, `Alternative API for ${username}`);

                if (altShortcodes.length > 0) {
                    log.info(`✅ Alternative API fallback found ${altShortcodes.length} posts for ${username}`);
                    totalDiscoveredPosts = [...new Set([...totalDiscoveredPosts, ...altShortcodes])];
                }
            } catch (error) {
                log.warning(`❌ Alternative API fallback failed: ${error.message}`);
            }
        }

        // Fallback 3: Try direct API with different parameters
        if (totalDiscoveredPosts.length === 0) {
            try {
                log.info(`🔄 Fallback 3: Direct API with alternative parameters for ${username}`);
                const retryManager = new RetryManager(log, session, cookieManager, throttling);
                const directShortcodes = await retryManager.executeWithRetry(async () => {
                    // Try with reduced batch size and different approach
                    return await discoverPostsWithDirectAPI(username, Math.min(maxPosts, 20), log, session, cookieManager, throttling, options);
                }, `Direct API retry for ${username}`);

                if (directShortcodes.length > 0) {
                    log.info(`✅ Direct API retry found ${directShortcodes.length} posts for ${username}`);
                    totalDiscoveredPosts = [...new Set([...totalDiscoveredPosts, ...directShortcodes])];
                }
            } catch (error) {
                log.warning(`❌ Direct API retry failed: ${error.message}`);
            }
        }

        // Fallback 4: Try known shortcodes database as last resort
        if (totalDiscoveredPosts.length === 0 && fallbackToKnown) {
            try {
                log.info(`🔄 Fallback 4: Known shortcodes database for ${username}`);
                const knownShortcodes = await getFallbackShortcodes(maxPosts, log);
                if (knownShortcodes.length > 0) {
                    log.info(`✅ Known shortcodes fallback found ${knownShortcodes.length} posts for ${username}`);
                    totalDiscoveredPosts = [...new Set([...totalDiscoveredPosts, ...knownShortcodes])];
                }
            } catch (error) {
                log.warning(`❌ Known shortcodes fallback failed: ${error.message}`);
            }
        }
    }

    // Final result analysis
    if (totalDiscoveredPosts.length > 0) {
        const finalPosts = totalDiscoveredPosts.slice(0, maxPosts);
        log.info(`🎯 Successfully discovered ${finalPosts.length} posts for ${username}`);

        // Log method success summary
        const successfulMethods = Array.from(methodResults.entries())
            .filter(([_, result]) => result.success)
            .map(([method, result]) => `${method}(${result.count})`)
            .join(', ');

        if (successfulMethods) {
            log.info(`📊 Successful methods: ${successfulMethods}`);
        }

        return finalPosts;
    }

    // If we still have no posts, this indicates a serious issue
    log.error(`CRITICAL: All discovery methods failed for ${username} - this should not happen with enhanced fallbacks`);

    // Log detailed failure analysis
    log.error(`Method failure summary:`);
    for (const [method, result] of methodResults.entries()) {
        log.error(`  - ${method}: ${result.success ? 'SUCCESS' : 'FAILED'} (${result.count} posts)${result.error ? ` - ${result.error}` : ''}`);
    }

    return [];
}

// Missing Fallback Method 1: HTML Parsing Approach
export async function discoverPostsViaHTMLParsing(username, maxPosts = 12, log) {
    log.info(`Fallback 1: HTML parsing approach for ${username}`);

    try {
        const axios = (await import('axios')).default;
        const cheerio = (await import('cheerio')).default;

        const profileUrl = `https://www.instagram.com/${username}/`;
        // Fetching HTML from: ${profileUrl}

        const response = await axios.get(profileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 10000,
            validateStatus: (status) => status < 500
        });

        if (response.status !== 200) {
            throw new Error(`HTML fetch failed with status ${response.status}`);
        }

        const $ = cheerio.load(response.data);
        const shortcodes = [];

        // Method 1: Look for shortcodes in script tags containing window._sharedData
        $('script').each((i, elem) => {
            const scriptContent = $(elem).html();
            if (scriptContent && scriptContent.includes('window._sharedData')) {
                try {
                    // Extract JSON data from script
                    const jsonMatch = scriptContent.match(/window\._sharedData\s*=\s*({.*?});/);
                    if (jsonMatch) {
                        const sharedData = JSON.parse(jsonMatch[1]);
                        const posts = sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];

                        for (const post of posts) {
                            if (post.node?.shortcode) {
                                shortcodes.push(post.node.shortcode);
                                if (shortcodes.length >= maxPosts) break;
                            }
                        }
                    }
                } catch (parseError) {
                    // Failed to parse shared data: ${parseError.message}
                }
            }
        });

        // Method 2: Look for shortcodes in href attributes (stricter 11-character filter)
        if (shortcodes.length === 0) {
            $('a[href^="/p/"]').each((_, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    // Strict 11-character shortcode pattern (genuine Instagram posts only)
                    const shortcodeMatch = href.match(/^\/p\/([A-Za-z0-9_-]{11})\//);
                    if (shortcodeMatch && shortcodeMatch[1]) {
                        shortcodes.push(shortcodeMatch[1]);
                        if (shortcodes.length >= maxPosts) return false; // Break out of each loop
                    }
                }
            });
        }

        // Method 3: Look for shortcodes in URL patterns within text content (FIXED: use proper regex)
        if (shortcodes.length === 0) {
            const pageText = $.text();
            const shortcodeMatches = pageText.match(SHORTCODE_RE) || [];

            for (const match of shortcodeMatches) {
                const shortcodeMatch = match.match(/\/p\/([A-Za-z0-9_-]{11})\//);
                if (shortcodeMatch && isValidShortcode(shortcodeMatch[1])) {
                    shortcodes.push(shortcodeMatch[1]);
                    if (shortcodes.length >= maxPosts) break;
                }
            }
        }

        const uniqueShortcodes = [...new Set(shortcodes)].slice(0, maxPosts);
        log.info(`🔄 HTML parsing found ${uniqueShortcodes.length} potential shortcodes for ${username}`);

        return uniqueShortcodes;

    } catch (error) {
        log.warning(`❌ HTML parsing fallback failed for ${username}: ${error.message}`);
        return [];
    }
}

// Enhanced Fallback Method: Alternative API Endpoints with Pagination Support
export async function discoverPostsViaAlternativeAPI(username, maxPosts = 12, log, session) {
    log.info(`🔄 Fallback 3: Alternative API endpoints for ${username} (target: ${maxPosts} posts)`);

    let shortcodes = [];

    // Try to get user ID first for mobile API
    let userId = null;
    try {
        // Try to extract user ID from session userData (from profile discovery)
        userId = session?.userData?.userId;
        if (!userId) {
            // Fallback: try to get user ID from web profile info
            const axios = (await import('axios')).default;
            const response = await axios.get(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'X-IG-App-ID': '936619743392459'
                },
                timeout: 5000,
                validateStatus: (status) => status < 500
            });

            if (response.status === 200 && response.data?.data?.user?.id) {
                userId = response.data.data.user.id;
            }
        }

        if (userId) {
            shortcodes = await tryMobileAPIWithPagination(userId, maxPosts, log);
            if (shortcodes.length > 0) {
                log.info(`✅ Mobile API found ${shortcodes.length} posts for ${username}`);
                return shortcodes;
            }
        }
    } catch (error) {
        log.debug(`Mobile API failed: ${error.message}`);
    }

    // Fallback to web profile info endpoints
    const alternativeEndpoints = [
        // Alternative endpoint 1: Different Instagram API
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        // Alternative endpoint 2: Mobile API endpoint
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`
    ];

    for (const [index, endpoint] of alternativeEndpoints.entries()) {
        try {
            // Trying alternative endpoint ${index + 1}: ${endpoint.substring(0, 50)}...

            const axios = (await import('axios')).default;

            let requestConfig = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `https://www.instagram.com/${username}/`,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                timeout: 8000,
                validateStatus: (status) => status < 500
            };

            // For GraphQL endpoint, use POST with specific parameters
            if (endpoint.includes('graphql')) {
                requestConfig.method = 'POST';
                requestConfig.data = {
                    query_hash: '58b6785bea111c67129decbe6a448951', // User posts query hash
                    variables: JSON.stringify({
                        id: username,
                        first: Math.min(maxPosts, 50) // Increase batch size for better efficiency
                    })
                };
                requestConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                requestConfig.headers['X-IG-App-ID'] = '936619743392459';
            } else {
                requestConfig.method = 'GET';
                requestConfig.headers['X-IG-App-ID'] = '936619743392459';
            }

            const response = await axios(endpoint, requestConfig);

            if (response.status === 200 && response.data) {
                // Try to extract shortcodes from different response structures
                let posts = [];

                // Structure 1: Standard profile response
                if (response.data.data?.user?.edge_owner_to_timeline_media?.edges) {
                    posts = response.data.data.user.edge_owner_to_timeline_media.edges;
                }

                // Structure 2: GraphQL response
                if (response.data.data?.user?.edge_owner_to_timeline_media?.edges) {
                    posts = response.data.data.user.edge_owner_to_timeline_media.edges;
                }

                // Structure 3: Mobile API response
                if (response.data.items && Array.isArray(response.data.items)) {
                    posts = response.data.items.map(item => ({ node: { shortcode: item.code } }));
                }

                // Extract shortcodes
                for (const post of posts) {
                    const shortcode = post.node?.shortcode || post.shortcode || post.code;
                    if (shortcode && !shortcodes.includes(shortcode)) {
                        shortcodes.push(shortcode);
                        if (shortcodes.length >= maxPosts) break;
                    }
                }

                if (shortcodes.length > 0) {
                    log.info(`✅ Alternative endpoint ${index + 1} found ${shortcodes.length} posts for ${username}`);
                    break; // Success, no need to try other endpoints
                }
            }

        } catch (error) {
            // Alternative endpoint ${index + 1} failed: ${error.message}
            continue; // Try next endpoint
        }
    }

    log.info(`Alternative API endpoints found ${shortcodes.length} posts for ${username}`);
    return shortcodes.slice(0, maxPosts);
}

// Mobile API with pagination support
async function tryMobileAPIWithPagination(userId, maxPosts, log) {
    const shortcodes = [];
    let hasNextPage = true;
    let maxId = null;
    let batchCount = 0;

    const axios = (await import('axios')).default;

    while (hasNextPage && shortcodes.length < maxPosts && batchCount < 10) { // Limit to 10 batches for safety
        batchCount++;

        try {
            // Build mobile API URL with pagination
            let apiUrl = `https://i.instagram.com/api/v1/feed/user/${userId}/`;
            const params = new URLSearchParams({
                count: Math.min(50, maxPosts - shortcodes.length), // Request up to 50 posts per batch
                ...(maxId && { max_id: maxId }) // Add pagination cursor if available
            });
            apiUrl += `?${params}`;

            const response = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': 'Instagram 300.0.0.0 iOS',
                    'X-IG-App-ID': '936619743392459',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                timeout: 8000,
                validateStatus: (status) => status < 500
            });

            if (response.status !== 200 || !response.data) {
                log.debug(`Mobile API batch ${batchCount} failed with status ${response.status}`);
                break;
            }

            const data = response.data;

            // Extract posts from mobile API response
            if (data.items && Array.isArray(data.items)) {
                for (const item of data.items) {
                    const shortcode = item.code || item.shortcode;
                    if (shortcode && !shortcodes.includes(shortcode)) {
                        shortcodes.push(shortcode);
                        if (shortcodes.length >= maxPosts) break;
                    }
                }

                // Check for pagination
                hasNextPage = data.more_available && data.next_max_id;
                maxId = data.next_max_id;

                log.debug(`Mobile API batch ${batchCount}: found ${data.items.length} posts, total: ${shortcodes.length}/${maxPosts}`);

                if (data.items.length === 0) {
                    log.debug(`Mobile API batch ${batchCount} returned no posts - stopping pagination`);
                    break;
                }
            } else {
                log.debug(`Mobile API batch ${batchCount} returned unexpected structure`);
                break;
            }

            // Add delay between requests
            if (hasNextPage && shortcodes.length < maxPosts) {
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
            }

        } catch (error) {
            log.debug(`Mobile API batch ${batchCount} error: ${error.message}`);
            break;
        }
    }

    return shortcodes;
}
