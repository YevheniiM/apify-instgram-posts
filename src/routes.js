import { createCheerioRouter, Dataset } from 'crawlee';
import moment from 'moment';

export const router = createCheerioRouter();

// Instagram GraphQL document IDs for different endpoints
const INSTAGRAM_DOCUMENT_IDS = {
    USER_POSTS: '9310670392322965', // For user timeline posts
    SINGLE_POST: '8845758582119845', // For individual post data
    REELS: '7950326061742207', // For reels/videos
    STORIES: '7828915700555087' // For stories (if needed)
};

// Helper function to handle common response validation
function validateResponse(response, session, log, context) {
    // Handle rate limiting and blocks
    if ([403, 429, 401].includes(response.statusCode)) {
        log.warning(`Blocked request (${response.statusCode}) for ${context}, retiring session`);
        session.retire();
        throw new Error(`Blocked request (${response.statusCode}), session retired.`);
    }

    if (response.statusCode !== 200) {
        log.warning(`Unexpected status code ${response.statusCode} for ${context}`);
        throw new Error(`HTTP ${response.statusCode}: ${response.statusText}`);
    }
}

// Helper function to parse JSON with error handling
function parseJsonResponse(responseBody, session, log, context) {
    try {
        const jsonResponse = JSON.parse(responseBody);
        return jsonResponse;
    } catch (err) {
        log.error(`JSON parsing error for ${context}:`, err.message);
        log.debug('Response body preview:', responseBody.substring(0, 500));
        session.retire();
        throw new Error(`JSON parsing error for ${context}, session retired.`);
    }
}

// Helper function to extract hashtags from text
function extractHashtags(text) {
    if (!text) return [];
    const hashtagRegex = /#(\w+)/g;
    const hashtags = [];
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
        hashtags.push(match[1]);
    }
    return hashtags;
}

// Helper function to extract mentions from text
function extractMentions(text) {
    if (!text) return [];
    const mentionRegex = /@(\w+)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        mentions.push(match[1]);
    }
    return mentions;
}

// Helper function to determine post type
function getPostType(post) {
    // Check product type first for specific video types
    if (post.product_type === 'clips') return 'reel';
    if (post.product_type === 'igtv') return 'igtv';

    // Then check typename for general types
    if (post.__typename === 'GraphVideo') return 'video';
    if (post.__typename === 'GraphSidecar') return 'carousel';
    if (post.__typename === 'GraphImage') return 'image';

    return 'unknown';
}

// Helper function to extract comprehensive post data
async function extractPostData(post, username, originalUrl, log) {
    const postTimestamp = moment.unix(post.taken_at_timestamp);
    const postType = getPostType(post);

    // Extract caption text
    const caption = post.edge_media_to_caption?.edges?.[0]?.node?.text || '';

    // Extract hashtags and mentions from caption
    const hashtags = extractHashtags(caption);
    const mentions = extractMentions(caption);

    // Extract tagged users
    const taggedUsers = post.edge_media_to_tagged_user?.edges?.map(edge => ({
        username: edge.node.user.username,
        fullName: edge.node.user.full_name,
        isVerified: edge.node.user.is_verified,
        position: {
            x: edge.node.x,
            y: edge.node.y
        }
    })) || [];

    // Extract location data
    const location = post.location ? {
        id: post.location.id,
        name: post.location.name,
        slug: post.location.slug,
        hasPublicPage: post.location.has_public_page,
        address: post.location.address_json ? JSON.parse(post.location.address_json) : null
    } : null;

    // Extract media URLs for different post types
    const mediaData = extractMediaData(post, postType);

    // Extract engagement data
    const engagement = {
        likesCount: post.edge_liked_by?.count || 0,
        commentsCount: post.edge_media_to_comment?.count || 0,
        viewsCount: post.video_view_count || null,
        playsCount: post.video_play_count || null
    };

    // Extract accessibility caption
    const accessibilityCaption = post.accessibility_caption || null;

    // Build comprehensive post data object
    const postData = {
        type: 'post',
        postType,
        username,
        shortcode: post.shortcode,
        id: post.id,
        url: `https://www.instagram.com/p/${post.shortcode}/`,

        // Media data
        ...mediaData,

        // Content data
        caption,
        hashtags,
        mentions,
        accessibilityCaption,

        // Engagement data
        ...engagement,

        // Metadata
        takenAt: postTimestamp.toISOString(),
        takenAtTimestamp: post.taken_at_timestamp,
        isVideo: post.is_video || false,
        hasAudio: post.has_audio || false,

        // Location and tagging
        location,
        taggedUsers,

        // Technical data
        dimensions: post.dimensions ? {
            height: post.dimensions.height,
            width: post.dimensions.width
        } : null,

        // Additional metadata
        commentsDisabled: post.comments_disabled || false,
        likingDisabled: post.like_and_view_counts_disabled || false,
        isSponsored: post.is_sponsored || false,

        // Scraping metadata
        scrapedAt: new Date().toISOString(),
        profileUrl: originalUrl
    };

    return postData;
}

