/**
 * File view and built-in editor.
 *
 * Shows a file in the working directory (`sha: null`) or in a commit. In the working directory
 * it can be edited and saved – in the encoding and with the line endings it had, or converted.
 * Markdown has a sanitised preview, images appear as images, binary files and very large files
 * get a hint.
 *
 * Keys: Ctrl+S saves · Esc closes (or goes back to the previous view; in edit mode only outside
 * the text) · Ctrl+F searches in the text while the focus is in the editor.
 */
import type { EditorView } from "@codemirror/view";
import { EditorView as CMView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import {
  Binary,
  ChevronDown,
  Eye,
  FileQuestion,
  FileText,
  FileWarning,
  History,
  ImageOff,
  ExternalLink,
  PencilLine,
  RefreshCw,
  Save,
  SquarePlus,
  UserSearch,
  WrapText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { core, type FileContent, type Id, type Sha } from "../../core";
import { stagePaths, openExternal } from "../../app/actions/files";
import { choose, hasOpenDialog } from "../../app/dialogs";
import { toCoreError, describeError } from "../../app/errors";
import { formatBytes, shortSha } from "../../app/format";
import { hasOpenMenu } from "../../app/menus/host";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { qk, queryClient, useDiff, useFileContent } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore, useBusy } from "../../app/store";
import { CodeEditor } from "../../components/code";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, toast } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { Notice } from "../DiffView/OtherKinds";
import { locale, t } from "../../i18n";
import {
  EMPTY_TREE,
  ENCODINGS,
  bufferFrom,
  bufferKey,
  drafts,
  setLiveBuffer,
  encodingShort,
  isDirty,
  isImagePath,
  isMarkdown,
  normalizeEol,
  withEol,
  type Buffer,
  type Eol,
} from "./buffer";
import { MarkdownPreview } from "./MarkdownPreview";
import { goBack } from "./nav";
import { BackButton, CodeSkeleton, Divider, FileTitle, Tag, isPlainEscape, ownsKey } from "./parts";

export interface FileViewProps {
  repoId: Id;
  tabId: Id;
  path: string;
  /** null = Arbeitsverzeichnis. */
  sha: Sha | null;
  mode: "view" | "edit";
}

