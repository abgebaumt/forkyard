import { useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  Copy,
  Eye,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  Moon,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Sun,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button, IconButton, Spinner } from "../ui/Button";
import { StatusBar, TabBar, Toolbar, ToolbarButton, ToolbarSeparator } from "../ui/Chrome";
import { ConfirmDialog, Dialog, dialogSurface } from "../ui/Dialog";
import { DiffHunk, type DiffLine } from "../ui/Diff";
import { Banner, EmptyState, ToastCard, toast } from "../ui/Feedback";
import { Checkbox, SegmentedControl, TextArea, TextField } from "../ui/Field";
import { Avatar, FileRow, PanelSection, RefLabel, TreeRow } from "../ui/Git";
import { Graph, type GraphCommit } from "../ui/Graph";
import { Kbd } from "../ui/Kbd";
import { ContextMenu, DropdownMenu, MenuPreview, type MenuEntry } from "../ui/Menu";
import { cn } from "../ui/cn";
import { t } from "../i18n";

const colorRoles = [
  "bg", "surface", "surface-raised", "surface-sunken", "border", "border-input",
  "text", "text-muted", "text-disabled", "accent", "on-accent", "accent-surface",
  "danger", "on-danger", "danger-surface", "success", "success-surface",
  "warning", "warning-surface", "diff-added", "diff-added-strong", "diff-removed", "diff-removed-strong",
];

const typeScale = [
  { name: "xs", cls: "text-xs font-medium", spec: "11/16 · 500", use: t("design.typeUse.xs") },
  { name: "sm", cls: "text-sm", spec: "12/16 · 400", use: t("design.typeUse.sm") },
  { name: "base", cls: "text-base", spec: "13/20 · 400", use: t("design.typeUse.base") },
  { name: "md", cls: "text-md font-medium", spec: "14/20 · 500", use: t("design.typeUse.md") },
  { name: "lg", cls: "text-lg font-semibold", spec: "16/24 · 600", use: t("design.typeUse.lg") },
  { name: "xl", cls: "text-xl font-semibold", spec: "20/28 · 600", use: t("design.typeUse.xl") },
  { name: "code", cls: "font-mono text-code", spec: "12/18 · 400 · Mono", use: t("design.typeUse.code") },
];

const commits: GraphCommit[] = [
  { id: "wip", lane: 0, parents: ["a"], kind: "wip", message: t("design.sample.wipFiles") },
  {
    id: "a", lane: 0, parents: ["c"], message: t("design.sample.commit.a"), author: "Mira Sommer", date: t("design.sample.date.hours2"), sha: "9f3c1ab",
    refs: [{ kind: "local", name: "main", lane: 0, head: true }, { kind: "remote", name: "origin/main", lane: 0 }],
  },
  {
    id: "b", lane: 1, parents: ["d"], message: t("design.sample.commit.b"), author: "Jonas Keller", date: t("design.sample.date.hours5"), sha: "41d07e2",
    refs: [{ kind: "local", name: "feature/zeilen-staging", lane: 1 }],
  },
  { id: "c", lane: 0, parents: ["e", "f"], kind: "merge", message: t("design.sample.commit.c"), author: "Mira Sommer", date: t("design.sample.date.yesterday"), sha: "c2a9914" },
  { id: "d", lane: 1, parents: ["e"], message: t("design.sample.commit.d"), author: "Jonas Keller", date: t("design.sample.date.yesterday"), sha: "7be4d10" },
  {
    id: "f", lane: 2, parents: ["g"], message: t("design.sample.commit.f"), author: "Aylin Demir", date: t("design.sample.date.days2"), sha: "e88b3f6",
    refs: [{ kind: "remote", name: "origin/fix/index-lock", lane: 2 }],
  },
  { id: "e", lane: 0, parents: ["g"], message: t("design.sample.commit.e"), author: "Mira Sommer", date: t("design.sample.date.days2"), sha: "5d1f0c8" },
  {
    id: "g", lane: 0, parents: ["h"], message: t("design.sample.commit.g"), author: "Aylin Demir", date: t("design.sample.date.days4"), sha: "0a6e7b3",
    refs: [{ kind: "tag", name: "v0.1.0" }],
  },
  { id: "h", lane: 0, parents: [], message: t("design.sample.commit.h"), author: "Mira Sommer", date: t("design.sample.date.days6"), sha: "3b90c5d" },
];

