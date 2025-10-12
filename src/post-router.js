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
export class CookieManager {
    static instance;

    constructor() {
        // Implement singleton pattern to prevent multiple cookie factories
        if (CookieManager.instance) {
            return CookieManager.instance;
        }

        this.cookiePools = new Map();
        this.cookieUsage = new Map();
        this.blockedCookies = new Set();
        this.domainCookies = new Map();

        CookieManager.instance = this;
    }

    async initializeCookies() {
        // 🎉 NEW: Guest cookie factory approach - no more credential management!
        console.log(`🚀 Initializing guest cookie factory for public Instagram scraping`);

        // Create guest cookie jars for each proxy/session
        const guestCookieCount = 30; // Increased to 30 guest jars to reduce pool exhaustion under throttling


        for (let i = 1; i <= guestCookieCount; i++) {
            try {
                const guestJar = await this.createGuestCookieJar();
                const cookieSet = {
                    id: `guest_jar_${i}`,
                    cookies: guestJar.cookies,
                    jar: guestJar.jar,
                    wwwClaim: guestJar.wwwClaim,
                    asbdId: guestJar.asbdId,
                    lsd: guestJar.lsd,
                    lsdUntil: guestJar.lsdUntil,
                    callCount: 0,
                    usage: 0,
                    lastUsed: 0,
                    blocked: false
                };

                this.cookiePools.set(cookieSet.id, cookieSet);
                console.log(`✅ Created guest jar ${i}: ${Object.keys(guestJar.cookies).length} cookies`);
            } catch (error) {
                console.log(`⚠️  Failed to create guest jar ${i}: ${error.message}`);
            }
        }

        if (this.cookiePools.size === 0) {
            throw new Error(`❌ CRITICAL: Failed to create any guest cookie jars. Check network connectivity.`);
        }

        // Optionally load authenticated session cookies (if provided via file or env)
        try {
            const realSets = await this.loadRealCookies();
            if (Array.isArray(realSets) && realSets.length > 0) {
                for (const rc of realSets) {
                    // Merge into pool; prefer minimal usage so they get picked first
                    this.cookiePools.set(rc.id, {
                        id: rc.id,
                        cookies: rc.cookies,
                        wwwClaim: rc.wwwClaim || '0',
                        asbdId: rc.asbdId || '129477',
                        lsd: rc.lsd || null,
                        lsdUntil: rc.lsdUntil || 0,
                        callCount: 0,
                        usage: rc.usage || 0,
                        lastUsed: rc.lastUsed || 0,
                        blocked: rc.blocked || false,
                    });
                }
                console.log(`🔐 Loaded ${realSets.length} authenticated cookie set(s) into pool`);
            } else {
                console.log(`🔐 No authenticated cookie sets provided (optional)`);
            }
        } catch (e) {
            console.log(`🔐 Skipped loading authenticated cookies: ${e.message}`);
        }

        console.log(`🎯 Guest cookie factory ready: ${this.cookiePools.size} jars created`);
        this.initializeDomainCookies();
        return this.cookiePools.size;
    }

    // 🎉 NEW: Guest cookie factory - creates anonymous Instagram cookies
    async createGuestCookieJar() {
        const axios = (await import('axios')).default;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };

