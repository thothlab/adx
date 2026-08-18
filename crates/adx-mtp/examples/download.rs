//! Read-path round trip against a real device.
//!
//! The unit tests cover the name rules, the conflict pass and the plan shape;
//! not one of them can answer the questions that actually matter here — does a
//! file come back byte for byte, does a folder tree reappear intact, and does
//! the device stay answerable while a large file is streaming off it. That last
//! one is a headline claim of this product, and it is only true if the session
//! lock is really released between read windows. Nothing but a real phone can
//! demonstrate that.
//!
//! ```text
//! cargo run -p adx-mtp --example download
//! ```
//!
//! # What it touches
//!
//! One folder, `ADX-selftest-dl`, at the root of the first writable storage,
//! plus a scratch directory under the system temp dir. It refuses to run if the
//! device folder already exists rather than reusing or clearing it, and removes
//! everything it made — including after a failed step, so a bad run leaves no
//! debris on the phone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use adx_core::plan_upload;
use adx_mtp::{
    download_tree, plan_download, ConflictPolicy, DownloadPolicy, DownloadReport, DownloadRoot,
    Session, SessionSlot, UploadReport,
};
use tokio::sync::Mutex;

const TEST_DIR: &str = "ADX-selftest-dl";
/// Big enough to take several read windows (8 MiB each) so the responsiveness
/// check has something to interleave with, small enough that a run stays short.
const BIG_FILE_BYTES: usize = 24 * 1024 * 1024;

#[tokio::main]
async fn main() {
    let code = match run().await {
        Ok(()) => {
            println!("\n== все проверки пройдены ==");
            0
        }
        Err(e) => {
            eprintln!("\n== ПРОВАЛ: {e} ==");
            1
        }
    };
    std::process::exit(code);
}

async fn run() -> Result<(), String> {
    let devices = {
        use adx_mtp::MtpBackend;
        adx_mtp::MtpRsBackend.list_devices().map_err(|e| e.to_string())?
    };
    let device = devices
        .iter()
        .find(|d| d.mtp_available)
        .ok_or("нет устройства в режиме передачи файлов")?;
    println!("устройство: {} {} ({})", device.manufacturer, device.model, device.serial);

    let serial = device.serial.clone();
    let session = Session::open(&serial).await.map_err(|e| e.to_string())?;
    let storages = session.storages();
    let storage = storages
        .iter()
        .find(|s| s.is_writable)
        .ok_or("нет накопителя, доступного для записи")?
        .id;

    let root = session.list(storage, None).await.map_err(|e| e.to_string())?;
    if root.iter().any(|e| e.name == TEST_DIR) {
        return Err(format!(
            "на устройстве уже есть \"{TEST_DIR}\" - удалите его вручную; \
             этот пример намеренно не трогает то, что создал не он"
        ));
    }

    let local = Scratch::new("source")?;
    build_tree(&local.0)?;

    // Put the tree on the device first: the read path can only be checked
    // against content whose original is known.
    let plan = plan_upload(&[local.0.join(TEST_DIR)]).map_err(|e| e.to_string())?;
    println!(
        "заливаем образец: {} файл(ов), {} папк(и), {} байт\n",
        plan.items.len(),
        plan.dirs.len(),
        plan.total_bytes
    );
    let report = adx_mtp::upload_tree(
        &session,
        storage,
        None,
        &plan,
        ConflictPolicy::Ask,
        |_| {},
        || false,
    )
    .await
    .map_err(|e| e.to_string())?;
    if !matches!(report, UploadReport::Done { .. }) {
        return Err(format!("образец не залился: {report:?}"));
    }

    // From here on the session lives in the slot, exactly as the app holds it.
    let slot: SessionSlot = Mutex::new(Some(session));

    let outcome = checks(&slot, &serial, storage, &local.0).await;
    let cleanup = cleanup(&slot, storage).await;

    if let Some(session) = slot.lock().await.take() {
        session.close().await.map_err(|e| e.to_string())?;
    }
    outcome?;
    cleanup
}

