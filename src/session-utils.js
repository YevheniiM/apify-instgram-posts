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
