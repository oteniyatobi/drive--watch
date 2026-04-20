// api/lib/cloudinaryAdmin.js
// Cloudinary config loader + SHA-256 signature generator for server-side signed uploads.
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const crypto = require('crypto');

function getCloudinaryConfig() {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    const missing = [];
    if (!cloudName)  missing.push('CLOUDINARY_CLOUD_NAME');
    if (!apiKey)     missing.push('CLOUDINARY_API_KEY');
    if (!apiSecret)  missing.push('CLOUDINARY_API_SECRET');

    if (missing.length > 0) {
        throw new Error(`Missing Cloudinary environment variables: ${missing.join(', ')}`);
    }

    return { cloudName, apiKey, apiSecret };
}

/**
 * Generate a Cloudinary API signature.
 * Sorts params alphabetically, joins as key=value, appends the API secret, then SHA-256 hashes.
 * @param {Record<string, string|number>} params - params to sign (exclude api_key, file, resource_type)
 * @param {string} apiSecret
 * @returns {string} hex digest
 */
function generateSignature(params, apiSecret) {
    const sorted = Object.keys(params).sort();
    const paramString = sorted.map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHash('sha256').update(paramString + apiSecret).digest('hex');
}

module.exports = { getCloudinaryConfig, generateSignature };
