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

// 🎯 ROBUST LSD RETRIEVAL: Multi-source approach for Instagram's new requirements
export async function fetchFreshLsd(session, log) {
    // Check cache first - 10 minute TTL
    const cacheOK = session.userData.lsdUntil && session.userData.lsdUntil > Date.now();
    if (cacheOK && session.userData.lsd) {
        return session.userData.lsd;
    }

    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    const axios = (await import('axios')).default;
    const cookie = session.getCookieString('https://www.instagram.com') || '';

    // 🔍 DEBUG: Check what Instagram is actually serving us
    try {
        const loginHtml = await axios.get(
            'https://www.instagram.com/accounts/login/',
            { headers: { 'User-Agent': UA }, timeout: 7000 }
        ).then(r => r.data.slice(0, 2048));  // first 2 KB

        log.debug('[LSD-DEBUG] Login page snippet:\n' + loginHtml.replace(/\n/g, ''));
    } catch (error) {
        log.debug(`[LSD-DEBUG] Failed to fetch login page: ${error.message}`);
    }

    // Helper function to try a request and extract token with updated regex patterns
    const tryFetch = async (url, extractor, headers = {}) => {
        try {
            const response = await axios.get(url, {
                headers: { 'User-Agent': UA, Cookie: cookie, ...headers },
                timeout: 7000,
                validateStatus: s => s < 500
            });
            return extractor(response.data, response.headers);
        } catch (error) {
            log.debug(`LSD fetch failed for ${url}: ${error.message}`);
            return null;
        }
    };

    // 🎯 UPDATED EXTRACTOR: Multi-regex approach for June 2025+ changes
    const extractLsdFromHtml = (html) => {
        const tokenRegexes = [
            /"lsd":{"token":"([A-Za-z0-9_-]{16,})"}/,      // June-2025 layout (__additionalDataLoaded)
            /"token":"([A-Za-z0-9_-]{16,})"/,             // fallback pattern
            /name="lsd" value="([^"]+)"/                  // legacy login form
        ];

        for (const regex of tokenRegexes) {
            const match = html.match(regex);
            if (match) {
                log.debug(`✅ LSD token found with pattern: ${regex.source}`);
                return match[1];
            }
        }
        return null;
    };

    let lsd = null;

    // 🎯 METHOD 1: Login page with updated extraction (most reliable)
    lsd = await tryFetch(
        'https://www.instagram.com/accounts/login/',
        extractLsdFromHtml
    );

    // 🎯 METHOD 2: Home page with updated extraction (since manifest.json no longer works)
    if (!lsd) {
        lsd = await tryFetch(
            'https://www.instagram.com/',
            extractLsdFromHtml
        );
    }

    // 🎯 METHOD 3: Any profile page as final fallback
    if (!lsd) {
        lsd = await tryFetch(
            'https://www.instagram.com/instagram/',
            extractLsdFromHtml
        );
    }

    if (lsd) {
        session.userData.lsd = lsd;
        session.userData.lsdUntil = Date.now() + 10 * 60 * 1000; // 10 min TTL
        log.debug(`🔑 New LSD token: ${lsd.slice(0, 8)}...`);
        return lsd;
    }

    log.warning('⚠️ Could not refresh LSD token - continuing without it');
    return null;
}

// 🎯 CONVENIENCE FUNCTION: Ensure LSD token is available
export async function ensureLsdToken(session, log) {
    if (!session.userData.lsdUntil || session.userData.lsdUntil < Date.now()) {
        await fetchFreshLsd(session, log);
    }
    return session.userData.lsd;
}

// 🎯 BACKWARD COMPATIBILITY: Keep old function name working
export async function getSharedLsd(session, log) {
    return await fetchFreshLsd(session, log);
}
