//! Status automaton of a coding agent: started → running ⇄ waiting for you → done (exit 0) |
//! failed (exit ≠ 0) | stopped (user or app). Pure: events and times come from outside, so the
//! rules can be tested with fixed timelines.

use std::time::{Duration, Instant};

use super::channel::HookSignal;
use crate::model::{AgentStatus, AgentStatusSource};

/// No screen change for this long while running: probably waiting (guess, only without hooks).
pub const QUIET_AFTER: Duration = Duration::from_secs(20);
/// A reported status needs to be this old before output switches it back to running.
pub const SETTLE: Duration = Duration::from_secs(2);

/// What the terminal reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    /// BEL.
    Bell,
    /// OSC 9 / OSC 777 desktop notification.
    Notification,
    /// OSC 0 / OSC 2 window title.
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// The visible screen changed.
    Output,
    Hook(HookSignal),
    Terminal(Cue),
    /// Periodic check (quiet period).
    Tick,
    /// The user asked to stop; the status follows when the process has ended.
    StopRequested,
    Exited(Option<i32>),
    AppClosed,
}

#[derive(Debug, Clone)]
pub struct Machine {
    status: AgentStatus,
    source: AgentStatusSource,
    since: Instant,
    last_output: Instant,
    hook_capable: bool,
    hook_seen: bool,
    stop_requested: bool,
    finished: bool,
    exit_code: Option<i32>,
}

impl Machine {
    pub fn new(now: Instant, hook_capable: bool) -> Machine {
        Machine {
            status: AgentStatus::Starting,
            source: AgentStatusSource::Guess,
            since: now,
            last_output: now,
            hook_capable,
            hook_seen: false,
            stop_requested: false,
            finished: false,
            exit_code: None,
        }
    }

    pub fn status(&self) -> AgentStatus {
        self.status
    }

    pub fn source(&self) -> AgentStatusSource {
        self.source
    }

