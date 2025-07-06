import { Actor } from 'apify';

// 🎯 GUEST COOKIE MANAGER: Production-ready cookie management for public Instagram scraping
export class GuestCookieManager {
    constructor(log) {
        this.log = log;
        this.cookiePools = new Map();
        this.cookieUsage = new Map();
        this.blockedCookies = new Set();
        this.domainCookies = new Map();
    }

    async getCookieSet(domain = 'instagram.com') {
        if (!this.cookiePools.has(domain)) {
            await this.initializeCookiePool(domain);
        }

        const pool = this.cookiePools.get(domain);
        if (!pool || pool.length === 0) {
            this.log.warning(`No available cookies for ${domain}, creating new ones`);
            await this.initializeCookiePool(domain);
            return this.cookiePools.get(domain)?.[0] || null;
        }

        // Get least used cookie
        const sortedCookies = pool.sort((a, b) => {
            const usageA = this.cookieUsage.get(a.id) || 0;
            const usageB = this.cookieUsage.get(b.id) || 0;
            return usageA - usageB;
        });

        const selectedCookie = sortedCookies[0];
        this.cookieUsage.set(selectedCookie.id, (this.cookieUsage.get(selectedCookie.id) || 0) + 1);
        
        return selectedCookie;
    }

    async initializeCookiePool(domain = 'instagram.com', poolSize = 5) {
        this.log.info(`🚀 Initializing guest cookie factory for public Instagram scraping`);
        const cookies = [];

        for (let i = 1; i <= poolSize; i++) {
            try {
                const cookieSet = await this.createGuestCookieSet(domain);
                if (cookieSet) {
                    cookies.push(cookieSet);
                    this.log.info(`✅ Created guest jar ${i}: ${cookieSet.cookies.length} cookies`);
                } else {
                    this.log.warning(`❌ Failed to create guest jar ${i}`);
                }
            } catch (error) {
                this.log.warning(`❌ Error creating guest jar ${i}: ${error.message}`);
            }
        }

        this.cookiePools.set(domain, cookies);
        this.log.info(`🎯 Guest cookie factory ready: ${cookies.length} jars created`);
        return cookies;
    }

