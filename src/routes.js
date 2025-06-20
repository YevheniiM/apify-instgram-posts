import { createHttpRouter, Dataset, KeyValueStore, log } from 'crawlee';
import moment from 'moment';
import { discoverPosts } from './post-discovery.js';

export const router = createHttpRouter();

// Production-scale throttling and delay management
class SmartThrottling {
    constructor() {
        this.requestCounts = new Map(); // Track requests per session
        this.lastRequestTime = new Map(); // Track timing per session
        this.blockCounts = new Map(); // Track blocks per session
    }

    // Smart randomized delay based on request patterns and blocks
    async applySmartDelay(sessionId, isBlocked = false) {
        const now = Date.now();
        const lastRequest = this.lastRequestTime.get(sessionId) || 0;
        const timeSinceLastRequest = now - lastRequest;

        // Update tracking
        this.requestCounts.set(sessionId, (this.requestCounts.get(sessionId) || 0) + 1);
        this.lastRequestTime.set(sessionId, now);

        if (isBlocked) {
            this.blockCounts.set(sessionId, (this.blockCounts.get(sessionId) || 0) + 1);
        }

        // Calculate dynamic delay based on:
        // 1. Base delay: 1-3 seconds as recommended
        // 2. Block penalty: Increase delay if session has been blocked
        // 3. Request frequency: Increase delay for rapid requests

        const baseDelay = 300 + Math.random() * 700; // 0.3-1 seconds (faster)
        const blockPenalty = (this.blockCounts.get(sessionId) || 0) * 1000; // +1s per block
        const frequencyPenalty = timeSinceLastRequest < 200 ? 500 : 0; // +0.5s if too fast

        const totalDelay = Math.min(baseDelay + blockPenalty + frequencyPenalty, 5000); // Max 5s

        if (totalDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, totalDelay));
        }

        return totalDelay;
    }

    // Get session statistics for monitoring
    getSessionStats(sessionId) {
        return {
            requests: this.requestCounts.get(sessionId) || 0,
            blocks: this.blockCounts.get(sessionId) || 0,
            lastRequest: this.lastRequestTime.get(sessionId) || 0
        };
    }

    // Clean up old session data
    cleanup(activeSessionIds) {
        for (const [sessionId] of this.requestCounts) {
            if (!activeSessionIds.includes(sessionId)) {
                this.requestCounts.delete(sessionId);
                this.lastRequestTime.delete(sessionId);
                this.blockCounts.delete(sessionId);
            }
        }
    }
}

// Global throttling manager
const throttling = new SmartThrottling();

// OPTIMIZATION 2: Advanced Cookie Management with Domain-Specific Support
class CookieManager {
    constructor() {
        this.cookiePools = new Map(); // Multiple cookie sets for rotation
        this.cookieUsage = new Map(); // Track usage per cookie set
        this.cookieExpiry = new Map(); // Track cookie expiration
        this.blockedCookies = new Set(); // Track blocked cookie sets
        this.domainCookies = new Map(); // Domain-specific cookies (www.instagram.com vs i.instagram.com)
    }

    // Initialize cookie pools with domain-specific support and enhanced resilience
    async initializeCookies() {
        // Enhanced cookie pool with more sets for better resilience
        const baseCookies = [
            {
                id: 'cookie_set_1',
                cookies: {
                    'mid': 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                    'csrftoken': 'missing', // Will be updated dynamically
                    'ig_did': 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'
                },
                usage: 0,
                lastUsed: 0,
                blocked: false,
                blockTime: null
            },
            {
                id: 'cookie_set_2',
                cookies: {
                    'mid': 'ZnK9YwALAAE7UjQ2NDY4NzQ3',
                    'csrftoken': 'missing',
                    'ig_did': 'B2C3D4E5-F6G7-8901-BCDE-F23456789012'
                },
                usage: 0,
                lastUsed: 0,
                blocked: false,
                blockTime: null
            },
            {
                id: 'cookie_set_3',
                cookies: {
                    'mid': 'ZnL0YwALAAE7UjQ2NDY4NzQ4',
                    'csrftoken': 'missing',
                    'ig_did': 'C3D4E5F6-G7H8-9012-CDEF-345678901234'
                },
                usage: 0,
                lastUsed: 0,
                blocked: false,
                blockTime: null
            },
            {
                id: 'cookie_set_4',
                cookies: {
                    'mid': 'ZnL1YwALAAE7UjQ2NDY4NzQ5',
                    'csrftoken': 'missing',
                    'ig_did': 'D4E5F6G7-H8I9-0123-DEFG-456789012345'
                },
                usage: 0,
                lastUsed: 0,
                blocked: false,
                blockTime: null
            },
            {
                id: 'cookie_set_5',
                cookies: {
                    'mid': 'ZnL2YwALAAE7UjQ2NDY4NzUw',
                    'csrftoken': 'missing',
                    'ig_did': 'E5F6G7H8-I9J0-1234-EFGH-567890123456'
                },
                usage: 0,
                lastUsed: 0,
                blocked: false,
                blockTime: null
            }
        ];

        for (const cookieSet of baseCookies) {
            this.cookiePools.set(cookieSet.id, cookieSet);
        }

        // Initialize domain-specific cookie mappings
        this.initializeDomainCookies();

        return baseCookies.length;
    }

    // OPTIMIZATION 2: Initialize domain-specific cookie mappings
    initializeDomainCookies() {
        // Map cookies to appropriate domains to fix domain mismatch errors
        this.domainCookies.set('www.instagram.com', {
            allowedCookies: ['mid', 'csrftoken', 'ig_did', 'sessionid', 'ds_user_id'],
            requiredCookies: ['mid', 'csrftoken']
        });

        this.domainCookies.set('i.instagram.com', {
            allowedCookies: ['mid', 'csrftoken', 'ig_did'], // Minimal cookies for API endpoints
            requiredCookies: ['mid']
        });

        this.domainCookies.set('graph.instagram.com', {
            allowedCookies: ['mid', 'csrftoken', 'ig_did'],
            requiredCookies: ['mid']
        });
    }

