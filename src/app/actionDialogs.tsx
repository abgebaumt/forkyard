/**
 * Dialogs with several fields that actions need: push target, ignore, tag, commit message.
 * Each is a function returning a promise – `null` means cancelled. They are shown by the
 * DialogHost (see dialogs.tsx › showDialog).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Trans } from "react-i18next";
import type { Id, Remote, Sha } from "../core";
import { t } from "../i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Banner } from "../ui/Feedback";
import { Checkbox, TextArea, TextField } from "../ui/Field";
import { cn } from "../ui/cn";
import { showDialog } from "./dialogs";
import { signInInTerminal } from "./ai/cliLogin";
import { openAiSettings } from "./ai/open";
import { useAiStatus } from "./queries";
import { isCli } from "../screens/Preferences/ai/model";
import { availableTargets, type ReleaseTarget } from "../screens/ReleaseNotes/model";
import { ReleaseTargets } from "../screens/ReleaseNotes/Targets";
import { useReleaseNotesAvailability } from "../screens/ReleaseNotes/useAvailability";
import { useReleaseNotesWriter } from "../screens/ReleaseNotes/useWriter";
import { ReleaseNotesWriter } from "../screens/ReleaseNotes/Writer";

/** Spaces turn into "-" while typing (branch and tag names). */
const dashed = (value: string) => value.replace(/\s/g, "-");

/**
 * Checks only Git's spelling rules for a ref name (not whether it already exists) –
 * for names on the remote, which the core only sees at push time.
 */