// Helper function to extract media data based on post type
function extractMediaData(post, postType) {
    const mediaData = {};

    switch (postType) {
        case 'image':
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [post.display_url];
            break;

        case 'video':
        case 'reel':
        case 'igtv':
            mediaData.displayUrl = post.display_url;
            mediaData.videoUrl = post.video_url;
            mediaData.mediaUrls = [post.video_url];
            mediaData.videoDuration = post.video_duration || null;
            break;

        case 'carousel':
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [];

            // Extract all carousel items
            if (post.edge_sidecar_to_children?.edges) {
                const carouselItems = post.edge_sidecar_to_children.edges.map(edge => {
                    const item = edge.node;
                    return {
                        id: item.id,
                        shortcode: item.shortcode,
                        displayUrl: item.display_url,
                        isVideo: item.is_video,
                        videoUrl: item.video_url || null,
                        videoDuration: item.video_duration || null,
                        dimensions: item.dimensions,
                        accessibilityCaption: item.accessibility_caption
                    };
                });

                mediaData.carouselItems = carouselItems;
                mediaData.mediaUrls = carouselItems.map(item =>
                    item.isVideo ? item.videoUrl : item.displayUrl
                ).filter(Boolean);
            }
            break;

        default:
            mediaData.displayUrl = post.display_url;
            mediaData.mediaUrls = [post.display_url];
    }

    return mediaData;
}

// Default handler for Instagram profile data retrieval (to get user ID for post scraping)
router.addDefaultHandler(async ({ request, response, session, log, crawler }) => {
    const { type, username, originalUrl, onlyPostsNewerThan, maxPosts, includeReels, includeIGTV } = request.userData;

    log.info(`Processing Instagram profile for post scraping: ${username} (${request.url})`);

    // Validate response
    validateResponse(response, session, log, `profile ${username}`);

    // Parse JSON response
    const jsonResponse = parseJsonResponse(response.body, session, log, `profile ${username}`);

    // Validate response structure
    if (!jsonResponse.data || !jsonResponse.data.user) {
        log.warning(`Invalid response structure for profile ${username}`);
        return;
    }

    const userData = jsonResponse.data.user;

    // Check if profile is private
    if (userData.is_private) {
        log.warning(`Profile ${username} is private, cannot scrape posts`);
        await Dataset.pushData({
            type: 'error',
            username,
            error: 'Profile is private',
            scrapedAt: new Date().toISOString()
        });
        return;
    }

    const userId = userData.id;
    const postsCount = userData.edge_owner_to_timeline_media?.count || 0;

    log.info(`Profile ${username} (ID: ${userId}) has ${postsCount} posts. Starting post scraping...`);

    // Create GraphQL request body for posts
    const variables = {
        after: null,
        before: null,
        data: {
            count: 12,
            include_reel_media_seen_timestamp: true,
            include_relationship_info: true,
            latest_besties_reel_media: true,
            latest_reel_media: true
        },
        first: 12,
        last: null,
        username: username,
        __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
        __relay_internal__pv__PolarisShareSheetV3relayprovider: true
    };

    const body = `variables=${encodeURIComponent(JSON.stringify(variables))}&doc_id=${INSTAGRAM_DOCUMENT_IDS.USER_POSTS}`;

    // Create request for post pagination
    const postRequest = {
        url: 'https://www.instagram.com/graphql/query',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        },
        payload: body,
        userData: {
            type: 'posts',
            username,
            userId,
            originalUrl,
            onlyPostsNewerThan,
            maxPosts,
            includeReels,
            includeIGTV,
            pageNumber: 1,
            cursor: null,
            totalScraped: 0
        }
    };

    // Add request to crawler
    await crawler.addRequests([postRequest]);

    log.info(`Added post scraping request for ${username}`);
});