async fn checks(
    slot: &SessionSlot,
    serial: &str,
    storage: u64,
    local: &Path,
) -> Result<(), String> {
    let folder = {
        let guard = slot.lock().await;
        let session = guard.as_ref().ok_or("сессия потеряна")?;
        session
            .list(storage, None)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|e| e.name == TEST_DIR)
            .ok_or("залитая папка не найдена на устройстве")?
    };
    let roots = [DownloadRoot {
        handle: folder.handle,
        name: folder.name.clone(),
        is_folder: true,
        size: 0,
    }];

    // ---- 1. The plan ------------------------------------------------------
    let plan = plan_download(slot, serial, storage, &roots, || false)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "1. план чтения: {} файл(ов), {} папк(и), {} байт",
        plan.items.len(),
        plan.dirs.len(),
        plan.total_bytes
    );
    if plan.items.len() != 4 {
        return Err(format!("ожидали 4 файла в плане, получили {}", plan.items.len()));
    }
    if !plan.dirs.iter().any(|d| d == &vec![TEST_DIR.to_string(), "sub".to_string(), "deep".to_string()])
    {
        return Err("трёхуровневая вложенность не попала в план".into());
    }

    // ---- 2. Whole tree, compared byte for byte ----------------------------
    let dest = Scratch::new("dest")?;
    let started = Instant::now();
    let report = download_tree(
        slot,
        serial,
        storage,
        &plan,
        &dest.0,
        DownloadPolicy::Ask,
        |_| {},
        || false,
    )
    .await
    .map_err(|e| e.to_string())?;

    let DownloadReport::Done { files, folders, bytes, .. } = &report else {
        return Err(format!("ожидали Done, получили {report:?}"));
    };
    let secs = started.elapsed().as_secs_f64();
    println!(
        "2. скачано: {files} файл(ов), {folders} папк(и), {bytes} байт за {secs:.1} с ({:.1} МБ/с)",
        *bytes as f64 / 1024.0 / 1024.0 / secs.max(0.001)
    );
    compare_trees(&local.join(TEST_DIR), &dest.0.join(TEST_DIR))?;
    println!("   содержимое совпадает побайтно, включая файл нулевой длины");

    // ---- 3. The device stays answerable while a big file streams ----------
    //
    // The whole reason the executor takes the lock per window. A listing issued
    // during the transfer must come back in window time, not in file time.
    let dest2 = Scratch::new("dest-live")?;
    let polls = AtomicU64::new(0);
    let worst_ms = AtomicU64::new(0);
    let done = AtomicBool::new(false);

    let transfer = async {
        let r = download_tree(
            slot,
            serial,
            storage,
            &plan,
            &dest2.0,
            DownloadPolicy::Ask,
            |_| {},
            || false,
        )
        .await;
        done.store(true, Ordering::SeqCst);
        r
    };

    let poller = async {
        while !done.load(Ordering::SeqCst) {
            let at = Instant::now();
            let listing = {
                let guard = slot.lock().await;
                let Some(session) = guard.as_ref() else { break };
                session.list(storage, None).await
            };
            let waited = at.elapsed().as_millis() as u64;
            if listing.is_ok() {
                polls.fetch_add(1, Ordering::SeqCst);
                worst_ms.fetch_max(waited, Ordering::SeqCst);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };

    let (transferred, ()) = tokio::join!(transfer, poller);
    transferred.map_err(|e| e.to_string())?;
    let count = polls.load(Ordering::SeqCst);
    let worst = worst_ms.load(Ordering::SeqCst);
    println!("3. во время передачи выполнено листингов: {count}, худшее ожидание {worst} мс");
    if count == 0 {
        return Err("ни один листинг не прошёл во время передачи - сессия держится всю задачу".into());
    }
    if worst > 3000 {
        return Err(format!(
            "листинг ждал {worst} мс - похоже, сессия не освобождается между окнами"
        ));
    }

    // ---- 4. Asking about conflicts writes nothing -------------------------
    let before = count_files(&dest.0)?;
    let report = download_tree(
        slot,
        serial,
        storage,
        &plan,
        &dest.0,
        DownloadPolicy::Ask,
        |_| {},
        || false,
    )
    .await
    .map_err(|e| e.to_string())?;
    let DownloadReport::Conflicts { names } = &report else {
        return Err(format!("ожидали Conflicts, получили {report:?}"));
    };
    if count_files(&dest.0)? != before {
        return Err("вопрос о конфликтах изменил содержимое папки назначения".into());
    }
    println!("4. конфликтов найдено: {}, папка назначения не изменилась", names.len());

    // ---- 5. Cancel takes effect inside a file, not after it ---------------
    let dest3 = Scratch::new("dest-cancel")?;
    let stop = AtomicBool::new(false);
    let seen = AtomicU64::new(0);
    let at = Instant::now();
    let report = download_tree(
        slot,
        serial,
        storage,
        &plan,
        &dest3.0,
        DownloadPolicy::Ask,
        |p| {
            seen.store(p.bytes_done, Ordering::SeqCst);
            // Stop once something real has moved but long before the tree is
            // through, so "cancelled" cannot be confused with "finished".
            if p.bytes_done > 4 * 1024 * 1024 {
                stop.store(true, Ordering::SeqCst);
            }
        },
        || stop.load(Ordering::SeqCst),
    )
    .await
    .map_err(|e| e.to_string())?;

    let DownloadReport::Cancelled { files, bytes, .. } = &report else {
        return Err(format!("ожидали Cancelled, получили {report:?}"));
    };
    println!(
        "5. остановлено за {:.1} с после {files} файл(ов) / {bytes} байт",
        at.elapsed().as_secs_f64()
    );
    let leftovers = find_partials(&dest3.0)?;
    if !leftovers.is_empty() {
        return Err(format!("после отмены остались недописанные файлы: {leftovers:?}"));
    }
    println!("   недописанных файлов не осталось");

    Ok(())
}

async fn cleanup(slot: &SessionSlot, storage: u64) -> Result<(), String> {
    let guard = slot.lock().await;
    let Some(session) = guard.as_ref() else { return Ok(()) };
    let root = session.list(storage, None).await.map_err(|e| e.to_string())?;
    let Some(dir) = root.into_iter().find(|e| e.name == TEST_DIR) else {
        return Ok(());
    };
    session
        .delete(storage, dir.handle)
        .await
        .map_err(|e| format!("не удалось убрать {TEST_DIR} с устройства: {e}"))?;
    println!("\nубрано с устройства: {TEST_DIR}");
    Ok(())
}

/// A scratch directory that removes itself when the run ends, pass or fail.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("adx-dl-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Four files on three levels, including an empty one — the case where the
/// windowed reader returns end-of-file on its very first call and the file must
/// still be created.
fn build_tree(root: &Path) -> Result<(), String> {
    let base = root.join(TEST_DIR);
    fs::create_dir_all(base.join("sub/deep")).map_err(|e| e.to_string())?;
    fs::write(base.join("note.txt"), "здравствуй, устройство\n").map_err(|e| e.to_string())?;
    fs::write(base.join("empty.bin"), b"").map_err(|e| e.to_string())?;
    fs::write(base.join("sub/deep/deep.txt"), "три уровня\n").map_err(|e| e.to_string())?;

    // Deterministic pseudo-random bytes: a file of zeroes would survive a bug
    // that writes the wrong window twice, and a random one could not be
    // reproduced from a failing run.
    let mut data = vec![0u8; BIG_FILE_BYTES];
    let mut x: u32 = 0x2545_F491;
    for byte in data.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *byte = (x >> 24) as u8;
    }
    fs::write(base.join("big.bin"), &data).map_err(|e| e.to_string())?;
    Ok(())
}

