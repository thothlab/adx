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