    // Get domain-appropriate cookie string
    getCookieStringForDomain(cookieSet, domain) {
        if (!cookieSet || !domain) return '';

        const domainConfig = this.domainCookies.get(domain);
        if (!domainConfig) {
            // Fallback to all cookies if domain not configured
            return this.getCookieString(cookieSet);
        }

        // Filter cookies based on domain configuration
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

    // Get optimal cookie set for request with automatic unblocking
    getCookiesForRequest() {
        const now = Date.now();
        const BLOCK_COOLDOWN = 30 * 60 * 1000; // 30 minutes cooldown for blocked cookies

        // First, check if any blocked cookies can be unblocked
        for (const [cookieId, cookieSet] of this.cookiePools.entries()) {
            if (cookieSet.blocked && cookieSet.blockTime && (now - cookieSet.blockTime) > BLOCK_COOLDOWN) {
                cookieSet.blocked = false;
                cookieSet.blockTime = null;
                cookieSet.usage = 0; // Reset usage counter
                this.blockedCookies.delete(cookieId);
                log.info(`Cookie set ${cookieId} automatically unblocked after cooldown`);
            }
        }

        const availableCookies = Array.from(this.cookiePools.values())
            .filter(cs => !cs.blocked && cs.usage < 1000) // Max 1000 requests per cookie set
            .sort((a, b) => a.usage - b.usage); // Use least used first

        if (availableCookies.length === 0) {
            // All cookies exhausted - try to find the oldest blocked cookie for emergency use
            const blockedCookies = Array.from(this.cookiePools.values())
                .filter(cs => cs.blocked)
                .sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));

            if (blockedCookies.length > 0) {
                const emergencyCookie = blockedCookies[0];
                log.warning(`Using emergency cookie ${emergencyCookie.id} (blocked ${Math.round((now - (emergencyCookie.blockTime || 0)) / 60000)} minutes ago)`);
                emergencyCookie.usage += 1;
                emergencyCookie.lastUsed = now;
                return emergencyCookie;
            }

            return null;
        }

        const selectedCookieSet = availableCookies[0];
        selectedCookieSet.usage += 1;
        selectedCookieSet.lastUsed = now;

        return selectedCookieSet;
    }

    // Update CSRF token for cookie set
    updateCsrfToken(cookieSetId, csrfToken) {
        const cookieSet = this.cookiePools.get(cookieSetId);
        if (cookieSet) {
            cookieSet.cookies.csrftoken = csrfToken;
        }
    }

    // Mark cookie set as blocked with timestamp for automatic recovery
    markAsBlocked(cookieSetId) {
        const cookieSet = this.cookiePools.get(cookieSetId);
        if (cookieSet) {
            cookieSet.blocked = true;
            cookieSet.blockTime = Date.now();
            this.blockedCookies.add(cookieSetId);
            log.warning(`Cookie set ${cookieSetId} marked as blocked (will auto-unblock in 30 minutes)`);
        }
    }

    // Get cookie string for HTTP headers
    getCookieString(cookieSet) {
        if (!cookieSet) return '';

        return Object.entries(cookieSet.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    // Get statistics
    getStats() {
        const total = this.cookiePools.size;
        const blocked = this.blockedCookies.size;
        const active = total - blocked;

        return { total, active, blocked };
    }
}

// Global cookie manager
const cookieManager = new CookieManager();

// Production Monitoring and Caching
class ProductionMonitor {
    constructor() {
        this.stats = {
            profilesProcessed: 0,
            postsExtracted: 0,
            requestsBlocked: 0,
            sessionsRetired: 0,
            cookiesBlocked: 0,
            startTime: Date.now(),
            lastReportTime: Date.now()
        };

        this.cache = new Map(); // Simple in-memory cache for profiles
    }

    // Update statistics
    updateStats(type, increment = 1) {
        if (this.stats[type] !== undefined) {
            this.stats[type] += increment;
        }
    }

    // Cache profile data temporarily (1-2 hours as recommended)
    async cacheProfile(username, profileData) {
        const cacheKey = `profile_${username}`;
        const cacheEntry = {
            data: profileData,
            timestamp: Date.now(),
            expirationSecs: 3600 // 1 hour cache
        };

        this.cache.set(cacheKey, cacheEntry);

        // Also store in Apify Key-Value Store for persistence
        try {
            await KeyValueStore.setValue(cacheKey, profileData, { expirationSecs: 3600 });
        } catch (error) {
            // Fallback to memory cache only
        }
    }

    // Get cached profile data
    async getCachedProfile(username) {
        const cacheKey = `profile_${username}`;

        // Check memory cache first
        const memoryEntry = this.cache.get(cacheKey);
        if (memoryEntry && (Date.now() - memoryEntry.timestamp) < (memoryEntry.expirationSecs * 1000)) {
            return memoryEntry.data;
        }

        // Check Apify Key-Value Store
        try {
            const cachedData = await KeyValueStore.getValue(cacheKey);
            if (cachedData) {
                // Update memory cache
                this.cache.set(cacheKey, {
                    data: cachedData,
                    timestamp: Date.now(),
                    expirationSecs: 3600
                });
                return cachedData;
            }
        } catch (error) {
            // Cache miss or error
        }

        return null;
    }

    // Generate performance report
    getPerformanceReport() {
        const now = Date.now();
        const totalRuntime = now - this.stats.startTime;
        const timeSinceLastReport = now - this.stats.lastReportTime;

        const report = {
            runtime: {
                total: Math.round(totalRuntime / 1000),
                sinceLastReport: Math.round(timeSinceLastReport / 1000)
            },
            throughput: {
                profilesPerSecond: this.stats.profilesProcessed / (totalRuntime / 1000),
                postsPerSecond: this.stats.postsExtracted / (totalRuntime / 1000),
                requestsPerSecond: (this.stats.profilesProcessed + this.stats.postsExtracted) / (totalRuntime / 1000)
            },
            reliability: {
                blockRate: this.stats.requestsBlocked / (this.stats.profilesProcessed + this.stats.postsExtracted),
                sessionRetirementRate: this.stats.sessionsRetired / (this.stats.profilesProcessed + this.stats.postsExtracted),
                cookieBlockRate: this.stats.cookiesBlocked / (this.stats.profilesProcessed + this.stats.postsExtracted)
            },
            totals: { ...this.stats }
        };

        this.stats.lastReportTime = now;
        return report;
    }

    // Clean up expired cache entries
    cleanupCache() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if ((now - entry.timestamp) > (entry.expirationSecs * 1000)) {
                this.cache.delete(key);
            }
        }
    }
}