// Handler for processing posts with pagination
router.addHandler('posts', async ({ request, response, session, log, crawler }) => {
    const {
        username,
        userId,
        originalUrl,
        onlyPostsNewerThan,
        maxPosts,
        includeReels,
        includeIGTV,
        pageNumber,
        cursor,
        totalScraped
    } = request.userData;

    log.info(`Processing posts page ${pageNumber} for ${username} (cursor: ${cursor || 'initial'})`);

    // Validate response
    validateResponse(response, session, log, `posts page ${pageNumber} for ${username}`);

    // Parse JSON response
    const jsonResponse = parseJsonResponse(response.body, session, log, `posts page ${pageNumber} for ${username}`);

    // Validate GraphQL response structure
    if (!jsonResponse.data || !jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection) {
        log.warning(`Invalid GraphQL response structure for ${username} page ${pageNumber}`);
        return;
    }

    const postsData = jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection;
    const posts = postsData.edges || [];
    const pageInfo = postsData.page_info || {};

    log.info(`Found ${posts.length} posts on page ${pageNumber} for ${username}`);

    let postsProcessed = 0;
    let postsSkipped = 0;

    // Process each post
    for (const postEdge of posts) {
        const post = postEdge.node;

        // Check if we've reached the maximum posts limit
        if (maxPosts && totalScraped + postsProcessed >= maxPosts) {
            log.info(`Reached maximum posts limit (${maxPosts}) for ${username}`);
            break;
        }

        // Apply date filtering if specified
        if (onlyPostsNewerThan) {
            const postTimestamp = moment.unix(post.taken_at_timestamp);
            if (postTimestamp.isBefore(moment(onlyPostsNewerThan))) {
                log.debug(`Skipping post ${post.shortcode} - older than ${onlyPostsNewerThan}`);
                postsSkipped++;
                continue;
            }
        }

        // Determine post type and apply filters
        const postType = getPostType(post);

        // Skip reels if not included
        if (postType === 'reel' && !includeReels) {
            log.debug(`Skipping reel ${post.shortcode} - reels not included`);
            postsSkipped++;
            continue;
        }

        // Skip IGTV if not included
        if (postType === 'igtv' && !includeIGTV) {
            log.debug(`Skipping IGTV ${post.shortcode} - IGTV not included`);
            postsSkipped++;
            continue;
        }

        // Extract comprehensive post data
        const postData = await extractPostData(post, username, originalUrl, log);

        // Save post data
        await Dataset.pushData(postData);
        postsProcessed++;

        log.debug(`Saved ${postType} post ${post.shortcode} from ${username}`);
    }

    log.info(`Page ${pageNumber} for ${username}: processed ${postsProcessed} posts, skipped ${postsSkipped} posts`);

    // Check if there are more pages and we haven't reached limits
    const newTotalScraped = totalScraped + postsProcessed;
    const hasNextPage = pageInfo.has_next_page;
    const nextCursor = pageInfo.end_cursor;

    if (hasNextPage && nextCursor && (!maxPosts || newTotalScraped < maxPosts)) {
        // Create next page request
        const variables = {
            after: nextCursor,
            before: null,
            data: {
                count: 12,
                include_reel_media_seen_timestamp: true,
                include_relationship_info: true,
                latest_besties_reel_media: true,
                latest_reel_media: true
            },
            first: 12,
            last: null,
            username: username,
            __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
            __relay_internal__pv__PolarisShareSheetV3relayprovider: true
        };

        const body = `variables=${encodeURIComponent(JSON.stringify(variables))}&doc_id=${INSTAGRAM_DOCUMENT_IDS.USER_POSTS}`;

        const nextRequest = {
            url: 'https://www.instagram.com/graphql/query',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            payload: body,
            userData: {
                type: 'posts',
                username,
                userId,
                originalUrl,
                onlyPostsNewerThan,
                maxPosts,
                includeReels,
                includeIGTV,
                pageNumber: pageNumber + 1,
                cursor: nextCursor,
                totalScraped: newTotalScraped
            }
        };

        await crawler.addRequests([nextRequest]);
        log.info(`Added next page request for ${username} (page ${pageNumber + 1}, cursor: ${nextCursor})`);
    } else {
        log.info(`Finished scraping posts for ${username}. Total posts scraped: ${newTotalScraped}`);
    }
});
