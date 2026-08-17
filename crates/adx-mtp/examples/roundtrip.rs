//! Write-path round trip against a real device.
//!
//! Unit tests cover the plan, the name rules and the ordering; none of them can
//! answer whether a folder tree actually lands on a phone, whether the conflict
//! pass really leaves the device untouched, or how fast a megabyte moves. This
//! does, by driving the same `upload_tree` the app calls.
//!
//! ```text
//! cargo run -p adx-mtp --example roundtrip
//! ```
//!
//! # What it touches
//!
//! One folder, `ADX-selftest`, at the root of the first writable storage, and
//! nothing else. It **refuses to run** if that folder already exists rather
//! than reusing or clearing it, and it deletes it at the end — including when a
//! step fails, so a bad run does not leave debris on the phone.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use adx_core::{plan_upload, UploadPlan};
use adx_mtp::{ConflictPolicy, Entry, Session, UploadReport};

const TEST_DIR: &str = "ADX-selftest";

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

    let session = Session::open(&device.serial).await.map_err(|e| e.to_string())?;
    let storages = session.storages();
    let storage = storages
        .iter()
        .find(|s| s.is_writable)
        .ok_or("нет накопителя, доступного для записи")?;
    println!("накопитель: {} ({} свободно)\n", storage.description, storage.free_space);

    let root = session.list(storage.id, None).await.map_err(|e| e.to_string())?;
    if root.iter().any(|e| e.name == TEST_DIR) {
        return Err(format!(
            "на устройстве уже есть \"{TEST_DIR}\" - удалите его вручную; \
             этот пример намеренно не трогает то, что создал не он"
        ));
    }

    let local = build_local_tree().map_err(|e| e.to_string())?;
    let plan = plan_upload(&[local.path.clone()]).map_err(|e| e.to_string())?;
    println!(
        "план: {} файл(ов), {} папк(и), {} байт",
        plan.items.len(),
        plan.dirs.len(),
        plan.total_bytes
    );

    // Everything after this point can leave a folder on the device, so the
    // result is captured and the cleanup runs either way.
    let outcome = checks(&session, storage.id, &plan).await;
    let cleanup = cleanup(&session, storage.id).await;

    session.close().await.map_err(|e| e.to_string())?;
    outcome?;
    cleanup
}

