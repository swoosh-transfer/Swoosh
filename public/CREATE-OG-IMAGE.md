# How to Create OG Image for Swoosh

## Quick Instructions

Create a **1200x630px** image with:

### Design Elements:
1. **Background**: Dark zinc (#18181b) matching your site
2. **Logo**: Swoosh logo (centered or left)
3. **Tagline**: "Free P2P File Transfer"
4. **Key Features** (bullet points):
   - ✓ Send files up to 50GB+
   - ✓ No server upload
   - ✓ End-to-end encrypted
   - ✓ No registration needed

### Tools to Create:
- **Canva** (easiest): https://www.canva.com/
  - Template: "Facebook Post" or "Open Graph"
  - Size: Custom 1200x630px
  
- **Figma** (professional): https://figma.com/
  - Create new frame: 1200x630px
  - Export as PNG

- **Photoshop/GIMP** (advanced)

### Save As:
- File name: `og-image.png`
- Location: `/public/og-image.png`
- Format: PNG (for transparency) or JPG

### Quick Template Colors:
- Background: `#18181b` (dark zinc)
- Primary text: `#ffffff` (white)
- Accent: `#10b981` (emerald green)
- Secondary text: `#71717a` (zinc-500)

## Preview Your OG Image

After creating and deploying:

1. **Facebook**: https://developers.facebook.com/tools/debug/
   - Enter: https://swoosh-transfer.vercel.app/
   - Click "Scrape Again"

2. **Twitter**: https://cards-dev.twitter.com/validator
   - Enter: https://swoosh-transfer.vercel.app/

3. **LinkedIn**: Share the URL and see preview

## Alternative: Use Text-Only

If you can't create an image, you can use a solid color background:
- Create 1200x630px solid emerald (#10b981) PNG
- This will still show as a branded preview

## Example Layout:

```
┌─────────────────────────────────────────┐
│                                         │
│   [Logo]    SWOOSH                      │
│                                         │
│   Free P2P File Transfer                │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
│                                         │
│   ✓ Send files up to 50GB+              │
│   ✓ No server upload                    │
│   ✓ End-to-end encrypted                │
│   ✓ No registration needed              │
│                                         │
│   swoosh-transfer.vercel.app            │
│                                         │
└─────────────────────────────────────────┘
     1200px x 630px
```

## Quick Win (No Design Skills):

Use this online tool:
- https://www.opengraph.xyz/ (OG image generator)
- Enter your title and description
- Download the image
- Save as `og-image.png` in `/public/`

---

**Note**: The OG image is referenced in `index.html` but won't break anything if missing. Search engines and social platforms will just use text-only previews.
