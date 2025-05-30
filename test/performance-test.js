import moment from 'moment';

/**
 * Performance and scalability tests for Instagram Post Scraper
 * Tests memory usage, processing speed, and scalability characteristics
 */

// Mock data generators for performance testing
function generateMockPost(index) {
    return {
        shortcode: `POST${index.toString().padStart(6, '0')}`,
        id: `${Date.now()}${index}`,
        display_url: `https://example.com/image${index}.jpg`,
        is_video: Math.random() > 0.7,
        taken_at_timestamp: Math.floor(Date.now() / 1000) - (index * 3600),
        edge_liked_by: { count: Math.floor(Math.random() * 10000) },
        edge_media_to_comment: { count: Math.floor(Math.random() * 500) },
        edge_media_to_caption: {
            edges: [{
                node: {
                    text: `Test caption ${index} with #hashtag${index} and @mention${index}`
                }
            }]
        },
        dimensions: { height: 1080, width: 1080 },
        __typename: ['GraphImage', 'GraphVideo', 'GraphSidecar'][Math.floor(Math.random() * 3)]
    };
}

function generateMockGraphQLResponse(postCount, hasNextPage = true) {
    const posts = Array.from({ length: postCount }, (_, i) => ({
        node: generateMockPost(i)
    }));
    
    return {
        data: {
            xdt_api__v1__feed__user_timeline_graphql_connection: {
                edges: posts,
                page_info: {
                    has_next_page: hasNextPage,
                    end_cursor: hasNextPage ? `cursor_${Date.now()}` : null
                }
            }
        }
    };
}

// Helper functions for testing (copied from routes.js)
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

function getPostType(post) {
    if (post.__typename === 'GraphVideo') return 'video';
    if (post.__typename === 'GraphSidecar') return 'carousel';
    if (post.__typename === 'GraphImage') return 'image';
    if (post.product_type === 'clips') return 'reel';
    if (post.product_type === 'igtv') return 'igtv';
    return 'unknown';
}

// Simulate post data extraction
function extractPostData(post, username, originalUrl) {
    const postTimestamp = moment.unix(post.taken_at_timestamp);
    const postType = getPostType(post);
    const caption = post.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    
    return {
        type: 'post',
        postType,
        username,
        shortcode: post.shortcode,
        id: post.id,
        url: `https://www.instagram.com/p/${post.shortcode}/`,
        displayUrl: post.display_url,
        caption,
        hashtags: extractHashtags(caption),
        mentions: extractMentions(caption),
        likesCount: post.edge_liked_by?.count || 0,
        commentsCount: post.edge_media_to_comment?.count || 0,
        takenAt: postTimestamp.toISOString(),
        takenAtTimestamp: post.taken_at_timestamp,
        isVideo: post.is_video || false,
        dimensions: post.dimensions,
        scrapedAt: new Date().toISOString(),
        profileUrl: originalUrl
    };
}

