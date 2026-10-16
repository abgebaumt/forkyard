/**
 * Collision warning (package 2b): one banner per pair of coding agents – or agent and the current
 * tip of its base – whose work touches the same files. “would collide” when Git's merge of both
 * states stops on conflicts (with the line ranges), “both change” when it merges cleanly. “Show
 * preview” shows both sides of every conflict; “Inform agent …” types a text the user confirmed
 * into the agent's terminal. A failed check is a state in the view (role alert), never a toast.
 * Nothing here takes the focus by itself; new collisions are announced politely.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { core, type Agent, type AgentCollision, type CollisionPreview, type Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { useAgentCollisions, useAgents } from "../../app/queries";
import { runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { TextArea } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { agentNames, collisionTitle, collisionsOf, conflictFiles, fileLabel, formatRanges, informTargets, informText, newCollisionIds, sideLabels } from "./collision";

function Side({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      <pre className="selectable max-h-64 overflow-auto rounded-sm bg-surface-sunken p-2 font-mono text-code whitespace-pre">{text || t("agents.collision.previewEmpty")}</pre>
    </div>
  );
}

function PreviewDialog({ repoId, collision, names, onDone }: { repoId: Id; collision: AgentCollision; names: Map<Id, string>; onDone: (value: null) => void }) {
  const files = conflictFiles(collision);
  const [path, setPath] = useState(files[0]?.path ?? "");
  const [preview, setPreview] = useState<CollisionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    core.agentCollisionPreview({ repoId, collisionId: collision.id, path }).then(
      (result) => {
        if (live) setPreview(result);
      },
      (raw: unknown) => {
        if (live) setError(describeError(raw).text);
      },
    );
    return () => {
      live = false;
    };
  }, [repoId, collision.id, path]);
  const [ours, theirs] = sideLabels(collision, names);
  // Right after switching the file the old answer is still in state until the effect ran: show only
  // an answer for the selected file, never the previous file's blocks under the new button.
  const current = preview && preview.path === path ? preview : null;
  return (
    <Dialog
      open
      size="lg"
      title={t("agents.collision.previewTitle", { title: collisionTitle(collision, names) })}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <Button variant="primary" data-autofocus onClick={() => onDone(null)}>
          {t("agents.collision.close")}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-col gap-3" data-preview-path={current ? current.path : undefined}>
        <div role="group" aria-label={t("agents.collision.previewFile")} className="flex flex-wrap gap-1">
          {files.map((file) => (
            <Button key={file.path} size="sm" variant={file.path === path ? "primary" : "secondary"} aria-pressed={file.path === path} data-preview-file={file.path} onClick={() => setPath(file.path)}>
              {fileLabel(file)}
            </Button>
          ))}
        </div>
        {!current && !error ? (
          <p className="text-sm text-text-muted" aria-live="polite">
            {t("agents.collision.previewLoading")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {current && current.blocks.length === 0 ? <p className="text-sm text-text-muted">{t("agents.collision.previewNoBlocks")}</p> : null}
        {current?.blocks.map((block, index) => {
          const heading = t("agents.collision.previewLines", { name: ours, lines: formatRanges([block.range]) });
          return (
            <section key={index} data-collision-block={index} aria-label={heading} className="flex flex-col gap-1">
              <h3 className="text-sm font-medium text-text">{heading}</h3>
              <div className="grid grid-cols-2 gap-2">
                <Side label={ours} text={block.ours} />
                <Side label={theirs} text={block.theirs} />
              </div>
            </section>
          );
        })}
        {current?.truncated ? <p className="text-sm text-text-muted">{t("agents.collision.previewTruncated")}</p> : null}
      </div>
    </Dialog>
  );
}

/** Both sides of the collision's conflicts in a dialog. */
export function openCollisionPreview(repoId: Id, collision: AgentCollision, names: Map<Id, string>): Promise<null> {
  return showDialog<null>((done) => <PreviewDialog repoId={repoId} collision={collision} names={names} onDone={done} />);
}

