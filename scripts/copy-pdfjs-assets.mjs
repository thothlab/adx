/**
 * Копирует данные подстановки шрифтов pdf.js в `public/`, откуда Vite кладёт их
 * в сборку как обычные файлы приложения.
 *
 * Не в репозитории, а шагом сборки: это ~3 МБ чужих бинарных файлов, которые
 * целиком выводятся из версии pdfjs-dist в package.json. Хранить их в git
 * значит хранить копию зависимости и однажды разойтись с ней.
 *
 * Зачем вообще: без этих файлов pdf.js не падает, а рисует страницу без текста,
 * если шрифт в документе не встроен. Белая страница без объяснения - худший из
 * возможных исходов, и он у нас уже случился.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "node_modules/pdfjs-dist");
const to = resolve(root, "public/pdfjs");

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  await cp(resolve(from, dir), resolve(to, dir), { recursive: true });
}
console.log("pdf.js: шрифты подстановки и cmaps скопированы в public/pdfjs");
