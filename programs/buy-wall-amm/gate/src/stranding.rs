//! Test builds that prove the gate catches stranding: copies of the program with the
//! mistakes that strand markets, made by editing a copy of the workspace exactly as a
//! careless change would edit the real one, so the program's own source never carries them.
//!
//! Three layout mistakes must be refused on every fixture, failing on every open market; a
//! payout rule narrowed so one fee slot can no longer be swept must be refused on every
//! market owed that slot; and a field appended into the reserve, as
//! `docs/spec/pool4-for-solana.md` ("One fixed-size layout") allows, must pass on every
//! fixture. CI builds them with `buy-wall-gate test-builds` and `tests/stranding.rs` runs the
//! gate on each.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestBuild {
    /// `wall_sol_placed` moved up before `sqrt_price`, shifting the pricing fields.
    MovedField,
    /// The market state type renamed with its discriminator left to Anchor, which derives it
    /// from the new name (what `POOL4-21` rules out).
    RenamedType,
    /// The account made 8 bytes larger, the reserve grown to match.
    Resized,
    /// A field appended into the reserve, zero meaning the old behaviour, as layout version 2
    /// beside version 1.
    AppendedField,
    /// `Owed::sweep` made to refuse slot 2, the suite's fees: the layout and the trades stay
    /// sound, but that ledger is stranded on every market owed it, and the gate's own tree,
    /// built with the same edit, would no longer call that job due.
    NarrowedSweep,
}

impl TestBuild {
    pub const ALL: [TestBuild; 5] = [
        TestBuild::MovedField,
        TestBuild::RenamedType,
        TestBuild::Resized,
        TestBuild::AppendedField,
        TestBuild::NarrowedSweep,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TestBuild::MovedField => "moved-field",
            TestBuild::RenamedType => "renamed-type",
            TestBuild::Resized => "resized",
            TestBuild::AppendedField => "appended-field",
            TestBuild::NarrowedSweep => "narrowed-sweep",
        }
    }

    /// Whether the gate must pass it on every fixture.
    pub fn must_pass(self) -> bool {
        self == TestBuild::AppendedField
    }

    /// Whether it breaks the market state's layout, which strands every open market.
    pub fn breaks_the_layout(self) -> bool {
        matches!(
            self,
            TestBuild::MovedField | TestBuild::RenamedType | TestBuild::Resized
        )
    }

    /// Edits the program's source, given as `(path under src/, text)` pairs.
    pub fn edit(self, sources: &mut Sources) -> Result<(), String> {
        match self {
            TestBuild::MovedField => {
                let state = sources.get("state.rs")?;
                let state = replace_once(state, "    pub wall_sol_placed: [u8; 8],\n", "")?;
                let state = replace_once(
                    &state,
                    "    pub sqrt_price: [u8; 16],\n",
                    "    pub wall_sol_placed: [u8; 8],\n    pub sqrt_price: [u8; 16],\n",
                )?;
                sources.set("state.rs", state);
            }
            TestBuild::RenamedType => {
                let state = replace_once(
                    sources.get("state.rs")?,
                    "#[account(zero_copy, discriminator = MARKET_STATE_DISCRIMINATOR)]",
                    "#[account(zero_copy)]",
                )?;
                sources.set("state.rs", state);
                for (_, text) in sources.files.iter_mut() {
                    *text = rename_identifier(text, "MarketState", "BuyWallMarket");
                }
            }
            TestBuild::Resized => {
                let config = edit_constant(sources.get("config.rs")?, "MARKET_STATE_SIZE", 8)?;
                sources.set("config.rs", config);
                let state = edit_constant(sources.get("state.rs")?, "RESERVE_LEN", 8)?;
                sources.set("state.rs", state);
            }
            TestBuild::AppendedField => {
                let state = sources.get("state.rs")?;
                let state = replace_once(
                    state,
                    "    pub reserve: [u8; RESERVE_LEN],\n",
                    "    pub appended: [u8; 8],\n    pub reserve: [u8; RESERVE_LEN],\n",
                )?;
                let state = edit_constant(&state, "RESERVE_LEN", -8)?;
                let state = replace_once(
                    &state,
                    "pub const LAYOUT_VERSION: u8 = 1;",
                    "pub const LAYOUT_VERSION: u8 = 2;",
                )?;
                let state = replace_once(
                    &state,
                    "pub const DEPLOYED_LAYOUT_VERSIONS: &[u8] = &[1];",
                    "pub const DEPLOYED_LAYOUT_VERSIONS: &[u8] = &[1, 2];",
                )?;
                sources.set("state.rs", state);
            }
            TestBuild::NarrowedSweep => {
                let payouts = replace_once(
                    sources.get("payouts.rs")?,
                    "            2 => &mut after.fees_suite,\n",
                    "            2 => return Err(Refusal::BadSlot),\n",
                )?;
                sources.set("payouts.rs", payouts);
            }
        }
        Ok(())
    }
}

