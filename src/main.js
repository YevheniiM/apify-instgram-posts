import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
import { router } from './routes.js';

await Actor.init();

// Get input from Actor
const input = await Actor.getInput() || {};
log.info('Actor input:', input);

// Configure Apify Proxies for robust scraping
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
});

// Create CheerioCrawler with session management and proxy configuration
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 10,
    sessionPoolOptions: {
        sessionOptions: { maxUsageCount: 20 },
    },
    maxRequestRetries: 3,
    requestHandler: router,
});

// Process input URLs
const startUrls = [];
if (input.directUrls && Array.isArray(input.directUrls)) {
    for (const url of input.directUrls) {
        if (url.includes('instagram.com')) {
            // Extract username from Instagram URL
            const usernameMatch = url.match(/instagram\.com\/([^/?]+)/);
            if (usernameMatch) {
                const username = usernameMatch[1];
                startUrls.push({
                    url: `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-origin'
                    },
                    userData: {
                        username,
                        originalUrl: url,
                        onlyPostsNewerThan: input.onlyPostsNewerThan
                    }
                });
            }
        }
    }
}

if (startUrls.length === 0) {
    log.warning('No valid Instagram URLs found in input. Please provide Instagram profile URLs.');
    await Actor.exit();
}

log.info(`Starting to crawl ${startUrls.length} Instagram profiles`);

await crawler.run(startUrls);

log.info('CheerioCrawler:Statistics:', 'Crawler finished successfully');
log.info('[Status message]: Post scraper finished');

await Actor.exit();