        try {
            // Step 1: Get guest cookies from Instagram homepage
            const response = await axios.get('https://www.instagram.com/', {
                headers,
                timeout: 10000,
                validateStatus: (status) => status < 500
            });

            if (response.status !== 200) {
                throw new Error(`Instagram homepage returned ${response.status}`);
            }

            // Step 2: Extract cookies from response
            const cookies = {};
            const setCookieHeaders = response.headers['set-cookie'] || [];

            setCookieHeaders.forEach(cookieHeader => {
                const [cookiePart] = cookieHeader.split(';');
                const [name, value] = cookiePart.split('=');
                if (name && value) {
                    cookies[name.trim()] = value.trim();
                }
            });

            // Step 3: Extract dynamic headers (corrected header names)
            const wwwClaim = response.headers['x-ig-set-www-claim'] || response.headers['ig-set-www-claim'] || '0';
            const asbdId = response.headers['x-ig-set-asbd-id'] || response.headers['ig-set-asbd-id'] || '129477';

            // Step 4: Get LSD token from manifest
            let lsd = null;
            let lsdUntil = null;

            try {
                const manifestResponse = await axios.get('https://www.instagram.com/data/manifest.json?__a=1', {
                    headers: {
                        ...headers,
                        'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
                    },
                    timeout: 5000
                });

                if (manifestResponse.data && manifestResponse.data.lsd) {
                    lsd = manifestResponse.data.lsd;
                    lsdUntil = Date.now() + 12 * 60 * 1000; // 12-min safety window
                }
            } catch (error) {
                console.log(`⚠️  Could not fetch LSD token: ${error.message}`);
            }

            // Validate essential cookies (mid is optional, sometimes not set immediately)
            if (!cookies.csrftoken) {
                throw new Error(`Missing essential cookies: csrftoken=${!!cookies.csrftoken}`);
            }

            // Generate mid if not provided by Instagram (common for guest sessions)
            if (!cookies.mid) {
                cookies.mid = `ZpL9AQABAAHd7hNTdn${Math.random().toString(36).substr(2, 15)}`;
                console.log(`🔧 Generated guest mid cookie: ${cookies.mid}`);
            }

            return {
                cookies,
                wwwClaim,
                asbdId,
                lsd,
                lsdUntil,
                jar: null // We'll manage cookies manually for better control
            };

        } catch (error) {
            throw new Error(`Failed to create guest cookie jar: ${error.message}`);
        }
    }

    // 🎯 NEW: Ensure fresh tokens for guest cookie jar
    async ensureFreshTokens(cookieSet) {
        const axios = (await import('axios')).default;

        cookieSet.callCount = (cookieSet.callCount || 0) + 1;
        const now = Date.now();

        // Refresh WWW-Claim every 25 calls or if missing
        if (!cookieSet.wwwClaim || cookieSet.callCount % 25 === 0) {
            try {
                const cookieString = Object.entries(cookieSet.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
                const headResponse = await axios.head('https://www.instagram.com/', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Cookie': cookieString
                    },
                    timeout: 5000
                });

                cookieSet.wwwClaim = headResponse.headers['x-ig-set-www-claim'] || headResponse.headers['ig-set-www-claim'] || cookieSet.wwwClaim || '0';
                if (cookieSet.wwwClaim === '0') {
                    try {
                        const loginResp = await axios.get('https://www.instagram.com/api/v1/web/accounts/login/ajax/', {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': '*/*',
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-IG-App-ID': '936619743392459',
                                'Referer': 'https://www.instagram.com/accounts/login/',
                                'Cookie': cookieString
                            },
                            timeout: 8000,
                            validateStatus: () => true,
                        });
                        const claim2 = loginResp.headers['x-ig-set-www-claim'] || loginResp.headers['ig-set-www-claim'];
                        if (claim2) cookieSet.wwwClaim = claim2;
                    } catch (e) {
                        // ignore, keep '0'
                    }
                }
                console.log(`🔄 Refreshed WWW-Claim for ${cookieSet.id}: ${cookieSet.wwwClaim}`);
            } catch (error) {
                console.log(`⚠️  Failed to refresh WWW-Claim for ${cookieSet.id}: ${error.message}`);
            }
        }

        // Refresh LSD token if expired or missing
        if (!cookieSet.lsdUntil || cookieSet.lsdUntil < now) {
            try {
                const cookieString = Object.entries(cookieSet.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
                const manifestResponse = await axios.get('https://www.instagram.com/data/manifest.json?__a=1', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Cookie': cookieString
                    },
                    timeout: 5000
                });

                if (manifestResponse.data && manifestResponse.data.lsd) {
                    cookieSet.lsd = manifestResponse.data.lsd;
                    cookieSet.lsdUntil = now + 12 * 60 * 1000; // 12-min safety window
                    console.log(`🔄 Refreshed LSD token for ${cookieSet.id}`);
                }
            } catch (error) {
                console.log(`⚠️  Failed to refresh LSD token for ${cookieSet.id}: ${error.message}`);
            }
        }
    }

    // 🎯 NEW: Build public headers for guest cookie jar
    buildPublicHeaders(cookieSet) {
        const cookieString = Object.entries(cookieSet.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        const csrftoken = cookieSet.cookies.csrftoken || 'missing';

        return {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': cookieSet.asbdId || '129477',
            'X-IG-WWW-Claim': cookieSet.wwwClaim || '0',
            'X-FB-LSD': cookieSet.lsd || '',
            'X-FB-Friendly-Name': 'PolarisProfileTimelineQuery',
            'X-CSRFToken': csrftoken,
            'Cookie': cookieString,
            'Referer': 'https://www.instagram.com/',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };
    }

    // 🎯 NEW: Get a guest cookie set for session (round-robin selection)
    async getCookieSet(session) {
        const availableCookieSets = Array.from(this.cookiePools.values()).filter(cs => !cs.blocked);

        if (availableCookieSets.length === 0) {
            console.log('⚠️  No available cookie sets, creating new guest jar');
            try {
                const guestJar = await this.createGuestCookieJar();
                const cookieSet = {
                    id: `guest_jar_emergency_${Date.now()}`,
                    cookies: guestJar.cookies,
                    jar: guestJar.jar,
                    wwwClaim: guestJar.wwwClaim,
                    asbdId: guestJar.asbdId,
                    lsd: guestJar.lsd,
                    lsdUntil: guestJar.lsdUntil,
                    callCount: 0,
                    usage: 0,
                    lastUsed: 0,
                    blocked: false
                };
                this.cookiePools.set(cookieSet.id, cookieSet);
                return cookieSet;
            } catch (error) {
                console.log(`❌ Failed to create emergency guest jar: ${error.message}`);
                return null;
            }
        }

        // Prefer authenticated cookie sets (with sessionid) when available
        const authSets = availableCookieSets.filter(cs => cs.cookies && typeof cs.cookies === 'object' && cs.cookies.sessionid);
        const pool = authSets.length > 0 ? authSets : availableCookieSets;

        // Simple round-robin selection based on usage
        const leastUsed = pool.reduce((min, current) =>
            current.usage < min.usage ? current : min
        );

        leastUsed.usage++;
        leastUsed.lastUsed = Date.now();

        return leastUsed;
    }

    // Convenience: always return an authenticated cookie set if present, without rotation
    getAuthenticatedCookieSet() {
        const authSets = Array.from(this.cookiePools.values()).filter(cs => !cs.blocked && cs.cookies && cs.cookies.sessionid);
        if (authSets.length > 0) return authSets[0];
        return null;
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
                        // 🔴 CRITICAL: Require sessionid, ds_user_id, and csrftoken for timeline queries
                        if (cookies.sessionid && cookies.ds_user_id && cookies.csrftoken) {
                            realCookies.push({
                                id: `real_cookie_set_${i + 1}`,
                                cookies: {
                                    'sessionid': cookies.sessionid,
                                    'ds_user_id': cookies.ds_user_id,
                                    'csrftoken': cookies.csrftoken,
                                    'mid': cookies.mid || 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                                    'ig_did': cookies.ig_did || 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
                                    'rur': cookies.rur || 'ATN'
                                },
                                usage: 0,
                                lastUsed: 0,
                                blocked: false
                            });
                        } else {
                            console.log(`⚠️  Skipping cookie set ${i + 1}: missing required fields (sessionid, ds_user_id, csrftoken)`);
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
            const ds_user_id = process.env.INSTAGRAM_DS_USER_ID;
            const csrftoken = process.env.INSTAGRAM_CSRFTOKEN;
            const mid = process.env.INSTAGRAM_MID;

            // 🔴 CRITICAL: Require sessionid, ds_user_id, and csrftoken
            if (sessionid && ds_user_id && csrftoken) {
                realCookies.push({
                    id: 'env_cookie_set_1',
                    cookies: {
                        'sessionid': sessionid,
                        'ds_user_id': ds_user_id,
                        'csrftoken': csrftoken,
                        'mid': mid || 'ZnK8YwALAAE7UjQ2NDY4NzQ2',
                        'ig_did': process.env.INSTAGRAM_IG_DID || 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
                        'rur': process.env.INSTAGRAM_RUR || 'ATN'
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

// 🎯 CRITICAL FIX: Create true singleton instance to prevent multiple cookie factories
let cookieManagerInstance = null;

function getCookieManager() {
    if (!cookieManagerInstance) {
        cookieManagerInstance = new CookieManager();
    }
    return cookieManagerInstance;
}

// Export singleton getter
export const cookieManager = getCookieManager();

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
    const maxRetries = 5;

    const cookieSet = await cookieManager.getCookieSet(session);
    if (!cookieSet) {
        return { shortcode, error: 'No available cookies', data: null };
    }

        // Local metrics for instrumentation per post
        let unauthorizedCount = 0;
        const variantStats = {
            base: { attempts: 0, success: 0 },
            no_lsd: { attempts: 0, success: 0 },
            no_lsd_claim: { attempts: 0, success: 0 },
            no_lsd_claim_csrf: { attempts: 0, success: 0 },
            no_lsd_claim_csrf_client_hints: { attempts: 0, success: 0 },
        };

        const getCookieHeader = (cookiesObj = {}) => {
            const keys = Object.keys(cookiesObj).sort();
            return keys.map((k) => `${k}=${cookiesObj[k]}`).join('; ');
        };


    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // 🎯 CRITICAL FIX: Use lightweight GET endpoint with correct doc_id and LSD token
            const graphqlUrl = 'https://www.instagram.com/graphql/query/';
            const variables = { shortcode };

            // 🎯 FIXED: Use correct shortcode media doc_id (confirmed 2025-07, same as Apify's actor)
            const params = new URLSearchParams({
                doc_id: INSTAGRAM_DOCUMENT_IDS.SHORTCODE_MEDIA,
                variables: JSON.stringify(variables)
            });

            const fullUrl = `${graphqlUrl}?${params}`;

            // Get dynamic tokens (from profile discovery); avoid per-post LSD fetch unless needed
            const wwwClaim = userData?.wwwClaim || '0';
            const asbdId = userData?.asbdId || '129477';
            let lsdToken = session?.userData?.lsd || null; // Use cached if present
            // LSD will be fetched lazily only for header variant 'base'
            // Note: Single-post GraphQL usually succeeds without LSD on cloud IPs

            // 🎯 Build request headers per attempt (header variant fallback strategy)
            const hasCsrf = !!cookieSet.cookies?.csrftoken;
            const csrf = cookieSet.cookies?.csrftoken;

            const buildHeaders = (variant) => {
                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'X-IG-App-ID': '936619743392459',
                    'X-ASBD-ID': asbdId,
                    'Cookie': getCookieHeader(cookieSet.cookies),
                    'Referer': `https://www.instagram.com/p/${shortcode}/`,
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                };
                // Do NOT send X-IG-WWW-Claim for single post requests (2025 mitigation)
                if (variant === 'base') {
                    headers['X-FB-LSD'] = lsdToken;
                }
                if (variant === 'no_lsd_claim_csrf' || variant === 'no_lsd_claim_csrf_client_hints') {
                    if (hasCsrf) headers['x-csrftoken'] = csrf;
                }
                if (variant === 'no_lsd_claim_csrf_client_hints') {
                    headers['sec-ch-ua'] = '"Chromium";v="120", "Not=A?Brand";v="24", "Google Chrome";v="120"';
                    headers['sec-ch-ua-platform'] = '"macOS"';
                    headers['sec-ch-ua-mobile'] = '?0';
                    headers['DNT'] = '1';
                }
                return headers;
            };

            let variant;
            if (attempt === 1) variant = 'no_lsd_claim_csrf_client_hints';
            else if (attempt === 2) variant = 'no_lsd_claim_csrf';
            else if (attempt === 3) variant = 'no_lsd_claim';
            else if (attempt === 4) variant = 'no_lsd';
            else variant = 'base';

            if (variantStats[variant]) variantStats[variant].attempts++;

            const requestHeaders = buildHeaders(variant);
            // Lazily ensure LSD only when needed (variant 'base')
            if (variant === 'base' && !lsdToken) {
                const { ensureLsdToken } = await import('./session-utils.js');
                lsdToken = await ensureLsdToken(session, log);
            }

            log.debug(`Header variant for ${shortcode}: attempt ${attempt} variant=${variant} lsd=${requestHeaders['X-FB-LSD'] ? 'set' : 'omitted'} claim=${requestHeaders['X-IG-WWW-Claim'] ? 'set' : 'omitted'} csrf=${requestHeaders['x-csrftoken'] ? 'set' : 'omitted'}`);

            const timeout = 10000 + (attempt - 1) * 5000;

            const response = await axios.get(fullUrl, {
                headers: requestHeaders,
                timeout,
                validateStatus: () => true,
                maxRedirects: 2,
            });

            // 🎯 ENHANCED 401 HANDLING: Better retry logic with session rotation
            if (response.status === 401) {
                unauthorizedCount++;
                if (attempt < maxRetries) {
                    log.warning(`Post ${shortcode} unauthorized (attempt ${attempt}) - rotating cookies and session`);
                    cookieManager.markAsBlocked(cookieSet.id);
                    // Rotate session to force new IP / identity
                    try { session.retire(); } catch (_) {}

                    // Apply specific backoff for 401 errors: 2s, 3s, 5s, 8s, 13s (+ jitter)
                    const delays401 = [2000, 3000, 5000, 8000, 13000];
                    const idx = Math.min(attempt - 1, delays401.length - 1);
                    const jitter = Math.floor(Math.random() * 500);
                    const backoffDelay = delays401[idx] + jitter;
                    await new Promise((resolve) => setTimeout(resolve, backoffDelay));

                    throw new Error(`Unauthorized - retry needed`);
                }
                log.info(`Post ${shortcode} header variants summary: ${JSON.stringify(variantStats)} 401_count=${unauthorizedCount}`);
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
            if (variantStats[variant]) variantStats[variant].success++;

            return { shortcode, error: null, data: postData };

        } catch (error) {
            if (attempt === maxRetries) {
                log.error(`Post ${shortcode} failed after ${maxRetries} attempts:`, error.message);
                log.info(`Post ${shortcode} header variants summary: ${JSON.stringify(variantStats)} 401_count=${unauthorizedCount}`);
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

    // 🎯 CRITICAL FIX: Defensive guard to prevent multiple cookie factory initializations
    if (!cookieManagerInitialized) {
        // Only initialize if not already done
        if (!cookieManager.cookiePools || cookieManager.cookiePools.size === 0) {
            await cookieManager.initializeCookies();
            log.info('Cookie manager initialized for post extraction');
        } else {
            log.info('Cookie manager already initialized, reusing existing instance');
        }
        cookieManagerInitialized = true;
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

    // Synthetic batch request path (triggered from main.js)
    if (type === 'direct_posts') {
        try {
            log.info(`Starting advanced post extraction for ${username} using provided shortcodes...`);

            const discoveryOptions = {
                maxPosts: maxPosts || null,
                methods: ['mobileapi'],
                fallbackToKnown: false,
                onlyPostsNewerThan: onlyPostsNewerThan
            };

            const discoveredShortcodes = (Array.isArray(request.userData?.discoveredShortcodes) && request.userData.discoveredShortcodes.length)
                ? request.userData.discoveredShortcodes
                : await discoverPosts(username, discoveryOptions, log, session, cookieManager, throttling);

            if (discoveredShortcodes.length === 0) {
                log.warning(`No shortcodes available for ${username} in direct batch path`);
                return;
            }

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

                    // Try optimized GraphQL batch first; if not fully successful, fall back to individual fetches
                    let batchResults = await fetchPostsBatchGraphQL(limitedBatch, username, originalUrl, onlyPostsNewerThan, log);
                    if (!Array.isArray(batchResults) || batchResults.length < limitedBatch.length) {
                        const missingCount = Array.isArray(batchResults) ? (limitedBatch.length - batchResults.length) : limitedBatch.length;
                        if (missingCount > 0) {
                            log.debug(`Batch GraphQL returned ${batchResults ? batchResults.length : 0}/${limitedBatch.length}; falling back to per-shortcode for the rest`);
                        }
                        const fallbackResults = await fetchPostsBatch(limitedBatch, username, originalUrl, onlyPostsNewerThan, log, sessionId);
                        batchResults = fallbackResults;
                    }

                    // Save all successful results
                    for (const postData of batchResults) {
                        if (postData) {
                            await Dataset.pushData(postData);
                            postsProcessed++;
                            log.debug(`Saved post ${postData.shortCode} from ${username} (${postData.type}, ${postData.likesCount} likes)`);
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
            const successRate = ((postsProcessed / discoveredShortcodes.length) * 100).toFixed(1);
            log.info(`Success Rate: ${successRate}% (${postsProcessed}/${discoveredShortcodes.length} posts)`);
            return;
        } catch (error) {
            log.error(`Error in direct post extraction for ${username}:`, error.message);
            return;
        }
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

    // Prefer mobile API first (2025): higher success than GraphQL on cloud IPs
    try {
        const mobileData = await extractPostViaMobileAPI(shortcode, username, originalUrl, log, session);
        if (mobileData) {
            await Dataset.pushData(mobileData);
            log.info(`Successfully extracted post via Mobile API: ${shortcode}`);
            return;
        }
    } catch (e) {
        log.debug(`Mobile API primary attempt failed for ${shortcode}: ${e.message}`);
    }

    // Fallback 2: GraphQL single-post endpoint (try header variants)
    let postResult = await extractSinglePostViaGraphQL(shortcode, username, originalUrl, log, session, request.userData);

    if (!(postResult && postResult.data)) {
        // Fallback 3: HTML parsing
        try {
            const htmlData = await extractPostViaHTML(shortcode, username, originalUrl, log, session);
            if (htmlData) {
                await Dataset.pushData(htmlData);
                log.info(`Successfully extracted post via HTML: ${shortcode}`);
                return;
            }
        } catch (e) {
            log.debug(`HTML fallback failed for ${shortcode}: ${e.message}`);
        }
    }

    if (postResult && postResult.data) {
        await Dataset.pushData(postResult.data);
        log.info(`Successfully extracted post via GraphQL: ${shortcode}`);
        return;
    } else {
        log.warning(`Failed to extract post: ${shortcode}`);
        // Ensure 100% data persistence: record a structured error item on final failure
        try {
            await Dataset.pushData({
                type: 'post_error',
                shortcode,
                username,
                url: originalUrl,
                error: 'Extraction failed after all fallbacks',
                scrapedAt: new Date().toISOString()
            });
        } catch (_) {}
        return;
    }


});


// Optimized batch GraphQL fetcher (attempt up to 25 shortcodes per request), with robust fallback
async function fetchPostsBatchGraphQL(shortcodes, username, originalUrl, onlyPostsNewerThan, log) {
    try {
        const axios = (await import('axios')).default;
        const cookieSet = cookieManager.getCookiesForRequest();
        if (!cookieSet) {
            log.debug('No cookies for batch GraphQL; skipping');
            return null;
        }

        const batchLimit = Math.min(shortcodes.length, 25);
        const batchShortcodes = shortcodes.slice(0, batchLimit);
        const graphqlUrl = 'https://www.instagram.com/graphql/query/';
        const variables = { shortcodes: batchShortcodes };
        const params = new URLSearchParams({
            doc_id: INSTAGRAM_DOCUMENT_IDS.BATCH_SHORTCODE_MEDIA,
            variables: JSON.stringify(variables)
        });
        const fullUrl = `${graphqlUrl}?${params}`;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookieManager.getCookieStringForDomain(cookieSet, 'www.instagram.com'),
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-CSRFToken': cookieSet.cookies?.csrftoken || 'missing',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': `https://www.instagram.com/${username}/`
        };

        const response = await axios.get(fullUrl, {
            headers,
            timeout: 15000,
            validateStatus: () => true,
            maxRedirects: 2
        });

        if (response.status !== 200 || !response.data || !response.data.data) {
            log.debug(`Batch GraphQL unsupported or non-200: ${response.status}`);
            return null;
        }

        const dataObj = response.data.data;
        // Find array of media-like objects
        let mediaArray = null;
        for (const val of Object.values(dataObj)) {
            if (Array.isArray(val) && val.length && (val[0]?.shortcode || val[0]?.code || val[0]?.node?.shortcode)) {
                mediaArray = val;
                break;
            }
            // Sometimes nested under "edges"
            if (val?.edges && Array.isArray(val.edges) && val.edges.length && (val.edges[0]?.node?.shortcode)) {
                mediaArray = val.edges.map(e => e.node);
                break;
            }
        }
        if (!mediaArray || !mediaArray.length) {
            log.debug('Batch GraphQL returned no media array');
            return null;
        }

        const mapped = [];
        for (const media of mediaArray) {
            const node = media?.node || media;
            // Optional time-range filter
            if (onlyPostsNewerThan && node?.taken_at_timestamp) {
                const postTs = moment.unix(node.taken_at_timestamp);
                if (postTs.isBefore(moment(onlyPostsNewerThan))) continue;
            }
            const m = await extractPostDataFromGraphQL(node, username, originalUrl, log);
            if (m) mapped.push(m);
        }

        return mapped;
    } catch (e) {
        log.debug(`Batch GraphQL fetch failed: ${e.message}`);
        return null;
    }
}

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

                // 🎯 PRODUCTION FIX: Use public GraphQL endpoint (GET request, no LSD needed)
                const graphqlUrl = 'https://www.instagram.com/graphql/query/';
                const variables = { shortcode };

                // Build GET URL with query parameters (no LSD needed)
                const params = new URLSearchParams({
                    doc_id: INSTAGRAM_DOCUMENT_IDS.SHORTCODE_MEDIA,
                    variables: JSON.stringify(variables)
                });

                const fullUrl = `${graphqlUrl}?${params}`;

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

                // Use GET request to public GraphQL endpoint (no LSD needed)
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


// Lightweight helper to build Cookie header from cookie map
function buildCookieHeader(cookies) {
    if (!cookies) return '';
    if (typeof cookies === 'string') return cookies;
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Fallback 1: Mobile API post extraction
async function extractPostViaMobileAPI(shortcode, username, originalUrl, log, session) {
    const axios = (await import('axios')).default;

    // Build endpoint for mobile API by shortcode
    // Known mobile path returns JSON with items[0]
    const url = `https://i.instagram.com/api/v1/media/shortcode/${shortcode}/`;

    const cookieSet = await cookieManager.getCookieSet(session);
    log.debug(`Mobile API attempt for ${shortcode} using cookieSet=${cookieSet?.id || 'none'} (auth=${cookieSet?.cookies?.sessionid ? 'yes' : 'no'})`);
    const headers = {
        'User-Agent': 'Instagram 300.0.0.0 iOS',
        'X-IG-App-ID': '936619743392459',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.instagram.com/p/${shortcode}/`,
        ...(cookieSet?.cookies ? { 'Cookie': buildCookieHeader(cookieSet.cookies) } : {})
    };

    const resp = await axios.get(url, { headers, timeout: 15000, validateStatus: s => s < 500 });
    if (resp.status === 401) {
        if (cookieSet?.id) cookieManager.markAsBlocked(cookieSet.id);
        try { session.retire(); } catch (_) {}
        return null;
    }
    if (resp.status !== 200 || !resp.data) return null;

    const data = resp.data;
    const item = data.items?.[0] || data.item || data.media;
    if (!item) return null;

    // Map minimal fields for compatibility
    const takenAt = item.taken_at || item.taken_at_timestamp || item.caption?.created_at;
    const tsIso = takenAt ? new Date(takenAt * 1000).toISOString() : undefined;

    return {
        id: item.id || item.pk,
        type: item.media_type === 2 ? 'Video' : (item.carousel_media ? 'Sidecar' : 'Image'),
        shortCode: shortcode,
        url: `https://www.instagram.com/p/${shortcode}/`,
        timestamp: tsIso,
        caption: item.caption?.text || '',
        likesCount: item.like_count ?? item.edge_liked_by?.count ?? null,
        commentsCount: item.comment_count ?? item.edge_media_to_comment?.count ?? null,
        ownerUsername: username,
        isCommercialContent: !!item.is_paid_partnership,
    };
}

// Fallback 2: HTML parsing of post page to extract __NEXT_DATA__ JSON
async function extractPostViaHTML(shortcode, username, originalUrl, log, session) {
    const axios = (await import('axios')).default;
    const cheerio = (await import('cheerio')).default;

    const url = `https://www.instagram.com/p/${shortcode}/`;
    const cookieSet = await cookieManager.getCookieSet(session);

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://www.instagram.com/`,
        ...(cookieSet?.cookies ? { 'Cookie': buildCookieHeader(cookieSet.cookies) } : {})
    };

    const resp = await axios.get(url, { headers, timeout: 15000, validateStatus: s => s < 500 });
    if (resp.status !== 200 || !resp.data || typeof resp.data !== 'string') return null;

    const $ = cheerio.load(resp.data);

    // Try to locate embedded JSON
    let jsonText = '';
    // Newer IG sometimes embeds JSON in script[type="application/json"][id="__NEXT_DATA__"]
    const nextData = $('script[type="application/json"]#__NEXT_DATA__').first().text();
    if (nextData) jsonText = nextData;
    if (!jsonText) {
        // Fallback: search for any script tag with "shortcode" inside
        $('script').each((_, el) => {
            const t = $(el).text();
            if (!jsonText && t && t.includes('shortcode')) jsonText = t;
        });
    }
    if (!jsonText) return null;

    let obj;
    try { obj = JSON.parse(jsonText); } catch (_) { return null; }

    // Heuristic paths to media
    const media = obj?.props?.pageProps?.postPage?.media
        || obj?.props?.pageProps?.graphql?.shortcode_media
        || obj?.data?.xdt_shortcode_media
        || null;
    if (!media) return null;

    const ts = media.taken_at_timestamp || media.taken_at || media.takenAt;
    const tsIso = ts ? new Date(ts * 1000).toISOString() : undefined;

    return {
        id: media.id,
        type: media.__typename === 'XDTGraphVideo' ? 'Video' : (media.edge_sidecar_to_children ? 'Sidecar' : 'Image'),
        shortCode: shortcode,
        url: `https://www.instagram.com/p/${shortcode}/`,
        timestamp: tsIso,
        caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text || '',
        likesCount: media.edge_media_preview_like?.count ?? media.like_count ?? null,
        commentsCount: media.edge_media_to_comment?.count ?? media.comment_count ?? null,
        ownerUsername: username,
        isCommercialContent: !!media.is_paid_partnership,
    };
}

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

        // Log successful extraction (reduced verbosity)
        log.debug(`Extracted post data for ${postData.shortCode}: ${postData.type}, ${postData.likesCount} likes`);
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


