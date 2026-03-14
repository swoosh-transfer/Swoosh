/**
 * Unit Tests for QR Code Utility
 *
 * Tests URL generation and props helper functions.
 */
import { describe, it, expect } from 'vitest';
import { getQRCodeUrl, generateQRCode, getQRCodeProps } from '@/utils/qrCode';

describe('getQRCodeUrl', () => {
  it('should return a URL string', () => {
    const url = getQRCodeUrl('https://example.com');
    expect(typeof url).toBe('string');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('should encode the input text', () => {
    const url = getQRCodeUrl('hello world');
    expect(url).toContain('hello%20world');
  });

  it('should use default size of 200', () => {
    const url = getQRCodeUrl('test');
    expect(url).toContain('200x200');
  });

  it('should use custom size', () => {
    const url = getQRCodeUrl('test', 300);
    expect(url).toContain('300x300');
  });

  it('should encode special characters', () => {
    const url = getQRCodeUrl('https://example.com?foo=bar&baz=qux');
    expect(url).toContain(encodeURIComponent('https://example.com?foo=bar&baz=qux'));
  });

  it('should request SVG format', () => {
    const url = getQRCodeUrl('test');
    expect(url).toContain('format=svg');
  });
});

describe('generateQRCode', () => {
  it('should return a URL (delegates to getQRCodeUrl)', async () => {
    const url = await generateQRCode('test');
    expect(typeof url).toBe('string');
    expect(url).toContain('test');
  });

  it('should accept custom size', async () => {
    const url = await generateQRCode('test', 500);
    expect(url).toContain('500x500');
  });
});

describe('getQRCodeProps', () => {
  it('should return img props for valid URL', () => {
    const props = getQRCodeProps('https://example.com');
    expect(props).toHaveProperty('src');
    expect(props).toHaveProperty('alt');
    expect(props).toHaveProperty('width');
    expect(props).toHaveProperty('height');
  });

  it('should use default size of 150', () => {
    const props = getQRCodeProps('https://example.com');
    expect(props.width).toBe(150);
    expect(props.height).toBe(150);
  });

  it('should use custom size', () => {
    const props = getQRCodeProps('https://example.com', 250);
    expect(props.width).toBe(250);
    expect(props.height).toBe(250);
  });

  it('should return null for empty/null URL', () => {
    expect(getQRCodeProps(null)).toBeNull();
    expect(getQRCodeProps(undefined)).toBeNull();
    expect(getQRCodeProps('')).toBeNull();
  });

  it('should set appropriate alt text', () => {
    const props = getQRCodeProps('https://example.com');
    expect(props.alt).toBeTruthy();
    expect(typeof props.alt).toBe('string');
  });
});
