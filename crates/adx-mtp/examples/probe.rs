//! Hardware probe — the diagnostic that closes the questions no test can.
//!
//! Everything in `adx-mtp` is unit-tested without a phone, deliberately. What
//! stays unanswerable that way is what a *real* Android device does: whether it
//! shows up once or twice, whether `ptpcamerad` grabs it in MTP mode the way it
//! does in PTP mode, how big and how slow a real root listing is.
//!
//! Run it with a phone attached:
//!
//! ```text
//! cargo run -p adx-mtp --example probe
//! ```
//!
//! Kept in the tree rather than thrown away after one use: every "the app can't
//! see my phone" report starts here, and the answer needs to come from the same
//! code path the app uses, not from a fresh script written under pressure.

use std::time::Instant;

use adx_mtp::{exclusive_owner, MtpBackend, MtpRsBackend};

#[tokio::main]
async fn main() {
    // Kept for step 3: naming the holder needs the serial of the device we
    // failed to open, and the IORegistry lists an owner for every hub too.
    let mut first_serial = String::new();

    println!("== 1. ADX device list (what the UI shows) ==");
    match MtpRsBackend.list_devices() {
        Ok(devices) if devices.is_empty() => println!("  (empty — nothing attached)"),
        Ok(devices) => {
            for d in &devices {
                println!(
                    "  serial={:<24} loc={:016x} mtp={} {} {}",
                    d.serial, d.location_id, d.mtp_available, d.manufacturer, d.model
                );
            }
            if let Some(d) = devices.iter().find(|d| d.mtp_available) {
                first_serial = d.serial.clone();
            }
            // The dedup fix this probe exists to confirm: one physical phone in
            // MTP mode must produce exactly one row, not a browsable row plus a
            // phantom "charging only" twin.
            let mut locations: Vec<u64> = devices.iter().map(|d| d.location_id).collect();
            locations.sort_unstable();
            let unique = {
                let mut l = locations.clone();
                l.dedup();
                l.len()
            };
            println!(
                "  -> {} rows, {} distinct locations{}",
                devices.len(),
                unique,
                if unique == devices.len() { "" } else { "  <-- DUPLICATE" }
            );
        }
        Err(e) => println!("  ERROR {e}"),
    }

    println!("\n== 2. Raw mtp-rs enumeration ==");
    match mtp_rs::mtp::MtpDevice::list_devices() {
        Ok(list) if list.is_empty() => println!("  (no MTP devices)"),
        Ok(list) => {
            for i in &list {
                println!(
                    "  {:04x}:{:04x} loc={:016x} serial={:?} {:?} {:?}",
                    i.vendor_id, i.product_id, i.location_id, i.serial_number, i.manufacturer, i.product
                );
            }
        }
        Err(e) => println!("  ERROR {e}"),
    }

    println!("\n== 3. Opening a session (this is where ptpcamerad shows up) ==");
    // Listing reads descriptors; it succeeds even when another process owns the
    // device. Interception only surfaces on open, so this step — not step 1 —
    // is what answers the ptpcamerad question.
    let opened = match mtp_rs::mtp::MtpDevice::open_first().await {
        Ok(dev) => {
            println!("  open_first: OK");
            // Printed even on success, and that is the interesting case: on
            // this machine the phone's `UsbExclusiveOwner` is `adb` while MTP
            // opens perfectly. The key names whoever opened the *device* node;
            // MTP and ADB claim different interfaces and do not collide. So a
            // holder name alone is not evidence that the device is unusable.
            match exclusive_owner(&first_serial) {
                Some(h) => println!("  device node owner: {} (pid {}) — MTP still opened", h.name, h.pid),
                None => println!("  device node owner: none"),
            }
            Some(dev)
        }
        Err(e) => {
            println!("  open_first: FAILED");
            println!("    display : {e}");
            println!("    debug   : {e:?}");
            println!("    exclusive_access = {}", e.is_exclusive_access());
            println!("    retryable        = {}", e.is_retryable());
            match exclusive_owner(&first_serial) {
                Some(h) => println!("    holder  : {} (pid {})", h.name, h.pid),
                None => println!("    holder  : not reported by IORegistry"),
            }
            None
        }
    };

    let Some(device) = opened else {
        println!("\n(stopping — nothing open to inspect)");
        return;
    };

    let info = device.device_info();
    println!("\n== 4. Device ==");
    println!("  {} {} sn={} fw={}", info.manufacturer, info.model, info.serial_number, info.device_version);
    println!("  supports_upload={} supports_rename={}", device.supports_upload(), device.supports_rename());
    println!("  capabilities: {:?}", device.capabilities());

    println!("\n== 5. Storages ==");
    let storages = match device.storages().await {
        Ok(s) => s,
        Err(e) => {
            println!("  ERROR {e:?}");
            return;
        }
    };
    for s in &storages {
        let i = s.info();
        println!(
            "  id={:#x} {:?} / {:?} total={} free={} writable={} type={:?} fs={:?}",
            s.id().0,
            i.description,
            i.volume_identifier,
            i.total_capacity,
            i.free_space,
            i.is_writable,
            i.storage_type,
            i.filesystem_type
        );
    }

    let Some(storage) = storages.first() else {
        println!("  (no storages — device is probably locked)");
        return;
    };

    println!("\n== 6. Root listing (size and speed decide T03's design) ==");
    let started = Instant::now();
    match storage.collect_objects(None).await {
        Ok(collection) => {
            let elapsed = started.elapsed();
            let objects = &collection.objects;
            let folders = objects.iter().filter(|o| o.is_folder()).count();
            println!(
                "  {} entries ({} folders, {} files) in {:?}{}",
                objects.len(),
                folders,
                objects.len() - folders,
                elapsed,
                if collection.skipped.is_empty() {
                    String::new()
                } else {
                    format!("  [{} handles unreadable]", collection.skipped.len())
                }
            );
            for o in objects.iter().take(20) {
                println!(
                    "    {} {:<40} {:>12} handle={:#x}",
                    if o.is_folder() { "d" } else { "-" },
                    o.filename,
                    o.size,
                    o.handle.0
                );
            }
            if objects.len() > 20 {
                println!("    … {} more", objects.len() - 20);
            }

            // The folder a user actually wants first. Timing it separately
            // matters: a root listing is small, a real media folder is not.
            if let Some(dcim) = objects.iter().find(|o| o.is_folder() && o.filename.eq_ignore_ascii_case("DCIM")) {
                let started = Instant::now();
                match storage.list_objects(Some(dcim.handle)).await {
                    Ok(children) => println!(
                        "\n  DCIM: {} entries in {:?}",
                        children.len(),
                        started.elapsed()
                    ),
                    Err(e) => println!("\n  DCIM listing failed: {e:?}"),
                }
            }
        }
        Err(e) => println!("  ERROR {e:?}"),
    }

    println!("\n== 7. Close ==");
    match device.close().await {
        Ok(()) => println!("  closed cleanly"),
        Err(e) => println!("  close failed: {e:?}"),
    }
}
