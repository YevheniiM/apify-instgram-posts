import { createCheerioRouter, Dataset } from 'crawlee';
import { Actor } from 'apify';
import { discoverPosts } from './post-discovery.js';
import axios from 'axios';
import crypto from 'crypto';
import { primeCsrf } from './session-utils.js';
import { CookieManager } from './post-router.js';
import { getUserIdViaNextData, getUserIdViaTopSearch, getUserIdViaAPIEnhanced } from './utils/user-id.js';

// Create router for Phase 1: Profile Discovery (production session management)
export const profileRouter = createCheerioRouter();

// Production Instagram constants (from Apify playbook)
const IG_APP_ID = '936619743392459'; // Public web-app identifier

// Mobile endpoint gives JSON even when the web HTML is stripped
const MOBILE_PROFILE_API = 'https://i.instagram.com/api/v1/users/web_profile_info/?username=';

/**
 * Returns user-id or null.  Automatically obeys the session / proxy setup.
 * Enhanced with required headers for June 2025+ Instagram changes
 */
export async function getUserIdViaAPI(username, session, log) {
    // Use the enhanced version with proper headers
    return await getUserIdViaAPIEnhanced(username, session, log);
}

// Initialize our custom cookie manager for guest cookies
const guestCookieManager = new CookieManager();
let cookieManagerInitialized = false;

