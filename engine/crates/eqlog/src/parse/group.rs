//! `src/main/log/parseGroup.ts` — the lines that say WHO YOU ARE WITH.
//!
//! NOTE THE FIELD ORDER: a group event writes `change` (and, when it names one, `name`) BEFORE the
//! `seq`/`ts`/`raw` envelope. It is the only kind in the whole stream that does, and it is the
//! reason `Ev::envelope` is a separate call rather than part of `begin`.

use crate::event::{Ev, Key, Kind};
use regex::Regex;

use super::Ctx;

const SELF_JOIN_LINE: &str = "You have joined the group.";
const SELF_LEAVE_LINE: &str = "You have been removed from the group.";
const SELF_LEADER_LINE: &str = "You are now the leader of your group.";
const SELF_TELL_PREFIX: &str = "You tell your party, '";

/// A PLAYER NAME as the subject — deliberately NOT `.+?`, so a chat line QUOTING one of these
/// sentences cannot satisfy the pattern with the speaker's whole prefix as the "name".
const NAME: &str = "([A-Za-z][A-Za-z`'-]*)";

pub struct GroupRes {
    /// The pattern table for the shapes that NAME someone, tried in order.
    named: Vec<(Regex, &'static str)>,
}

/// See `AcquireRes`'s note: `Default` is `new`.
impl Default for GroupRes {
    fn default() -> Self {
        Self::new()
    }
}

impl GroupRes {
    pub fn new() -> Self {
        let re = |body: String| Regex::new(&body).unwrap();
        GroupRes {
            named: vec![
                (re(format!(r"^{NAME} has joined the group\.$")), "join"),
                (
                    re(format!(
                        r"^{NAME} has (?:left|been removed from) the group\.$"
                    )),
                    "leave",
                ),
                (
                    re(format!(r"^You remove {NAME} from the group\.$")),
                    "leave",
                ),
                (
                    re(format!(r"^{NAME} is now the leader of your group\.$")),
                    "leader",
                ),
                (
                    re(format!(r"^You invite {NAME} to join your group\.$")),
                    "invite",
                ),
                (
                    re(format!(r"^{NAME} invites you to join a group\.$")),
                    "invite",
                ),
                (re(format!(r"^{NAME} tells the group, '")), "confirm"),
            ],
        }
    }
}

pub fn classify_group(r: &GroupRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if !text.contains("group") && !text.contains("party") {
        return false;
    }
    // The two self EXACT lines are compared before any regex runs, so `You have joined the group.`
    // can never be read as a member named "You".
    if text == SELF_JOIN_LINE {
        out.begin(Kind::Group);
        out.s(Key::Change, "selfJoin");
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    if text == SELF_LEAVE_LINE {
        out.begin(Kind::Group);
        out.s(Key::Change, "selfLeave");
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    // Named here so the next reader knows they were seen and dismissed, not missed.
    if text == SELF_LEADER_LINE || text.starts_with(SELF_TELL_PREFIX) {
        return false;
    }
    for (re, change) in &r.named {
        if let Some(m) = re.captures(text) {
            out.begin(Kind::Group);
            out.s(Key::Change, change);
            out.s(Key::Name, &m[1]);
            out.envelope(c.seq, c.ts, c.raw);
            return true;
        }
    }
    false
}
