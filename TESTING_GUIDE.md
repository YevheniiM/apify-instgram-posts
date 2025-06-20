# Instagram Scraper - Local Testing Guide

## 🔧 Setting Up Real Instagram Cookies

To test the Instagram scraper locally, you need real Instagram cookies from an authenticated session.

### Method 1: Using cookies.json file (Recommended)

1. **Get Instagram Cookies from Browser:**
   - Open Instagram in your browser and log in
   - Open Developer Tools (F12)
   - Go to Application/Storage tab → Cookies → https://www.instagram.com
   - Copy the following cookie values:
     - `sessionid` (most important)
     - `csrftoken` (required)
     - `mid` (machine ID)
     - `ig_did` (device ID)
     - `ds_user_id` (user ID)

2. **Create cookies.json file:**
   ```bash
   cp cookies.json.example cookies.json
   ```

3. **Edit cookies.json with your real values:**
   ```json
   [
     {
       "sessionid": "your_real_sessionid_from_browser",
       "csrftoken": "your_real_csrftoken_from_browser",
       "mid": "your_real_mid_from_browser",
       "ig_did": "your_real_ig_did_from_browser",
       "ds_user_id": "your_real_user_id_from_browser"
     }
   ]
   ```

### Method 2: Using Environment Variables

Set environment variables:
```bash
export INSTAGRAM_SESSIONID="your_sessionid"
export INSTAGRAM_CSRFTOKEN="your_csrftoken"
export INSTAGRAM_MID="your_mid"
export INSTAGRAM_IG_DID="your_ig_did"
```

## 🧪 Running Tests

### Basic Test
```bash
npm start
```

### Test with Multiple Profiles
Edit `INPUT.json`:
```json
{
    "directUrls": [
        "https://www.instagram.com/natgeo/",
        "https://www.instagram.com/nasa/",
        "https://www.instagram.com/instagram/"
    ],
    "maxPosts": 50,
    "onlyPostsNewerThan": "2024-01-01T00:00:00Z"
}
```

## 📊 Expected Results

With real cookies, you should see:
- ✅ Profile discovery finds post URLs
- ✅ Post extraction succeeds
- ✅ Complete metadata extraction
- ✅ 95%+ success rates

Without real cookies:
- ⚠️ Instagram login redirect
- ❌ 0 post URLs discovered
- ❌ Authentication required errors

## 🔍 Troubleshooting

### "Instagram is redirecting to login page"
- Your cookies are missing or expired
- Get fresh cookies from browser

### "No available cookies"
- Check cookies.json format
- Verify sessionid and csrftoken are present

### "Request blocked"
- Instagram detected automation
- Try different cookies or wait before retrying
- Check if account is rate limited

## 🚀 Production Deployment

For production use:
1. Use Apify proxy with `APIFY_PROXY_PASSWORD`
2. Implement cookie rotation with multiple accounts
3. Monitor success rates and session health
4. Use time-range filtering to avoid processing old posts