function InformDialog({ collision, targets, names, onDone }: { collision: AgentCollision; targets: Agent[]; names: Map<Id, string>; onDone: (value: true | null) => void }) {
  const firstTarget = targets[0]!;
  const [recipient, setRecipient] = useState<Id>(firstTarget.id);
  const [text, setText] = useState(() => informText(collision, firstTarget.id, names));
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const empty = text.trim() === "";
  const recipientName = names.get(recipient) ?? recipient;
  return (
    <Dialog
      open
      size="md"
      title={t("agents.collision.informTitle")}
      description={t("agents.collision.informHint")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("agents.collision.informCancel")}</Button>
          <Button variant="primary" type="submit" form="agent-inform" data-action="inform-send" disabled={empty || sending}>
            {t("agents.collision.informSend")}
          </Button>
        </>
      }
    >
      <form
        id="agent-inform"
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (empty || sending) return;
          setSending(true);
          const result = await runAction(t("agents.collision.informSend"), () => core.agentInform({ agentId: recipient, text }), {
            success: t("agents.collision.informDone", { name: recipientName }),
          });
          setSending(false);
          if (result.ok) onDone(true);
        }}
      >
        {targets.length > 1 ? (
          <Select
            label={t("agents.collision.informRecipient")}
            value={recipient}
            options={targets.map((target) => ({ value: target.id, label: target.shortName }))}
            onValueChange={(next) => {
              setRecipient(next);
              if (!edited) setText(informText(collision, next, names));
            }}
          />
        ) : (
          <p className="text-sm text-text">{t("agents.collision.informTo", { name: firstTarget.shortName })}</p>
        )}
        <TextArea
          data-autofocus
          data-field="inform-text"
          label={t("agents.collision.informText")}
          rows={6}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setEdited(true);
          }}
        />
      </form>
    </Dialog>
  );
}

/** Asks for recipient and text, then types it into that agent's terminal; null = cancelled. */
export function openInform(collision: AgentCollision, targets: Agent[], names: Map<Id, string>): Promise<true | null> {
  return showDialog<true>((done) => <InformDialog collision={collision} targets={targets} names={names} onDone={done} />);
}

export function CollisionBanners({ repoId, agentId = null, showSkipped = false, inset = false }: { repoId: Id; agentId?: Id | null; showSkipped?: boolean; inset?: boolean }) {
  const report = useAgentCollisions(repoId);
  const agents = useAgents(repoId);
  const list = useMemo(() => agents.data ?? [], [agents.data]);
  const names = useMemo(() => agentNames(list), [list]);
  const collisions = collisionsOf(report.data, list, agentId);
  const failed = report.data?.state === "failed";
  const skipped = showSkipped && report.data?.state === "done" ? report.data.skipped : [];
  const seen = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!report.data || report.data.state === "checking") return;
    if (seen.current) {
      const fresh = newCollisionIds(seen.current, collisions);
      const first = collisions.find((collision) => collision.id === fresh[0]);
      if (first) setAnnouncement(t("agents.collision.announce", { title: collisionTitle(first, names) }));
    }
    seen.current = new Set(collisions.map((collision) => collision.id));
    // Only a new report counts; names and the list follow from it.
  }, [report.data]);

  const anything = failed || collisions.length > 0 || skipped.length > 0;
  return (
    <div data-collisions aria-label={t("agents.collision.regionLabel")} className={cn("flex flex-col gap-2", inset && anything && "px-4 pt-3")}>
      <p className="sr-only" aria-live="polite" data-collision-live>
        {announcement}
      </p>
      {failed ? (
        <Banner
          tone="danger"
          title={t("agents.collision.failed")}
          actions={
            <Button size="sm" data-action="collision-check" onClick={() => void runAction(t("agents.collision.checkAgain"), () => core.agentCollisionCheck({ repoId }))}>
              {t("agents.collision.checkAgain")}
            </Button>
          }
        >
          {report.data?.error}
        </Banner>
      ) : null}
      {collisions.map((collision) => {
        const targets = informTargets(collision, list);
        const listed = collision.files.length > 1 || collision.files.some((file) => file.ranges.length > 0);
        return (
          <div key={collision.id} data-collision={collision.id} data-kind={collision.kind}>
            <Banner
              tone={collision.kind === "conflict" ? "warning" : "info"}
              title={collisionTitle(collision, names)}
              actions={
                <>
                  {collision.kind === "conflict" && conflictFiles(collision).length > 0 ? (
                    <Button size="sm" data-action="collision-preview" onClick={() => void openCollisionPreview(repoId, collision, names)}>
                      {t("agents.collision.preview")}
                    </Button>
                  ) : null}
                  {targets.length > 0 ? (
                    <Button size="sm" data-action="collision-inform" onClick={() => void openInform(collision, targets, names)}>
                      {t("agents.collision.inform")}
                    </Button>
                  ) : null}
                </>
              }
            >
              {listed ? (
                <ul className="flex flex-col">
                  {collision.files.map((file) => (
                    <li key={file.path} className="font-mono text-code break-all">
                      {fileLabel(file)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {targets.length === 0 ? <p>{t("agents.collision.informNotRunning")}</p> : null}
            </Banner>
          </div>
        );
      })}
      {skipped.map((skip) => (
        <p key={skip.agentId} className="text-sm text-text-muted" data-collision-skip={skip.agentId}>
          {t("agents.collision.skipped", { name: names.get(skip.agentId) ?? skip.agentId, reason: skip.reason })}
        </p>
      ))}
    </div>
  );
}
