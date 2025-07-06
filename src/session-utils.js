export function primeCsrf(session) {
  if (!session.getCookieString('www.instagram.com').includes('csrftoken')) {
      session.setCookie({
          name: 'csrftoken',
          value: 'missing',
          domain: '.instagram.com',
          path: '/',
      });
  }
}

// Verify that session has all required cookies for GraphQL authentication
export function validateSessionCookies(session, log) {
    const cookieString = session.getCookieString('www.instagram.com');
    const requiredCookies = ['csrftoken', 'sessionid', 'ds_user_id'];
    const presentCookies = cookieString.split(';').map(c => c.split('=')[0].trim());
    const missingCookies = requiredCookies.filter(c => !presentCookies.includes(c));

    if (missingCookies.length > 0) {
        log.warning(`Missing required cookies: ${missingCookies.join(', ')}`);
        return false;
    }

    return true;
}

// Extract CSRF token from cookie string
export function extractCsrfToken(cookieString) {
    const csrfMatch = cookieString.match(/csrftoken=([^;]+)/);
    return csrfMatch ? csrfMatch[1] : null;
}

// Proactively refresh CSRF token when authentication starts failing
export async function refreshCsrfToken(session, log) {
    try {
        const axios = (await import('axios')).default;

        log.info('🔄 Refreshing CSRF token due to authentication issues');

        const response = await axios.get('https://www.instagram.com/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Cookie': session.getCookieString('https://www.instagram.com')
            },
            timeout: 7000,
            validateStatus: s => s < 500
        });

        if (response.status === 200) {
            // Extract new CSRF token from response
            const newCsrfMatch = response.data.match(/"csrf_token":"([^"]+)"/);
            if (newCsrfMatch) {
                session.setCookie({
                    name: 'csrftoken',
                    value: newCsrfMatch[1],
                    domain: '.instagram.com',
                    path: '/'
                });
                log.info('✅ CSRF token refreshed successfully');
                return true;
            }
        }

        log.warning('⚠️ CSRF token refresh failed - no new token found');
        return false;

    } catch (error) {
        log.warning(`⚠️ CSRF token refresh failed: ${error.message}`);
        return false;
    }
}

// Get fresh LSD token without re-downloading full profile HTML
export async function getFreshLsd(session, log) {
    try {
        const axios = (await import('axios')).default;

        const response = await axios.get('https://www.instagram.com/data/manifest.json?__a=1', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': session.getCookieString('https://www.instagram.com')
            },
            timeout: 5000,
            validateStatus: s => s < 500
        });

        if (response.status === 200 && response.data?.lsd) {
            log.debug('✅ Fresh LSD token obtained from manifest endpoint');
            return response.data.lsd;
        }

        return null;

    } catch (error) {
        log.debug(`LSD refresh failed: ${error.message}`);
        return null;
    }
}

// 🎯 ROBUST LSD RETRIEVAL: Enhanced debugging to see what Instagram actually serves
export async function fetchFreshLsd(session, log) {
    // � Minimal instrumentation to confirm function is called
    log.debug('[LSD-BOOT] entered fetchFreshLsd');

    // �🔑 Step 1: Prove exactly where it blows up
    try {
        const axiosMod = await import('axios');
        if (!axiosMod?.default) throw new Error('axios import returned undefined');
    } catch (e) {
        log.error('[LSD-BOOT] early failure *before* first request:', e.stack || e);
        throw e;          // let caller bubble-up so you always see it
    }

    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const axios = (await import('axios')).default;
    const cookie = session.getCookieString('https://www.instagram.com') || '';

    const sources = [
        { url: 'https://www.instagram.com/accounts/login/',
          note: 'login-form' },
        { url: 'https://www.instagram.com/',
          note: 'front-page' }
    ];

    for (const src of sources) {
        try {
            // 🔑 Step 2: Expose network stalls with granular timing
            log.debug(`[LSD-FETCH] GET ${src.note} → ${src.url}`);
            const t0 = Date.now();

            const resp = await axios.get(src.url, {
                headers: { 'User-Agent': UA, Cookie: cookie },
                timeout: 20000,  // Increased timeout to confirm proxy stalls
                validateStatus: s => s < 500
            });

            log.debug(`[LSD-DONE] ${src.note} ${resp.status} in ${Date.now()-t0} ms`);
            log.debug(`[LSD-FETCH] ${src.note} → ${resp.status} / ${resp.headers['content-type']}`);
            log.debug(`[LSD-HEAD]  wClaim=${resp.headers['ig-set-www-claim']}  asbd=${resp.headers['ig-set-asbd-id']}`);
            log.debug('[LSD-BODY] ' + String(resp.data).slice(0,2048).replace(/\n/g,''));  // Increased to 2KB

            const html = String(resp.data);

            // 🔑 Step 3: Enhanced regex patterns for different LSD formats
            const patterns = [
                /"lsd":\{"token":"([A-Za-z0-9_-]{16,})"/,           // June 2025 format
                /name=["']lsd["']\s+value=["']([^"']{8,})/i,        // Login form with flexible quotes/whitespace
                /"token":"([A-Za-z0-9_-]{16,})"/,                  // Generic token pattern
                /name=["']jazoest["']\s+value=["']([^"']{8,})/i     // Alternative field name
            ];

            let m = null;
            for (const pattern of patterns) {
                m = html.match(pattern);
                if (m) {
                    log.debug(`✅ LSD token found with pattern: ${pattern.source}`);
                    break;
                }
            }

            if (m) {
                session.userData.lsd = m[1];
                session.userData.lsdUntil = Date.now() + 10*60*1000;
                log.info(`[LSD] extracted ${m[1].slice(0,8)}… from ${src.note}`);
                return m[1];
            } else {
                log.debug(`❌ No LSD token found in ${src.note} HTML`);
            }
        } catch (err) {
            log.debug(`[LSD-ERR] ${src.note}: ${err.message}`);
        }
    }

    // nothing found
    log.warning('⚠️ Could not refresh LSD token – continuing without it');
    return null;
}

// 🎯 CONVENIENCE FUNCTION: Ensure LSD token is available
export async function ensureLsdToken(session, log) {
    // 🔧 CRITICAL FIX: Check both token existence AND expiry
    if (!session.userData.lsd                     // no token yet
        || !session.userData.lsdUntil             // never fetched
        || session.userData.lsdUntil < Date.now() // expired
    ) {
        log.debug('[LSD] cache miss or expired – going to network');
        session.userData.lsd = await fetchFreshLsd(session, log);
    } else {
        log.debug(`[LSD] cached token ok – valid for ${Math.round((session.userData.lsdUntil-Date.now())/1000)} s`);
    }

    // 🚑 Quick rollback safety-net: fallback to random token if real extraction failed
    if (!session.userData.lsd) {
        const crypto = await import('crypto');
        session.userData.lsd = crypto.randomBytes(20).toString('base64url');
        log.warning(`[LSD] injecting placeholder token ${session.userData.lsd.slice(0,8)}…`);
    }

    return session.userData.lsd;
}

// 🎯 BACKWARD COMPATIBILITY: Keep old function name working
export async function getSharedLsd(session, log) {
    return await fetchFreshLsd(session, log);
}
