# Documentation Update Summary - Output Format Corrections

**Date:** October 25, 2025  
**Purpose:** Align all documentation with actual scraper output format

## Executive Summary

All documentation files have been updated to accurately reflect the actual output format produced by the Instagram scraper. This update was based on a live test run that scraped 8 posts from the @instagram profile.

## Test Run Details

- **Input:** `https://www.instagram.com/instagram/`
- **Posts Scraped:** 8 successful posts
- **Post Types Captured:** Video posts, Carousel (Sidecar) posts
- **Output Location:** `storage/datasets/default/`

## Key Corrections Made

### Field Name Corrections

| Documented (Incorrect) | Actual (Correct) | Notes |
|------------------------|------------------|-------|
| `shortcode` | `shortCode` | Proper camelCase |
| `postType` | `type` | Simplified field name |
| `takenAt` | `timestamp` | ISO 8601 format |
| `takenAtTimestamp` | *(removed)* | Redundant with timestamp |
| `accessibilityCaption` | `alt` | Shorter field name |
| `viewsCount` | `videoViewCount` | More specific |
| `playsCount` | *(removed)* | Not in actual output |
| `mediaUrls` | `images` | Array of image URLs |
| `dimensions` | `dimensionsHeight`, `dimensionsWidth` | Separate fields |
| `profileUrl` | `inputUrl` | Renamed for clarity |
| `scrapedAt` | *(removed)* | Not in actual output |

### Type Value Corrections

**Post Type Field (`type`):**
- ✅ Correct: `"Image"`, `"Video"`, `"Sidecar"`, `"profile_info"`
- ❌ Incorrect (was documented): `"post"`, `"image"`, `"video"`, `"carousel"`

### Fields Removed from Documentation

These fields were documented but **NOT present** in actual output:
- `isVideo` / `hasAudio` - Type information is in the `type` field
- `location` - Not extracted in current implementation
- `taggedUsers` - Not extracted in current implementation
- `commentsDisabled` / `likingDisabled` - Not extracted
- `carouselItems` - Carousel posts use the `images` array instead

### Fields Added to Documentation

These fields were **missing** from documentation but present in actual output:
- `alt` - Accessibility alt text (string | null)
- `sponsors` - Array of sponsored/tagged business accounts
- `videoViewCount` - Video view count (always present, 0 for non-videos)
- `dimensionsHeight` / `dimensionsWidth` - Separate dimension fields
- `paidPartnership` - Instagram's official paid partnership flag
- `isSponsored` - Alternative sponsored content indicator

## Complete Actual Output Schema

### Post Record Fields