const diffLines: DiffLine[] = [
  { kind: "context", oldNo: 41, newNo: 41, segments: [{ text: "fn build_patch(hunk: &Hunk, picked: &[usize]) -> Vec<u8> {" }] },
  { kind: "remove", oldNo: 42, segments: [{ text: "    let text = " }, { text: "String::from_utf8_lossy", changed: true }, { text: "(&hunk.bytes);" }] },
  { kind: "add", newNo: 42, selected: true, segments: [{ text: "    let text = " }, { text: "hunk.bytes.as_slice", changed: true }, { text: "();" }] },
  { kind: "add", newNo: 43, selected: true, segments: [{ text: t("design.sample.codeComment") }] },
  { kind: "context", oldNo: 43, newNo: 44, segments: [{ text: "    let mut out = Vec::with_capacity(text.len());" }] },
  { kind: "context", oldNo: 44, newNo: 45, segments: [{ text: "    for (index, line) in split_keep_eol(text).enumerate() {" }] },
];

const commitMenu: MenuEntry[] = [
  { label: t("design.menu.createBranch"), icon: <GitBranchPlus className="size-icon" />, shortcut: "Ctrl+B" },
  { label: t("design.menu.setTag"), icon: <Tag className="size-icon" /> },
  { type: "separator" },
  { label: t("design.menu.cherryPick"), icon: <Copy className="size-icon" /> },
  { label: t("design.menu.revert"), icon: <RotateCcw className="size-icon" /> },
  { type: "label", label: t("design.menu.resetLabel") },
  { label: t("design.menu.resetSoft") },
  { label: t("design.menu.resetMixed"), checked: true },
  { label: t("design.menu.resetHard"), danger: true, icon: <Trash2 className="size-icon" /> },
  { type: "separator" },
  { label: t("design.menu.copySha"), icon: <Copy className="size-icon" />, disabled: true },
];

