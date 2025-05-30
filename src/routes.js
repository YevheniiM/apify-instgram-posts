import { createCheerioRouter, Dataset } from 'crawlee';
import moment from 'moment';

export const router = createCheerioRouter();

// Default handler for Instagram profile data retrieval
router.addDefaultHandler(async ({ request, response, session, log }) => {
    const { username, originalUrl, onlyPostsNewerThan } = request.userData;

    log.info(`Processing Instagram profile: ${username} (${request.url})`);

    // Handle blocked requests and session management
    if ([403, 429].includes(response.statusCode)) {
        session.retire();
        throw new Error('Blocked request, session retired.');
    }

    // Handle network issues and JSON parsing errors
    let jsonResponse;
    try {
        jsonResponse = JSON.parse(response.body);
    } catch (err) {
        log.error(`JSON parsing error for ${username}:`, err.message);
        session.retire();
        throw new Error('JSON parsing error, session retired.');
    }

    // Validate response structure
    if (!jsonResponse.data || !jsonResponse.data.user) {
        log.warning(`Invalid response structure for ${username}`);
        return;
    }

    const userData = jsonResponse.data.user;
    log.info(`Successfully retrieved profile data for ${username}. Posts count: ${userData.edge_owner_to_timeline_media?.count || 0}`);

    // Extract basic profile information
    const profileData = {
        username: userData.username,
        fullName: userData.full_name,
        biography: userData.biography,
        followersCount: userData.edge_followed_by?.count || 0,
        followingCount: userData.edge_follow?.count || 0,
        postsCount: userData.edge_owner_to_timeline_media?.count || 0,
        isPrivate: userData.is_private,
        isVerified: userData.is_verified,
        profilePicUrl: userData.profile_pic_url_hd,
        externalUrl: userData.external_url,
        scrapedAt: new Date().toISOString(),
        originalUrl
    };

    // Save profile data
    await Dataset.pushData({
        type: 'profile',
        ...profileData
    });

    // Process posts if available and account is not private
    if (!userData.is_private && userData.edge_owner_to_timeline_media?.edges) {
        const posts = userData.edge_owner_to_timeline_media.edges;

        for (const postEdge of posts) {
            const post = postEdge.node;
            const postTimestamp = moment.unix(post.taken_at_timestamp);

            // Apply date filtering if specified
            if (onlyPostsNewerThan) {
                if (postTimestamp.isBefore(moment(onlyPostsNewerThan))) {
                    log.info(`Skipping post ${post.shortcode} - older than ${onlyPostsNewerThan}`);
                    continue;
                }
            }

            // Extract post data
            const postData = {
                type: 'post',
                username,
                shortcode: post.shortcode,
                id: post.id,
                displayUrl: post.display_url,
                isVideo: post.is_video,
                likesCount: post.edge_liked_by?.count || 0,
                commentsCount: post.edge_media_to_comment?.count || 0,
                caption: post.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                takenAt: postTimestamp.toISOString(),
                takenAtTimestamp: post.taken_at_timestamp,
                dimensions: {
                    height: post.dimensions?.height,
                    width: post.dimensions?.width
                },
                scrapedAt: new Date().toISOString(),
                profileUrl: originalUrl
            };

            // Save post data
            await Dataset.pushData(postData);
            log.info(`Saved post ${post.shortcode} from ${username}`);
        }

        log.info(`Processed ${posts.length} posts for ${username}`);
    } else if (userData.is_private) {
        log.info(`Profile ${username} is private, skipping posts`);
    } else {
        log.info(`No posts found for ${username}`);
    }
});

// Handler for pagination (will be implemented in Step 5)
router.addHandler('pagination', async ({ request, response, session, log }) => {
    log.info(`Processing pagination: ${request.url}`);

    // Handle blocked requests
    if ([403, 429].includes(response.statusCode)) {
        session.retire();
        throw new Error('Blocked request, session retired.');
    }

    // This will be implemented in Step 5 for GraphQL pagination
    log.info('Pagination handler - to be implemented in Step 5');
});
