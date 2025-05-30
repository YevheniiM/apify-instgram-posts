import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
import { router } from './routes.js';

await Actor.init();

// Get input from Actor
const input = await Actor.getInput() || {};
log.info('Instagram Post Scraper - Actor input:', input);

// Validate input
if (!input.directUrls || !Array.isArray(input.directUrls) || input.directUrls.length === 0) {
    log.error('Invalid input: directUrls must be a non-empty array of Instagram profile URLs');
    await Actor.exit();
}

// Configure Apify Proxies for robust scraping
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
});

// Create CheerioCrawler with session management and proxy configuration
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 8, // Reduced for more stable scraping
    sessionPoolOptions: {
        sessionOptions: {
            maxUsageCount: 15, // Reduced for better session rotation
            maxErrorScore: 3
        },
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 15,
            maxErrorScore: 3
        }
    },
    maxRequestRetries: 5, // Increased for better reliability
    requestHandlerTimeoutSecs: 60,
    requestHandler: router,
});

// Process input URLs and extract usernames
const startUrls = [];
const processedUsernames = new Set();

for (const url of input.directUrls) {
    if (!url.includes('instagram.com')) {
        log.warning(`Skipping non-Instagram URL: ${url}`);
        continue;
    }

    // Extract username from Instagram URL
    const usernameMatch = url.match(/instagram\.com\/([^/?]+)/);
    if (!usernameMatch) {
        log.warning(`Could not extract username from URL: ${url}`);
        continue;
    }

    const username = usernameMatch[1];

    // Skip duplicate usernames
    if (processedUsernames.has(username)) {
        log.info(`Skipping duplicate username: ${username}`);
        continue;
    }

    processedUsernames.add(username);

    // First, get user profile to extract user ID for post scraping
    startUrls.push({
        url: `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459', // Instagram's public app ID
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        },
        userData: {
            type: 'profile',
            username,
            originalUrl: url,
            onlyPostsNewerThan: input.onlyPostsNewerThan,
            maxPosts: input.maxPosts || null,
            includeStories: input.includeStories || false,
            includeReels: input.includeReels || true,
            includeIGTV: input.includeIGTV || true
        }
    });
}

if (startUrls.length === 0) {
    log.error('No valid Instagram URLs found in input. Please provide valid Instagram profile URLs.');
    await Actor.exit();
}

log.info(`Starting Instagram post scraper for ${startUrls.length} profiles`);
log.info('Configuration:', {
    maxConcurrency: 8,
    maxRetries: 5,
    sessionMaxUsage: 15,
    dateFilter: input.onlyPostsNewerThan || 'none',
    maxPosts: input.maxPosts || 'unlimited'
});

await crawler.run(startUrls);

log.info('Instagram Post Scraper completed successfully');
log.info('[Status message]: Post scraper finished');

await Actor.exit();