    pub fn is_final(&self) -> bool {
        self.finished
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    fn set(&mut self, status: AgentStatus, source: AgentStatusSource, now: Instant) -> bool {
        if self.status == status && self.source == source {
            return false;
        }
        self.status = status;
        self.source = source;
        self.since = now;
        true
    }

    /// Applies an event; true if status or source changed.
    pub fn apply(&mut self, event: Event, now: Instant) -> bool {
        if self.finished {
            return false;
        }
        match event {
            Event::Output | Event::Terminal(Cue::Title) => {
                self.last_output = now;
                match self.status {
                    AgentStatus::Starting => self.set(AgentStatus::Running, AgentStatusSource::Guess, now),
                    AgentStatus::Waiting | AgentStatus::Done if now.saturating_duration_since(self.since) >= SETTLE => {
                        let source = self.source;
                        self.set(AgentStatus::Running, source, now)
                    }
                    _ => false,
                }
            }
            Event::Hook(signal) => {
                self.hook_seen = true;
                let status = match signal {
                    HookSignal::Waiting => AgentStatus::Waiting,
                    HookSignal::Done => AgentStatus::Done,
                    HookSignal::Running => AgentStatus::Running,
                };
                self.set(status, AgentStatusSource::Agent, now)
            }
            Event::Terminal(Cue::Bell | Cue::Notification) => {
                if self.hook_seen {
                    return false;
                }
                self.set(AgentStatus::Waiting, AgentStatusSource::Agent, now)
            }
            Event::Tick => {
                let quiet = now.saturating_duration_since(self.last_output) >= QUIET_AFTER;
                if self.hook_seen || self.status != AgentStatus::Running || !quiet {
                    return false;
                }
                self.set(AgentStatus::Waiting, AgentStatusSource::Guess, now)
            }
            Event::StopRequested => {
                self.stop_requested = true;
                false
            }
            Event::Exited(code) => {
                self.finished = true;
                self.exit_code = code;
                let status = match (self.stop_requested, code) {
                    (true, _) => AgentStatus::Stopped,
                    (false, Some(0)) => AgentStatus::Done,
                    (false, _) => AgentStatus::Failed,
                };
                let source = if self.hook_capable { AgentStatusSource::Agent } else { self.source };
                self.set(status, source, now);
                true
            }
            Event::AppClosed => {
                self.finished = true;
                let source = self.source;
                self.set(AgentStatus::Stopped, source, now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agents::channel::HookSignal;

    fn at(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn hooks_win_and_output_resumes_after_settling() {
        let t0 = Instant::now();
        let mut m = Machine::new(t0, true);
        assert_eq!((m.status(), m.source()), (AgentStatus::Starting, AgentStatusSource::Guess));
        assert!(m.apply(Event::Output, at(t0, 1)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Running, AgentStatusSource::Guess));
        assert!(m.apply(Event::Hook(HookSignal::Waiting), at(t0, 5)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Waiting, AgentStatusSource::Agent));
        // The redraw right after the report does not count …
        assert!(!m.apply(Event::Output, at(t0, 6)));
        assert_eq!(m.status(), AgentStatus::Waiting);
        // … later output does (the user answered).
        assert!(m.apply(Event::Output, at(t0, 9)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Running, AgentStatusSource::Agent));
        // Once a hook spoke, terminal cues and quiet periods change nothing.
        assert!(!m.apply(Event::Terminal(Cue::Bell), at(t0, 10)));
        assert!(!m.apply(Event::Tick, at(t0, 60)));
        assert_eq!(m.status(), AgentStatus::Running);
        assert!(m.apply(Event::Hook(HookSignal::Done), at(t0, 61)));
        assert_eq!((m.status(), m.is_final()), (AgentStatus::Done, false), "the session still runs");
        assert!(m.apply(Event::Hook(HookSignal::Running), at(t0, 62)));
        assert_eq!(m.status(), AgentStatus::Running);
        assert!(m.apply(Event::Exited(Some(0)), at(t0, 70)));
        assert_eq!((m.status(), m.is_final(), m.exit_code()), (AgentStatus::Done, true, Some(0)));
        // Final: nothing changes it any more.
        for event in [Event::Output, Event::Hook(HookSignal::Waiting), Event::Terminal(Cue::Notification), Event::Tick, Event::AppClosed, Event::Exited(Some(1))] {
            assert!(!m.apply(event, at(t0, 80)));
        }
        assert_eq!(m.status(), AgentStatus::Done);
    }

    #[test]
    fn without_hooks_terminal_signals_and_quiet_periods_decide() {
        let t0 = Instant::now();
        let mut m = Machine::new(t0, false);
        m.apply(Event::Output, at(t0, 1));
        assert!(!m.apply(Event::Tick, at(t0, 20)), "19 s quiet: still running");
        assert!(m.apply(Event::Tick, at(t0, 21)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Waiting, AgentStatusSource::Guess));
        assert!(m.apply(Event::Output, at(t0, 30)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Running, AgentStatusSource::Guess));
        // A window title is output, not a status.
        assert!(!m.apply(Event::Terminal(Cue::Title), at(t0, 31)));
        assert!(!m.apply(Event::Tick, at(t0, 50)), "the title reset the quiet period");
        assert!(m.apply(Event::Terminal(Cue::Bell), at(t0, 52)));
        assert_eq!((m.status(), m.source()), (AgentStatus::Waiting, AgentStatusSource::Agent));
        assert!(m.apply(Event::Exited(Some(2)), at(t0, 60)));
        assert_eq!((m.status(), m.exit_code()), (AgentStatus::Failed, Some(2)));
    }

    #[test]
    fn stopping_and_closing_end_as_stopped() {
        let t0 = Instant::now();
        let mut stopped = Machine::new(t0, true);
        stopped.apply(Event::Output, at(t0, 1));
        assert!(!stopped.apply(Event::StopRequested, at(t0, 2)), "the status changes only when the process ends");
        assert!(stopped.apply(Event::Exited(Some(143)), at(t0, 3)));
        assert_eq!((stopped.status(), stopped.is_final()), (AgentStatus::Stopped, true));
        let mut killed = Machine::new(t0, true);
        assert!(killed.apply(Event::Exited(None), at(t0, 1)));
        assert_eq!(killed.status(), AgentStatus::Failed, "ended without an exit code");
        let mut closed = Machine::new(t0, false);
        closed.apply(Event::Output, at(t0, 1));
        assert!(closed.apply(Event::AppClosed, at(t0, 2)));
        assert_eq!((closed.status(), closed.is_final()), (AgentStatus::Stopped, true));
    }
}