    async createGuestCookieSet(domain = 'instagram.com') {
        const axios = (await import('axios')).default;
        
        try {
            const response = await axios.get('https://www.instagram.com/', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                timeout: 10000,
                validateStatus: () => true
            });

            if (response.status === 200 && response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'];
                const cookieSet = {
                    id: `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    cookies: cookies,
                    domain: domain,
                    created: Date.now(),
                    lsdUntil: Date.now() + 12*60*1000  // 12 min initial TTL
                };

                return cookieSet;
            }
        } catch (error) {
            this.log.debug(`Failed to create guest cookie set: ${error.message}`);
        }

        return null;
    }

    blockCookieSet(cookieId) {
        this.blockedCookies.add(cookieId);
        this.log.debug(`🚫 Blocked cookie set: ${cookieId}`);
    }

    isBlocked(cookieId) {
        return this.blockedCookies.has(cookieId);
    }
}

// 🎯 ROBUST LSD RETRIEVAL: Hardened multi-source approach for production
export async function fetchFreshLsd(session, log) {
    // Check cache first - 15 minute TTL
    if (session.userData.lsd && session.userData.lsdUntil > Date.now()) {
        return session.userData.lsd;
    }

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    
    // Node 18 ESM/CJS friendly axios import
    const axiosOrig = (await import('axios')).default;
    const axios = axiosOrig?.default ? axiosOrig.default : axiosOrig;

    const cookie = session.getCookieString('https://www.instagram.com') || '';
    const common = { 
        headers: { 'User-Agent': UA, Cookie: cookie },
        timeout: 8000,      // 8s per shot
        validateStatus: s => s < 500 
    };

    // Updated regex patterns for June 2025+ Instagram changes
    const LSD_RX = /["']token["']\s*:\s*["']([A-Za-z0-9_-]{12,})["']/;
    const INPUT_RX = /name=["']lsd["']\s+value=["']([A-Za-z0-9_-]{12,})["']/;

    const sources = [
        {
            note: 'login_page',
            url: 'https://www.instagram.com/accounts/login/',
            hunt: (html) => html.match(LSD_RX)?.[1] || html.match(INPUT_RX)?.[1]
        },
        {
            note: 'manifest_json',
            url: 'https://www.instagram.com/data/manifest.json?__a=1&__d=dis',
            hunt: (json) => (typeof json === 'object' && json?.lsd) ? json.lsd : null,
            json: true
        },
        {
            note: 'home_html',
            url: 'https://www.instagram.com/',
            hunt: (html) => html.match(LSD_RX)?.[1]
        }
    ];

    for (const src of sources) {
        try {
            log.debug(`[LSD-FETCH] ${src.note} → ${src.url}`);
            
            const requestConfig = src.json ? 
                { ...common, responseType: 'json', headers: { ...common.headers, Accept: 'application/json' } } :
                common;
                
            const resp = await axios.get(src.url, requestConfig);
            const body = src.json ? resp.data : String(resp.data);
            const token = src.hunt(body);

            if (token) {
                session.userData.lsd = token;
                session.userData.lsdUntil = Date.now() + 15 * 60 * 1000;   // keep 15 min
                log.info(`[LSD-OK] ${token.slice(0,8)}… from ${src.note}`);
                return token;
            }

            log.debug(`[LSD-MISS] pattern not found in ${src.note}`);
        } catch (e) {
            log.debug(`[LSD-ERR] ${src.note} – ${e.message}`);
        }
    }

    // Total failure - throw error instead of returning null
    throw new Error('Unable to obtain LSD token from any known source');
}

// 🎯 CONVENIENCE FUNCTION: Ensure LSD token is available
export async function ensureLsdToken(session, log) {
    // 🔧 CRITICAL FIX: Treat placeholder/empty tokens as stale
    const stale = !session.userData.lsd ||
                  session.userData.lsd === 'missing' ||         // placeholder tokens
                  session.userData.lsd.length < 10 ||           // too short to be valid
                  !session.userData.lsdUntil ||
                  session.userData.lsdUntil < Date.now();

    if (stale) {
        log.debug('[LSD] cache miss or expired – going to network');
        try {
            session.userData.lsd = await fetchFreshLsd(session, log);
        } catch (error) {
            log.warning(`[LSD] Failed to fetch real token: ${error.message}`);
            // Fallback to placeholder only if real fetch fails
            const crypto = await import('crypto');
            session.userData.lsd = crypto.randomBytes(20).toString('base64url');
            session.userData.lsdUntil = Date.now() + 5 * 60 * 1000;
            log.warning(`[LSD] Using fallback token: ${session.userData.lsd.slice(0,8)}…`);
        }
    } else {
        log.debug(`[LSD] cached token ok – valid for ${Math.round((session.userData.lsdUntil-Date.now())/1000)} s`);
    }

    return session.userData.lsd;
}

// 🎯 ENHANCED TOKEN EXTRACTION: Extract dynamic tokens from Instagram responses
export function extractTokensFromResponse(response, log) {
    const tokens = {
        wwwClaim: null,
        asbdId: null,
        lsd: null
    };

    try {
        // Extract from headers
        if (response.headers['ig-set-www-claim']) {
            tokens.wwwClaim = response.headers['ig-set-www-claim'];
        }
        if (response.headers['ig-set-asbd-id']) {
            tokens.asbdId = response.headers['ig-set-asbd-id'];
        }

        // Extract LSD from HTML content
        if (typeof response.data === 'string') {
            const lsdMatch = response.data.match(/"lsd":\{"token":"([^"]+)"/);
            if (lsdMatch) {
                tokens.lsd = lsdMatch[1];
            }
        }

        log.debug(`🔑 Extracted tokens: WWW-Claim="${tokens.wwwClaim}", ASBD-ID="${tokens.asbdId}", LSD="${tokens.lsd ? 'present' : 'MISSING'}"`);
        return tokens;
    } catch (error) {
        log.debug(`Token extraction error: ${error.message}`);
        return tokens;
    }
}

// 🎯 COOKIE STRING BUILDER: Build cookie string from cookie set
export function buildCookieString(cookieSet) {
    if (!cookieSet || !cookieSet.cookies) {
        return '';
    }

    return cookieSet.cookies
        .map(cookie => {
            const parts = cookie.split(';')[0]; // Get only the name=value part
            return parts;
        })
        .join('; ');
}