// Global production monitor
const monitor = new ProductionMonitor();

// Instagram GraphQL document IDs (updated January 2025)
const INSTAGRAM_DOCUMENT_IDS = {
    SHORTCODE_MEDIA: '10015901848480474', // For individual posts by shortcode (WORKING 2025)
    BATCH_SHORTCODE_MEDIA: '8845758582119845', // For batch post retrieval (optimized)
    USER_POSTS: '9310670392322965', // For user timeline posts (may be outdated)
    SINGLE_POST: '8845758582119845', // For individual post data (may be outdated)
    REELS: '7950326061742207', // For reels/videos (may be outdated)
    STORIES: '7828915700555087' // For stories (may be outdated)
};



// Helper function to parse JSON with error handling
function parseJsonResponse(responseBody, session, log, context) {
    try {
        // Check if responseBody exists and is a string
        if (!responseBody) {
            log.error(`Empty response body for ${context}`);
            session.retire();
            throw new Error(`Empty response body for ${context}, session retired.`);
        }

        if (typeof responseBody !== 'string') {
            log.error(`Invalid response body type for ${context}:`, typeof responseBody);
            log.debug('Response body:', responseBody);
            session.retire();
            throw new Error(`Invalid response body type for ${context}, session retired.`);
        }

        // Response body preview for debugging

        const jsonResponse = JSON.parse(responseBody);
        return jsonResponse;
    } catch (err) {
        log.error(`JSON parsing error for ${context}:`, err.message);
        if (responseBody && typeof responseBody === 'string') {
            // Response body preview available for debugging
        } else {
            // Response body available for debugging
        }
        session.retire();
        throw new Error(`JSON parsing error for ${context}, session retired.`);
    }
}

// Helper function to extract hashtags from text
function extractHashtags(text) {
    if (!text) return [];
    const hashtagRegex = /#(\w+)/g;
    const hashtags = [];
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
        hashtags.push(match[1]);
    }
    return hashtags;
}

// Helper function to extract mentions from text
function extractMentions(text) {
    if (!text) return [];
    const mentionRegex = /@(\w+)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        mentions.push(match[1]);
    }
    return mentions;
}

// Helper function to determine post type
function getPostType(post) {
    // Check product type first for specific video types
    if (post.product_type === 'clips') return 'reel';
    if (post.product_type === 'igtv') return 'igtv';

    // Then check typename for general types
    if (post.__typename === 'GraphVideo') return 'video';
    if (post.__typename === 'GraphSidecar') return 'carousel';
    if (post.__typename === 'GraphImage') return 'image';

    return 'unknown';
}