const pullMenu: MenuEntry[] = [
  { label: t("design.menu.fetchAll"), shortcut: "Ctrl+L" },
  { type: "separator" },
  { type: "label", label: t("design.menu.pullDefault") },
  { label: t("design.menu.fastForwardOrMerge"), checked: true },
  { label: t("design.menu.fastForwardOnly") },
  { label: "Rebase" },
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {note ? <p className="mt-1 max-w-3xl text-base text-text-muted">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Specimen({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className="text-xs font-medium tracking-wide text-text-muted uppercase">{label}</p>
      {children}
    </div>
  );
}

function Swatch({ role }: { role: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-8 shrink-0 rounded-md border border-border-input" style={{ background: `var(--gc-${role})` }} />
      <code className="font-mono text-code">{role}</code>
    </div>
  );
}

export function DesignPage() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
  const [diffMode, setDiffMode] = useState<"hunk" | "inline" | "split">("hunk");
  const [amend, setAmend] = useState(false);
  const [pushAfter, setPushAfter] = useState(true);
  const [selected, setSelected] = useState("a");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("forkyard");

  const switchTheme = (next: string) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-320 px-8 pb-16">
        <header className="flex items-center gap-4 py-6">
          <div className="flex-1">
            <h1 className="text-xl font-semibold">{t("design.title")}</h1>
            <p className="text-base text-text-muted">
              {t("design.intro")}
            </p>
          </div>
          <SegmentedControl
            label="Theme"
            value={theme}
            onValueChange={switchTheme}
            options={[
              { value: "dark", label: t("design.theme.dark"), icon: <Moon className="size-3.5" aria-hidden /> },
              { value: "light", label: t("design.theme.light"), icon: <Sun className="size-3.5" aria-hidden /> },
            ]}
          />
        </header>

        <Section title={t("design.colors.title")} note={t("design.colors.note")}>
          <div className="grid grid-cols-4 gap-x-6 gap-y-3">
            {colorRoles.map((role) => <Swatch key={role} role={role} />)}
          </div>
          <p className="mt-6 mb-3 text-xs font-medium tracking-wide text-text-muted uppercase">{t("design.colors.lanes")}</p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }, (_, lane) => (
              <RefLabel key={lane} kind="local" name={`lane-${lane + 1}`} lane={lane} />
            ))}
            {Array.from({ length: 8 }, (_, lane) => (
              <RefLabel key={lane} kind="remote" name={`origin/lane-${lane + 1}`} lane={lane} />
            ))}
          </div>
        </Section>

        <Section title={t("design.typography.title")} note={t("design.typography.note")}>
          <div className="flex flex-col gap-2">
            {typeScale.map((row) => (
              <div key={row.name} className="flex items-baseline gap-4">
                <code className="w-12 font-mono text-code text-text-muted">{row.name}</code>
                <span className={cn("w-96", row.cls)}>{t("design.typography.sample")}</span>
                <span className="w-40 text-sm text-text-muted tabular-nums">{row.spec}</span>
                <span className="text-sm text-text-muted">{row.use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="grid grid-cols-2 gap-8">
            <Specimen label={t("design.buttons.variants")}>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Commit</Button>
                <Button>{t("design.buttons.cancel")}</Button>
                <Button variant="ghost">{t("design.buttons.showMore")}</Button>
                <Button variant="danger">{t("design.buttons.discard")}</Button>
              </div>
            </Specimen>
            <Specimen label={t("design.buttons.sizes")}>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">{t("design.buttons.stageHunk")}</Button>
                <Button size="md">{t("design.buttons.createStash")}</Button>
                <Button size="lg" variant="primary" icon={<FolderGit2 className="size-icon" aria-hidden />}>
                  {t("design.buttons.openRepository")}
                </Button>
              </div>
            </Specimen>
            <Specimen label={t("design.buttons.states")}>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" loading>{t("design.buttons.pushing")}</Button>
                <Button variant="primary" disabled>Commit</Button>
                <Button disabled>{t("design.buttons.cancel")}</Button>
                <Button loading>{t("design.buttons.cloning")}</Button>
                <Spinner />
              </div>
            </Specimen>
            <Specimen label={t("design.buttons.iconButtons")}>
              <div className="flex flex-wrap items-center gap-1">
                <IconButton label={t("design.buttons.stageFile")} shortcut="S" icon={<Plus className="size-icon" aria-hidden />} />
                <IconButton label={t("design.buttons.hideInGraph")} icon={<Eye className="size-icon" aria-hidden />} active />
                <IconButton label={t("design.buttons.discardChanges")} danger icon={<Trash2 className="size-icon" aria-hidden />} />
                <IconButton label={t("design.buttons.search")} shortcut="Ctrl+F" icon={<Search className="size-icon" aria-hidden />} disabled />
                <span className="ml-3 flex items-center gap-2 text-sm text-text-muted">
                  {t("design.buttons.shortcut")} <Kbd>Ctrl+Shift+S</Kbd>
                </span>
              </div>
            </Specimen>
          </div>
        </Section>

        <Section title={t("design.inputs.title")}>
          <div className="grid grid-cols-3 gap-8">
            <div className="flex flex-col gap-4">
              <TextField label={t("design.inputs.branchName")} defaultValue="feature/zeilen-staging" mono />
              <TextField label={t("design.inputs.remoteUrl")} placeholder={t("design.inputs.remoteUrlPlaceholder")} hint={t("design.inputs.remoteUrlHint")} mono />
              <TextField label={t("design.inputs.branchName")} defaultValue="feature/neu..x" error={t("design.inputs.branchNameError")} mono />
              <TextField label={t("design.inputs.locked")} defaultValue="origin" disabled />
            </div>
            <div className="flex flex-col gap-4">
              <TextArea label={t("design.inputs.description")} rows={4} placeholder={t("design.inputs.descriptionPlaceholder")} />
              <Specimen label={t("design.inputs.toggle")}>
                <SegmentedControl
                  label={t("design.inputs.diffView")}
                  value={diffMode}
                  onValueChange={setDiffMode}
                  options={[
                    { value: "hunk", label: t("design.inputs.hunks") },
                    { value: "inline", label: t("design.inputs.wholeFile") },
                    { value: "split", label: t("design.inputs.sideBySide") },
                  ]}
                />
              </Specimen>
            </div>
            <div className="flex flex-col gap-3">
              <Checkbox label={t("design.inputs.amend")} checked={amend} onCheckedChange={setAmend} />
              <Checkbox label={t("design.inputs.pushAfter")} checked={pushAfter} onCheckedChange={setPushAfter} />
              <Checkbox label={t("design.inputs.allFiles")} checked="indeterminate" hint={t("design.inputs.allFilesHint")} />
              <Checkbox label={t("design.inputs.skipHooks")} checked={false} disabled />
            </div>
          </div>
        </Section>

        <Section title={t("design.feedback.title")} note={t("design.feedback.note")}>
          <div className="grid grid-cols-3 gap-8">
            <Specimen label={t("design.feedback.commitMenu")}>
              <MenuPreview entries={commitMenu} />
              <div className="flex gap-2">
                <DropdownMenu entries={commitMenu}>
                  <Button size="sm">{t("design.feedback.openDropdown")}</Button>
                </DropdownMenu>
                <ContextMenu entries={commitMenu}>
                  <Button size="sm" variant="ghost">{t("design.feedback.rightClickHere")}</Button>
                </ContextMenu>
              </div>
            </Specimen>
            <Specimen label={t("design.feedback.destructiveConfirm")}>
              <div className={cn(dialogSurface, "w-full")}>
                <div className="px-4 pt-4">
                  <p className="text-lg font-semibold">{t("design.feedback.discardTitle")}</p>
                  <p className="mt-1 text-base text-text-muted">
                    {t("design.feedback.discardBody")}
                  </p>
                </div>
                <div className="flex justify-end gap-2 px-4 pt-4 pb-4">
                  <Button>{t("design.buttons.cancel")}</Button>
                  <Button variant="danger">{t("design.buttons.discard")}</Button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setConfirmOpen(true)}>{t("design.feedback.openConfirm")}</Button>
                <Button size="sm" onClick={() => setDialogOpen(true)}>{t("design.feedback.openDialog")}</Button>
              </div>
            </Specimen>
            <Specimen label={t("design.feedback.toasts")}>
              <ToastCard toast={{ tone: "success", title: t("design.feedback.pushedTitle"), description: t("design.feedback.pushedBody") }} onClose={() => {}} />
              <ToastCard
                toast={{
                  tone: "danger",
                  title: t("design.feedback.rejectedTitle"),
                  description: t("design.feedback.rejectedBody"),
                  action: { label: t("design.feedback.pullFirst"), onClick: () => {} },
                }}
                onClose={() => {}}
              />
              <div>
                <Button size="sm" onClick={() => toast({ tone: "info", title: t("design.feedback.fetchDoneTitle"), description: t("design.feedback.fetchDoneBody") })}>
                  {t("design.feedback.fireToast")}
                </Button>
              </div>
            </Specimen>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <Banner tone="warning" title={t("design.feedback.detachedTitle")} actions={<Button size="sm">{t("design.feedback.createBranch")}</Button>}>
              {t("design.feedback.detachedBody")}
            </Banner>
            <Banner tone="danger" title={t("design.feedback.mergePausedTitle")} actions={<Button size="sm">{t("design.feedback.abortMerge")}</Button>}>
              {t("design.feedback.mergePausedBody")}
            </Banner>
            <Banner tone="info" title={t("design.feedback.rebaseRunning")} />
            <Banner tone="success" title={t("design.feedback.allResolved")} actions={<Button size="sm" variant="primary">{t("design.feedback.finishMerge")}</Button>} />
          </div>
        </Section>

        <Section title={t("design.chrome.title")} note={t("design.chrome.note")}>
          <div className="overflow-hidden rounded-lg border border-border">
            <TabBar
              tabs={[
                { id: "forkyard", title: "forkyard", path: "C:\\Projekte\\forkyard", dirty: true },
                { id: "website", title: "website", path: "C:\\Projekte\\website" },
                { id: "notes", title: "notizen-archiv-2025", path: "C:\\Projekte\\notizen-archiv-2025" },
              ]}
              activeId={activeTab}
              onActivate={setActiveTab}
            />
            <Toolbar>
              <ToolbarButton label={t("design.chrome.undo")} shortcut="Ctrl+Z" hint={t("design.chrome.undoHint")} icon={<Undo2 className="size-icon" aria-hidden />} />
              <ToolbarButton label={t("design.chrome.redo")} disabled hint={t("design.chrome.nothingToRedo")} icon={<Redo2 className="size-icon" aria-hidden />} />
              <ToolbarSeparator />
              <ToolbarButton label="Pull" badge={3} menu={pullMenu} icon={<ArrowDownToLine className="size-icon" aria-hidden />} />
              <ToolbarButton label="Push" badge={2} icon={<ArrowUpFromLine className="size-icon" aria-hidden />} />
              <ToolbarSeparator />
              <ToolbarButton label="Branch" shortcut="Ctrl+B" icon={<GitBranchPlus className="size-icon" aria-hidden />} />
              <ToolbarButton label="Stash" icon={<Archive className="size-icon" aria-hidden />} />
              <ToolbarButton label="Pop" disabled hint={t("design.chrome.noStash")} icon={<ArchiveRestore className="size-icon" aria-hidden />} />
              <ToolbarButton label="Fetch" busy icon={<Cloud className="size-icon" aria-hidden />} />
              <div className="flex-1" />
              <div className="w-64">
                <TextField aria-label={t("design.chrome.searchCommits")} placeholder={t("design.chrome.searchCommitsPlaceholder")} />
              </div>
            </Toolbar>
            <div className="h-10 bg-bg" />
            <StatusBar
              left={
                <>
                  <span className="inline-flex items-center gap-1"><GitBranch className="size-3" aria-hidden />main</span>
                  <span>{t("design.chrome.aheadBehind")}</span>
                  <span>{t("design.chrome.lastFetch")}</span>
                </>
              }
              right={<><span>UTF-8</span><span>100 %</span></>}
            />
          </div>
        </Section>

        <Section title={t("design.repo.title")} note={t("design.repo.note")}>
          <div className="flex h-105 overflow-hidden rounded-lg border border-border">
            <aside className="w-65 shrink-0 overflow-auto border-r border-border bg-surface" role="tree" aria-label={t("design.repo.branchesAndTags")}>
              <PanelSection title={t("design.repo.local")} count={3} actions={<IconButton size="sm" label={t("design.feedback.createBranch")} icon={<Plus className="size-3.5" aria-hidden />} />}>
                <TreeRow label="main" active ahead={2} behind={3} />
                <TreeRow label="feature" icon={<FolderGit2 className="size-3.5" aria-hidden />} />
                <TreeRow label="zeilen-staging" depth={1} selected icon={<GitBranch className="size-3.5" aria-hidden />} ahead={2} />
                <TreeRow label="alter-versuch" depth={1} hidden icon={<GitBranch className="size-3.5" aria-hidden />} />
              </PanelSection>
              <PanelSection title="Remote" count={2}>
                <TreeRow label="origin" icon={<Cloud className="size-3.5" aria-hidden />} />
                <TreeRow label="main" depth={1} icon={<GitBranch className="size-3.5" aria-hidden />} />
                <TreeRow label="fix/index-lock" depth={1} icon={<GitBranch className="size-3.5" aria-hidden />} />
              </PanelSection>
              <PanelSection title="Tags" count={1}>
                <TreeRow label="v0.1.0" icon={<Tag className="size-3.5" aria-hidden />} />
              </PanelSection>
              <PanelSection title="Stashes" count={0}>
                <p className="px-3 py-1 text-sm text-text-muted">{t("design.repo.noStashes")}</p>
              </PanelSection>
              <PanelSection title="Worktrees" count={0} defaultOpen={false}>
                <span />
              </PanelSection>
            </aside>
            <main className="min-w-0 flex-1 overflow-auto bg-bg">
              <Graph commits={commits} selectedId={selected} onSelect={setSelected} />
            </main>
            <aside className="flex w-95 shrink-0 flex-col border-l border-border bg-surface">
              <PanelSection title={t("design.repo.unstaged")} count={2} actions={<Button size="sm" variant="ghost">{t("design.repo.stageAll")}</Button>}>
                <div role="listbox" aria-label={t("design.repo.unstagedFiles")}>
                  <FileRow path="src-tauri/src/patch.rs" status="modified" selected additions={12} deletions={4} action={<IconButton size="sm" label={t("design.buttons.stageFile")} shortcut="S" icon={<Plus className="size-3.5" aria-hidden />} />} />
                  <FileRow path="docs/zeilen-staging.md" status="untracked" additions={38} action={<IconButton size="sm" label={t("design.buttons.stageFile")} icon={<Plus className="size-3.5" aria-hidden />} />} />
                </div>
              </PanelSection>
              <PanelSection title={t("design.repo.staged")} count={4}>
                <div role="listbox" aria-label={t("design.repo.stagedFiles")}>
                  <FileRow path="src-tauri/src/status.rs" status="added" additions={96} />
                  <FileRow path="src/graph/layout.ts" oldPath="src/graph/lanes.ts" status="renamed" additions={3} deletions={3} />
                  <FileRow path="src/legacy/poll.ts" status="deleted" deletions={54} />
                  <FileRow path="assets/demo.mp4" status="modified" lfs />
                </div>
              </PanelSection>
              <div className="mt-auto flex flex-col gap-2 border-t border-border p-3">
                <TextField aria-label={t("design.repo.summary")} placeholder={t("design.repo.summary")} defaultValue={t("design.repo.summaryValue")} />
                <TextArea aria-label={t("design.inputs.description")} rows={2} placeholder={t("design.repo.descriptionOptional")} />
                <Button variant="primary" size="lg" icon={<GitCommitHorizontal className="size-icon" aria-hidden />}>
                  {t("design.repo.commitFiles")}
                </Button>
              </div>
            </aside>
          </div>
        </Section>

        <Section title={t("design.diff.title")}>
          <div className="grid grid-cols-2 gap-8">
            <Specimen label={t("design.diff.hunkSpecimen")}>
              <DiffHunk
                header="@@ -41,4 +41,5 @@ fn build_patch"
                lines={diffLines}
                actions={
                  <>
                    <Button size="sm">{t("design.diff.stageLines")}</Button>
                    <IconButton size="sm" label={t("design.diff.discardHunk")} danger icon={<Trash2 className="size-3.5" aria-hidden />} />
                  </>
                }
              />
            </Specimen>
            <div className="flex flex-col gap-6">
              <Specimen label={t("design.diff.conflictFiles")}>
                <div className="rounded-md border border-border bg-surface" role="listbox" aria-label={t("design.diff.conflictFiles")}>
                  <FileRow path="src-tauri/src/patch.rs" status="conflicted" selected />
                  <FileRow path="README.md" status="conflicted" />
                </div>
              </Specimen>
              <Specimen label={t("design.diff.emptyState")}>
                <div className="rounded-md border border-border bg-surface">
                  <EmptyState
                    icon={<GitMerge className="size-8" aria-hidden />}
                    title={t("design.diff.nothingToCommit")}
                    action={<Button size="sm">{t("design.diff.createFile")}</Button>}
                  >
                    {t("design.diff.emptyBody")}
                  </EmptyState>
                </div>
              </Specimen>
            </div>
          </div>
        </Section>

        <Section title={t("design.misc.title")}>
          <div className="flex flex-wrap items-center gap-6">
            <Specimen label={t("design.misc.avatars")}>
              <div className="flex items-center gap-2">
                <Avatar name="Mira Sommer" /> <Avatar name="Jonas Keller" /> <Avatar name="Aylin Demir" size={28} />
              </div>
            </Specimen>
            <Specimen label={t("design.misc.refLabels")}>
              <div className="flex items-center gap-2">
                <RefLabel kind="local" name="main" head />
                <RefLabel kind="remote" name="origin/main" />
                <RefLabel kind="tag" name="v0.1.0" />
                <RefLabel kind="local" name="feature/x" lane={3} dropTarget />
                <RefLabel kind="local" name="ausgeblendet" lane={4} dimmed />
              </div>
            </Specimen>
          </div>
        </Section>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("design.dialog.addRemote")}
        description={t("design.dialog.addRemoteBody")}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>{t("design.buttons.cancel")}</Button>
            <Button variant="primary" onClick={() => setDialogOpen(false)}>{t("design.dialog.add")}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextField label="Name" defaultValue="upstream" mono autoFocus />
          <TextField label="URL" placeholder={t("design.inputs.remoteUrlPlaceholder")} mono />
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("design.dialog.deleteBranchTitle")}
        description={t("design.dialog.deleteBranchBody")}
        confirmLabel={t("design.dialog.deleteBranch")}
        danger
        onConfirm={() => setConfirmOpen(false)}
      />
    </div>
  );
}
