//! The native application menu.
//!
//! Four items the user asked for — «О программе», «Настройки», «Проверить
//! наличие обновлений…», «Выйти» — plus the two submenus that have to be there
//! whether anyone asks or not.
//!
//! # Why Edit and Window are not optional
//!
//! Replacing Tauri's default menu replaces *all* of it. On macOS the standard
//! Cut/Copy/Paste/Select All key equivalents are not implemented by the web
//! view — they are delivered by the Edit menu, and an app that ships without
//! one has text fields that silently ignore ⌘C and ⌘V. This app has text
//! fields: the rename and new-folder dialogs. So Edit stays, even though it is
//! not in the request.
//!
//! # Why the menu is rebuilt instead of built once
//!
//! Menu labels are baked at construction, in Rust, before the web view has
//! loaded — and the interface language lives in the front end's
//! `localStorage`, which Rust cannot read. A menu built once would be stuck in
//! whatever language it guessed, while «переключение языка меняет весь видимый
//! текст без перезапуска» is an acceptance criterion. So the front end reports
//! its locale on startup and on every switch, and the menu is rebuilt.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

/// Menu item ids. Compared against `event.id()`, so they live in one place
/// rather than as string literals at both ends.
pub const SETTINGS: &str = "settings";
pub const CHECK_UPDATES: &str = "check-updates";
pub const QUIT: &str = "quit";

/// Every string the menu shows, in one language.
///
/// A struct rather than a lookup by key: adding a language is then a compile
/// error until every label is translated, which is the same guarantee `ru.ts`
/// gets from being typed against `Dict`.
struct Labels {
    about: &'static str,
    settings: &'static str,
    check_updates: &'static str,
    quit: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    window: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    close: &'static str,
    comments: &'static str,
}

const RU: Labels = Labels {
    about: "О программе ADX",
    settings: "Настройки",
    // Ellipsis, and the real character rather than three dots: on macOS it is
    // the convention meaning "this opens something that asks more of you", and
    // the user's own screenshot has it.
    check_updates: "Проверить наличие обновлений…",
    quit: "Выйти",
    edit: "Правка",
    undo: "Отменить",
    redo: "Повторить",
    cut: "Вырезать",
    copy: "Скопировать",
    paste: "Вставить",
    select_all: "Выбрать всё",
    window: "Окно",
    minimize: "Убрать в Dock",
    zoom: "Развернуть",
    close: "Закрыть",
    comments: "Доступ к файлам Android-устройства по USB через MTP.",
};

const EN: Labels = Labels {
    about: "About ADX",
    settings: "Settings",
    check_updates: "Check for Updates…",
    quit: "Quit ADX",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    close: "Close",
    comments: "Access the files on an Android device over USB, through MTP.",
};

fn labels(locale: &str) -> &'static Labels {
    match locale {
        "en" => &EN,
        _ => &RU,
    }
}

/// Build the menu in the given language.
///
/// Separate from [`apply`] because the builder wants a menu at startup, before
/// there is an `AppHandle` to hang one on.
pub fn build<R: Runtime, M: Manager<R>>(app: &M, locale: &str) -> tauri::Result<Menu<R>> {
    let l = labels(locale);

    let metadata = AboutMetadata {
        name: Some("ADX".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        comments: Some(l.comments.into()),
        license: Some("Apache-2.0".into()),
        website: Some("https://github.com/thothlab/adx".into()),
        website_label: Some("GitHub".into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "ADX",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(l.about), Some(metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS, l.settings, true, Some("CmdOrCtrl+,"))?,
            &MenuItem::with_id(app, CHECK_UPDATES, l.check_updates, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            // A custom item rather than `PredefinedMenuItem::quit`, and the
            // difference is not cosmetic. The predefined one terminates through
            // the platform, which can bypass Tauri's `RunEvent::Exit` — and
            // that handler is where the MTP session is closed. A session left
            // unclosed leaves the phone believing it is still in one, and the
            // next open fails until the device times it out, which the user
            // experiences as "it worked yesterday". This item goes through
            // `app.exit(0)`, which runs that handler.
            &MenuItem::with_id(app, QUIT, l.quit, true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    // Not requested, and not optional — see the module comment. Predefined
    // items carry the platform key equivalents with them.
    let edit_menu = Submenu::with_items(
        app,
        l.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(l.undo))?,
            &PredefinedMenuItem::redo(app, Some(l.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(l.cut))?,
            &PredefinedMenuItem::copy(app, Some(l.copy))?,
            &PredefinedMenuItem::paste(app, Some(l.paste))?,
            &PredefinedMenuItem::select_all(app, Some(l.select_all))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        l.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(l.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(l.zoom))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(l.close))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

/// Rebuild the menu in another language and hang it on the app.
///
/// Called by the front end on startup (with the locale it restored from
/// `localStorage`) and on every switch.
#[tauri::command]
pub async fn menu_set_locale<R: Runtime>(app: AppHandle<R>, locale: String) -> Result<(), String> {
    let menu = build(&app, &locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// What the front end is told when a menu item is chosen.
///
/// The menu is native and the dialogs it opens are not, so the two halves talk
/// over an event. One event with the id in it rather than an event per item:
/// the front end already switches on a string, and a new item should not need a
/// new listener on both sides.
pub const MENU_EVENT: &str = "menu-action";

/// Route a menu click. `quit` is handled here; the rest reach the window.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    use tauri::Emitter;

    match id {
        // Not emitted to the front end: leaving is not something the interface
        // needs to render, and routing it through the web view would make
        // quitting depend on the web view being alive.
        QUIT => app.exit(0),
        SETTINGS | CHECK_UPDATES => {
            if let Err(e) = app.emit(MENU_EVENT, id) {
                tracing::warn!("menu action {id} did not reach the window: {e}");
            }
        }
        other => tracing::debug!("unhandled menu id {other}"),
    }
}