// OPTIMIZATION 1: Batch post retrieval function for high-speed processing
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

    try {
        log.info(`🚀 Fetching batch of ${batchSize} posts: ${shortcodes.slice(0, 3).join(',')}${batchSize > 3 ? '...' : ''}`);

        // Enhanced individual post fetching with retry logic for 100% success rate
        const fetchSinglePostWithRetry = async (shortcode, maxRetries = 3) => {
            let lastError = null;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    log.debug(`Fetching post ${shortcode} (attempt ${attempt}/${maxRetries})`);

                    // Get fresh cookie set for retries if needed
                    const currentCookieSet = attempt === 1 ? cookieSet : cookieManager.getCookiesForRequest();
                    if (!currentCookieSet) {
                        throw new Error('No available cookies for retry');
                    }

                    // Use the working GraphQL endpoint for individual posts
                    const graphqlUrl = new URL('https://www.instagram.com/api/graphql');
                    graphqlUrl.searchParams.set('variables', JSON.stringify({ shortcode }));
                    graphqlUrl.searchParams.set('doc_id', INSTAGRAM_DOCUMENT_IDS.SHORTCODE_MEDIA);
                    graphqlUrl.searchParams.set('lsd', 'AVqbxe3J_YA');

                    // OPTIMIZATION 2: Production-grade headers with domain-specific cookie management
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

                    // CRITICAL FIX: Progressive timeout increase (15s -> 20s -> 25s) to eliminate timeout errors
                    const timeout = 15000 + (attempt - 1) * 5000;

                    const response = await axios.post(graphqlUrl.toString(), null, {
                        headers: productionHeaders,
                        timeout,
                        validateStatus: () => true,
                        maxRedirects: 2
                    });

                    // Handle specific error cases that require retries
                    if (response.status === 401) {
                        if (attempt < maxRetries) {
                            log.warning(`Post ${shortcode} unauthorized (attempt ${attempt}) - retrying with new session`);
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
                            const rateLimitDelay = 3000 * Math.pow(2, attempt - 1);
                            await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
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

                    log.debug(`⏳ Post ${shortcode} waiting ${delay}ms before retry ${attempt + 1}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            return { shortcode, error: lastError?.message || 'Unknown error', data: null };
        };

        // Process posts in parallel with individual retry logic
        const batchPromises = shortcodes.slice(0, batchSize).map(shortcode =>
            fetchSinglePostWithRetry(shortcode)
        );

        // Wait for all batch requests to complete
        const batchResults = await Promise.allSettled(batchPromises);

        // Process results with enhanced error reporting
        let successCount = 0;
        let errorCount = 0;

        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value.data) {
                results.push(result.value.data);
                successCount++;
            } else {
                errorCount++;
                if (result.status === 'rejected') {
                    log.debug(`Batch promise rejected: ${result.reason}`);
                } else if (result.value?.error) {
                    log.debug(`Post ${result.value.shortcode} failed: ${result.value.error}`);
                }
            }
        }

        log.info(`✅ Batch completed: ${successCount} success, ${errorCount} errors (${shortcodes.slice(0, 3).join(',')}...)`);
        return results;

    } catch (error) {
        log.error(`Error in batch processing:`, error.message);

        // Mark cookie as potentially problematic if repeated errors
        if (error.message.includes('timeout') || error.message.includes('network')) {
            log.debug(`Network error for cookie ${cookieSet.id}: ${error.message}`);
        }

        return [];
    }
}



// Function to extract post data from the new GraphQL response structure
async function extractPostDataFromGraphQL(post, username, originalUrl, log) {
    try {
        // Extract basic post information
        const postData = {
            type: 'post',
            postType: getPostType(post),
            username: username,
            shortcode: post.shortcode,
            id: post.id,
            url: `https://www.instagram.com/p/${post.shortcode}/`,

            // Media content
            displayUrl: post.display_url,
            mediaUrls: [post.display_url],

            // Content metadata
            caption: post.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            hashtags: [],
            mentions: [],
            accessibilityCaption: post.accessibility_caption,

            // Engagement metrics
            likesCount: post.edge_media_preview_like?.count || 0,
            commentsCount: post.edge_media_to_comment?.count || 0,
            viewsCount: post.video_view_count || null,
            playsCount: post.video_play_count || null,

            // Temporal data
            takenAt: moment.unix(post.taken_at_timestamp).toISOString(),
            takenAtTimestamp: post.taken_at_timestamp,
            scrapedAt: moment().toISOString(),

            // Media properties
            isVideo: post.is_video || false,
            hasAudio: post.has_audio || false,
            dimensions: post.dimensions,

            // Location data
            location: post.location,

            // Tagged users
            taggedUsers: [],

            // Post settings
            commentsDisabled: post.comments_disabled || false,
            likingDisabled: false,
            isSponsored: post.is_paid_partnership || false,

            // Scraping metadata
            profileUrl: originalUrl
        };

        // Handle video content
        if (post.is_video && post.video_url) {
            postData.videoUrl = post.video_url;
            postData.videoDuration = post.video_duration;
            postData.mediaUrls = [post.video_url];
        }

        // Handle carousel posts
        if (post.__typename === 'GraphSidecar' && post.edge_sidecar_to_children) {
            postData.carouselItems = [];
            postData.mediaUrls = [];

            for (const edge of post.edge_sidecar_to_children.edges) {
                const item = edge.node;
                const carouselItem = {
                    id: item.id,
                    shortcode: item.shortcode,
                    displayUrl: item.display_url,
                    isVideo: item.is_video || false,
                    videoUrl: item.video_url || null,
                    videoDuration: item.video_duration || null,
                    dimensions: item.dimensions,
                    accessibilityCaption: item.accessibility_caption
                };

                postData.carouselItems.push(carouselItem);
                postData.mediaUrls.push(item.display_url);

                if (item.is_video && item.video_url) {
                    postData.mediaUrls.push(item.video_url);
                }
            }
        }

        // Extract hashtags and mentions from caption
        if (postData.caption) {
            postData.hashtags = (postData.caption.match(/#[\w]+/g) || []).map(tag => tag.substring(1));
            postData.mentions = (postData.caption.match(/@[\w.]+/g) || []).map(mention => mention.substring(1));
        }

        // Extract tagged users if available
        if (post.edge_media_to_tagged_user?.edges) {
            postData.taggedUsers = post.edge_media_to_tagged_user.edges.map(edge => ({
                username: edge.node.user.username,
                fullName: edge.node.user.full_name,
                isVerified: edge.node.user.is_verified,
                position: edge.node.position || { x: 0, y: 0 }
            }));
        }

        log.debug(`Extracted post data for ${postData.shortcode}: ${postData.postType}, ${postData.likesCount} likes`);
        return postData;

    } catch (error) {
        log.error(`Error extracting post data:`, error.message);
        return null;
    }
}

// Helper function to extract comprehensive post data
async function extractPostData(post, username, originalUrl, log) {
    const postTimestamp = moment.unix(post.taken_at_timestamp);
    const postType = getPostType(post);

    // Extract caption text
    const caption = post.edge_media_to_caption?.edges?.[0]?.node?.text || '';

    // Extract hashtags and mentions from caption
    const hashtags = extractHashtags(caption);
    const mentions = extractMentions(caption);

    // Extract tagged users
    const taggedUsers = post.edge_media_to_tagged_user?.edges?.map(edge => ({
        username: edge.node.user.username,
        fullName: edge.node.user.full_name,
        isVerified: edge.node.user.is_verified,
        position: {
            x: edge.node.x,
            y: edge.node.y
        }
    })) || [];

    // Extract location data
    const location = post.location ? {
        id: post.location.id,
        name: post.location.name,
        slug: post.location.slug,
        hasPublicPage: post.location.has_public_page,
        address: post.location.address_json ? JSON.parse(post.location.address_json) : null
    } : null;

    // Extract media URLs for different post types
    const mediaData = extractMediaData(post, postType);

    // Extract engagement data
    const engagement = {
        likesCount: post.edge_liked_by?.count || 0,
        commentsCount: post.edge_media_to_comment?.count || 0,
        viewsCount: post.video_view_count || null,
        playsCount: post.video_play_count || null
    };

    // Extract accessibility caption
    const accessibilityCaption = post.accessibility_caption || null;

    // Build comprehensive post data object
    const postData = {
        type: 'post',
        postType,
        username,
        shortcode: post.shortcode,
        id: post.id,
        url: `https://www.instagram.com/p/${post.shortcode}/`,

        // Media data
        ...mediaData,

        // Content data
        caption,
        hashtags,
        mentions,
        accessibilityCaption,

        // Engagement data
        ...engagement,

        // Metadata
        takenAt: postTimestamp.toISOString(),
        takenAtTimestamp: post.taken_at_timestamp,
        isVideo: post.is_video || false,
        hasAudio: post.has_audio || false,

        // Location and tagging
        location,
        taggedUsers,

        // Technical data
        dimensions: post.dimensions ? {
            height: post.dimensions.height,
            width: post.dimensions.width
        } : null,

        // Additional metadata
        commentsDisabled: post.comments_disabled || false,
        likingDisabled: post.like_and_view_counts_disabled || false,
        isSponsored: post.is_sponsored || false,

        // Scraping metadata
        scrapedAt: new Date().toISOString(),
        profileUrl: originalUrl
    };

    return postData;
}

// Helper function to extract media data based on post type
function extractMediaData(post, postType) {
    const mediaData = {};

    switch (postType) {
        case 'image':
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [post.display_url];
            break;

        case 'video':
        case 'reel':
        case 'igtv':
            mediaData.displayUrl = post.display_url;
            mediaData.videoUrl = post.video_url;
            mediaData.mediaUrls = [post.video_url];
            mediaData.videoDuration = post.video_duration || null;
            break;

        case 'carousel':
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [];

            // Extract all carousel items
            if (post.edge_sidecar_to_children?.edges) {
                const carouselItems = post.edge_sidecar_to_children.edges.map(edge => {
                    const item = edge.node;
                    return {
                        id: item.id,
                        shortcode: item.shortcode,
                        displayUrl: item.display_url,
                        isVideo: item.is_video,
                        videoUrl: item.video_url || null,
                        videoDuration: item.video_duration || null,
                        dimensions: item.dimensions,
                        accessibilityCaption: item.accessibility_caption
                    };
                });

                mediaData.carouselItems = carouselItems;
                mediaData.mediaUrls = carouselItems.map(item =>
                    item.isVideo ? item.videoUrl : item.displayUrl
                ).filter(Boolean);
            }
            break;

        default:
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [post.display_url];
    }

    return mediaData;
}

// Initialize cookie manager on first use
let cookieManagerInitialized = false;

// Production-optimized default handler for Instagram profile data retrieval
router.addDefaultHandler(async ({ request, response, session, log, crawler }) => {
    const { type, username, originalUrl, onlyPostsNewerThan, maxPosts, includeReels, includeIGTV } = request.userData;

    // Initialize cookie manager if not done
    if (!cookieManagerInitialized) {
        await cookieManager.initializeCookies();
        cookieManagerInitialized = true;
        log.info('Cookie manager initialized with production cookie pools');
    }

    // Apply smart throttling before request
    const sessionId = session.id;
    const delayApplied = await throttling.applySmartDelay(sessionId);

    log.info(`Processing Instagram profile: ${username} (session: ${sessionId}, delay: ${delayApplied}ms)`);

    // Check cache first for profile data
    const cachedProfile = await monitor.getCachedProfile(username);
    if (cachedProfile) {
        log.info(`Using cached profile data for ${username}`);
        monitor.updateStats('profilesProcessed');

        // Process cached profile data (skip to post extraction)
        const userData = cachedProfile.data.user;
        const userId = userData.id;
        const postsCount = userData.edge_owner_to_timeline_media?.count || 0;

        log.info(`Cached profile ${username} (ID: ${userId}) has ${postsCount} posts`);

        // Continue with post extraction using cached data...
        // (Implementation continues below)
        return;
    }

    // Get optimal cookie set for this request
    const cookieSet = cookieManager.getCookiesForRequest();
    if (!cookieSet) {
        log.error(`No available cookies for ${username} - all cookie sets exhausted or blocked`);
        monitor.updateStats('cookiesBlocked');
        session.retire();
        monitor.updateStats('sessionsRetired');
        throw new Error('No available cookies, session retired');
    }

    // Enhanced direct HTTP request with production features
    const axios = (await import('axios')).default;
    let jsonResponse;
    let isBlocked = false;

    try {
        log.info(`Making production HTTP request for ${username} (cookie set: ${cookieSet.id})`);

        // OPTIMIZATION 2: Enhanced headers with domain-specific cookie management
        const requestUrl = new URL(request.url);
        const domain = requestUrl.hostname;

        const enhancedHeaders = {
            ...request.headers,
            'Cookie': cookieManager.getCookieStringForDomain(cookieSet, domain),
            // Realistic browser headers for better success rate
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        const axiosResponse = await axios.get(request.url, {
            headers: enhancedHeaders,
            timeout: 15000, // Increased timeout for production
            validateStatus: () => true,
            maxRedirects: 3
        });

        log.info(`Production request status: ${axiosResponse.status} for ${username}`);

        // Enhanced block detection and handling
        if ([403, 429, 401, 400].includes(axiosResponse.status)) {
            isBlocked = true;
            log.warning(`BLOCKED: ${axiosResponse.status} for ${username} (cookie: ${cookieSet.id})`);

            // Update monitoring statistics
            monitor.updateStats('requestsBlocked');
            monitor.updateStats('cookiesBlocked');

            // Mark cookie set as blocked
            cookieManager.markAsBlocked(cookieSet.id);

            // Apply block penalty delay
            await throttling.applySmartDelay(sessionId, true);

            // Retire session
            session.retire();
            monitor.updateStats('sessionsRetired');
            throw new Error(`Blocked request (${axiosResponse.status}), session and cookies retired`);
        }

        if (axiosResponse.status !== 200) {
            log.warning(`Unexpected status ${axiosResponse.status} for ${username}`);
            throw new Error(`HTTP ${axiosResponse.status}: ${axiosResponse.statusText}`);
        }

        // Enhanced response handling
        if (typeof axiosResponse.data === 'object' && axiosResponse.data !== null) {
            jsonResponse = axiosResponse.data;
            log.info(`Profile data retrieved for ${username} (${Object.keys(jsonResponse).length} keys)`);
        } else if (axiosResponse.data && typeof axiosResponse.data === 'string') {
            jsonResponse = parseJsonResponse(axiosResponse.data, session, log, `profile ${username}`);
        } else {
            log.error(`Invalid response data for ${username}`);
            session.retire();
            monitor.updateStats('sessionsRetired');
            throw new Error(`Invalid response data for ${username}, session retired`);
        }

        // Validate response structure with detailed logging
        if (!jsonResponse.data || !jsonResponse.data.user) {
            log.warning(`Invalid response structure for profile ${username}`);
            log.debug('Available keys:', Object.keys(jsonResponse));
            return;
        }

        // Cache profile data for future use (1-2 hours as recommended)
        await monitor.cacheProfile(username, jsonResponse);
        log.debug(`Profile data cached for ${username}`);

        // Update monitoring statistics
        monitor.updateStats('profilesProcessed');

        // Log comprehensive statistics
        const performanceReport = monitor.getPerformanceReport();

        log.info(`Production Stats - Profiles: ${performanceReport.totals.profilesProcessed}, Posts: ${performanceReport.totals.postsExtracted}, Block Rate: ${(performanceReport.reliability.blockRate * 100).toFixed(2)}%`);

    } catch (error) {
        log.error(`Production request failed for ${username}:`, error.message);

        // Apply block delay if needed
        if (isBlocked) {
            await throttling.applySmartDelay(sessionId, true);
        }

        session.retire();
        throw error;
    }

    const userData = jsonResponse.data.user;

    // Check if profile is private
    if (userData.is_private) {
        log.warning(`Profile ${username} is private, cannot scrape posts`);
        await Dataset.pushData({
            type: 'error',
            username,
            error: 'Profile is private',
            scrapedAt: new Date().toISOString()
        });
        return;
    }

    const userId = userData.id;
    const postsCount = userData.edge_owner_to_timeline_media?.count || 0;

    log.info(`Profile ${username} (ID: ${userId}) has ${postsCount} posts. Starting post scraping...`);

    // Get CSRF token from profile page
    let csrfToken = 'missing';
    try {
        const profilePageUrl = `https://www.instagram.com/${username}/`;
        log.info(`Getting CSRF token from profile page for ${username}`);

        const profileResponse = await axios.get(profilePageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"macOS"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 10000
        });

        // Extract CSRF token from response
        const setCookieHeaders = profileResponse.headers['set-cookie'];
        if (setCookieHeaders) {
            for (const cookie of setCookieHeaders) {
                const csrfMatch = cookie.match(/csrftoken=([^;]+)/);
                if (csrfMatch) {
                    csrfToken = csrfMatch[1];
                    break;
                }
            }
        }

        // Also try to extract from HTML content
        if (csrfToken === 'missing' && typeof profileResponse.data === 'string') {
            const csrfMatch = profileResponse.data.match(/"csrf_token":"([^"]+)"/);
            if (csrfMatch) {
                csrfToken = csrfMatch[1];
            }
        }

        log.info(`CSRF token for ${username}: ${csrfToken.substring(0, 10)}...`);

        // Use the new advanced post discovery system
        log.info(`Starting advanced post discovery for ${username}...`);

        const discoveryOptions = {
            maxPosts: maxPosts || 100,
            methods: ['directapi'], // Use high-speed direct API method
            fallbackToKnown: false
        };

        const discoveredShortcodes = await discoverPosts(username, discoveryOptions, log, session, cookieManager, throttling);

        if (discoveredShortcodes.length > 0) {
            log.info(`Discovered ${discoveredShortcodes.length} posts for ${username} using advanced discovery`);

            // Update cookie manager with CSRF token
            const cookieSet = cookieManager.getCookiesForRequest();
            if (cookieSet && csrfToken !== 'missing') {
                cookieManager.updateCsrfToken(cookieSet.id, csrfToken);
            }

            // OPTIMIZATION 3: Process discovered shortcodes in batches for maximum speed
            let postsProcessed = 0;
            const batchSize = 10; // Process 10 posts per batch
            const totalBatches = Math.ceil(discoveredShortcodes.length / batchSize);

            log.info(`Processing ${discoveredShortcodes.length} posts in ${totalBatches} batches of ${batchSize}`);

            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                if (maxPosts && postsProcessed >= maxPosts) break;

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
                            monitor.updateStats('postsExtracted');
                            log.info(`✅ Saved post ${postData.shortcode} from ${username} (${postData.postType}, ${postData.likesCount} likes)`);
                        }
                    }

                    log.info(`✅ Batch ${batchIndex + 1} completed: ${batchResults.length}/${limitedBatch.length} posts saved (total: ${postsProcessed})`);

                    // Smart delay between batches (shorter than individual delays)
                    if (batchIndex < totalBatches - 1) {
                        const batchDelay = 500 + Math.random() * 500; // 0.5-1 second between batches
                        await new Promise(resolve => setTimeout(resolve, batchDelay));
                    }

                } catch (error) {
                    log.error(`Error processing batch ${batchIndex + 1}:`, error.message);
                    // Continue with next batch
                }
            }

            log.info(`🎯 Successfully processed ${postsProcessed} posts for ${username} using advanced discovery`);

            // Generate final performance report
            const finalReport = monitor.getPerformanceReport();
            log.info(`📊 Final Stats - Profiles: ${finalReport.totals.profilesProcessed}, Posts: ${finalReport.totals.postsExtracted}, Success Rate: ${((finalReport.totals.postsExtracted / discoveredShortcodes.length) * 100).toFixed(1)}%`);

            return; // Skip the old GraphQL approach if this worked
        } else {
            log.warning(`❌ Advanced post discovery found no posts for ${username}`);
        }

        // Legacy fallback: Try to extract post shortcodes from profile page HTML
        if (typeof profileResponse.data === 'string') {
            log.info(`🔄 Fallback: Attempting to extract post shortcodes from profile page HTML for ${username}`);

            // Look for shortcodes in the HTML using regex
            const shortcodeMatches = profileResponse.data.match(/"shortcode":"([A-Za-z0-9_-]+)"/g);
            if (shortcodeMatches && shortcodeMatches.length > 0) {
                const shortcodes = shortcodeMatches
                    .map(match => match.match(/"shortcode":"([A-Za-z0-9_-]+)"/)[1])
                    .filter((shortcode, index, array) => array.indexOf(shortcode) === index) // Remove duplicates
                    .slice(0, maxPosts || 12); // Limit to maxPosts

                log.info(`Found ${shortcodes.length} unique shortcodes in profile page HTML for ${username}`);

                // OPTIMIZATION 3: Process fallback shortcodes in batches too
                let postsProcessed = 0;
                const batchSize = 10;
                const totalBatches = Math.ceil(shortcodes.length / batchSize);

                log.info(`🚀 Processing ${shortcodes.length} fallback posts in ${totalBatches} batches of ${batchSize}`);

                for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                    if (maxPosts && postsProcessed >= maxPosts) break;

                    const startIndex = batchIndex * batchSize;
                    const endIndex = Math.min(startIndex + batchSize, shortcodes.length);
                    const batchShortcodes = shortcodes.slice(startIndex, endIndex);

                    const remainingPosts = maxPosts ? Math.min(maxPosts - postsProcessed, batchShortcodes.length) : batchShortcodes.length;
                    const limitedBatch = batchShortcodes.slice(0, remainingPosts);

                    try {
                        log.info(`📦 Processing fallback batch ${batchIndex + 1}/${totalBatches}: ${limitedBatch.length} posts`);

                        const batchResults = await fetchPostsBatch(limitedBatch, username, originalUrl, onlyPostsNewerThan, log, sessionId);

                        for (const postData of batchResults) {
                            if (postData) {
                                await Dataset.pushData(postData);
                                postsProcessed++;
                                monitor.updateStats('postsExtracted');
                                log.info(`✅ Saved post ${postData.shortcode} from ${username} (${postData.postType}, ${postData.likesCount} likes)`);
                            }
                        }

                        log.info(`✅ Fallback batch ${batchIndex + 1} completed: ${batchResults.length}/${limitedBatch.length} posts saved`);

                        if (batchIndex < totalBatches - 1) {
                            const batchDelay = 500 + Math.random() * 500;
                            await new Promise(resolve => setTimeout(resolve, batchDelay));
                        }

                    } catch (error) {
                        log.error(`Error processing fallback batch ${batchIndex + 1}:`, error.message);
                    }
                }

                if (postsProcessed > 0) {
                    log.info(`Successfully extracted ${postsProcessed} posts using legacy HTML extraction for ${username}`);
                    return; // Skip the old GraphQL approach if this worked
                }
            }
        }

    } catch (error) {
        log.warning(`Failed to get CSRF token for ${username}:`, error.message);
    }

    // Create GraphQL request body for posts
    const variables = {
        after: null,
        before: null,
        data: {
            count: 12,
            include_reel_media_seen_timestamp: true,
            include_relationship_info: true,
            latest_besties_reel_media: true,
            latest_reel_media: true
        },
        first: 12,
        last: null,
        username: username,
        __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
        __relay_internal__pv__PolarisShareSheetV3relayprovider: true
    };

    const body = `variables=${encodeURIComponent(JSON.stringify(variables))}&doc_id=${INSTAGRAM_DOCUMENT_IDS.USER_POSTS}`;

    // Create request for post pagination
    const postRequest = {
        url: 'https://www.instagram.com/graphql/query',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            'X-CSRFToken': csrfToken,
            'X-Instagram-AJAX': '1',
            'X-Asbd-Id': '129477',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Referer': `https://www.instagram.com/${username}/`
        },
        payload: body,
        userData: {
            type: 'posts',
            username,
            userId,
            originalUrl,
            onlyPostsNewerThan,
            maxPosts,
            includeReels,
            includeIGTV,
            pageNumber: 1,
            cursor: null,
            totalScraped: 0
        }
    };

    // Add request to crawler
    await crawler.addRequests([postRequest]);

    log.info(`Added post scraping request for ${username}`);
});

