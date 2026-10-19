# Forkyard website

The project page: one static HTML page with screenshots, three interactive demos (Undo, line
staging, command palette), English and German text and the legal pages (Impressum, Datenschutz,
Haftungsausschluss). No framework, no cookies, no external requests: fonts and images are served
from the same folder.

## Build

```bash
SITE_URL=https://your-domain.example node website/build.mjs
```

- `website/dist/` is the finished site: `index.html`, `assets/`, `robots.txt`, `sitemap.xml`, `favicon.png`.
- Without `SITE_URL` the build still works, but leaves out the canonical link, `og:url`, hreflang
  and the sitemap.
- The build also writes a single self-contained HTML file (all assets inlined) to `ARTIFACT_OUT`
  for previews.

Sources live in `website/src/`: `page.html` (markup, styles, script), `head.html` (SEO and social
meta), `faq.json` (FAQ, also emitted as JSON-LD) and `assets/`.

## Deploy

Upload `website/dist/` to any static host (GitHub Pages, Netlify, Cloudflare Pages, a plain web
server). Nothing has to run on the server.

## Before going live

Fill in every placeholder in square brackets in `src/page.html`, sections `#impressum` and
`#datenschutz`: name, address, e-mail, hosting provider, log retention period, supervisory
authority and date. The legal texts are templates, not legal advice; have them checked.

Screenshots come from `docs/images/` (converted to WebP). After new screenshots, convert again:

```bash
for f in graph graph-light diff conflict rebase settings; do
  magick docs/images/$f.png -quality 82 -define webp:method=6 website/src/assets/$f.webp
done
```
