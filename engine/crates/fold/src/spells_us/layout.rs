//! Which column layout a client's `spells_us.txt` is in — the TypeScript reader's twin
//! (`src/main/resist/spellsUsLayout.ts`), one rule for both.
//!
//! THE 2026-10-13 GAME PATCH INSERTED ONE COLUMN somewhere in fields 52..=75. Measured on the
//! owner's patched install: the icon moved 75 -> 76, the resist adjustment 78 -> 79, the effect
//! slots 172 -> 173, while everything up to the class levels (36..=51) stayed put. No reader
//! takes a field in 52..=74, so dropping ONE column at 52 from every row of a patched file puts
//! every field a reader takes back where the parser expects it, whichever column the patch added.
//!
//! The layout is read from the file: the effect-slot list (`1|35|1|0|100|0$2|...`) sits in 172 in
//! the old layout and in 173 in the new one, and the majority over a sample of rows decides, so an
//! unpatched client and the tests' 173-field rows parse exactly as before.

/// Where the extra column is dropped from a patched row. Any index in 52..=75 restores every read field.
pub const INSERTED_COLUMN: usize = 52;
const OLD_SLOTS: usize = 172;
const NEW_SLOTS: usize = 173;
/// Rows sampled to decide; the effect lists start within the first few hundred rows.
const SAMPLE_ROWS: usize = 4000;

/// `1|...`: digits, then a bar — the head of an effect-slot list.
fn is_slot_list(s: &str) -> bool {
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && s.as_bytes().get(digits) == Some(&b'|')
}

/// True when the file is in the patched (2026-10-13) layout.
#[must_use]
pub fn shifted(text: &str) -> bool {
    let (mut old_votes, mut new_votes, mut seen) = (0usize, 0usize, 0usize);
    for line in text.split('\n').take(SAMPLE_ROWS) {
        let f: Vec<&str> = line.split('^').collect();
        if f.len() <= OLD_SLOTS {
            continue;
        }
        seen += 1;
        if is_slot_list(f[OLD_SLOTS]) {
            old_votes += 1;
        } else if f.len() > NEW_SLOTS && is_slot_list(f[NEW_SLOTS]) {
            new_votes += 1;
        }
    }
    seen > 0 && new_votes > old_votes
}

/// A row's fields in the layout the reader indexes: the inserted column dropped from a patched row.
#[must_use]
pub fn unshift(mut f: Vec<&str>, shifted: bool) -> Vec<&str> {
    if shifted && f.len() > INSERTED_COLUMN {
        f.remove(INSERTED_COLUMN);
    }
    f
}

/// A field, as `f[i]` reads over there: `undefined` past the end, which `Number` reads as `NaN` and
/// `Number(x) || 0` reads as 0.
pub(super) fn field<'a>(f: &[&'a str], i: usize) -> Option<&'a str> {
    f.get(i).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(len: usize, slots_at: usize) -> String {
        let mut f = vec!["0".to_string(); len];
        f[slots_at] = "1|35|1|0|100|0$2|0|-1|0|101|11".to_string();
        f.join("^")
    }

    #[test]
    fn the_old_layout_is_left_alone() {
        let text = [row(173, 172), row(173, 172)].join("\n");
        assert!(!shifted(&text));
        let f: Vec<&str> = text.lines().next().unwrap().split('^').collect();
        assert_eq!(unshift(f.clone(), false).len(), f.len());
    }

    #[test]
    fn the_patched_layout_is_detected_and_unshifted() {
        let text = [row(174, 173), row(174, 173), row(174, 172)].join("\n");
        assert!(shifted(&text));
        let line = row(174, 173);
        let f = unshift(line.split('^').collect(), true);
        assert_eq!(f.len(), 173);
        assert!(is_slot_list(f[OLD_SLOTS]), "the slots are back at 172");
    }

    #[test]
    fn a_file_with_no_long_rows_is_not_shifted() {
        assert!(!shifted("1^Short^row"));
    }
}
