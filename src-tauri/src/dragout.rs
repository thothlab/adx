//! Перетаскивание файлов и папок с устройства в Finder.
//!
//! Держится на file promises (`NSFilePromiseProvider`): перетаскивание
//! начинается сразу, а файл создаётся уже после дропа - система сообщает
//! выбранный пользователем URL и ждёт, пока мы туда напишем. Другого способа
//! нет: файлы лежат на телефоне, и скачать гигабайтный ролик до начала
//! перетаскивания значило бы задержать нажатие мыши на минуту.
//!
//! **Только macOS.** Ни у Windows, ни у Linux эквивалента обещаниям в таком
//! виде нет (там это `CFSTR_FILECONTENTS` и XDND `XdndDirectSave`), поэтому
//! команда на них отвечает `Unsupported`, а интерфейс перетаскивание не
//! начинает.

use adx_core::{AdxError, ErrorKind};
use serde::Serialize;

use crate::transfer::{DownloadOutcomeDto, DownloadRootDto};

/// Чем закончилось скачивание, начатое дропом.
///
/// Отдельное событие, а не возврат команды: команда завершается, как только
/// система взяла сессию перетаскивания, - за минуты до того, как пользователь
/// отпустит кнопку. Без этого события панель операций так и осталась бы с
/// прогрессом от передачи, о завершении которой ей никто не сказал.
pub const DRAG_DONE_EVENT: &str = "drag-download-done";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DragDoneDto {
    Done { outcome: DownloadOutcomeDto },
    Failed { error: AdxError },
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{DragDoneDto, DRAG_DONE_EVENT};
    use crate::state::AppState;
    use crate::transfer::{run_download, DownloadRootDto, PolicyDto};
    use adx_core::{AdxError, ErrorKind};
    use block2::DynBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSImage,
        NSImageNameMultipleDocuments, NSView,
    };
    use objc2_foundation::{
        NSArray, NSDictionary, NSError, NSLocalizedDescriptionKey, NSObject, NSObjectProtocol,
        NSOperationQueue, NSPoint, NSRect, NSSize, NSString, NSURL,
    };
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Emitter, Manager};

    /// Одна очередь на все обещания сразу, строго последовательная.
    ///
    /// Finder запрашивает файлы дропа независимо друг от друга и может
    /// попросить несколько сразу. У устройства одна сессия, поэтому
    /// параллельные скачивания всё равно выстроились бы в очередь - но уже
    /// внутри бэкенда, на мьютексе, где о них некому рассказать: панель
    /// операций показала бы одну передачу, а телефон читал бы вторую.
    fn promise_queue(mtm: MainThreadMarker) -> Retained<NSOperationQueue> {
        let _ = mtm;
        thread_local! {
            static QUEUE: RefCell<Option<Retained<NSOperationQueue>>> = const { RefCell::new(None) };
        }
        QUEUE.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let Some(q) = slot.as_ref() {
                return q.clone();
            }
            let q = NSOperationQueue::new();
            q.setMaxConcurrentOperationCount(1);
            q.setName(Some(&NSString::from_str("tech.thothlab.adx.promises")));
            *slot = Some(q.clone());
            q
        })
    }

    /// Что нужно, чтобы написать один обещанный файл: строка списка, чьё это
    /// хранилище и через кого дотянуться до сессии.
    #[derive(Debug)]
    pub struct PromiseIvars {
        app: AppHandle,
        storage_id: String,
        root: DownloadRootDto,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AdxFilePromiseDelegate"]
        #[ivars = PromiseIvars]
        struct PromiseDelegate;

        unsafe impl NSObjectProtocol for PromiseDelegate {}

        unsafe impl NSFilePromiseProviderDelegate for PromiseDelegate {
            #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
            fn file_name(
                &self,
                _provider: &NSFilePromiseProvider,
                _file_type: &NSString,
            ) -> Retained<NSString> {
                NSString::from_str(&self.ivars().root.name)
            }

            #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
            fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
                // Своя очередь, а не главная: писать будем блокирующе, и на
                // главной это заморозило бы окно на всю передачу.
                promise_queue(MainThreadMarker::new().expect("делегат на главном потоке"))
            }

            #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
            fn write_promise(
                &self,
                _provider: &NSFilePromiseProvider,
                url: &NSURL,
                completion: &DynBlock<dyn Fn(*mut NSError)>,
            ) {
                let ivars = self.ivars();
                let target = match url.path() {
                    Some(p) => PathBuf::from(p.to_string()),
                    None => {
                        completion.call((error("система не назвала путь для файла").as_ref()
                            as *const NSError as *mut NSError,));
                        return;
                    }
                };

                let result = write_one(&ivars.app, &ivars.storage_id, &ivars.root, &target);
                let done = match &result {
                    Ok(outcome) => DragDoneDto::Done { outcome: outcome.clone() },
                    Err(e) => DragDoneDto::Failed { error: e.clone() },
                };
                let _ = ivars.app.emit(DRAG_DONE_EVENT, done);

                match result {
                    Ok(_) => completion.call((std::ptr::null_mut(),)),
                    Err(e) => {
                        let ns = error(&e.message);
                        completion.call((ns.as_ref() as *const NSError as *mut NSError,));
                    }
                }
            }
        }
    );

    /// Ошибку показывает система, а не наше окно: дроп мог случиться в другом
    /// пространстве, поверх чужого приложения, и единственное место, где
    /// пользователь узнает о неудаче, - алерт Finder. Поэтому текст кладётся в
    /// `NSLocalizedDescriptionKey`, а не теряется в коде ошибки.
    fn error(message: &str) -> Retained<NSError> {
        let domain = NSString::from_str("tech.thothlab.adx");
        let key = unsafe { NSLocalizedDescriptionKey };
        let value = NSString::from_str(message);
        let info = NSDictionary::from_slices::<NSString>(&[key], &[value.as_ref()]);
        unsafe { NSError::errorWithDomain_code_userInfo(&domain, 1, Some(&info)) }
    }

    impl PromiseDelegate {
        fn new(
            mtm: MainThreadMarker,
            app: AppHandle,
            storage_id: String,
            root: DownloadRootDto,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(PromiseIvars { app, storage_id, root });
            unsafe { objc2::msg_send![super(this), init] }
        }
    }

    /// Скачать одну строку списка в путь, который назвала система.
    ///
    /// Скачивание умеет писать `<папка>/<имя>`, а Finder называет полный путь и
    /// может переименовать файл, если такое имя в папке уже занято. Поэтому
    /// сначала во временный подкаталог **внутри той же папки**, затем
    /// переименование: тот же том по построению, значит переименование
    /// мгновенное и без копирования - и никакого `EXDEV` на внешнем диске или
    /// сетевом томе.
    fn write_one(
        app: &AppHandle,
        storage_id: &str,
        root: &DownloadRootDto,
        target: &Path,
    ) -> Result<crate::transfer::DownloadOutcomeDto, AdxError> {
        let parent = target
            .parent()
            .ok_or_else(|| AdxError::new(ErrorKind::Io, "у пути назначения нет папки"))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let staging = parent.join(format!(".adx-drop-{stamp}"));
        std::fs::create_dir_all(&staging)
            .map_err(|e| AdxError::new(ErrorKind::Io, format!("не создать временную папку: {e}")))?;

        let outcome = tauri::async_runtime::block_on(async {
            let state = app.state::<AppState>();
            run_download(
                app.clone(),
                &state,
                storage_id.to_string(),
                vec![root.clone()],
                staging.to_string_lossy().to_string(),
                PolicyDto::Replace,
            )
            .await
        });

        let finish = outcome.and_then(|outcome| {
            let written = staging.join(&root.name);
            std::fs::rename(&written, target).map_err(|e| {
                AdxError::new(ErrorKind::Io, format!("не переложить в папку назначения: {e}"))
            })?;
            Ok(outcome)
        });

        // Убирается в любом случае: и после ошибки, и после отмены - иначе в
        // папке пользователя остаётся скрытый каталог с недокачанным файлом.
        let _ = std::fs::remove_dir_all(&staging);
        finish
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AdxDragSource"]
        struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operation_mask(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                // Копирование, и только оно: перемещение означало бы удаление с
                // телефона по факту дропа, а удаление в этом приложении -
                // всегда явная кнопка с подтверждением.
                NSDragOperation::Copy
            }
        }
    );

    impl DragSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { objc2::msg_send![super(this), init] }
        }
    }

    /// Начать перетаскивание. Только с главного потока.
    pub fn start(
        app: &AppHandle,
        view: *mut std::ffi::c_void,
        storage_id: String,
        roots: Vec<DownloadRootDto>,
    ) -> Result<(), AdxError> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| AdxError::new(ErrorKind::Unsupported, "не главный поток"))?;
        let view: &NSView = unsafe { &*(view as *mut NSView) };

        let ns_app = NSApplication::sharedApplication(mtm);
        // Событие мыши, из которого система ведёт сессию. Его нет, если
        // перетаскивание попросили не во время нажатия - тогда начинать нечего.
        let event = ns_app
            .currentEvent()
            .ok_or_else(|| AdxError::new(ErrorKind::Unsupported, "нет события мыши"))?;

        let source = DragSource::new(mtm);
        let icon = NSImage::imageNamed(unsafe { NSImageNameMultipleDocuments });
        let mut items: Vec<Retained<NSDraggingItem>> = Vec::new();

        for (i, root) in roots.into_iter().enumerate() {
            let file_type = uti_for(&root.name, root.is_folder);
            let delegate = PromiseDelegate::new(mtm, app.clone(), storage_id.clone(), root);
            let provider = NSFilePromiseProvider::initWithFileType_delegate(
                NSFilePromiseProvider::alloc(),
                &NSString::from_str(file_type),
                ProtocolObject::from_ref(&*delegate),
            );
            // Провайдер держит делегата слабо (assign), как принято у
            // делегатов в AppKit, а дроп случится уже после выхода отсюда.
            std::mem::forget(delegate);

            let item = NSDraggingItem::initWithPasteboardWriter(
                NSDraggingItem::alloc(),
                ProtocolObject::from_ref(&*provider),
            );
            // Рамка и картинка обязательны: элемент без содержимого система
            // тащит, но показать его нечем.
            let origin = NSPoint::new(0.0, (i as f64) * 8.0);
            unsafe {
                item.setDraggingFrame_contents(
                    NSRect::new(origin, NSSize::new(64.0, 64.0)),
                    icon.as_deref().map(|i| i.as_ref()),
                );
            }
            items.push(item);
        }

        let refs: Vec<&NSDraggingItem> = items.iter().map(|i| &**i).collect();
        let array = NSArray::from_slice(&refs);
        let _session = view.beginDraggingSessionWithItems_event_source(
            &array,
            &event,
            ProtocolObject::from_ref(&*source),
        );
        // Источник должен пережить сессию: система держит его слабо.
        std::mem::forget(source);
        Ok(())
    }

    /// Тип обещанного объекта: папка или файл по расширению имени.
    ///
    /// Точность нужна не нам, а приёмнику: по типу Finder решает, какую иконку
    /// показывать, пока файла ещё нет, и папку с типом файла он рисует листом
    /// бумаги. Неизвестное расширение - `public.data`, то есть "просто файл".
    fn uti_for(name: &str, is_folder: bool) -> &'static str {
        if is_folder {
            return "public.folder";
        }
        match name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()) {
            Some(ext) => match ext.as_str() {
                "jpg" | "jpeg" => "public.jpeg",
                "png" => "public.png",
                "gif" => "com.compuserve.gif",
                "heic" => "public.heic",
                "mp4" | "m4v" => "public.mpeg-4",
                "mov" => "com.apple.quicktime-movie",
                "mp3" => "public.mp3",
                "m4a" => "public.mpeg-4-audio",
                "pdf" => "com.adobe.pdf",
                "txt" | "log" => "public.plain-text",
                "zip" => "public.zip-archive",
                _ => "public.data",
            },
            None => "public.data",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::uti_for;

        #[test]
        fn known_extensions_get_their_type_and_the_rest_are_just_files() {
            assert_eq!(uti_for("IMG_0001.JPG", false), "public.jpeg");
            assert_eq!(uti_for("clip.mov", false), "com.apple.quicktime-movie");
            assert_eq!(uti_for("сводка.pdf", false), "com.adobe.pdf");
            assert_eq!(uti_for("data.exmu-cfg1", false), "public.data");
            assert_eq!(uti_for("Без расширения", false), "public.data");
        }

        /// Папка с типом файла приезжает в Finder иконкой листа бумаги, даже
        /// если внутри окажется каталог: тип он читает до дропа.
        #[test]
        fn a_folder_is_promised_as_a_folder_whatever_its_name_looks_like() {
            assert_eq!(uti_for("DCIM", true), "public.folder");
            assert_eq!(uti_for("Backup.2026", true), "public.folder");
        }
    }
}