| Field | Type | Always Present | Description |
|-------|------|----------------|-------------|
| `id` | string | ✅ | Unique Instagram post ID |
| `type` | string | ✅ | "Image", "Video", or "Sidecar" |
| `shortCode` | string | ✅ | Instagram post shortcode |
| `url` | string | ✅ | Direct URL to the post |
| `timestamp` | string | ✅ | ISO 8601 timestamp |
| `caption` | string | ✅ | Post caption text |
| `alt` | string \| null | ✅ | Accessibility alt text |
| `hashtags` | string[] | ✅ | Array of hashtags (without #) |
| `mentions` | string[] | ✅ | Array of mentions (without @) |
| `sponsors` | string[] | ✅ | Array of sponsor accounts |
| `likesCount` | number | ✅ | Number of likes |
| `commentsCount` | number | ✅ | Number of comments |
| `videoViewCount` | number | ✅ | Video views (0 for non-videos) |
| `displayUrl` | string | ✅ | Main display image URL |
| `images` | string[] | ✅ | All image URLs |
| `videoUrl` | string \| null | ✅ | Video URL (null for non-videos) |
| `videoDuration` | number \| null | ✅ | Duration in ms (null for non-videos) |
| `dimensionsHeight` | number | ✅ | Height in pixels |
| `dimensionsWidth` | number | ✅ | Width in pixels |
| `paidPartnership` | boolean | ✅ | Paid partnership flag |
| `isSponsored` | boolean | ✅ | Sponsored content flag |
| `inputUrl` | string | ✅ | Original profile URL scraped |
| `username` | string | ✅ | Profile username |

### Profile Info Record Fields

One `profile_info` record is output per profile:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always "profile_info" |
| `username` | string | Profile username |
| `userId` | string | Instagram user ID |
| `originalUrl` | string | Original profile URL |
| `actualPostCount` | number | Total posts on profile |
| `discoveredPostCount` | number | Posts discovered |
| `targetPostCount` | number | Target posts requested |
| `isPrivate` | boolean | Whether profile is private |
| `onlyPostsNewerThan` | string | Date filter applied |
| `maxPosts` | number | Max posts setting |
| `includeReels` | boolean | Reels inclusion setting |
| `includeIGTV` | boolean | IGTV inclusion setting |
| `discoveryLastCursor` | string | Last pagination cursor |
| `discoveryBatches` | number | Number of batches |
| `discoveryTotalRetries` | number | Total retries |
| `discoveryLastStatus` | number | Last HTTP status |
| `discoveryLastError` | string \| null | Last error message |
| `discoveryUsedAuthCookie` | boolean | Whether auth cookie was used |

## Files Updated

### 1. README.md
- **Section:** "Output Format" (lines 82-210)
- **Changes:** Complete rewrite with accurate field names, types, and examples
- **Added:** Field descriptions table, post type examples, profile info record documentation

### 2. .actor/output_schema.json
- **Changes:** Added all missing fields (alt, hashtags, mentions, sponsors, videoViewCount, videoDuration, dimensionsHeight, dimensionsWidth, paidPartnership, isSponsored)
- **Fixed:** Corrected type definitions (number vs string for counts)
- **Improved:** Added detailed descriptions for all fields

### 3. .actor/dataset_schema.json
- **Changes:** Added missing fields to properties section
- **Updated:** Field descriptions to match actual output
- **Enhanced:** Views section to include all new fields with proper formatting

### 4. docs/IG_SCRAPER_TECHNICAL.md
- **Section:** "Accurate data extraction" (lines 157-166)
- **Changes:** Updated field list to match actual extracted fields
- **Organized:** Fields into logical categories (Core, Content, Engagement, Media, Dimensions, Business, Context)

### 5. DATA_STRUCTURE_ADAPTATION.md
- **Status:** ✅ Already accurate - no changes needed
- **Note:** This file was already correctly documenting the actual output format

## Example Output Samples

### Video Post Example
```json
{
  "id": "3750655667658124865",
  "type": "Video",
  "shortCode": "DQNAXU5kW5B",
  "url": "https://www.instagram.com/p/DQNAXU5kW5B/",
  "timestamp": "2025-10-24T19:13:06.000Z",
  "caption": "bffs 🫶🐶⁣\n⁣\n#InTheMoment",
  "alt": null,
  "hashtags": ["InTheMoment"],
  "mentions": ["kipotheshibainu", "hanszimmer", "camilleofficiel"],
  "sponsors": [],
  "likesCount": 243750,
  "commentsCount": 3248,
  "videoViewCount": 8711638,
  "displayUrl": "https://instagram.fksc1-1.fna.fbcdn.net/...",
  "images": ["https://instagram.fksc1-1.fna.fbcdn.net/..."],
  "videoUrl": "https://instagram.fksc1-1.fna.fbcdn.net/...",
  "videoDuration": 6151,
  "dimensionsHeight": 1920,
  "dimensionsWidth": 1080,
  "paidPartnership": false,
  "isSponsored": false,
  "inputUrl": "https://www.instagram.com/instagram/",
  "username": "instagram"
}
```

### Carousel (Sidecar) Post Example
```json
{
  "id": "3749844881657323194",
  "type": "Sidecar",
  "shortCode": "DQKIA1mAF66",
  "url": "https://www.instagram.com/p/DQKIA1mAF66/",
  "timestamp": "2025-10-23T16:19:25.000Z",
  "caption": "Meet creator @tamir...",
  "alt": "An AI-generated image of a person in collage form posing by a wall.",
  "hashtags": [],
  "mentions": ["tamir", "meta.ai"],
  "sponsors": ["meta.ai", "tamir"],
  "likesCount": 421717,
  "commentsCount": 5339,
  "videoViewCount": 0,
  "displayUrl": "https://instagram.fksc1-1.fna.fbcdn.net/...",
  "images": [
    "https://instagram.fksc1-1.fna.fbcdn.net/image1.jpg",
    "https://instagram.fksc1-1.fna.fbcdn.net/image2.jpg",
    "https://instagram.fksc1-1.fna.fbcdn.net/image3.jpg"
    // ... 18 total images in this carousel
  ],
  "videoUrl": null,
  "videoDuration": null,
  "dimensionsHeight": 1350,
  "dimensionsWidth": 1080,
  "paidPartnership": false,
  "isSponsored": false,
  "inputUrl": "https://www.instagram.com/instagram/",
  "username": "instagram"
}
```

## Verification

All documentation updates have been verified against actual scraper output from:
- `storage/datasets/default/000000001.json` (profile_info)
- `storage/datasets/default/000000002.json` (Video)
- `storage/datasets/default/000000003.json` (Video)
- `storage/datasets/default/000000004.json` (Sidecar with 18 images)
- `storage/datasets/default/000000005.json` (Video)
- `storage/datasets/default/000000006.json` (Video)

## Next Steps

✅ All documentation is now accurate and consistent  
✅ Schema files match actual output  
✅ Examples reflect real data structure  

**Recommendation:** Run tests to ensure the scraper continues to produce this exact output format, and update documentation if any code changes modify the output structure.

