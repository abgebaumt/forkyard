/**
 * Language selection by file name. Each language is only loaded when a file needs it
 * (dynamic import), so that the start bundle stays small.
 */
import type { LanguageSupport } from "@codemirror/language";

type Loader = () => Promise<LanguageSupport>;

const javascript = (options: { jsx?: boolean; typescript?: boolean }): Loader => () =>
  import("@codemirror/lang-javascript").then((module) => module.javascript(options));

const loaders: Record<string, Loader> = {
  javascript: javascript({ jsx: true }),
  typescript: javascript({ typescript: true }),
  tsx: javascript({ typescript: true, jsx: true }),
  json: () => import("@codemirror/lang-json").then((module) => module.json()),
  css: () => import("@codemirror/lang-css").then((module) => module.css()),
  html: () => import("@codemirror/lang-html").then((module) => module.html()),
  markdown: () => import("@codemirror/lang-markdown").then((module) => module.markdown()),
  python: () => import("@codemirror/lang-python").then((module) => module.python()),
  rust: () => import("@codemirror/lang-rust").then((module) => module.rust()),
  go: () => import("@codemirror/lang-go").then((module) => module.go()),
  java: () => import("@codemirror/lang-java").then((module) => module.java()),
  cpp: () => import("@codemirror/lang-cpp").then((module) => module.cpp()),
  sql: () => import("@codemirror/lang-sql").then((module) => module.sql()),
  xml: () => import("@codemirror/lang-xml").then((module) => module.xml()),
  yaml: () => import("@codemirror/lang-yaml").then((module) => module.yaml()),
};

const byExtension: Record<string, keyof typeof loaders> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  webmanifest: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  ino: "cpp",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  csproj: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** Files without a meaningful extension. */
const byFileName: Record<string, keyof typeof loaders> = {
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "composer.lock": "json",
  ".clang-format": "yaml",
};

/** Name of the language for a path, or null (then the text stays uncoloured). */
export function languageNameForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name in byFileName) return byFileName[name] ?? null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return byExtension[name.slice(dot + 1)] ?? null;
}

const cache = new Map<string, Promise<LanguageSupport | null>>();

/**
 * Loads the language for a path. Result `null`: no matching language, or loading
 * failed – the text is then shown without colours, never with an error.
 */
export function loadLanguageForPath(path: string | null | undefined): Promise<LanguageSupport | null> {
  const name = languageNameForPath(path);
  if (!name) return Promise.resolve(null);
  let pending = cache.get(name);
  if (!pending) {
    const loader = loaders[name];
    pending = loader
      ? loader().catch((error: unknown) => {
          console.warn(`Failed to load language "${name}":`, error);
          cache.delete(name);
          return null;
        })
      : Promise.resolve(null);
    cache.set(name, pending);
  }
  return pending;
}
