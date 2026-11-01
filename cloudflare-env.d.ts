declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    MATCHING_API_URL?: string;
    MATCHING_API_TOKEN?: string;
    MATCHING_MODEL?: string;
    BUCKET?: R2Bucket;
  }
}