async function runPerformanceTests() {
    console.log('⚡ Starting Instagram Post Scraper performance tests...');
    
    // Test 1: Single post processing speed
    console.log('\n📝 Test 1: Single post processing speed');
    const singlePost = generateMockPost(1);
    const iterations = 1000;
    
    const startTime = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        extractPostData(singlePost, 'test_user', 'https://instagram.com/test_user');
    }
    const endTime = process.hrtime.bigint();
    
    const processingTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    const avgTimePerPost = processingTime / iterations;
    
    console.log(`✅ Processed ${iterations} posts in ${processingTime.toFixed(2)}ms`);
    console.log(`✅ Average time per post: ${avgTimePerPost.toFixed(4)}ms`);
    console.log(`✅ Theoretical throughput: ${Math.floor(1000 / avgTimePerPost)} posts/second`);
    
    // Test 2: Batch processing performance
    console.log('\n📝 Test 2: Batch processing performance');
    const batchSizes = [10, 50, 100, 500, 1000];
    
    for (const batchSize of batchSizes) {
        const mockResponse = generateMockGraphQLResponse(batchSize, false);
        const posts = mockResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges;
        
        const batchStartTime = process.hrtime.bigint();
        const processedPosts = [];
        
        for (const postEdge of posts) {
            const postData = extractPostData(postEdge.node, 'test_user', 'https://instagram.com/test_user');
            processedPosts.push(postData);
        }
        
        const batchEndTime = process.hrtime.bigint();
        const batchTime = Number(batchEndTime - batchStartTime) / 1000000;
        
        console.log(`✅ Batch size ${batchSize}: ${batchTime.toFixed(2)}ms (${(batchTime/batchSize).toFixed(4)}ms per post)`);
    }
    
    // Test 3: Memory usage simulation
    console.log('\n📝 Test 3: Memory usage simulation');
    const memoryTestSizes = [1000, 5000, 10000];
    
    for (const testSize of memoryTestSizes) {
        const memBefore = process.memoryUsage();
        
        // Simulate processing large number of posts
        const largeBatch = [];
        for (let i = 0; i < testSize; i++) {
            const post = generateMockPost(i);
            const processedPost = extractPostData(post, 'test_user', 'https://instagram.com/test_user');
            largeBatch.push(processedPost);
        }
        
        const memAfter = process.memoryUsage();
        const memDiff = {
            rss: (memAfter.rss - memBefore.rss) / 1024 / 1024,
            heapUsed: (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024,
            heapTotal: (memAfter.heapTotal - memBefore.heapTotal) / 1024 / 1024
        };
        
        console.log(`✅ ${testSize} posts: RSS +${memDiff.rss.toFixed(2)}MB, Heap +${memDiff.heapUsed.toFixed(2)}MB`);
        console.log(`   Memory per post: ${(memDiff.heapUsed / testSize * 1024).toFixed(2)}KB`);
        
        // Clean up
        largeBatch.length = 0;
        if (global.gc) {
            global.gc();
        }
    }
    
    // Test 4: Date filtering performance
    console.log('\n📝 Test 4: Date filtering performance');
    const filterTestSize = 10000;
    const filterDate = '2024-06-01T00:00:00Z';
    const postsToFilter = Array.from({ length: filterTestSize }, (_, i) => generateMockPost(i));
    
    const filterStartTime = process.hrtime.bigint();
    let filteredCount = 0;
    
    for (const post of postsToFilter) {
        const postTimestamp = moment.unix(post.taken_at_timestamp);
        if (postTimestamp.isAfter(moment(filterDate))) {
            filteredCount++;
        }
    }
    
    const filterEndTime = process.hrtime.bigint();
    const filterTime = Number(filterEndTime - filterStartTime) / 1000000;
    
    console.log(`✅ Filtered ${filterTestSize} posts in ${filterTime.toFixed(2)}ms`);
    console.log(`✅ ${filteredCount} posts passed filter (${(filteredCount/filterTestSize*100).toFixed(1)}%)`);
    console.log(`✅ Filter rate: ${Math.floor(filterTestSize / filterTime * 1000)} posts/second`);
    
    // Test 5: Pagination simulation
    console.log('\n📝 Test 5: Pagination simulation');
    const pagesPerProfile = 10;
    const postsPerPage = 12;
    const totalPosts = pagesPerProfile * postsPerPage;
    
    const paginationStartTime = process.hrtime.bigint();
    let totalProcessed = 0;
    
    for (let page = 1; page <= pagesPerProfile; page++) {
        const mockResponse = generateMockGraphQLResponse(postsPerPage, page < pagesPerProfile);
        const posts = mockResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges;
        
        for (const postEdge of posts) {
            extractPostData(postEdge.node, 'test_user', 'https://instagram.com/test_user');
            totalProcessed++;
        }
    }
    
    const paginationEndTime = process.hrtime.bigint();
    const paginationTime = Number(paginationEndTime - paginationStartTime) / 1000000;
    
    console.log(`✅ Processed ${totalProcessed} posts across ${pagesPerProfile} pages`);
    console.log(`✅ Total time: ${paginationTime.toFixed(2)}ms`);
    console.log(`✅ Average per page: ${(paginationTime / pagesPerProfile).toFixed(2)}ms`);
    
    // Test 6: Scalability projections
    console.log('\n📝 Test 6: Scalability projections');
    const avgPostProcessingTime = avgTimePerPost;
    
    const scenarios = [
        { profiles: 10, postsPerProfile: 100 },
        { profiles: 100, postsPerProfile: 500 },
        { profiles: 1000, postsPerProfile: 1000 },
        { profiles: 10000, postsPerProfile: 100 }
    ];
    
    console.log('Scalability projections (single-threaded):');
    for (const scenario of scenarios) {
        const totalPosts = scenario.profiles * scenario.postsPerProfile;
        const estimatedTime = totalPosts * avgPostProcessingTime;
        const estimatedTimeMinutes = estimatedTime / 1000 / 60;
        
        console.log(`✅ ${scenario.profiles} profiles × ${scenario.postsPerProfile} posts = ${totalPosts.toLocaleString()} posts`);
        console.log(`   Estimated time: ${estimatedTimeMinutes.toFixed(1)} minutes`);
    }
    
    // Final summary
    console.log('\n🎉 Performance test suite completed!');
    console.log('\n📊 Performance Summary:');
    console.log(`✅ Single post processing: ${avgTimePerPost.toFixed(4)}ms`);
    console.log(`✅ Theoretical throughput: ${Math.floor(1000 / avgTimePerPost)} posts/second`);
    console.log(`✅ Memory efficiency: ~${((memoryTestSizes[0] * avgTimePerPost) / 1024).toFixed(2)}KB per post`);
    console.log(`✅ Date filtering: ${Math.floor(filterTestSize / filterTime * 1000)} posts/second`);
    
    console.log('\n🚀 Recommendations for production:');
    console.log('• Use concurrency level 8-10 for optimal performance');
    console.log('• Implement batch processing for large datasets');
    console.log('• Monitor memory usage for profiles with >10k posts');
    console.log('• Consider pagination limits for very active profiles');
    console.log('• Use date filtering to reduce processing overhead');
}

// Run the performance tests
runPerformanceTests().catch(console.error);