/// The program's `.rs` files under `src/`, by path relative to it.
pub struct Sources {
    pub files: Vec<(String, String)>,
}

impl Sources {
    pub fn read(src: &Path) -> Result<Self, String> {
        let mut files = vec![];
        collect(src, src, &mut files)?;
        files.sort();
        Ok(Sources { files })
    }

    pub fn get(&self, path: &str) -> Result<&str, String> {
        self.files
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, text)| text.as_str())
            .ok_or_else(|| format!("src/{path} is missing"))
    }

    fn set(&mut self, path: &str, text: String) {
        if let Some(file) = self.files.iter_mut().find(|(p, _)| p == path) {
            file.1 = text;
        }
    }

    pub fn write(&self, src: &Path) -> Result<(), String> {
        for (path, text) in &self.files {
            let file = src.join(path);
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            std::fs::write(&file, text).map_err(|e| format!("src/{path}: {e}"))?;
        }
        Ok(())
    }
}

fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            collect(root, &path, files)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            files.push((relative.to_string_lossy().into_owned(), text));
        }
    }
    Ok(())
}

/// `text` with `from` replaced by `to`, which must occur exactly once, so an edit that no
/// longer fits the source fails loudly rather than building something else.
fn replace_once(text: &str, from: &str, to: &str) -> Result<String, String> {
    match text.matches(from).count() {
        1 => Ok(text.replacen(from, to, 1)),
        n => Err(format!(
            "expected {from:?} once in the source, found it {n} times"
        )),
    }
}

/// `text` with the `usize` constant `name`'s value (written with optional `_` separators)
/// moved by `delta`.
fn edit_constant(text: &str, name: &str, delta: i64) -> Result<String, String> {
    let prefix = &format!("pub const {name}: usize = ");
    let start = match text.matches(prefix).count() {
        1 => text
            .find(prefix)
            .map(|i| i + prefix.len())
            .unwrap_or_default(),
        n => {
            return Err(format!(
                "expected {prefix:?} once in the source, found it {n} times"
            ))
        }
    };
    let digits: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .collect();
    let value: i64 = digits
        .replace('_', "")
        .parse()
        .map_err(|_| format!("no number after {prefix:?}"))?;
    Ok(format!(
        "{}{}{}",
        &text[..start],
        value + delta,
        &text[start + digits.len()..]
    ))
}

/// `text` with every whole identifier `from` renamed to `to`.
fn rename_identifier(text: &str, from: &str, to: &str) -> String {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(from) {
        let before = rest[..i].chars().next_back();
        let after = rest[i + from.len()..].chars().next();
        out.push_str(&rest[..i]);
        if before.is_some_and(is_ident) || after.is_some_and(is_ident) {
            out.push_str(from);
        } else {
            out.push_str(to);
        }
        rest = &rest[i + from.len()..];
    }
    out.push_str(rest);
    out
}

/// Where the test build `build` is written under `out`.
pub fn path(out: &Path, build: TestBuild) -> PathBuf {
    out.join(build.name()).join("buy_wall_amm.so")
}

