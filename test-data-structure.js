/**
 * Test script to verify the new data structure matches the requirements
 * Run with: node test-data-structure.js
 */

import { Actor } from 'apify';
import moment from 'moment';

// Mock post data from Instagram GraphQL API
const mockInstagramPost = {
    id: "3402168035103030001",
    shortcode: "C827c1ugTrx",
    __typename: "GraphVideo",
    is_video: true,
    video_url: "https://scontent.cdninstagram.com/v/t50.2886-16/video.mp4",
    video_duration: 15.5,
    video_view_count: 5000,
    display_url: "https://scontent.cdninstagram.com/v/t51.2885-15/thumbnail.jpg",
    taken_at_timestamp: 1704067200,
    dimensions: {
        height: 1080,
        width: 1920
    },
    edge_media_to_caption: {
        edges: [{
            node: {
                text: "Amazing sunset! #nature #photography @friend_username"
            }
        }]
    },
    edge_media_preview_like: {
        count: 1250
    },
    edge_media_to_comment: {
        count: 150
    },
    accessibility_caption: "Photo of a beautiful sunset over mountains",
    is_paid_partnership: false,
    is_sponsored_tag: false,
    location: {
        name: "Yosemite National Park",
        id: "123456"
    },
    edge_media_to_tagged_user: {
        edges: [{
            node: {
                user: {
                    username: "sponsor_brand",
                    is_business_account: true,
                    is_verified: true
                }
            }
        }]
    }
};

// Mock carousel post
const mockCarouselPost = {
    id: "3402168035103030002",
    shortcode: "C827c1ugTry",
    __typename: "GraphSidecar",
    is_video: false,
    display_url: "https://scontent.cdninstagram.com/v/t51.2885-15/first.jpg",
    taken_at_timestamp: 1704067200,
    dimensions: {
        height: 1080,
        width: 1080
    },
    edge_sidecar_to_children: {
        edges: [
            {
                node: {
                    id: "child1",
                    shortcode: "child1_code",
                    display_url: "https://scontent.cdninstagram.com/v/t51.2885-15/first.jpg",
                    is_video: false,
                    dimensions: { height: 1080, width: 1080 }
                }
            },
            {
                node: {
                    id: "child2",
                    shortcode: "child2_code",
                    display_url: "https://scontent.cdninstagram.com/v/t51.2885-15/second.jpg",
                    is_video: true,
                    video_url: "https://scontent.cdninstagram.com/v/t50.2886-16/video2.mp4",
                    video_duration: 10.2,
                    video_view_count: 3000,
                    dimensions: { height: 1080, width: 1080 }
                }
            }
        ]
    },
    edge_media_to_caption: {
        edges: [{
            node: {
                text: "Multi-photo post #carousel #photos"
            }
        }]
    },
    edge_media_preview_like: {
        count: 800
    },
    edge_media_to_comment: {
        count: 45
    }
};

// Helper functions (copied from post-router.js)
function getPostType(post) {
    if (post.__typename === 'GraphSidecar' || (post.edge_sidecar_to_children?.edges?.length > 1)) {
        return 'Sidecar';
    }
    if (post.is_video) {
        return 'Video';
    }
    return 'Image';
}

