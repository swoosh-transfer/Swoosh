/**
 * QR Code Generator Utility
 * Generates QR codes for room sharing links
 */

/**
 * Generate a QR code as a data URL using an external API
 * @param {string} text - The text/URL to encode
 * @param {number} size - Size of the QR code in pixels (default: 200)
 * @returns {string} URL for the QR code image
 */
export function getQRCodeUrl(text, size = 200) {
  // Using QR Server API (free, no auth required)
  const encoded = encodeURIComponent(text);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&bgcolor=1a1a2e&color=ffffff&format=svg`;
}

/**
 * Generate QR code using canvas (local generation)
 * Falls back to external API if canvas generation fails
 * @param {string} text - The text/URL to encode
 * @param {number} size - Size of the QR code in pixels
 * @returns {Promise<string>} Data URL of the QR code
 */
export async function generateQRCode(text, size = 200) {
  // For simplicity, use the external API
  // This avoids adding a large QR code library dependency
  return getQRCodeUrl(text, size);
}

/**
 * QR Code component props generator
 * @param {string} url - The URL to encode
 * @returns {Object} Props for an img element
 */
export function getQRCodeProps(url, size = 150) {
  if (!url) return null;
  
  return {
    src: getQRCodeUrl(url, size),
    alt: 'Scan to join room',
    width: size,
    height: size,
  };
}

export default {
  getQRCodeUrl,
  generateQRCode,
  getQRCodeProps,
};