const WRAP_KEY = "gc.fileView.wrap";
const readWrap = () => {
  try {
    return localStorage.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
};

const busyKey = (repoId: Id, path: string) => `${repoId}:file-write:${path}`;
/** Characters outside ASCII: only then is “valid UTF-8” a reliable statement about the encoding. */
const NON_ASCII = /[^\u0000-\u007f]/;

/**
 * Only “\n” separates lines in the editor. Otherwise CodeMirror would also take a single “\r” as
 * a line ending and write it back as “\n” on saving – the file's content would be silently
 * changed. Pasted or dropped text with “\r\n” is normalised in return.
 */
const KEEP_LONE_CR: Extension = [EditorState.lineSeparator.of("\n"), CMView.clipboardInputFilter.of((text) => text.replace(/\r\n/g, "\n"))];

/** Datei. */
export function FileView({ repoId, tabId, path, sha, mode }: FileViewProps) {
  const store = useAppStore.getState;
  const worktree = sha === null;
  const key = bufferKey(repoId, path);
  const query = useFileContent(repoId, path, sha);
  const data: FileContent | undefined = query.data;
  const textual = Boolean(data && data.text !== null);
  const editing = worktree && mode === "edit" && textual;
  const markdown = isMarkdown(path);

  // --- Arbeitsstand ------------------------------------------------------------------------------
  const [buffer, setBuffer] = useState<Buffer | null>(() => (worktree ? (drafts.get(key) ?? null) : null));
  const [restored, setRestored] = useState(() => worktree && drafts.has(key));
  /** The file changed on disk while there are unsaved changes here. */
  const [external, setExternal] = useState<FileContent | null>(null);
  const dirty = worktree && isDirty(buffer) && buffer?.key === key;
  const saving = useBusy(busyKey(repoId, path));
  const latest = useRef({ buffer, key, discarded: false });
  latest.current = { ...latest.current, buffer, key };

  useEffect(() => {
    if (!worktree || !data || data.text === null) return;
    const current = latest.current.buffer;
    if (!current || current.key !== key) {
      const draft = drafts.get(key);
      if (draft) setRestored(true);
      setBuffer(draft ?? bufferFrom(key, data));
      return;
    }
    const incoming = normalizeEol(data.text);
    if (incoming === current.base && (data.encoding || "utf-8") === current.baseEncoding) return;
    if (!isDirty(current)) {
      setExternal(null);
      setBuffer(bufferFrom(key, data));
      return;
    }
    setExternal(data);
  }, [data, key, worktree]);

  // Keep unsaved content when leaving the view.
  useEffect(() => {
    const ref = latest;
    return () => {
      const { buffer: last, discarded } = ref.current;
      if (!discarded && last && isDirty(last)) drafts.set(last.key, last);
    };
  }, []);

  // As long as the view is open, “Close tab” and “Quit app” know about the unsaved text.
  useEffect(() => {
    setLiveBuffer(key, dirty ? buffer : null);
    return () => setLiveBuffer(key, null);
  }, [buffer, dirty, key]);

  const shownText = useMemo(() => {
    if (worktree && buffer && buffer.key === key) return buffer.text;
    return data?.text != null ? normalizeEol(data.text) : "";
  }, [worktree, buffer, key, data]);

  /** Lines counted as in the editor: an empty last line counts too. */
  const lineCount = useMemo(() => {
    let count = 1;
    for (let index = shownText.indexOf("\n"); index !== -1; index = shownText.indexOf("\n", index + 1)) count++;
    return count;
  }, [shownText]);

  // --- Ansicht ---------------------------------------------------------------------------------
  const [wrap, setWrap] = useState(readWrap);
  const toggleWrap = () =>
    setWrap((value) => {
      try {
        localStorage.setItem(WRAP_KEY, value ? "0" : "1");
      } catch {
        // only until restart
      }
      return !value;
    });
  const [preview, setPreview] = useState<boolean>(() => markdown && mode === "view");
  useEffect(() => setPreview(markdown && mode === "view"), [markdown, mode, path]);

  const viewRef = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1, lines: 1 });
  const cursorExtension = useMemo(
    (): Extension => [
      KEEP_LONE_CR,
      CMView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged && !update.geometryChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCursor((current) => {
          const next = { line: line.number, column: head - line.from + 1, lines: update.state.doc.lines };
          return current.line === next.line && current.column === next.column && current.lines === next.lines ? current : next;
        });
      }),
    ],
    [],
  );

  // --- Aktionen --------------------------------------------------------------------------------
  const setMode = (next: "view" | "edit") => store().openFile(tabId, path, null, next);

  const save = useCallback(
    async (andStage = false): Promise<boolean> => {
      const current = latest.current.buffer;
      if (!worktree || !current || current.key !== key) return false;
      const { text, encoding, eol } = current;
      const name = path.slice(path.lastIndexOf("/") + 1);
      const result = await runAction(t("fileView.save"), () => core.fileWrite({ repoId, path, content: text, encoding, eol }), { busyKey: busyKey(repoId, path) });
      if (!result.ok) return false;
      setBuffer((now) => (now && now.key === key ? { ...now, base: text, baseEncoding: encoding, baseEol: eol, mixed: false, eolTouched: false } : now));
      setExternal(null);
      setRestored(false);
      drafts.delete(key);
      queryClient.setQueryData<FileContent>(qk.file(repoId, path, null), (old) =>
        old ? { ...old, text: withEol(text, eol), encoding, eol, size: old.size } : old,
      );
      if (andStage) {
        const staged = await stagePaths(repoId, [path]);
        if (!staged.ok) return false;
        toast({ tone: "success", title: t("fileView.savedStaged", { name }) });
      } else {
        toast({ tone: "success", title: t("fileView.saved", { name }) });
      }
      return true;
    },
    [key, path, repoId, worktree],
  );

  const discardChanges = useCallback(() => {
    drafts.delete(key);
    latest.current.discarded = true;
    setRestored(false);
    setExternal(null);
    if (data && data.text !== null) setBuffer(bufferFrom(key, data));
  }, [data, key]);

  /** Close or go back – with a prompt if there are unsaved changes. */
  const close = useCallback(async () => {
    if (worktree && isDirty(latest.current.buffer)) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const answer = await choose({
        title: t("fileView.closeDirty.title", { name }),
        description: t("fileView.closeDirty.text"),
        options: [
          { key: "save", label: t("fileView.save"), description: t("fileView.closeDirty.saveHint") },
          { key: "discard", label: t("fileView.closeDirty.discard"), description: t("fileView.closeDirty.discardHint"), danger: true },
        ],
      });
      if (answer === null) return;
      if (answer === "save" && !(await save(false))) return;
      if (answer === "discard") {
        drafts.delete(key);
        latest.current.discarded = true;
      }
    }
    goBack(tabId);
  }, [key, path, save, tabId, worktree]);

  const reloadFromDisk = () => {
    if (!external) return;
    drafts.delete(key);
    setBuffer(bufferFrom(key, external));
    setExternal(null);
    setRestored(false);
  };
  const keepMine = () => {
    if (!external) return;
    // The state on disk becomes the new base; your own changes stay unsaved.
    setBuffer((current) => (current ? { ...current, base: normalizeEol(external.text ?? ""), baseEncoding: external.encoding || current.baseEncoding } : current));
    setExternal(null);
  };

  // --- Tastatur ----------------------------------------------------------------------------------
  const keys = useRef({ save, close, editing, worktree });
  keys.current = { save, close, editing, worktree };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const blocked = hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay);
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        // Ctrl+S always belongs to the file view, also in the editor; never “Save page”.
        event.preventDefault();
        if (!blocked && keys.current.worktree && keys.current.editing) void keys.current.save(false);
        return;
      }
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, blocked)) return;
      // In edit mode Esc in the text stays with the editor (e.g. to dissolve a multi-selection).
      const inEditor = event.target instanceof Element && Boolean(event.target.closest(".cm-editor"));
      if (keys.current.editing && inEditor) return;
      event.preventDefault();
      void keys.current.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Kopf ------------------------------------------------------------------------------------
  const name = path.slice(path.lastIndexOf("/") + 1);
  const standLabel = worktree ? t("fileView.header.worktree") : t("fileView.header.commit", { sha: shortSha(sha!) });
  const header = (
    <header data-file-header="" className="@container shrink-0 border-b border-border bg-surface">
      <div className="flex h-control-lg items-center gap-2 pr-1 pl-3">
        <FileTitle path={path} icon={<FileText className="size-icon" aria-hidden />} />
        <Tag title={worktree ? t("fileView.header.worktreeTip") : t("fileView.header.commitTip", { sha })} data-stand={worktree ? "worktree" : sha!}>
          {standLabel}
        </Tag>
        {editing ? (
          <Tag tone="accent" title={t("fileView.header.editableTip")} data-editable="">
            <PencilLine className="size-3" aria-hidden />
            {t("fileView.header.editable")}
          </Tag>
        ) : null}
        {dirty ? (
          <Tip label={t("fileView.header.unsavedTip")}>
            <span data-dirty="" className="flex shrink-0 items-center gap-1 text-xs text-text-muted" role="status">
              <span aria-hidden className="size-2 rounded-pill bg-accent" />
              <span className="hidden @2xl:inline">{t("fileView.header.unsaved")}</span>
              <span className="sr-only @2xl:hidden">{t("fileView.header.unsaved")}</span>
            </span>
          </Tip>
        ) : null}
        <Divider />
        <IconButton size="sm" label={t("fileView.header.history")} shortcut="Mod+Shift+H" icon={<History className="size-icon" aria-hidden />} onClick={() => store().openHistory(tabId, path)} />
        <IconButton size="sm" label={t("fileView.header.blame")} icon={<UserSearch className="size-icon" aria-hidden />} disabled={!textual} onClick={() => store().openBlame(tabId, path, sha)} />
        <IconButton
          size="sm"
          label={t("fileView.openExternal")}
          icon={<ExternalLink className="size-icon" aria-hidden />}
          disabled={!worktree}
          title={worktree ? undefined : t("fileView.header.worktreeOnly")}
          onClick={() => void openExternal(repoId, "editor", path)}
        />
        <Divider />
        <BackButton tabId={tabId} onClick={() => void close()} />
      </div>

      {textual ? (
        <div role="toolbar" aria-label={t("fileView.toolbar")} className="flex h-control-lg items-center gap-1.5 border-t border-border pr-2 pl-3">
          {worktree ? (
            <SegmentedControl
              label={t("fileView.mode.label")}
              value={editing ? "edit" : "view"}
              options={[
                { value: "view", label: t("fileView.mode.view"), icon: <Eye className="size-3.5" aria-hidden /> },
                { value: "edit", label: t("fileView.mode.edit"), icon: <PencilLine className="size-3.5" aria-hidden /> },
              ]}
              onValueChange={(next) => setMode(next)}
            />
          ) : (
            <Button size="sm" variant="ghost" icon={<PencilLine className="size-icon" aria-hidden />} onClick={() => store().openFile(tabId, path, null, "edit")}>
              <span className="hidden @xl:inline">{t("fileView.mode.editWorktree")}</span>
              <span className="@xl:hidden">{t("fileView.mode.edit")}</span>
            </Button>
          )}
          {markdown ? (
            <SegmentedControl
              label="Markdown"
              value={preview ? "preview" : "source"}
              options={[
                { value: "source", label: t("fileView.markdown.source") },
                { value: "preview", label: t("fileView.markdown.previewMode") },
              ]}
              onValueChange={(next) => setPreview(next === "preview")}
            />
          ) : null}
          <IconButton size="sm" label={t("fileView.wrap")} active={wrap} aria-pressed={wrap} disabled={preview} icon={<WrapText className="size-icon" aria-hidden />} onClick={toggleWrap} />
          <span className="min-w-0 flex-1" />
          {editing ? (
            <>
              <Tip label={t("fileView.saveStageTip")}>
                <Button size="sm" disabled={!dirty || saving} icon={<SquarePlus className="size-icon" aria-hidden />} onClick={() => void save(true)} aria-label={t("fileView.saveStage")}>
                  <span className="hidden @2xl:inline">{t("fileView.saveStage")}</span>
                </Button>
              </Tip>
              <Tip label={t("fileView.save")} shortcut="Mod+S">
                <Button size="sm" variant="primary" loading={saving} disabled={!dirty} icon={<Save className="size-icon" aria-hidden />} onClick={() => void save(false)}>
                  {t("fileView.save")}
                </Button>
              </Tip>
            </>
          ) : null}
        </div>
      ) : null}
    </header>
  );

  // --- Inhalt ----------------------------------------------------------------------------------
  let body: ReactNode;
  if (query.isPending) {
    body = <CodeSkeleton label={t("fileView.loading", { name })} />;
  } else if (query.isError || !data) {
    const error = toCoreError(query.error);
    const gone = error.code === "not_found";
    body = (
      <Notice
        id={gone ? "gone" : "error"}
        tone={gone ? "muted" : "danger"}
        icon={gone ? <FileQuestion className="size-8" aria-hidden /> : <FileWarning className="size-8" aria-hidden />}
        title={gone ? (worktree ? t("fileView.error.goneWorktree") : t("fileView.error.goneCommit", { sha: shortSha(sha!) })) : t("fileView.error.readFailed")}
        action={
          <>
            {gone ? (
              <Button icon={<History className="size-icon" aria-hidden />} onClick={() => store().openHistory(tabId, path)}>
                {t("fileView.error.showHistory")}
              </Button>
            ) : (
              <Button icon={<RefreshCw className="size-icon" aria-hidden />} loading={query.isFetching} onClick={() => void query.refetch()}>
                {t("fileView.retry")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => goBack(tabId)}>
              {t("fileView.back.generic")}
            </Button>
          </>
        }
      >
        {gone ? (worktree ? t("fileView.error.goneWorktreeHint") : describeError(error).text) : describeError(error).text}
      </Notice>
    );
  } else if (data.isBinary) {
    body = isImagePath(path) ? <ImagePreview repoId={repoId} path={path} sha={sha} size={data.size} /> : <BinaryNotice size={data.size} worktree={worktree} onExternal={() => void openExternal(repoId, "editor", path)} />;
  } else if (data.text === null) {
    body = (
      <Notice
        id="too-large"
        icon={<FileWarning className="size-8" aria-hidden />}
        title={t("fileView.tooLarge.title")}
        action={
          worktree ? (
            <Button icon={<ExternalLink className="size-icon" aria-hidden />} onClick={() => void openExternal(repoId, "editor", path)}>
              {t("fileView.openExternal")}
            </Button>
          ) : undefined
        }
      >
        {t("fileView.tooLarge.text", { size: formatBytes(data.size) })} {worktree ? t("fileView.tooLarge.external") : ""}
      </Notice>
    );
  } else if (markdown && preview) {
    body = <MarkdownPreview source={shownText} path={path} />;
  } else {
    body = (
      <CodeEditor
        key={`${key}|${sha ?? ""}`}
        value={shownText}
        path={path}
        readOnly={!editing}
        wrap={wrap}
        ariaLabel={editing ? t("fileView.contentEditable", { path }) : t("fileView.content", { path })}
        onChange={(text) => {
          latest.current.discarded = false;
          setBuffer((current) => (current && current.key === key ? { ...current, text } : current));
        }}
        onView={(view) => {
          viewRef.current = view;
          // The text gets the focus (also when viewing: arrows scroll, Esc closes).
          if (!view) return;
          const wantsFocus = editing && mode === "edit";
          requestAnimationFrame(() => {
            if (wantsFocus || viewMayTakeFocus()) view.focus();
          });
        }}
        extensions={cursorExtension}
      />
    );
  }

  // --- Footer: encoding, line endings, position ---------------------------------------------
  const effectiveEncoding = worktree && buffer?.key === key ? buffer.encoding : data?.encoding || "utf-8";
  const loadedEncoding = worktree && buffer?.key === key ? buffer.baseEncoding : data?.encoding || "utf-8";
  const effectiveEol: Eol = worktree && buffer?.key === key ? buffer.eol : data?.eol === "crlf" ? "crlf" : "lf";
  const mixed = worktree && buffer?.key === key ? buffer.mixed && !buffer.eolTouched : data?.eol === "mixed";
  const canChange = worktree && textual && buffer?.key === key;
  // Re-read: the core reliably detects UTF-8 and UTF-16; everything else it reads in the encoding
  // configured for the repository. “Re-read as” changes exactly this default.
  const baseText = worktree && buffer?.key === key ? buffer.base : "";
  const certain = loadedEncoding.startsWith("utf-") && (loadedEncoding !== "utf-8" || NON_ASCII.test(baseText));
  const rereadBlocked = dirty ? t("fileView.encoding.saveFirst") : certain ? t("fileView.encoding.certain", { encoding: encodingShort(loadedEncoding) }) : null;
  const rereadAs = async (encoding: string) => {
    const result = await runAction(t("fileView.encoding.reread"), () => core.repoSettingsSet({ repoId, patch: { encoding } }));
    if (!result.ok) return;
    queryClient.setQueryData(qk.repoSettings(repoId), result.value);
    await queryClient.invalidateQueries({ queryKey: ["repo", repoId, "file"] });
    toast({ tone: "info", title: t("fileView.encoding.rereadDone", { encoding: encodingShort(encoding) }), description: t("fileView.encoding.rereadHint") });
  };
  const encodingEntries: MenuEntry[] = [
    { type: "label", label: t("fileView.encoding.writeAs") },
    ...(ENCODINGS.some((item) => item.value === effectiveEncoding) ? ENCODINGS : [{ value: effectiveEncoding, label: effectiveEncoding }, ...ENCODINGS]).map((item) => ({
      label: item.label,
      checked: item.value === effectiveEncoding,
      hint: item.value === loadedEncoding ? t("fileView.encoding.detected") : undefined,
      onSelect: () => setBuffer((current) => (current ? { ...current, encoding: item.value } : current)),
    })),
    { type: "separator" },
    {
      label: t("fileView.encoding.rereadAs"),
      icon: <RefreshCw className="size-icon" />,
      disabled: Boolean(rereadBlocked),
      hint: rereadBlocked ?? undefined,
      children: ENCODINGS.filter((item) => !item.value.startsWith("utf-")).map((item) => ({
        label: item.label,
        checked: item.value === loadedEncoding,
        onSelect: () => void rereadAs(item.value),
      })),
    },
  ];
  const eolEntries: MenuEntry[] = [
    { type: "label", label: t("fileView.encoding.writeAs") },
    { label: t("fileView.eol.lf"), checked: effectiveEol === "lf" && !mixed, onSelect: () => setBuffer((current) => (current ? { ...current, eol: "lf", eolTouched: true } : current)) },
    { label: t("fileView.eol.crlf"), checked: effectiveEol === "crlf" && !mixed, onSelect: () => setBuffer((current) => (current ? { ...current, eol: "crlf", eolTouched: true } : current)) },
  ];

  const showsEditor = !(markdown && preview);
  const footer = data && textual ? (
    <footer data-file-footer="" className="flex h-statusbar shrink-0 items-center gap-1 border-t border-border bg-surface px-2 text-xs text-text-muted">
      {showsEditor ? (
        <>
          <span className="tabular-nums" data-cursor="">
            {t("fileView.footer.cursor", { line: cursor.line.toLocaleString(locale()), column: cursor.column.toLocaleString(locale()) })}
          </span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span className="tabular-nums" data-line-count={lineCount}>
        {t("fileView.footer.lines", { count: lineCount })}
      </span>
      <span aria-hidden className="hidden @lg:inline">·</span>
      <span className="hidden tabular-nums @lg:inline">{formatBytes(data.size)}</span>
      <span className="min-w-0 flex-1" />
      {effectiveEncoding !== loadedEncoding ? (
        <span data-encoding-pending="" className="truncate text-text">
          {t("fileView.footer.pendingEncoding", { encoding: encodingShort(effectiveEncoding) })}
        </span>
      ) : null}
      <FooterMenu label={t("fileView.footer.encoding", { encoding: encodingShort(effectiveEncoding) })} text={encodingShort(effectiveEncoding)} entries={encodingEntries} disabled={!canChange} data="encoding" />
      <FooterMenu
        label={t("fileView.footer.eol", { eol: mixed ? t("fileView.footer.mixed") : effectiveEol.toUpperCase() })}
        text={mixed ? t("fileView.footer.mixedTo", { eol: effectiveEol.toUpperCase() }) : effectiveEol.toUpperCase()}
        entries={eolEntries}
        disabled={!canChange}
        data="eol"
        warn={mixed}
      />
    </footer>
  ) : null;

  return (
    <section aria-label={t("fileView.section", { path })} data-screen="file-view" data-mode={editing ? "edit" : "view"} data-dirty-state={dirty ? "dirty" : "clean"} className="@container flex h-full min-h-0 min-w-0 flex-col bg-bg">
      {header}
      {restored && dirty ? (
        <Banner
          tone="info"
          title={t("fileView.restored.title")}
          actions={
            <Button size="sm" variant="ghost" onClick={discardChanges}>
              {t("fileView.restored.discard")}
            </Button>
          }
        >
          {t("fileView.restored.text")}
        </Banner>
      ) : null}
      {external ? (
        <Banner
          tone="warning"
          title={t("fileView.external.title")}
          actions={
            <>
              <Button size="sm" onClick={reloadFromDisk}>
                {t("fileView.external.reload")}
              </Button>
              <Button size="sm" variant="ghost" onClick={keepMine}>
                {t("fileView.external.keep")}
              </Button>
            </>
          }
        >
          {t("fileView.external.text", { name })}
        </Banner>
      ) : null}
      <div className="relative min-h-0 flex-1">{body}</div>
      {footer}
    </section>
  );
}

function FooterMenu({ label, text, entries, disabled, data, warn = false }: { label: string; text: string; entries: MenuEntry[]; disabled: boolean; data: string; warn?: boolean }) {
  const trigger = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-footer-menu={data}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 font-medium whitespace-nowrap",
        "hover:bg-surface-raised hover:text-text disabled:pointer-events-none",
        warn ? "text-warning" : "text-text-muted",
      )}
    >
      {text}
      {disabled ? null : <ChevronDown className="size-3" aria-hidden />}
    </button>
  );
  if (disabled) return <Tip label={t("fileView.footer.worktreeOnly", { label })}>{trigger}</Tip>;
  return (
    <DropdownMenu entries={entries} align="end">
      {trigger}
    </DropdownMenu>
  );
}