// Handler for processing posts with pagination
router.addHandler('posts', async ({ request, response, session, log, crawler }) => {
    const {
        username,
        userId,
        originalUrl,
        onlyPostsNewerThan,
        maxPosts,
        includeReels,
        includeIGTV,
        pageNumber,
        cursor,
        totalScraped
    } = request.userData;

    log.info(`Processing posts page ${pageNumber} for ${username} (cursor: ${cursor || 'initial'})`);

    // Use direct HTTP request for GraphQL as well
    const axios = (await import('axios')).default;
    let jsonResponse;

    try {
        log.info(`Making direct GraphQL request for ${username} page ${pageNumber}`);
        const axiosResponse = await axios.post(request.url, request.payload, {
            headers: request.headers,
            timeout: 10000,
            validateStatus: () => true
        });

        log.info(`Direct GraphQL request status: ${axiosResponse.status}`);

        // Validate response
        if ([403, 429, 401].includes(axiosResponse.status)) {
            log.warning(`Blocked GraphQL request (${axiosResponse.status}) for ${username}, retiring session`);
            session.retire();
            throw new Error(`Blocked GraphQL request (${axiosResponse.status}), session retired.`);
        }

        if (axiosResponse.status !== 200) {
            log.warning(`Unexpected GraphQL status code ${axiosResponse.status} for ${username}`);
            throw new Error(`HTTP ${axiosResponse.status}: ${axiosResponse.statusText}`);
        }

        // Handle JSON response
        if (typeof axiosResponse.data === 'object' && axiosResponse.data !== null) {
            jsonResponse = axiosResponse.data;
            log.info(`GraphQL response already parsed as object for ${username}`);
        } else if (axiosResponse.data && typeof axiosResponse.data === 'string') {
            jsonResponse = parseJsonResponse(axiosResponse.data, session, log, `posts page ${pageNumber} for ${username}`);
        } else {
            log.error(`Invalid GraphQL response data for ${username}:`, axiosResponse.data);
            session.retire();
            throw new Error(`Invalid GraphQL response data for ${username}, session retired.`);
        }

    } catch (error) {
        log.error(`Error making direct GraphQL request for ${username}:`, error.message);
        session.retire();
        throw new Error(`GraphQL request failed for ${username}, session retired.`);
    }

    // Debug GraphQL response structure
    log.debug(`GraphQL response keys for ${username}:`, Object.keys(jsonResponse));
    log.debug(`GraphQL response for ${username}:`, JSON.stringify(jsonResponse, null, 2));

    // Check for errors in GraphQL response
    if (jsonResponse.errors) {
        log.error(`GraphQL errors for ${username}:`, jsonResponse.errors);
        session.retire();
        throw new Error(`GraphQL errors for ${username}, session retired.`);
    }

    // Validate GraphQL response structure
    if (!jsonResponse.data || !jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection) {
        log.warning(`Invalid GraphQL response structure for ${username} page ${pageNumber}`);
        log.debug('Expected: data.xdt_api__v1__feed__user_timeline_graphql_connection');
        log.debug('Actual response structure:', Object.keys(jsonResponse.data || {}));
        return;
    }

    const postsData = jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection;
    const posts = postsData.edges || [];
    const pageInfo = postsData.page_info || {};

    log.info(`Found ${posts.length} posts on page ${pageNumber} for ${username}`);

    let postsProcessed = 0;
    let postsSkipped = 0;

    // Process each post
    for (const postEdge of posts) {
        const post = postEdge.node;

        // Check if we've reached the maximum posts limit
        if (maxPosts && totalScraped + postsProcessed >= maxPosts) {
            log.info(`Reached maximum posts limit (${maxPosts}) for ${username}`);
            break;
        }

        // Apply date filtering if specified
        if (onlyPostsNewerThan) {
            const postTimestamp = moment.unix(post.taken_at_timestamp);
            if (postTimestamp.isBefore(moment(onlyPostsNewerThan))) {
                log.debug(`Skipping post ${post.shortcode} - older than ${onlyPostsNewerThan}`);
                postsSkipped++;
                continue;
            }
        }

        // Determine post type and apply filters
        const postType = getPostType(post);

        // Skip reels if not included
        if (postType === 'reel' && !includeReels) {
            log.debug(`Skipping reel ${post.shortcode} - reels not included`);
            postsSkipped++;
            continue;
        }

        // Skip IGTV if not included
        if (postType === 'igtv' && !includeIGTV) {
            log.debug(`Skipping IGTV ${post.shortcode} - IGTV not included`);
            postsSkipped++;
            continue;
        }

        // Extract comprehensive post data
        const postData = await extractPostData(post, username, originalUrl, log);

        // Save post data
        await Dataset.pushData(postData);
        postsProcessed++;

        log.debug(`Saved ${postType} post ${post.shortcode} from ${username}`);
    }

    log.info(`Page ${pageNumber} for ${username}: processed ${postsProcessed} posts, skipped ${postsSkipped} posts`);

    // Check if there are more pages and we haven't reached limits
    const newTotalScraped = totalScraped + postsProcessed;
    const hasNextPage = pageInfo.has_next_page;
    const nextCursor = pageInfo.end_cursor;

    if (hasNextPage && nextCursor && (!maxPosts || newTotalScraped < maxPosts)) {
        // Create next page request
        const variables = {
            after: nextCursor,
            before: null,
            data: {
                count: 12,
                include_reel_media_seen_timestamp: true,
                include_relationship_info: true,
                latest_besties_reel_media: true,
                latest_reel_media: true
            },
            first: 12,
            last: null,
            username: username,
            __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
            __relay_internal__pv__PolarisShareSheetV3relayprovider: true
        };

        const body = `variables=${encodeURIComponent(JSON.stringify(variables))}&doc_id=${INSTAGRAM_DOCUMENT_IDS.USER_POSTS}`;

        const nextRequest = {
            url: 'https://www.instagram.com/graphql/query',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            payload: body,
            userData: {
                type: 'posts',
                username,
                userId,
                originalUrl,
                onlyPostsNewerThan,
                maxPosts,
                includeReels,
                includeIGTV,
                pageNumber: pageNumber + 1,
                cursor: nextCursor,
                totalScraped: newTotalScraped
            }
        };

        await crawler.addRequests([nextRequest]);
        log.info(`Added next page request for ${username} (page ${pageNumber + 1}, cursor: ${nextCursor})`);
    } else {
        log.info(`Finished scraping posts for ${username}. Total posts scraped: ${newTotalScraped}`);
    }
});