async fn checks(session: &Session, storage: u64, plan: &UploadPlan) -> Result<(), String> {
    // ---- 1. First upload -------------------------------------------------
    let started = Instant::now();
    let mut ticks = 0usize;
    let report = adx_mtp::upload_tree(
        session,
        storage,
        None,
        plan,
        ConflictPolicy::Ask,
        |_| ticks += 1,
        || false,
    )
    .await
    .map_err(|e| format!("первая загрузка: {e}"))?;

    match &report {
        UploadReport::Done { files, folders, bytes, .. } => println!(
            "1. загружено: {files} файл(ов), {folders} папк(и), {bytes} байт за {:?} ({ticks} событий прогресса)",
            started.elapsed()
        ),
        other => return Err(format!("первая загрузка вернула {other:?}, ожидалось Done")),
    }
    if ticks == 0 {
        return Err("прогресс не сообщался ни разу - полоса в UI осталась бы пустой".into());
    }

    // ---- 2. The tree really is there --------------------------------------
    let test_dir = child(session, storage, None, TEST_DIR).await?;
    let a = child(session, storage, Some(test_dir.handle), "a.txt").await?;
    if a.size != 5 {
        return Err(format!("a.txt на устройстве {} байт, ожидалось 5", a.size));
    }
    let sub = child(session, storage, Some(test_dir.handle), "sub").await?;
    if !sub.is_folder {
        return Err("sub на устройстве не папка".into());
    }
    let deep = child(session, storage, Some(sub.handle), "deep").await?;
    let big = child(session, storage, Some(deep.handle), "big.bin").await?;
    if big.size != 2 * 1024 * 1024 {
        return Err(format!("big.bin {} байт, ожидалось {}", big.size, 2 * 1024 * 1024));
    }
    // An empty folder is content too — the plan carries it separately from the
    // files, and this is the only way to find out it survived.
    child(session, storage, Some(sub.handle), "empty").await?;
    println!("2. дерево на устройстве совпадает с исходным, пустая папка на месте");

    // ---- 3. Conflicts are detected without writing anything ---------------
    let before = snapshot(session, storage, test_dir.handle).await?;
    let report = adx_mtp::upload_tree(session, storage, None, plan, ConflictPolicy::Ask, |_| {}, || false)
        .await
        .map_err(|e| format!("повторная загрузка: {e}"))?;
    let names = match &report {
        UploadReport::Conflicts { names } => names.clone(),
        other => return Err(format!("повтор вернул {other:?}, ожидалось Conflicts")),
    };
    if names.len() != plan.items.len() {
        return Err(format!("конфликтов {}, файлов в плане {}", names.len(), plan.items.len()));
    }
    let after = snapshot(session, storage, test_dir.handle).await?;
    if before != after {
        return Err("устройство изменилось, пока шёл только вопрос о конфликтах".into());
    }
    println!("3. конфликты найдены ({}) и устройство не тронуто", names.len());

    // ---- 4. Skip really skips ---------------------------------------------
    let report = adx_mtp::upload_tree(session, storage, None, plan, ConflictPolicy::Skip, |_| {}, || false)
        .await
        .map_err(|e| format!("загрузка с пропуском: {e}"))?;
    match &report {
        UploadReport::Done { skipped, files, .. } if *skipped == plan.items.len() && *files == 0 => {
            println!("4. пропуск: {skipped} файл(ов) не тронуто, записано 0")
        }
        other => return Err(format!("пропуск вернул {other:?}")),
    }

    // ---- 5. Replace really replaces ---------------------------------------
    let report =
        adx_mtp::upload_tree(session, storage, None, plan, ConflictPolicy::Replace, |_| {}, || false)
            .await
            .map_err(|e| format!("загрузка с заменой: {e}"))?;
    match &report {
        UploadReport::Done { replaced, files, .. }
            if *replaced == plan.items.len() && *files == plan.items.len() =>
        {
            println!("5. замена: {replaced} файл(ов) переписано")
        }
        other => return Err(format!("замена вернула {other:?}")),
    }

    // ---- 6. Rename and create ---------------------------------------------
    let a = child(session, storage, Some(test_dir.handle), "a.txt").await?;
    session
        .rename(storage, a.handle, "renamed.txt")
        .await
        .map_err(|e| format!("переименование: {e}"))?;
    child(session, storage, Some(test_dir.handle), "renamed.txt").await?;
    println!("6. переименование работает");

    session
        .create_folder(storage, Some(test_dir.handle), "создано-из-ADX")
        .await
        .map_err(|e| format!("создание папки: {e}"))?;
    child(session, storage, Some(test_dir.handle), "создано-из-ADX").await?;
    println!("7. создание папки работает, кириллица в имени тоже");

    // ---- 7. Cancel stops it -----------------------------------------------
    let report = adx_mtp::upload_tree(
        session,
        storage,
        None,
        plan,
        ConflictPolicy::Replace,
        |_| {},
        || true, // cancelled before the first file
    )
    .await
    .map_err(|e| format!("отмена: {e}"))?;
    match &report {
        UploadReport::Cancelled { files: 0, .. } => println!("8. отмена даёт терминальный Cancelled"),
        other => return Err(format!("отмена вернула {other:?}, ожидалось Cancelled")),
    }

    Ok(())
}

/// Remove the test folder, and prove it is gone.
async fn cleanup(session: &Session, storage: u64) -> Result<(), String> {
    let root = session.list(storage, None).await.map_err(|e| e.to_string())?;
    let Some(dir) = root.iter().find(|e| e.name == TEST_DIR) else {
        return Ok(());
    };
    session
        .delete(storage, dir.handle)
        .await
        .map_err(|e| format!("удаление {TEST_DIR}: {e}"))?;

    let root = session.list(storage, None).await.map_err(|e| e.to_string())?;
    if root.iter().any(|e| e.name == TEST_DIR) {
        return Err(format!("{TEST_DIR} остался на устройстве после удаления"));
    }
    println!("9. рекурсивное удаление работает, устройство чистое");
    Ok(())
}

async fn child(
    session: &Session,
    storage: u64,
    parent: Option<u64>,
    name: &str,
) -> Result<Entry, String> {
    session
        .list(storage, parent)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("на устройстве не найдено \"{name}\""))
}

/// Names and sizes of a folder's contents, for before/after comparison.
async fn snapshot(session: &Session, storage: u64, parent: u64) -> Result<Vec<(String, u64)>, String> {
    Ok(session
        .list(storage, Some(parent))
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|e| (e.name, e.size))
        .collect())
}

struct LocalTree {
    path: PathBuf,
}

impl Drop for LocalTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path.parent().unwrap_or(&self.path));
    }
}

/// A small tree with the shapes that matter: a file at the top, nesting two
/// levels deep, an empty folder, and one file large enough that progress fires
/// more than once.
fn build_local_tree() -> std::io::Result<LocalTree> {
    let base = std::env::temp_dir().join(format!("adx-roundtrip-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join(TEST_DIR);
    fs::create_dir_all(root.join("sub/deep"))?;
    fs::create_dir_all(root.join("sub/empty"))?;
    fs::write(root.join("a.txt"), b"hello")?;
    fs::write(root.join("sub/b.txt"), b"nested")?;
    fs::write(root.join("sub/deep/big.bin"), vec![0x5au8; 2 * 1024 * 1024])?;
    Ok(LocalTree { path: root })
}