/// Builds every test build into `out/<name>/buy_wall_amm.so`, each from a copy of the
/// workspace at `workspace` (`programs/`) with the edit applied, by its own manifest as the
/// real program is built.
///
/// Every build uses one copy, at `out/workspace`, and a target directory of its own,
/// `out/target`, never the workspace's: cargo fingerprints a workspace member by its path
/// within the workspace, so a copy built in the workspace's target directory would pass for
/// the real program there, and the next real build could find it fresh and ship a test
/// build. Each build rewrites every source file of the copy, so cargo rebuilds the program,
/// and the builds are checked to differ from one another and from the real build.
pub fn build_all(workspace: &Path, out: &Path) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let out = out
        .canonicalize()
        .map_err(|e| format!("{}: {e}", out.display()))?;
    let out = out.as_path();
    let copy = out.join("workspace");
    // A fresh copy each run, so nothing deleted from the workspace lives on in it.
    if copy.exists() {
        std::fs::remove_dir_all(&copy).map_err(|e| format!("{}: {e}", copy.display()))?;
    }
    copy_tree(workspace, &copy, out)?;
    let real = Sources::read(&workspace.join("buy-wall-amm/src"))?;
    let src = copy.join("buy-wall-amm/src");
    let mut hashes: Vec<(String, String)> = vec![];
    if let Ok(elf) = std::fs::read(crate::programs::current_build_path()) {
        hashes.push((
            "the real build".into(),
            pipeline_check::executable_sha256(&elf).0,
        ));
    }
    for build in TestBuild::ALL {
        let mut sources = Sources {
            files: real.files.clone(),
        };
        build
            .edit(&mut sources)
            .map_err(|e| format!("{}: {e}", build.name()))?;
        if src.exists() {
            std::fs::remove_dir_all(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        }
        sources.write(&src)?;
        let target = out.join(build.name());
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        eprintln!("== the {} test build", build.name());
        let status = Command::new("cargo")
            .arg("build-sbf")
            .arg("--manifest-path")
            .arg(copy.join("buy-wall-amm/Cargo.toml"))
            .arg("--sbf-out-dir")
            .arg(&target)
            .env("CARGO_TARGET_DIR", out.join("target"))
            .status()
            .map_err(|e| format!("cannot run cargo build-sbf: {e}"))?;
        if !status.success() {
            return Err(format!("the {} test build did not build", build.name()));
        }
        let elf = std::fs::read(path(out, build)).map_err(|e| format!("{}: {e}", build.name()))?;
        let hash = pipeline_check::executable_sha256(&elf).0;
        if let Some((same, _)) = hashes.iter().find(|(_, h)| *h == hash) {
            return Err(format!(
                "the {} test build came out identical to {same}",
                build.name()
            ));
        }
        hashes.push((format!("the {} test build", build.name()), hash));
    }
    Ok(())
}

/// Copies the workspace's sources, leaving out build outputs, installed packages and `skip`
/// (the test builds' own folder, wherever it is), each file written anew so its time is
/// now and cargo never takes it for an older build's.
fn copy_tree(from: &Path, to: &Path, skip: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let path = entry.path();
        if name == "target"
            || name == "node_modules"
            || name.to_string_lossy().starts_with('.')
            || path.canonicalize().is_ok_and(|p| p == skip)
        {
            continue;
        }
        if path.is_dir() {
            copy_tree(&path, &to.join(&name), skip)?;
        } else {
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            std::fs::write(to.join(&name), bytes)
                .map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Sources {
        Sources::read(&crate::programs::crate_dir().join("../src")).unwrap()
    }

    #[test]
    fn every_edit_fits_the_programs_source_as_it_is() {
        for build in TestBuild::ALL {
            let mut edited = sources();
            build
                .edit(&mut edited)
                .unwrap_or_else(|e| panic!("{}: {e}", build.name()));
            assert_ne!(
                edited.files,
                sources().files,
                "{} changed nothing",
                build.name()
            );
        }
    }

    #[test]
    fn the_rename_renames_whole_identifiers_only() {
        assert_eq!(
            rename_identifier(
                "MarketState, MarketStateX, &MarketState>",
                "MarketState",
                "B"
            ),
            "B, MarketStateX, &B>"
        );
    }

    #[test]
    fn numbers_move_with_their_separators_dropped() {
        assert_eq!(
            edit_constant("pub const A: usize = 1_024;", "A", 8).unwrap(),
            "pub const A: usize = 1032;"
        );
        assert!(edit_constant("pub const B: usize = 3;", "A", 8).is_err());
    }
}