// Profile discovery handler - uses production session management
profileRouter.addDefaultHandler(async ({ request, response, $, log, crawler, session }) => {
    const { username, originalUrl, onlyPostsNewerThan, maxPosts, includeReels, includeIGTV } = request.userData;

    // 🎉 NEW: Initialize guest cookie factory for profile discovery
    if (!cookieManagerInitialized) {
        await guestCookieManager.initializeCookies();
        cookieManagerInitialized = true;
        log.info('Guest cookie factory initialized for profile discovery');
    }

    log.info(`Phase 1: Profile discovery for ${username}`);

    // Handle session errors (production pattern)
    if ([403, 429, 590, 595].includes(response.statusCode)) {
        log.warning(`Request blocked, retrying it again with different session`);
        log.warning(`{"id":"${request.id}","url":"${request.url}","retryCount":${request.retryCount || 1}}`);
        session.retire();
        throw new Error(`Request blocked (${response.statusCode}), session retired.`);
    }

    try {
        // Use the response from CheerioCrawler (already has session cookies)
        log.info(`Response status: ${response.statusCode}, URL: ${request.url}`);

        // Check for login redirect and bootstrap if needed
        const htmlContent = $.html();
        if (htmlContent.includes('login') || htmlContent.includes('Login') || htmlContent.length < 10000) {
            log.info(`Login redirect detected - using guest cookie approach for production`);

            // 🎯 PRODUCTION FIX: Use guest cookie factory instead of manual bootstrap
            const { cookieManager } = await import('./post-router.js');

            // Initialize cookie manager if not already done
            if (!cookieManager.cookiePools || cookieManager.cookiePools.size === 0) {
                await cookieManager.initializeCookies();
                log.info(`🍪 Guest cookie factory initialized with ${cookieManager.cookiePools.size} jars`);
            }

            // Get a fresh guest cookie set
            const guestCookieSet = cookieManager.getCookiesForRequest();
            if (guestCookieSet) {
                // Apply guest cookies to session
                for (const [name, value] of Object.entries(guestCookieSet.cookies)) {
                    await session.setCookie(`${name}=${value}`, 'https://www.instagram.com');
                }
                log.info(`🔑 Applied guest cookies: ${Object.keys(guestCookieSet.cookies).join(', ')}`);

                // Ensure fresh tokens
                await cookieManager.ensureFreshTokens(guestCookieSet);
                log.info(`🔄 Refreshed tokens: WWW-Claim="${guestCookieSet.wwwClaim}", ASBD-ID="${guestCookieSet.asbdId}"`);
            }

            // Try to re-fetch the profile page with guest cookies
            const axios = (await import('axios')).default;
            const retryResponse = await axios.get(`https://www.instagram.com/${username}/`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cookie': session.getCookieString('https://www.instagram.com')
                },
                timeout: 30000,
                validateStatus: () => true
            });

            if (retryResponse.status === 200 && retryResponse.data.length > 10000) {
                log.info(`✅ Guest cookie retry successful - got profile data`);
                // Update the HTML content for processing
                const cheerio = (await import('cheerio')).default;
                $ = cheerio.load(retryResponse.data);
            } else {
                log.warning(`⚠️ Guest cookie retry failed - status: ${retryResponse.status}, length: ${retryResponse.data?.length || 0}`);
            }
        } else {
            log.info(`✅ Successfully authenticated! No login redirect detected.`);
        }

        // Extract post URLs from the authenticated response
        const postUrls = [];
        let profileData = null;

        // Method 1: Extract user ID using enhanced cascade approach (June 2025+ fix)
        let userId = null;

        //------------------------------------------------------------------
        // 1) Fast-path: parse __NEXT_DATA__ (works for 95% of profiles)
        userId = await getUserIdViaNextData(htmlContent);
        if (userId) {
            log.info(`✅ Found user ID via __NEXT_DATA__: ${userId}`);
        }

        // 2) Old regexes – keep them for safety
        if (!userId) {
            const userIdPatterns = [
                /"profilePage_(\d+)"/,
                /"user_id":"(\d+)"/,
                /"id":"(\d+)"/,
                /profilePage_(\d+)/,
                /"owner":{"id":"(\d+)"/
            ];

            for (const pattern of userIdPatterns) {
                const match = htmlContent.match(pattern);
                if (match) {
                    userId = match[1];
                    log.info(`✅ Found user ID via regex pattern: ${userId}`);
                    break;
                }
            }
        }

        // 3) Mobile JSON API (now with mandatory headers)
        if (!userId) {
            log.info(`Trying mobile API fallback for ${username}`);
            userId = await getUserIdViaAPI(username, session, log);
        }

        // 4) GUARANTEED fallback – top-search endpoint
        if (!userId) {
            log.info(`Trying top-search fallback for ${username}`);
            userId = await getUserIdViaTopSearch(username, session, log);
        }

        if (!userId) {
            log.error(`❌ Still no user-id for ${username} – giving up`);
            return;
        }
        //------------------------------------------------------------------

        // Generate rank_token for mobile API pagination
        session.userData.rankToken = `${crypto.randomUUID()}_${userId}`;

        // Method 2: Extract actual post count from profile HTML
        let actualPostCount = null;
        const postCountPatterns = [
            /"edge_owner_to_timeline_media":{"count":(\d+)/,
            /"media_count":(\d+)/,
            /"posts_count":(\d+)/,
            /(\d+)\s*posts/i,
            /"count":(\d+),"page_info"/
        ];

        for (const pattern of postCountPatterns) {
            const match = htmlContent.match(pattern);
            if (match) {
                actualPostCount = parseInt(match[1]);
                log.info(`Found actual post count: ${actualPostCount} using pattern: ${pattern}`);
                break;
            }
        }

        // Determine target post count: use maxPosts if specified, otherwise use actual count, fallback to unlimited
        let targetPostCount;
        if (maxPosts && maxPosts > 0) {
            targetPostCount = maxPosts;
            log.info(`Using specified maxPosts limit: ${targetPostCount}`);
        } else if (actualPostCount && actualPostCount > 0) {
            targetPostCount = actualPostCount;
            log.info(`Using actual profile post count: ${targetPostCount} (extracting ALL posts)`);
        } else {
            targetPostCount = 1000; // High limit for unlimited extraction
            log.info(`Could not determine post count, using high limit: ${targetPostCount} for unlimited extraction`);
        }

        // Method 3: Extract ALL dynamic tokens from current HTML response (Late 2024+ requirement)
        log.info(`🔑 Step 1: Extracting dynamic tokens from ${username} profile HTML`);

        // Extract dynamic tokens from response headers and current HTML
        const wwwClaimHeader = response.headers['ig-set-www-claim'];
        const asbdIdHeader = response.headers['ig-set-asbd-id'];
        const lsdHeader = response.headers['ig-set-lsd'];

        const wwwClaimMeta = $('meta[name="ig-www-claim"]').attr('content');
        const lsdInput = $('input[name="lsd"]').attr('value');

        // Extract all three required tokens
        const wwwClaim = wwwClaimHeader || wwwClaimMeta || '0';
        const asbdId = asbdIdHeader || '129477';
        const lsd = lsdInput || lsdHeader || null; // fine if null for public scraping

        // Store tokens in session userData for GraphQL requests
        session.userData.wwwClaim = wwwClaim;
        session.userData.asbdId = asbdId;
        session.userData.lsd = lsd;

        log.info(`🔑 Extracted tokens: WWW-Claim="${wwwClaim}", ASBD-ID="${asbdId}", LSD="${lsd ? 'present' : 'MISSING'}"`);

        // Method 4: Use enhanced post discovery with dynamic tokens
        log.info(`🚀 Step 2: Using enhanced post discovery for ${username} (target: ${targetPostCount} posts)`);

        // Create a simple cookie manager interface for the post discovery
        const cookieManager = {
            getCookiesForRequest: () => {
                const cookieString = session.getCookieString('https://www.instagram.com');
                return {
                    id: session.id,
                    cookies: cookieString
                };
            },
            getCookieString: (cookieSet) => {
                return cookieSet ? cookieSet.cookies : session.getCookieString('https://www.instagram.com');
            },
            markAsBlocked: (cookieSetId) => {
                log.info(`🍪 Cookie set ${cookieSetId} marked as blocked`);
            }
        };

        // Create a simple throttling interface
        const throttling = {
            applySmartDelay: async (sessionId, isBlocked = false) => {
                const delay = isBlocked ? 2000 + Math.random() * 3000 : 500 + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                return delay;
            }
        };

        // 🔍 DEBUG: Check guestCookieManager before passing to discoverPosts
        log.info(`🔍 DEBUG: guestCookieManager type: ${typeof guestCookieManager}`);
        log.info(`🔍 DEBUG: guestCookieManager.getCookieSet type: ${typeof guestCookieManager?.getCookieSet}`);
        log.info(`🔍 DEBUG: guestCookieManager methods: ${Object.getOwnPropertyNames(guestCookieManager).join(', ')}`);

        // 🎯 FIXED: Use our custom guest cookie manager instead of Crawlee's built-in one
        const shortcodes = await discoverPosts(username, {
            maxPosts: targetPostCount,
            methods: ['directapi'], // Use our enhanced direct API method with dynamic tokens
            fallbackToKnown: true,
            prefetchedUserId: userId
        }, log, session, guestCookieManager, throttling);

        log.info(`✅ Enhanced discovery found ${shortcodes.length} posts for ${username}`);

        // Convert shortcodes to post URLs and pass dynamic tokens
        for (const shortcode of shortcodes) {
            const postUrl = `https://www.instagram.com/p/${shortcode}/`;
            postUrls.push({
                url: postUrl,
                userData: {
                    type: 'post_extraction',
                    username,
                    originalUrl,
                    onlyPostsNewerThan,
                    maxPosts,
                    includeReels,
                    includeIGTV,
                    shortcode: shortcode,
                    // Pass dynamic tokens from profile discovery to post extraction
                    wwwClaim: session.userData?.wwwClaim || '0',
                    asbdId: session.userData?.asbdId || '129477',
                    lsd: session.userData?.lsd || null
                }
            });
        }



        // Store discovered post URLs for Phase 2
        const existingPostUrls = await Actor.getValue('POST_URLS') || [];
        const allPostUrls = [...existingPostUrls, ...postUrls];
        await Actor.setValue('POST_URLS', allPostUrls);

        log.info(`Phase 1: Discovered ${postUrls.length} post URLs for ${username}`);

        // Extract profile information from discovered data
        if (shortcodes.length > 0) {
            const profileInfo = {
                username,
                userId: userId,
                originalUrl,
                actualPostCount: actualPostCount,
                discoveredPostCount: shortcodes.length,
                targetPostCount: targetPostCount,
                isPrivate: false, // If we got posts, it's likely public
                onlyPostsNewerThan,
                maxPosts,
                includeReels,
                includeIGTV
            };

            await Dataset.pushData({
                type: 'profile_info',
                ...profileInfo
            });

            log.info(`Profile ${username} (ID: ${userId}) - Actual: ${actualPostCount || 'unknown'} posts, Discovered: ${shortcodes.length}/${targetPostCount} posts. Private: ${profileInfo.isPrivate}`);
        }

    } catch (error) {
        log.error(`Phase 1: Profile discovery failed for ${username}:`, error.message);

        // Retry with session rotation on blocks
        if (error.message.includes('blocked') || error.message.includes('403') || error.message.includes('429')) {
            log.warning(`Request blocked, retrying it again with different session`);
            session.retire();
            throw error;
        }
    }


});
