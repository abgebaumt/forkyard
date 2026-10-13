/**
 * For the "Notifications" section of the preferences: the real state of system notifications
 * (allowed, blocked by the system, not asked yet) and a test that really sends a notification
 * now.
 */
import { t } from "../../i18n";
import { useEffect, useState } from "react";
import { BellOff, CircleCheck, CircleHelp, Send } from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge, SettingRow, type BadgeTone } from "../../screens/Preferences/parts";
import { readSystemNotifications, sendTestNotification, systemNotificationState, type SystemNotifications } from "../notify";
import { onSystemNotificationsChange } from "./system";

/**
 * The state as soon as the section is open – determined afresh, because the permission may
 * have been changed in the system settings in the meantime. The system is not asked here; that
 * happens with the first notification (or the test).
 */
export function useSystemNotificationState(): SystemNotifications {
  const [state, setState] = useState<SystemNotifications>(systemNotificationState);
  useEffect(() => {
    let active = true;
    const apply = () => {
      if (active) setState(systemNotificationState());
    };
    const stop = onSystemNotificationsChange(apply);
    void readSystemNotifications().then(apply);
    return () => {
      active = false;
      stop();
    };
  }, []);
  return state;
}

/** Sentence for the section's introduction – promises only what the system allows. */
export function systemIntro(state: SystemNotifications): string {
  switch (state) {
    case "granted":
      return ` ${t("notifications.system.intro.granted")}`;
    case "blocked":
      return ` ${t("notifications.system.intro.blocked")}`;
    case "unknown":
      return ` ${t("notifications.system.intro.unknown")}`;
  }
}

const badges: Record<SystemNotifications, { tone: BadgeTone; label: string; icon: typeof CircleCheck; text: string }> = {
  granted: {
    tone: "success",
    label: t("notifications.system.granted.label"),
    icon: CircleCheck,
    text: t("notifications.system.granted.text"),
  },
  blocked: {
    tone: "warning",
    label: t("notifications.system.blocked.label"),
    icon: BellOff,
    text: t("notifications.system.blocked.text"),
  },
  unknown: {
    tone: "neutral",
    label: t("notifications.system.unknown.label"),
    icon: CircleHelp,
    text: t("notifications.system.unknown.text"),
  },
};

type Probe = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "failed"; reason: string };

/** Row "System notifications": state as a word, and the test. */
export function SystemNotificationsRow({ state }: { state: SystemNotifications }) {
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });
  const badge = badges[state];
  const Icon = badge.icon;

  const send = async () => {
    if (probe.kind === "sending") return;
    setProbe({ kind: "sending" });
    const failure = await sendTestNotification();
    setProbe(failure ? { kind: "failed", reason: failure } : { kind: "sent" });
  };

  return (
    <SettingRow title={t("notifications.system.title")} group stacked description={<span data-system-text>{badge.text}</span>}>
      {(ids) => (
        <div role="group" aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} data-system-state={state} className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone} icon={<Icon className="size-3" aria-hidden />}>
            {badge.label}
          </Badge>
          <Button size="sm" loading={probe.kind === "sending"} disabled={state === "blocked"} icon={<Send className="size-3.5" aria-hidden />} data-action="notification-probe" onClick={() => void send()}>
            {t("notifications.system.probe")}
          </Button>
          <span role="status" data-probe={probe.kind} className="min-w-0 text-sm text-text-muted">
            {probe.kind === "sent" ? t("notifications.system.sent") : null}
            {probe.kind === "failed" ? <span className="selectable break-words text-danger">{t("notifications.system.notSent", { reason: probe.reason })}</span> : null}
          </span>
        </div>
      )}
    </SettingRow>
  );
}
