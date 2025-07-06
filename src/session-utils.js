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

// 🎯 ROBUST LSD RETRIEVAL: Fixed to handle IG's new requirements
export async function getSharedLsd(session, log) {
    const axios = (await import('axios')).default;
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const cookieStr = session.getCookieString('https://www.instagram.com');
    const headers = {
        'User-Agent': UA,
        'X-IG-App-ID': '936619743392459', // 🎯 CRITICAL: Required for LSD endpoint
        'Cookie': cookieStr,
        'Accept': 'application/json, */*'
    };

    try {
        // 🎯 PRIMARY: Try official LSD endpoint with required headers
        const url = 'https://www.instagram.com/api/v1/web/get_shared_lsd/?surface=www';
        const res = await axios.get(url, {
            headers,
            timeout: 7000,
            validateStatus: s => s < 500
        });

        if (res.status === 200 && res.data?.lsd?.token) {
            session.userData.lsd = res.data.lsd.token;
            session.userData.lsdUntil = Date.now() + 14 * 60 * 1000;
            log.debug(`✅ New LSD token: ${session.userData.lsd.slice(0, 8)}...`);
            return session.userData.lsd;
        }

        log.warning(`⚠️ LSD endpoint returned ${res.status}, trying HTML fallback`);
    } catch (error) {
        log.warning(`⚠️ LSD endpoint failed: ${error.message}, trying HTML fallback`);
    }

    try {
        // 🎯 FALLBACK: Extract LSD token from HTML meta tag
        const html = await axios.get('https://www.instagram.com/', {
            headers,
            timeout: 7000
        });

        const match = html.data.match(/"token":"([A-Za-z0-9-_]{16,})"/);
        if (match) {
            session.userData.lsd = match[1];
            session.userData.lsdUntil = Date.now() + 14 * 60 * 1000;
            log.debug(`✅ LSD token from HTML: ${session.userData.lsd.slice(0, 8)}...`);
            return session.userData.lsd;
        }

        log.warning('⚠️ No LSD token found in HTML');
    } catch (error) {
        log.warning(`⚠️ HTML fallback failed: ${error.message}`);
    }

    log.warning('⚠️ Could not refresh LSD token');
    return null;
}

// Ensure session has valid LSD token before GraphQL calls
export async function ensureLsdToken(session, log) {
    if (!session.userData.lsdUntil || session.userData.lsdUntil < Date.now()) {
        log.debug('🔄 LSD token expired or missing, fetching new one');
        await getSharedLsd(session, log);
    }
    return session.userData.lsd;
}