/// Every file present on both sides with identical bytes, and no extras.
fn compare_trees(left: &Path, right: &Path) -> Result<(), String> {
    let mut ours = Vec::new();
    collect(left, left, &mut ours)?;
    let mut theirs = Vec::new();
    collect(right, right, &mut theirs)?;
    ours.sort();
    theirs.sort();

    if ours != theirs {
        return Err(format!("состав папок разошёлся:\n  на диске: {ours:?}\n  скачано:  {theirs:?}"));
    }
    for rel in &ours {
        let a = fs::read(left.join(rel)).map_err(|e| e.to_string())?;
        let b = fs::read(right.join(rel)).map_err(|e| e.to_string())?;
        if a != b {
            return Err(format!(
                "{}: содержимое разошлось ({} байт против {})",
                rel.display(),
                a.len(),
                b.len()
            ));
        }
    }
    Ok(())
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            collect(base, &path, out)?;
        } else {
            out.push(path.strip_prefix(base).map_err(|e| e.to_string())?.to_path_buf());
        }
    }
    Ok(())
}

fn count_files(dir: &Path) -> Result<usize, String> {
    let mut all = Vec::new();
    collect(dir, dir, &mut all)?;
    Ok(all.len())
}

fn find_partials(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut all = Vec::new();
    collect(dir, dir, &mut all)?;
    Ok(all
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".part"))
        .collect())
}
