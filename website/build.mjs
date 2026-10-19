// Builds the Forkyard website from src/ into two outputs:
//   dist/                 a static site for any host (assets as files, robots.txt, sitemap.xml)
//   $ARTIFACT_OUT         one self-contained HTML file with every asset inlined (used for previews)
// Usage: SITE_URL=https://example.org node website/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "src");
const assetDir = path.join(srcDir, "assets");
const distDir = path.join(here, "dist");
const site = (process.env.SITE_URL || "").replace(/\/+$/, "");
const artifactOut = process.env.ARTIFACT_OUT ||
  "/tmp/claude-1000/-home-user-Schreibtisch-Programming-Projekte-git-client/17bacf26-e245-4c4b-9949-68a99ab3c3f4/scratchpad/forkyard-site.html";

const read = (name) => fs.readFileSync(path.join(srcDir, name), "utf8");
const mime = { webp: "image/webp", png: "image/png", woff2: "font/woff2", svg: "image/svg+xml" };
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const faq = JSON.parse(read("faq.json"));
const faqHtml = faq.map((item, i) =>
  `      <details><summary data-i18n="faq.q${i}">${escHtml(item.q.en)}</summary><p data-i18n="faq.a${i}">${escHtml(item.a.en)}</p></details>`).join("\n");
const faqDe = faq.map((item, i) => `"faq.q${i}": ${JSON.stringify(item.q.de)}, "faq.a${i}": ${JSON.stringify(item.a.de)},`).join("\n    ");

const jsonld = [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Forkyard",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Git client",
    operatingSystem: "Windows 10, Windows 11, macOS, Linux",
    description: "Free, open-source Git client for Windows, Linux and macOS with a commit graph, line staging, a three-way merge tool and interactive rebase.",
    license: "https://www.gnu.org/licenses/gpl-3.0.html",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
    downloadUrl: "https://github.com/abgebaumt/forkyard/releases/latest",
    codeRepository: "https://github.com/abgebaumt/forkyard",
    inLanguage: ["en", "de"],
    ...(site ? { url: `${site}/`, image: `${site}/assets/og.png` } : {}),
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({ "@type": "Question", name: item.q.en, acceptedAnswer: { "@type": "Answer", text: item.a.en } })),
  },
].map((data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`).join("\n");

/** Fills the template; `asset` decides how an asset is referenced (data URI or file path). */
function render(text, asset) {
  let out = text
    .replace("{{faq}}", faqHtml)
    .replace("/*{{faq-de}}*/", faqDe)
    .replace("{{jsonld}}", jsonld)
    .replace(/\{\{asset-path:([\w.-]+)\}\}/g, (_, name) => `assets/${name}`)
    .replace(/\{\{asset:([\w.-]+)\}\}/g, (_, name) => asset(name));
  // Without a site URL, absolute links (canonical, og:url, hreflang) would point nowhere: drop them.
  out = site ? out.replaceAll("{{site}}", site) : out.split("\n").filter((line) => !line.includes("{{site}}")).join("\n");
  return out;
}

const dataUri = (name) => {
  const ext = name.split(".").pop();
  return `data:${mime[ext]};base64,${fs.readFileSync(path.join(assetDir, name)).toString("base64")}`;
};

// 1. Self-contained artifact: no doctype/html/head/body (the host wraps it).
const page = read("page.html");
const head = read("head.html");
const titleEnd = page.indexOf("</title>") + "</title>".length;
const artifact = render(page.slice(0, titleEnd) + "\n" + head + page.slice(titleEnd), dataUri);
fs.mkdirSync(path.dirname(artifactOut), { recursive: true });
fs.writeFileSync(artifactOut, artifact);

// 2. Static site.
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
for (const name of fs.readdirSync(assetDir)) fs.copyFileSync(path.join(assetDir, name), path.join(distDir, "assets", name));
fs.copyFileSync(path.join(assetDir, "favicon-32.png"), path.join(distDir, "favicon.png"));
const title = page.slice(0, titleEnd);
const body = page.slice(titleEnd);
const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${render(title, (n) => `assets/${n}`)}
${render(head, (n) => `assets/${n}`)}
</head>
<body>
${render(body, (n) => `assets/${n}`)}
</body>
</html>
`;
fs.writeFileSync(path.join(distDir, "index.html"), doc);
fs.writeFileSync(path.join(distDir, "robots.txt"), `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}/sitemap.xml\n` : ""}`);
if (site) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(distDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url>\n    <loc>${site}/</loc>\n    <lastmod>${today}</lastmod>\n    <xhtml:link rel="alternate" hreflang="en" href="${site}/"/>\n    <xhtml:link rel="alternate" hreflang="de" href="${site}/?lang=de"/>\n  </url>\n</urlset>\n`);
} else {
  console.warn("SITE_URL is not set: canonical, og:url, hreflang and sitemap.xml were left out. Run again with SITE_URL=https://your-domain.");
}
const kb = (file) => `${Math.round(fs.statSync(file).size / 1024)} KB`;
console.log(`artifact  ${artifactOut} (${kb(artifactOut)})`);
console.log(`site      ${path.join(distDir, "index.html")} (${kb(path.join(distDir, "index.html"))})`);
