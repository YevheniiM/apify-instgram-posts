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
            const resp = await axios.get(src.url, {
                headers: { 'User-Agent': UA, Cookie: cookie },
                timeout: 7000,
                validateStatus: s => s < 500
            });

            log.debug(`[LSD-FETCH] ${src.note} → ${resp.status} / ${resp.headers['content-type']}`);
            log.debug(`[LSD-HEAD]  wClaim=${resp.headers['ig-set-www-claim']}  asbd=${resp.headers['ig-set-asbd-id']}`);
            log.debug('[LSD-BODY] ' + String(resp.data).slice(0,1024).replace(/\n/g,''));

            const html = String(resp.data);
            const rx = /"lsd":\{"token":"([A-Za-z0-9_-]{16,})"/;      // June 2025 format
            const m  = html.match(rx) || html.match(/name="lsd" value="([^"]+)"/);
            if (m) {
                session.userData.lsd = m[1];
                session.userData.lsdUntil = Date.now() + 10*60*1000;
                log.info(`[LSD] extracted ${m[1].slice(0,8)}… from ${src.note}`);
                return m[1];
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
    const ttlOk = session.userData.lsd && session.userData.lsdUntil > Date.now();

    if (!ttlOk) {
        log.info('[LSD] cache miss or expired – going to network');
        await fetchFreshLsd(session, log);

        // FORCE a log even if the fetch failed
        if (!session.userData.lsd) {
            log.warning('[LSD] still empty after refresh – injecting dummy token so flow continues');
            const crypto = await import('crypto');
            session.userData.lsd = crypto.randomBytes(12).toString('base64');  // 16 chars
            session.userData.lsdUntil = Date.now() + 5*60*1000;                // 5 min TTL
        }
    }
    return session.userData.lsd;
}

// 🎯 BACKWARD COMPATIBILITY: Keep old function name working
export async function getSharedLsd(session, log) {
    return await fetchFreshLsd(session, log);
}
