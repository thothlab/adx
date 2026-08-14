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
  },
  listing: {
    title: "Файлы",
    empty: "Выберите папку",
    empty_folder: "Папка пуста",
    name: "Имя",
    size: "Размер",
    modified: "Изменён",
    size_unknown: "неизвестен",
  },
  jobs: {
    title: "Операции",
    empty: "Нет активных операций",
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
