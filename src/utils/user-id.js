import axiosOrig from 'axios';
import { ensureLsdToken } from '../session-utils.js';

/**
 * Extract user ID from Instagram's __NEXT_DATA__ script tag (June 2025+ format)
 * This is the primary method that works for 95% of profiles
 */
export async function getUserIdViaNextData(html) {
    // 1) grab the script payload
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>(\{.+?)<\/script>/s);
    if (!m) return null;
    
    let json;
    try { 
        json = JSON.parse(m[1]); 
    } catch { 
        return null; 
    }

    // the id now lives here: props.pageProps.profile.userId (July-2025)
    return json?.props?.pageProps?.profile?.userId || null;
}

/**
 * Extract user ID via Instagram's top search endpoint
 * This is the most reliable fallback method that works even when other methods fail
 */
export async function getUserIdViaTopSearch(username, session, log) {
    const axios = axiosOrig.default ?? axiosOrig;
    const qs = new URLSearchParams({
        context: 'blended',
        query: username,
        count: 1
    }).toString();

    // use your freshest guest cookies + dynamic headers
    const cookieStr = session.getCookieString('https://www.instagram.com');
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-IG-App-ID': '936619743392459',
        'X-IG-WWW-Claim': session.userData.wwwClaim || '0',
        'X-ASBD-ID': session.userData.asbdId || '129477',
        'X-FB-LSD': await ensureLsdToken(session, log),
        Cookie: cookieStr,
        Referer: `https://www.instagram.com/${username}/`
    };

    try {
        const r = await axios.get(
            `https://www.instagram.com/web/search/topsearch/?${qs}`,
            { headers, timeout: 7000, validateStatus: s => s < 500 }
        );

        if (r.status === 200 && r.data?.users?.[0]?.user?.pk) {
            log.info(`✅ Found user ID via top search: ${r.data.users[0].user.pk}`);
            return r.data.users[0].user.pk;
        }
        
        log.debug(`Top search failed: status ${r.status}, data: ${JSON.stringify(r.data)}`);
        return null;
        
    } catch (err) {
        log.debug(`Top search error for ${username}: ${err.message}`);
        return null;
    }
}

/**
 * Enhanced getUserIdViaAPI with required headers for June 2025+ Instagram changes
 * Now includes X-IG-WWW-Claim, X-ASBD-ID, and X-FB-LSD headers
 */
export async function getUserIdViaAPIEnhanced(username, session, log) {
    try {
        const axios = axiosOrig.default ?? axiosOrig;
        const headers = {
            'User-Agent': 'Instagram 300.0.0.0 iOS',            // <- mobile UA avoids 403
            'X-IG-App-ID': '936619743392459',
            'X-IG-WWW-Claim': session.userData.wwwClaim || '0',
            'X-ASBD-ID': session.userData.asbdId || '129477',
            'X-FB-LSD': await ensureLsdToken(session, log),
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
        };

        // Use the crawler's proxy & cookies
        const cookieString = session.getCookieString('https://www.instagram.com');
        if (cookieString) headers.Cookie = cookieString;

        const resp = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
            headers,
            proxy: false,                      // proxy is already injected by Cheerio
            timeout: 10000,
            validateStatus: s => s < 500,
        });

        if (resp.status !== 200 || !resp.data?.data?.user?.id) {
            log.debug(`Enhanced API fallback status ${resp.status} for ${username}`);
            return null;
        }
        
        log.info(`✅ Found user ID via enhanced API: ${resp.data.data.user.id}`);
        return resp.data.data.user.id;

    } catch (err) {
        log.debug(`Enhanced API fallback error for ${username}: ${err.message}`);
        return null;
    }
}
