//! Turning "the user dropped these things" into an ordered list of device work.
//!
//! Dropping a folder is the requirement that makes this module necessary: MTP
//! has no recursive copy, so a folder tree becomes N `create_folder` calls and
//! M uploads, and *something* has to decide their order and their names on the
//! device. Doing that walk here, ahead of the transfer, buys three things the
//! streaming alternative cannot:
//!
//! - a real total (file count and byte count) before the first byte moves, so
//!   progress is a fraction rather than a spinner;
//! - every filesystem error surfaced before anything is written to the phone,
//!   instead of half a tree copied and then a failure;
//! - a pure function over paths, testable against a temp directory with no
//!   device in the room.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// One file to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadItem {
    /// Where to read it from on this computer.
    pub local: PathBuf,
    /// Folder chain below the drop target that must exist before it is written.
    /// Empty means "directly into the folder the user dropped onto".
    pub rel_dir: Vec<String>,
    /// Name it will carry on the device.
    pub name: String,
    pub size: u64,
}

/// What a drop expands into.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UploadPlan {
    /// Folders to create, parents always before their children.
    pub dirs: Vec<Vec<String>>,
    /// Files to send, in the order they should go.
    pub items: Vec<UploadItem>,
    pub total_bytes: u64,
    /// Paths the walk refused to follow, with the reason. Reported rather than
    /// silently dropped: a copy that quietly skipped something is worse than
    /// one that says what it skipped.
    pub skipped: Vec<(PathBuf, SkipReason)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// A symlink. Not followed, because a link pointing at its own ancestor
    /// turns a folder copy into an infinite one, and a link pointing outside
    /// the dropped tree would copy files the user never selected.
    Symlink,
    /// Neither a regular file nor a directory — a socket, a fifo, a device node.
    NotAFile,
    /// The name cannot exist on the device.
    UnusableName,
}

impl UploadPlan {
    pub fn file_count(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.dirs.is_empty()
    }
}

/// Expand dropped paths into the work they imply.
///
/// `roots` are what the user actually selected or dragged — a mix of files and
/// folders. Each folder becomes a folder of the same name on the device, and
/// its contents follow it.
///
/// # Errors
///
/// Only for failures that make the plan unknowable — an unreadable root, a
/// directory that cannot be listed. Individual unusable entries are recorded in
/// [`UploadPlan::skipped`] instead, so one odd file in a large tree does not
/// cancel the transfer.
pub fn plan_upload(roots: &[PathBuf]) -> io::Result<UploadPlan> {
    let mut plan = UploadPlan::default();
    // Deduplicated because a user can drag a folder and a file inside it in the
    // same gesture; without this the file is written twice, and the second
    // write races the first for the same name on the device.
    let mut seen_dirs: BTreeSet<Vec<String>> = BTreeSet::new();

    for root in roots {
        let meta = fs::symlink_metadata(root)?;
        if meta.is_symlink() {
            plan.skipped.push((root.clone(), SkipReason::Symlink));
            continue;
        }
        let Some(name) = file_name_of(root) else {
            plan.skipped.push((root.clone(), SkipReason::UnusableName));
            continue;
        };

        if meta.is_dir() {
            let base = vec![name];
            if seen_dirs.insert(base.clone()) {
                plan.dirs.push(base.clone());
            }
            walk(root, &base, &mut plan, &mut seen_dirs)?;
        } else if meta.is_file() {
            plan.total_bytes += meta.len();
            plan.items.push(UploadItem {
                local: root.clone(),
                rel_dir: Vec::new(),
                name,
                size: meta.len(),
            });
        } else {
            plan.skipped.push((root.clone(), SkipReason::NotAFile));
        }
    }

    Ok(plan)
}

fn walk(
    dir: &Path,
    rel: &[String],
    plan: &mut UploadPlan,
    seen_dirs: &mut BTreeSet<Vec<String>>,
) -> io::Result<()> {
    // Read the whole directory before recursing, and sort it. Filesystem order
    // is arbitrary; a transfer that lists its files in a different order every
    // run is impossible to resume, compare or reason about from a log.
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .map(|e| e.path())
        .collect();
    entries.sort();

    for path in entries {
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_symlink() {
            plan.skipped.push((path, SkipReason::Symlink));
            continue;
        }
        let Some(name) = file_name_of(&path) else {
            plan.skipped.push((path, SkipReason::UnusableName));
            continue;
        };

        if meta.is_dir() {
            let mut child = rel.to_vec();
            child.push(name);
            // Depth-first, and the folder is recorded before its contents, so
            // the executor can create folders in list order and never look for
            // a parent that does not exist yet.
            if seen_dirs.insert(child.clone()) {
                plan.dirs.push(child.clone());
            }
            walk(&path, &child, plan, seen_dirs)?;
        } else if meta.is_file() {
            plan.total_bytes += meta.len();
            plan.items.push(UploadItem {
                local: path,
                rel_dir: rel.to_vec(),
                name,
                size: meta.len(),
            });
        } else {
            plan.skipped.push((path, SkipReason::NotAFile));
        }
    }

    Ok(())
}