function BinaryNotice({ size, worktree, onExternal }: { size: number; worktree: boolean; onExternal: () => void }) {
  return (
    <Notice
      id="binary"
      icon={<Binary className="size-8" aria-hidden />}
      title={t("fileView.binary.title")}
      action={
        worktree ? (
          <Button icon={<ExternalLink className="size-icon" aria-hidden />} onClick={onExternal}>
            {t("fileView.openExternal")}
          </Button>
        ) : undefined
      }
    >
      {t("fileView.binary.text", { size: formatBytes(size) })}
    </Notice>
  );
}

/** Images as images: the comparison against the empty tree yields the file as a data: URL. */
function ImagePreview({ repoId, path, sha, size }: { repoId: Id; path: string; sha: Sha | null; size: number }) {
  const diff = useDiff(repoId, path, { kind: "range", from: EMPTY_TREE, to: sha });
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (diff.isPending) return <CodeSkeleton label={t("fileView.image.loading")} />;
  const url = diff.data?.kind === "image" ? diff.data.newDataUrl : null;
  if (!url || failed) {
    return (
      <Notice id="image-missing" icon={<ImageOff className="size-8" aria-hidden />} title={t("fileView.image.failed")}>
        {diff.isError ? describeError(diff.error).text : t("fileView.image.failedText", { size: formatBytes(size) })}
      </Notice>
    );
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <figure data-image-preview="" className="m-0 flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-sunken p-6">
        <img
          src={url}
          alt={name}
          draggable={false}
          className={cn("gc-checker max-h-full max-w-full border border-border object-contain", dimensions && dimensions.width < 192 && dimensions.height < 192 && "gc-pixelated min-w-48")}
          onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      </div>
      <figcaption className="flex h-statusbar shrink-0 items-center gap-2 border-t border-border bg-surface px-3 text-xs text-text-muted tabular-nums">
        {dimensions ? `${dimensions.width} × ${dimensions.height} px` : t("fileView.image.label")} · {formatBytes(size)}
      </figcaption>
    </figure>
  );
}