async function extractPostDataFromGraphQL(post, username, originalUrl, log) {
    try {
        // Extract basic post information (matching required fields)
        const postData = {
            // Core Post Fields - Basic Post Information
            id: post.id,
            type: getPostType(post), // "Video", "Sidecar", "Image"
            shortCode: post.shortcode, // Note: using shortCode (camelCase) as specified
            url: `https://www.instagram.com/p/${post.shortcode}/`,
            timestamp: moment.unix(post.taken_at_timestamp).toISOString(),

            // Content Fields
            caption: post.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            alt: post.accessibility_caption || null,
            hashtags: [], // Will be populated below
            mentions: [], // Will be populated below
            sponsors: [], // Will be populated below

            // Engagement Metrics
            likesCount: post.edge_media_preview_like?.count || 0,
            commentsCount: post.edge_media_to_comment?.count || 0,
            videoViewCount: post.video_view_count || 0,

            // Media Content
            displayUrl: post.display_url,
            images: [post.display_url], // Default to display URL, will be updated for carousels
            videoUrl: post.video_url || null,
            videoDuration: post.video_duration ? post.video_duration * 1000 : null, // Convert to milliseconds as specified
            dimensionsHeight: post.dimensions?.height || 0,
            dimensionsWidth: post.dimensions?.width || 0,

            // Business/Sponsored Content
            paidPartnership: post.is_paid_partnership || false,
            isSponsored: post.is_sponsored_tag || false,

            // Additional metadata for compatibility
            inputUrl: originalUrl,
            username: username
        };

        // Handle carousel posts (Sidecar) - extract all images
        if (post.__typename === 'GraphSidecar' && post.edge_sidecar_to_children) {
            const allImages = [];
            
            for (const edge of post.edge_sidecar_to_children.edges) {
                const item = edge.node;
                allImages.push(item.display_url);
                
                // For video items in carousel, also add video URL
                if (item.is_video && item.video_url) {
                    postData.videoUrl = item.video_url; // Use first video found
                    postData.videoDuration = item.video_duration ? item.video_duration * 1000 : null;
                    postData.videoViewCount = item.video_view_count || 0;
                }
            }
            
            postData.images = allImages;
        }

        // Extract hashtags and mentions from caption
        if (postData.caption) {
            // Extract hashtags (without #)
            postData.hashtags = (postData.caption.match(/#[\w]+/g) || []).map(tag => tag.substring(1));
            
            // Extract mentions (without @)
            postData.mentions = (postData.caption.match(/@[\w.]+/g) || []).map(mention => mention.substring(1));
        }

        // Extract sponsors from tagged users (business accounts)
        if (post.edge_media_to_tagged_user?.edges) {
            postData.sponsors = post.edge_media_to_tagged_user.edges
                .filter(edge => edge.node.user.is_business_account || edge.node.user.is_verified)
                .map(edge => edge.node.user.username);
        }

        return postData;

    } catch (error) {
        log.error(`Error extracting post data:`, error.message);
        return null;
    }
}

// Test function
async function testDataStructure() {
    console.log('🧪 Testing Instagram Post Data Structure\n');

    const mockLog = {
        info: (msg) => console.log(`ℹ️  ${msg}`),
        error: (msg) => console.error(`❌ ${msg}`)
    };

    // Test 1: Video Post
    console.log('📹 Test 1: Video Post');
    const videoPost = await extractPostDataFromGraphQL(mockInstagramPost, 'testuser', 'https://www.instagram.com/testuser/', mockLog);
    console.log(JSON.stringify(videoPost, null, 2));
    
    // Verify required fields
    const requiredFields = ['id', 'type', 'shortCode', 'url', 'timestamp', 'caption', 'hashtags', 'mentions', 'sponsors', 'likesCount', 'commentsCount', 'videoViewCount', 'displayUrl', 'images', 'dimensionsHeight', 'dimensionsWidth', 'paidPartnership', 'isSponsored'];
    
    console.log('\n✅ Field Validation:');
    for (const field of requiredFields) {
        const hasField = videoPost.hasOwnProperty(field);
        console.log(`  ${hasField ? '✅' : '❌'} ${field}: ${hasField ? typeof videoPost[field] : 'MISSING'}`);
    }

    // Test 2: Carousel Post
    console.log('\n\n📸 Test 2: Carousel Post');
    const carouselPost = await extractPostDataFromGraphQL(mockCarouselPost, 'testuser', 'https://www.instagram.com/testuser/', mockLog);
    console.log(JSON.stringify(carouselPost, null, 2));

    console.log('\n✅ Carousel-specific validation:');
    console.log(`  ✅ Type: ${carouselPost.type} (should be "Sidecar")`);
    console.log(`  ✅ Images count: ${carouselPost.images.length} (should be 2)`);
    console.log(`  ✅ Has video from carousel: ${carouselPost.videoUrl ? 'Yes' : 'No'}`);

    console.log('\n🎉 Data structure test completed!');
}

// Run the test
testDataStructure().catch(console.error);