/// Начать перетаскивание выбранных строк в Finder.
///
/// Возвращается сразу, как только система взяла сессию: сам дроп случится
/// позже, и о нём расскажет `DRAG_DONE_EVENT`. Папка назначения тут не
/// спрашивается - её выбирает пользователь тем, куда отпустит кнопку.
#[tauri::command]
pub async fn drag_out_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    storage_id: String,
    roots: Vec<DownloadRootDto>,
) -> Result<(), AdxError> {
    if roots.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let view = window
            .ns_view()
            .map_err(|e| AdxError::new(ErrorKind::Unsupported, format!("нет окна: {e}")))?
            as usize;

        // Сессию начинает только главный поток, а команда приходит не на нём.
        // Ответ ждём здесь, чтобы ошибка попала в интерфейс, а не в лог.
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        window
            .run_on_main_thread(move || {
                let _ =
                    tx.send(imp::start(&handle, view as *mut std::ffi::c_void, storage_id, roots));
            })
            .map_err(|e| AdxError::new(ErrorKind::Unsupported, format!("главный поток: {e}")))?;
        rx.recv().map_err(|e| AdxError::new(ErrorKind::Unsupported, format!("нет ответа: {e}")))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, storage_id, roots);
        Err(AdxError::new(
            ErrorKind::Unsupported,
            "перетаскивание на компьютер поддержано только в macOS",
        ))
    }
}