export function refNameSyntaxError(name: string): string | null {
  if (!name) return null;
  if (/[\s~^:?*[\\]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return t("app.actionDialogs.refName.chars");
  if (name.includes("..")) return t("app.actionDialogs.refName.doubleDot");
  if (name.includes("@{")) return t("app.actionDialogs.refName.atBrace");
  if (name.startsWith("-")) return t("app.actionDialogs.refName.leadingDash");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return t("app.actionDialogs.refName.slashes");
  if (name.endsWith(".")) return t("app.actionDialogs.refName.trailingDot");
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return t("app.actionDialogs.refName.dotOrLock");
  if (name === "@" || name === "HEAD") return t("app.actionDialogs.refName.reserved");
  return null;
}

// ---------------------------------------------------------------------------
// Choice among a few options (radio group with arrow keys)
// ---------------------------------------------------------------------------

interface RadioOption<K extends string> {
  key: K;
  label: string;
  description?: string;
  mono?: boolean;
}

function RadioList<K extends string>({ label, options, value, onChange }: { label: string; options: RadioOption<K>[]; value: K; onChange: (key: K) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const index = options.findIndex((option) => option.key === value);
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % options.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    const target = options[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.key);
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text-muted">{label}</span>
      <div ref={ref} role="radiogroup" aria-label={label} className="flex flex-col gap-1" onKeyDown={onKeyDown}>
        {options.map((option) => {
          const checked = option.key === value;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              title={option.description ? `${option.label} – ${option.description}` : option.label}
              onClick={() => onChange(option.key)}
              className={cn(
                "flex min-h-control-md items-center gap-2 rounded-md border px-2 py-1 text-left",
                checked ? "border-accent bg-accent-surface" : "border-border hover:bg-surface-raised",
              )}
            >
              <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-pill border", checked ? "border-accent" : "border-border-input")}>
                {checked ? <span className="size-1.5 rounded-pill bg-accent" /> : null}
              </span>
              <span className={cn("min-w-0 flex-1 truncate text-text", option.mono && "font-mono text-code")}>{option.label}</span>
              {option.description ? <span className="max-w-48 shrink-0 truncate text-sm text-text-muted">{option.description}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Push without upstream: "Push where?"
// ---------------------------------------------------------------------------

export interface PushTarget {
  remote: string;
  remoteBranch: string;
}

function PushTargetDialog({ branch, remotes, onDone }: { branch: string; remotes: Remote[]; onDone: (value: PushTarget | null) => void }) {
  const [remote, setRemote] = useState(remotes.find((item) => item.name === "origin")?.name ?? remotes[0]?.name ?? "");
  const [name, setName] = useState(branch);
  const error = refNameSyntaxError(name.trim());
  const valid = Boolean(remote) && Boolean(name.trim()) && !error;
  const submit = () => {
    if (valid) onDone({ remote, remoteBranch: name.trim() });
  };
  return (
    <Dialog
      open
      size="sm"
      title={t("app.actionDialogs.push.title")}
      description={
        <Trans i18nKey="app.actionDialogs.push.description" values={{ branch }} components={{ strong: <strong className="font-medium text-text" /> }} />
      }
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {t("app.actionDialogs.push.confirm")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {remotes.length > 1 ? (
          <RadioList label={t("app.actionDialogs.push.remote")} value={remote} onChange={setRemote} options={remotes.map((item) => ({ key: item.name, label: item.name, description: item.pushUrl ?? item.fetchUrl }))} />
        ) : null}
        <TextField
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          label={t("app.actionDialogs.push.branchName")}
          value={name}
          mono
          autoComplete="off"
          error={error ?? undefined}
          hint={name.trim() && remote ? t("app.actionDialogs.push.createdAs", { name: `${remote}/${name.trim()}` }) : undefined}
          onChange={(event) => setName(dashed(event.target.value))}
        />
        {/* Enter in the field submits, even without a visible submit button in the form. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function askPushTarget(branch: string, remotes: Remote[]): Promise<PushTarget | null> {
  return showDialog<PushTarget>((done) => <PushTargetDialog branch={branch} remotes={remotes} onDone={done} />);
}

// ---------------------------------------------------------------------------
// Ignore
// ---------------------------------------------------------------------------

export interface IgnoreChoice {
  pattern: string;
  stopTracking: boolean;
}

export interface IgnoreSuggestion {
  key: string;
  label: string;
  pattern: string;
}

function IgnoreDialog({
  suggestions,
  initial,
  tracked,
  onDone,
}: {
  suggestions: IgnoreSuggestion[];
  initial: string;
  /** At least one of the files is already tracked – then .gitignore alone has no effect. */
  tracked: boolean;
  onDone: (value: IgnoreChoice | null) => void;
}) {
  const start = suggestions.find((item) => item.key === initial) ?? suggestions[0];
  const [choice, setChoice] = useState(start?.key ?? "");
  const [pattern, setPattern] = useState(start?.pattern ?? "");
  const [stopTracking, setStopTracking] = useState(tracked);
  const trimmed = pattern.trim();
  const error = /[\r\n]/.test(pattern) ? t("app.actionDialogs.ignore.oneLine") : trimmed.startsWith("#") ? t("app.actionDialogs.ignore.comment") : null;
  const valid = Boolean(trimmed) && !error;
  const submit = () => {
    if (valid) onDone({ pattern: trimmed, stopTracking });
  };
  return (
    <Dialog
      open
      size="sm"
      title={t("app.actionDialogs.ignore.title")}
      description={t("app.actionDialogs.ignore.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {t("app.actionDialogs.ignore.confirm")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {suggestions.length > 1 ? (
          <RadioList
            label={t("app.actionDialogs.ignore.what")}
            value={choice}
            onChange={(key) => {
              setChoice(key);
              setPattern(suggestions.find((item) => item.key === key)?.pattern ?? "");
            }}
            options={suggestions.map((item) => ({ key: item.key, label: item.label, description: item.pattern }))}
          />
        ) : null}
        <TextField autoFocus label={t("app.actionDialogs.ignore.pattern")} value={pattern} mono autoComplete="off" error={error ?? undefined} onChange={(event) => setPattern(event.target.value)} />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text-muted">{t("app.actionDialogs.ignore.preview")}</span>
          <code data-ignore-preview className="selectable block min-h-control-md truncate rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-code text-text" title={trimmed}>
            {trimmed || " "}
          </code>
        </div>
        <Checkbox
          label={t("app.actionDialogs.ignore.stopTracking")}
          checked={stopTracking}
          onCheckedChange={setStopTracking}
          hint={
            tracked
              ? t("app.actionDialogs.ignore.stopTrackingTracked")
              : t("app.actionDialogs.ignore.stopTrackingHint")
          }
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function askIgnore(suggestions: IgnoreSuggestion[], initial: string, tracked: boolean): Promise<IgnoreChoice | null> {
  return showDialog<IgnoreChoice>((done) => <IgnoreDialog suggestions={suggestions} initial={initial} tracked={tracked} onDone={done} />);
}

// ---------------------------------------------------------------------------
// Create tag
// ---------------------------------------------------------------------------

export interface TagInput {
  name: string;
  /** null = lightweight tag. */
  message: string | null;
  /** Release notes (v1.2): where the annotation also goes once the tag exists. */
  targets: ReleaseTarget[];
}

function TagDialog({
  repoId,
  sha,
  target,
  annotated,
  validate,
  onDone,
}: {
  repoId: Id;
  /** null = HEAD. */
  sha: Sha | null;
  /** What the tag points at, as text. */
  target: string;
  /** The annotation is required (command "Create annotated tag"). */
  annotated: boolean;
  validate: (name: string) => Promise<string | null>;
  onDone: (value: TagInput | null) => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const messageRef = useRef("");
  const setText = (value: string) => {
    messageRef.current = value;
    setMessage(value);
  };
  const [targets, setTargets] = useState<ReleaseTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = useRef(0);
  const notes = useReleaseNotesAvailability(repoId);
  const writer = useReleaseNotesWriter({ repoId, to: sha, current: () => messageRef.current, apply: setText });
  const provider = useAiStatus().data?.provider ?? null;

  useEffect(() => {
    const id = ++check.current;
    const value = name.trim();
    if (!value) {
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void validate(value).then((result) => {
        if (id === check.current) setError(result);
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [name, validate]);

  const missingMessage = annotated && !message.trim();
  const submit = async () => {
    const value = name.trim();
    if (!value || busy || missingMessage) return;
    setBusy(true);
    const result = await validate(value);
    setBusy(false);
    if (result) {
      setError(result);
      return;
    }
    const text = message.trim();
    onDone({ name: value, message: text || null, targets: notes.visible && text ? targets : [] });
  };

  return (
    <Dialog
      open
      size={notes.visible ? "md" : "sm"}
      title={annotated ? t("app.actionDialogs.tag.titleAnnotated") : t("app.actionDialogs.tag.title")}
      description={t("app.actionDialogs.tag.description", { target })}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={!name.trim() || Boolean(error) || missingMessage} loading={busy} onClick={() => void submit()}>
            {t("app.actionDialogs.tag.confirm")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField data-tag-name="" autoFocus label={t("app.actionDialogs.tag.name")} value={name} placeholder="v1.0.0" mono autoComplete="off" error={error ?? undefined} onChange={(event) => setName(dashed(event.target.value))} />
        <TextArea
          data-tag-annotation=""
          label={annotated ? t("app.actionDialogs.tag.annotation") : t("app.actionDialogs.tag.annotationOptional")}
          value={message}
          rows={notes.visible ? 8 : 3}
          hint={
            message.trim()
              ? t("app.actionDialogs.tag.hintAnnotated")
              : annotated
                ? t("app.actionDialogs.tag.hintNeedsText")
                : t("app.actionDialogs.tag.hintLightweight")
          }
          onChange={(event) => {
            setText(event.target.value);
            writer.edited();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {notes.visible ? (
          <ReleaseNotesWriter
            repoId={repoId}
            to={sha}
            writer={writer}
            openSetup={notes.openSetup}
            local={notes.local}
            onSetup={() => {
              onDone(null);
              openAiSettings();
            }}
            onSignIn={
              provider && isCli(provider)
                ? () => {
                    // The terminal sits behind this modal dialog: close it first.
                    onDone(null);
                    signInInTerminal(provider);
                  }
                : undefined
            }
          />
        ) : null}
        {notes.visible && message.trim() ? (
          <ReleaseTargets available={availableTargets("tag", notes.hostReleases)} selected={targets} onChange={setTargets} hostName={notes.hostName} remote={notes.remote} />
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function askTag(options: { repoId: Id; sha: Sha | null; target: string; annotated: boolean; validate: (name: string) => Promise<string | null> }): Promise<TagInput | null> {
  return showDialog<TagInput>((done) => <TagDialog {...options} onDone={done} />);
}

// ---------------------------------------------------------------------------
// Commit message (reword, squash)
// ---------------------------------------------------------------------------

export interface MessageInput {
  summary: string;
  description: string;
}

export interface MessageDialogOptions {
  title: string;
  description?: ReactNode;
  summary: string;
  body: string;
  confirmLabel: string;
  /** Notice above the fields, e.g. "already on the remote". */
  warning?: { title: string; text: string };
}

const SUMMARY_SOFT = 50;
const SUMMARY_HARD = 72;

function MessageDialog({ options, onDone }: { options: MessageDialogOptions; onDone: (value: MessageInput | null) => void }) {
  const [summary, setSummary] = useState(options.summary);
  const [body, setBody] = useState(options.body);
  const length = summary.trim().length;
  const submit = () => {
    if (length) onDone({ summary: summary.trim(), description: body.replace(/\s+$/, "") });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <Dialog
      open
      size="md"
      title={options.title}
      description={options.description}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={!length} onClick={submit}>
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {options.warning ? (
          <div className="overflow-hidden rounded-md">
            <Banner tone="warning" title={options.warning.title}>
              {options.warning.text}
            </Banner>
          </div>
        ) : null}
        <TextField
          autoFocus
          label={t("app.actionDialogs.message.summary")}
          value={summary}
          autoComplete="off"
          spellCheck
          hint={length >= SUMMARY_SOFT ? t(length > SUMMARY_HARD ? "app.actionDialogs.message.lengthLong" : "app.actionDialogs.message.length", { count: length, max: SUMMARY_HARD }) : undefined}
          onChange={(event) => setSummary(event.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={onKeyDown}
        />
        <TextArea label={t("app.actionDialogs.message.description")} value={body} rows={6} spellCheck onChange={(event) => setBody(event.target.value)} onKeyDown={onKeyDown} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function askMessage(options: MessageDialogOptions): Promise<MessageInput | null> {
  return showDialog<MessageInput>((done) => <MessageDialog options={options} onDone={done} />);
}
