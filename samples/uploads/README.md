# Upload test assets

Use these files with the in-app approved-hero uploader to exercise the supported image formats:

| File | Format | Asset shape |
|---|---|---|
| `transparent-packshot.png` | PNG with alpha | Isolated product packshot |
| `opaque-square-hero.jpg` | JPEG | Complete campaign scene |
| `../assets/citrus-lift-approved-hero.webp` | WebP | Complete campaign scene |

Select a product, upload one file, and run in Sample mode. The selected product should report `Approved asset`; the run report should record reuse rather than generation. Use an opaque hero for the strongest finished creative. The transparent PNG is included to verify alpha-channel input and can be assigned as `referenceAssetPath` in the complete brief editor when testing live scene generation plus deterministic packshot composition.
