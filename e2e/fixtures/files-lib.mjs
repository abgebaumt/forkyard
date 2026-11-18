/** Markdown with scripts, event attributes, remote images and javascript: links (features/diff.mjs). */
export const EVIL_MD = [
  "# Messbericht",
  "",
  "Normaler **Text** mit [Projektseite](https://example.org/projekt) und [Skript-Link](javascript:alert(1)).",
  "",
  "<script>window.__evil = (window.__evil || 0) + 1</script>",
  '<img src=x onerror="window.__evil = (window.__evil || 0) + 1">',
  "",
  "![Radarbild](https://example.org/radar.png)",
  "",
  '<iframe src="https://example.org"></iframe>',
  '<a href="https://example.org/klick" onclick="window.__evil = 99">Klick</a>',
  '<div style="position:fixed;inset:0;background:red">Überdeckung</div>',
  "",
  "- [x] Sensor geprüft",
  "- [ ] Bericht verschickt",
  "",
].join("\n");
