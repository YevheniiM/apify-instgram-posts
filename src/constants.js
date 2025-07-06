// Hard-code the July-2025 SHORTCODE_MEDIA doc  ➜  keeps local + prod in sync
export const SHORTCODE_DOC_ID = '8845758582119845';

// Production-optimized timeouts and session settings
export const TIMEOUTS = {
    PROFILE_REQUEST: 7000,  // Reduced from 10s - faster fail for residential proxies
    GRAPHQL_REQUEST: 7000,  // Faster timeout for GraphQL requests
    TOKEN_REFRESH: 5000     // Quick timeout for token refresh requests
};

export const SESSION_CONFIG = {
    MAX_USAGE_COUNT: 30,    // Increased from 20 - IG allows ~40-45 requests per session
    POOL_SIZE: 50,          // Optimal pool size for residential proxies
    COOLDOWN_TIME: 3 * 60 * 1000  // 3 minutes cooldown instead of immediate retire
};
