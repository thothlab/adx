//! List a folder on the attached device, by path.
//!
//! Read-only. Exists because "what is actually on the phone right now" is a
//! question that comes up constantly while debugging, and answering it by
//! launching the app and clicking is both slow and changes the thing being
//! inspected (the app opens a session, so nothing else can look).
//!
//! ```text
//! cargo run -p adx-mtp --example ls              # storages and the root
//! cargo run -p adx-mtp --example ls Alarms       # one folder
//! cargo run -p adx-mtp --example ls DCIM/Camera  # nested
//! ```
//!
//! The path is matched case-insensitively against the first writable storage.

use adx_mtp::{MtpBackend, MtpRsBackend, Session};

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).unwrap_or_default();

    let devices = match MtpRsBackend.list_devices() {
        Ok(d) => d,
        Err(e) => return eprintln!("перечисление: {e}"),
    };
    let Some(device) = devices.iter().find(|d| d.mtp_available) else {
        return eprintln!("нет устройства в режиме передачи файлов");
    };

    let session = match Session::open(&device.serial).await {
        Ok(s) => s,
        Err(e) => return eprintln!("открытие: {e}"),
    };

    let storages = session.storages();
    let Some(storage) = storages.first() else {
        return eprintln!("нет накопителей");
    };
    println!("{} {} / {}", device.manufacturer, device.model, storage.description);

    // Walk the path one component at a time, resolving each against the folder
    // before it. MTP has no path lookup — a path is a client-side idea.
    let mut parent: Option<u64> = None;
    for component in path.split('/').filter(|c| !c.is_empty()) {
        let listing = match session.list(storage.id, parent).await {
            Ok(l) => l,
            Err(e) => return eprintln!("чтение: {e}"),
        };
        match listing
            .iter()
            .find(|e| e.is_folder && e.name.eq_ignore_ascii_case(component))
        {
            Some(found) => parent = Some(found.handle),
            None => return eprintln!("папка \"{component}\" не найдена"),
        }
    }

    match session.list(storage.id, parent).await {
        Ok(entries) if entries.is_empty() => println!("  (пусто)"),
        Ok(entries) => {
            for e in &entries {
                println!(
                    "  {} {:<44} {:>12} {}",
                    if e.is_folder { "d" } else { "-" },
                    e.name,
                    if e.is_folder { "—".into() } else { e.size.to_string() },
                    e.modified.as_deref().unwrap_or("")
                );
            }
            println!("  {} объект(ов)", entries.len());
        }
        Err(e) => eprintln!("чтение: {e}"),
    }

    if let Err(e) = session.close().await {
        eprintln!("закрытие: {e}");
    }
}