/// The device-side name for a path, or `None` when there isn't a usable one.
///
/// The rule itself lives in [`crate::name::check_name`], shared with the rename
/// and new-folder commands — three callers deciding independently what a legal
/// name is would be three chances to disagree. Checked here rather than at the
/// device because a rejection mid-tree leaves a half-copied folder, and the
/// user learns about it after the wait rather than before it.
fn file_name_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?.to_string();
    crate::name::check_name(&name).ok()?;
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch tree, removed when the test ends.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("adx-upload-plan-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, bytes).unwrap();
            p
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_lone_file_lands_in_the_target_folder() {
        let tmp = Tmp::new("lone");
        let f = tmp.file("note.txt", b"hello");

        let plan = plan_upload(&[f.clone()]).unwrap();

        assert_eq!(plan.dirs, Vec::<Vec<String>>::new());
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].rel_dir, Vec::<String>::new());
        assert_eq!(plan.items[0].name, "note.txt");
        assert_eq!(plan.total_bytes, 5);
    }

    /// The requirement the whole module exists for: a folder with subfolders.
    #[test]
    fn a_folder_brings_its_subtree_with_parents_before_children() {
        let tmp = Tmp::new("tree");
        tmp.file("trip/a.jpg", b"1234");
        tmp.file("trip/raw/b.dng", b"567");
        tmp.file("trip/raw/deep/c.txt", b"89");
        let root = tmp.0.join("trip");

        let plan = plan_upload(&[root]).unwrap();

        assert_eq!(
            plan.dirs,
            vec![
                vec!["trip".to_string()],
                vec!["trip".to_string(), "raw".to_string()],
                vec!["trip".to_string(), "raw".to_string(), "deep".to_string()],
            ],
            "a parent must never be listed after a child that needs it"
        );
        assert_eq!(plan.items.len(), 3);
        assert_eq!(plan.total_bytes, 9);

        let deep = plan.items.iter().find(|i| i.name == "c.txt").unwrap();
        assert_eq!(deep.rel_dir, vec!["trip", "raw", "deep"]);
    }

    /// An empty folder is content too — a copy that silently drops it has not
    /// copied the folder.
    #[test]
    fn empty_folders_survive_the_plan() {
        let tmp = Tmp::new("empty");
        tmp.dir("shell/inner");
        let plan = plan_upload(&[tmp.0.join("shell")]).unwrap();

        assert!(plan.items.is_empty());
        assert_eq!(plan.dirs, vec![vec!["shell".to_string()], vec!["shell".to_string(), "inner".to_string()]]);
        assert!(!plan.is_empty(), "a plan that only creates folders still has work");
    }

    /// Dragging a folder and something inside it in one gesture is normal, and
    /// must not create the folder twice.
    #[test]
    fn overlapping_roots_do_not_duplicate_a_folder() {
        let tmp = Tmp::new("overlap");
        tmp.file("box/a.txt", b"x");
        let plan = plan_upload(&[tmp.0.join("box"), tmp.0.join("box")]).unwrap();

        assert_eq!(plan.dirs, vec![vec!["box".to_string()]]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_and_reported() {
        let tmp = Tmp::new("link");
        tmp.file("real/a.txt", b"x");
        std::os::unix::fs::symlink(tmp.0.join("real"), tmp.0.join("real/loop")).unwrap();

        let plan = plan_upload(&[tmp.0.join("real")]).unwrap();

        assert_eq!(plan.items.len(), 1, "the loop must not be followed");
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].1, SkipReason::Symlink);
    }

    #[test]
    fn listing_is_ordered_so_two_runs_agree() {
        let tmp = Tmp::new("order");
        for n in ["c.txt", "a.txt", "b.txt"] {
            tmp.file(&format!("many/{n}"), b"x");
        }
        let names = |p: &UploadPlan| p.items.iter().map(|i| i.name.clone()).collect::<Vec<_>>();

        let first = plan_upload(&[tmp.0.join("many")]).unwrap();
        let second = plan_upload(&[tmp.0.join("many")]).unwrap();

        assert_eq!(names(&first), vec!["a.txt", "b.txt", "c.txt"]);
        assert_eq!(names(&first), names(&second));
    }

    #[test]
    fn names_the_device_cannot_store_are_rejected_before_the_transfer() {
        assert_eq!(file_name_of(Path::new("/tmp/ok.txt")).as_deref(), Some("ok.txt"));
        assert_eq!(file_name_of(Path::new("/tmp")).as_deref(), Some("tmp"));
        assert_eq!(file_name_of(Path::new("/")), None);

        let long: String = "x".repeat(255);
        assert_eq!(file_name_of(Path::new(&format!("/tmp/{long}"))), None);
    }

    #[test]
    fn a_missing_root_is_an_error_not_an_empty_plan() {
        let err = plan_upload(&[PathBuf::from("/nope/does/not/exist")]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
