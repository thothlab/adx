/**
 * Russian dictionary. Mirror of `en.ts` — same keys, translated values. The
 * `Dict` type makes a missing key a compile error; `i18n.spec.ts` guards the
 * other direction (an extra key that English doesn't have).
 */
import type { Dict } from "./en";

const ru: Dict = {
  app: {
    name: "ADX",
    tagline: "Android Device eXplorer",
  },
  devices: {
    title: "Устройства",
    refresh: "Обновить",
    empty_title: "Устройство не подключено",
    empty_hint:
      "Подключите Android-устройство кабелем и выберите на телефоне режим передачи файлов.",
    charging_only: "Только зарядка — выберите на телефоне режим передачи файлов",
    charging_only_hint:
      "Android умеет запомнить выбор: найдите на телефоне настройку режима USB по умолчанию и задайте её один раз.",
  },
  errors: {
    no_device: "Устройство не найдено",
    occupied: "Устройство занято другим процессом",
    unauthorized: "Устройство не отдаёт файлы",
    permission_denied: "Нет прав на доступ к устройству",
    busy: "Устройство занято",
    disconnected: "Устройство отключено",
    device_reset: "Устройство было сброшено — переподключаемся",
    stale_handle: "Список устарел — перечитываем",
    timeout: "Устройство не ответило вовремя",
    not_found: "Не найдено",
    not_writable: "Запись сюда недоступна",
    unsupported: "Устройство не поддерживает эту операцию",
    name_too_long: "Слишком длинное имя",
    name_invalid: "Недопустимые символы в имени",
    name_taken: "Такое имя в этой папке уже занято",
    not_enough_space: "На устройстве не хватает места",
    cancelled: "Отменено",
    io: "Ошибка обмена с устройством",
    protocol: "Неожиданный ответ устройства",
  },
  storages: {
    title: "Хранилища",
    empty: "Выберите устройство",
    free_of: "{{free}} свободно из {{total}}",
    read_only: "Только чтение",
  },
  tree: {
    title: "Папки",
    empty: "Выберите хранилище",
    root: "Хранилище",
  },
  listing: {
    title: "Файлы",
    empty: "Выберите папку",
    empty_folder: "Папка пуста",
    name: "Имя",
    size: "Размер",
    modified: "Изменён",
    size_unknown: "неизвестен",
    upload_files: "Добавить файлы",
    upload_folder: "Добавить папку",
    new_folder: "Новая папка",
    rename: "Переименовать",
    delete: "Удалить",
    reload: "Перечитать",
    selected: "выбрано: {{count}}",
    drop_hint: "Перетащите сюда файлы или папки из Finder.",
    drop_here: "Отпустите, чтобы скопировать на устройство",
    drop_blocked: "Сначала откройте на устройстве папку, доступную для записи",
  },
  jobs: {
    title: "Операции",
    empty: "Нет активных операций",
    preparing: "Готовим…",
    cancel: "Остановить",
    done: "Скопировано файлов: {{files}}, {{bytes}}",
    folders: "создано папок: {{count}}",
    replaced: "заменено: {{count}}",
    skipped: "пропущено: {{count}}",
    cancelled: "Остановлено после {{files}} файл(ов), {{bytes}}",
  },
  dialog: {
    cancel: "Отмена",
    create: "Создать",
    rename: "Переименовать",
    name_label: "Имя",
    new_folder_title: "Новая папка",
    rename_title: "Переименовать",
    delete_title: "Удалить с устройства?",
    delete_body: "Будет удалено объектов: {{count}}. Папки удаляются вместе с содержимым.",
    conflict_title: "Уже есть на устройстве",
    conflict_body:
      "В этой папке уже есть такие имена: {{count}}. На устройство пока ничего не записано.",
    conflict_replace: "Заменить",
    conflict_skip: "Пропустить их",
  },
  settings: {
    theme: "Тема",
    theme_light: "Светлая",
    theme_dark: "Тёмная",
    theme_system: "Системная",
    language: "Язык",
  },
};

export default ru;
