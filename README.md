# Instagram Scraper

A robust Instagram scraper built with Crawlee and optimized for the Apify platform. This scraper can handle high-volume scraping of Instagram profiles and posts with advanced session management and proxy rotation.

## Features

- ✅ **Profile Data Extraction**: Scrapes complete Instagram profile information
- ✅ **Post Scraping**: Extracts posts with metadata (likes, comments, captions, etc.)
- ✅ **Date Filtering**: Only scrape posts newer than a specified date
- ✅ **Session Management**: Automatic session rotation to avoid blocks
- ✅ **Proxy Support**: Uses Apify residential proxies for robust scraping
- ✅ **Error Handling**: Comprehensive error handling and retry logic
- ✅ **JSON Output**: Structured data output to Apify dataset
- 🚧 **Pagination**: GraphQL pagination support (to be implemented in Step 5)

## Implementation Status

This implementation covers **Steps 1-4** from the Instagram Scraper Implementation Guide:

### ✅ Completed Steps:
1. **Project Setup**: Initialized with Bootstrap CheerioCrawler template
2. **Dependencies**: Added required packages (crawlee, axios, moment)
3. **Session and Proxy Handling**: Configured Apify proxies with session management
4. **Basic Scraping Logic**: Profile data retrieval with error handling

### 🚧 Pending Steps:
5. **Profile Data Retrieval Enhancement**: GraphQL pagination for complete post history
6. **Post Pagination**: Cursor-based pagination implementation
7. **Advanced Date/Time Filtering**: Enhanced filtering logic
8. **Retry Logic Enhancement**: More sophisticated retry strategies
9. **Network Error Handling**: Additional network issue handling
10. **Input/Output Optimization**: Enhanced data structure handling
11. **Actor Scheduling**: Apify Scheduler integration
12. **Scalability Optimization**: Dynamic concurrency management
13. **Comprehensive Logging**: Enhanced monitoring and metrics
14. **Performance Monitoring**: Runtime statistics tracking
15. **Compliance Features**: Random delays and session rotation
16. **Deployment**: Apify platform deployment
17. **CI/CD Integration**: GitHub integration for automated deployments

## Usage

### Local Development

1. **Install dependencies**:
```bash
npm install
```

2. **Run the actor locally**:
```bash
npm start
```

3. **Run with custom input**:
```bash
apify run --input-file INPUT.json
```

### Input Format

```json
{
    "directUrls": [
        "https://www.instagram.com/instagram/",
        "https://www.instagram.com/natgeo/"
    ],
    "onlyPostsNewerThan": "2025-01-01T00:00:00Z"
}
```

### Output Format

The scraper outputs two types of data:

#### Profile Data
```json
{
    "type": "profile",
    "username": "instagram",
    "fullName": "Instagram",
    "biography": "Bringing you closer to the people and things you love. ❤️",
    "followersCount": 627000000,
    "followingCount": 7,
    "postsCount": 7500,
    "isPrivate": false,
    "isVerified": true,
    "profilePicUrl": "https://...",
    "externalUrl": "https://about.instagram.com/",
    "scrapedAt": "2025-01-20T10:30:00.000Z",
    "originalUrl": "https://www.instagram.com/instagram/"
}
```

#### Post Data
```json
{
    "type": "post",
    "username": "instagram",
    "shortcode": "ABC123",
    "id": "123456789",
    "displayUrl": "https://...",
    "isVideo": false,
    "likesCount": 50000,
    "commentsCount": 1200,
    "caption": "Post caption text...",
    "takenAt": "2025-01-15T14:30:00.000Z",
    "takenAtTimestamp": 1737814200,
    "dimensions": {
        "height": 1080,
        "width": 1080
    },
    "scrapedAt": "2025-01-20T10:30:00.000Z",
    "profileUrl": "https://www.instagram.com/instagram/"
}
```

## Architecture

### Session Management
- Automatic session rotation after 20 requests
- Session retirement on blocked requests (403, 429)
- Retry strategy for blocked and timed-out requests

### Proxy Configuration
- Uses Apify residential proxies
- US-based proxy rotation
- Automatic proxy switching on failures

### Error Handling
- JSON parsing error handling
- Network timeout handling
- Session retirement on errors
- Comprehensive logging

## Development

### Lint and Format
```bash
npm run lint
npm run format
```

### Testing
```bash
npm test
```

## Deploy to Apify

### Deploy to Apify Platform
```bash
apify login
apify push
```

## Compliance

This scraper is designed to respect Instagram's terms of service:
- Uses reasonable delays between requests
- Implements session rotation
- Respects rate limits
- Only scrapes public data

## Documentation

- [Apify SDK Documentation](https://docs.apify.com/sdk/js/)
- [Crawlee Documentation](https://crawlee.dev/)
- [Instagram Scraper Implementation Guide](./start.md)
