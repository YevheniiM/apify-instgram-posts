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
