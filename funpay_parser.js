// @ts-check
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as cheerio from "cheerio";
import FormData from "form-data";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "https://funpay.com/";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/121.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

// Будет обновлён после разбора флагов
let acceptLangHeader = DEFAULT_HEADERS["Accept-Language"];

/**
 * Sleep helper
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split price into amount and currency
 * @param {string} text
 * @returns {[string,string]}
 */
function splitPrice(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (isNaN(Number(text[i])) && text[i] !== "," && text[i] !== ".") {
      return [text.slice(0, i).trim(), text.slice(i).trim()];
    }
  }
  return [text, ""];
}

/**
 * Convert price string to number (dot as decimal) or NaN
 * @param {string} price
 */
function priceToNumber(price) {
  const normalized = price.replace(/\s+/g, "").replace(/,/g, ".");
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Very naive CLI args parsing
 */
const args = process.argv.slice(2);
let output = "lots.txt";
let delayMin = 1000;
let delayMax = 2500;
let rubEurRate = 0.011; // 1 ₽ ≈ 0.011 € (можно переопределить через --rub-eur)
let imgurClientId = process.env.IMGUR_CLIENT_ID || "";
let imgurClientSecret = process.env.IMGUR_CLIENT_SECRET || "";
let imgurAccessToken = process.env.IMGUR_ACCESS_TOKEN || "";
let uploadImages = false;
let verbose = false;
let langFilter = "";
const targetUrls = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--output") {
    output = args[++i] || output;
  } else if (a === "--delay-min") {
    delayMin = Number(args[++i]) * 1000;
  } else if (a === "--delay-max") {
    delayMax = Number(args[++i]) * 1000;
  } else if (a === "--rub-eur") {
    rubEurRate = Number(args[++i]) || rubEurRate;
  } else if (a === "--imgur-client-id") {
    imgurClientId = args[++i] || imgurClientId;
    uploadImages = true;
  } else if (a === "--imgur-access-token") {
    imgurAccessToken = args[++i] || imgurAccessToken;
    uploadImages = true;
  } else if (a === "--imgur-client-secret") {
    imgurClientSecret = args[++i] || imgurClientSecret;
    uploadImages = true;
  } else if (a === "--lang" || a === "-l") {
    langFilter = (args[++i] || "").toLowerCase();
    // обновляем заголовок Accept-Language
    if (langFilter === "en") {
      acceptLangHeader = "en-US,en;q=0.9";
    } else if (langFilter === "ru") {
      acceptLangHeader = "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7";
    }
  } else if (a === "--upload-images") {
    uploadImages = true;
  } else if (a === "--verbose" || a === "-v") {
    verbose = true;
  } else if (a === "--url" || a === "-u") {
    targetUrls.push(args[++i]);
  } else if (/^https?:\/\//i.test(a)) {
    // positional URL
    targetUrls.push(a);
  }
}

// применяем заголовок Accept-Language для всех запросов
axios.defaults.headers.common["Accept-Language"] = acceptLangHeader;

// ---------- Каталог изображений ----------
const IMG_DIR = path.resolve(__dirname, "imgs");
try {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
} catch {}
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------- Загрузка списка прокси ----------
let proxies = [];
try {
  const proxiesPath = path.resolve(__dirname, "proxies.txt");
  if (fs.existsSync(proxiesPath)) {
    proxies = fs
      .readFileSync(proxiesPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (verbose && proxies.length)
      console.log(`[PROXY] Loaded ${proxies.length} proxies`);
  }
} catch (e) {
  console.warn("[PROXY] Failed to read proxies.txt:", e.message);
}

/**
 * Получить конфигурацию прокси в формате Axios
 * @returns {import("axios").AxiosProxyConfig | null}
 */
function getRandomProxyConfig() {
  if (!proxies.length) return null;
  const line = proxies[Math.floor(Math.random() * proxies.length)];
  // формат login:pass@host:port или host:port
  const [authPart, hostPart] = line.includes("@")
    ? line.split("@")
    : [null, line];
  const [host, portStr] = hostPart.split(":");
  const port = Number(portStr);
  /** @type {import("axios").AxiosProxyConfig} */
  const cfg = { protocol: "http", host, port };
  if (authPart) {
    const [username, password] = authPart.split(":");
    cfg.auth = { username, password };
  }
  return cfg;
}

// ---------- Подключаем интерцепторы для прокси ----------
function attachProxyInterceptor(instance) {
  instance.interceptors.request.use((config) => {
    // Определяем полный URL запроса
    let targetUrl = config.url || "";
    if (config.baseURL && !/^https?:\/\//i.test(targetUrl)) {
      try {
        targetUrl = new URL(targetUrl, config.baseURL).toString();
      } catch {}
    }

    const isImgur = /imgur\.com/i.test(targetUrl);
    if (isImgur) {
      const proxyCfg = getRandomProxyConfig();
      if (proxyCfg) {
        config.proxy = proxyCfg;
        if (verbose) {
          const authInfo = proxyCfg.auth ? `${proxyCfg.auth.username}@` : "";
          console.log(
            `[PROXY] Imgur via ${authInfo}${proxyCfg.host}:${proxyCfg.port}`
          );
        }
      }
    } else {
      // для остальных доменов прокси не используем
      delete config.proxy;
    }
    return config;
  });
}
attachProxyInterceptor(axios); // только глобальный axios (используется в uploadToImgur)

// Regex диапазоны эмодзи + вариационный селектор FE0F, стрелки и геом.фигуры
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu;

function stripEmoji(str) {
  return str.replace(EMOJI_RE, "|");
}

// ---------- Языковая фильтрация ----------
/**
 * Проверка наличия кириллицы (русских букв)
 * @param {string} str
 */
function hasCyrillic(str) {
  return /[а-яё]/i.test(str);
}

/**
 * Проверка наличия латиницы (английских букв)
 * @param {string} str
 */
function hasLatin(str) {
  return /[a-z]/i.test(str);
}

/**
 * Запрос с повторными попытками на случай 429
 * @param {string} url
 * @param {number} retries
 */
async function requestWithRetry(url, retries = 5) {
  try {
    return await axios.get(
      url.startsWith("http") ? url : url.replace(BASE_URL, "")
    );
  } catch (err) {
    if (
      axios.isAxiosError(err) &&
      err.response?.status === 429 &&
      retries > 0
    ) {
      const wait = Math.random() * 5000 + 5000; // 5–10 с
      console.warn(
        `  [RATE LIMIT] 429 – ждём ${(wait / 1000).toFixed(
          1
        )} с и пробуем снова…`
      );
      await sleep(wait);
      return requestWithRetry(url, retries - 1);
    }
    throw err;
  }
}

/**
 * Fetch and parse HTML with cheerio
 * @param {string} url
 */
async function getPage(url) {
  const resp = await requestWithRetry(url);
  return cheerio.load(resp.data);
}

/**
 * Iterate all categories on front page
 * @returns {Promise<Array<{name:string,url:string}>>}
 */
async function getCategories() {
  const $ = await getPage(BASE_URL);
  /** @type {Array<{name:string,url:string}>} */
  const list = [];
  $("a.fp-item, a.tc-item, nav a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("/login")) return;
    const name = $(el).text().trim();
    if (name) list.push({ name, url: new URL(href, BASE_URL).toString() });
  });
  return list;
}

const ACCEPTED_EXTS = [".jpeg", ".jpg", ".gif", ".png", ".apng", ".tiff"];

function isAcceptedImage(url) {
  const p = new URL(url);
  const ext = p.pathname.split(".").pop()?.toLowerCase() || "";
  return ACCEPTED_EXTS.includes(`.${ext}`);
}

function isUserAvatar(url) {
  return /avatar/i.test(url);
}

/**
 * Parse all lot cards from a category page
 * @param {import("cheerio").CheerioAPI} $
 * @param {string} categoryName
 * @returns {Array<object>}
 */
function parseLots($, categoryName) {
  /** @type {Array<object>} */
  const lots = [];

  // -------- вариант 1: showcase-table карточки/ссылки --------
  $(
    "div.showcase-table a.tc-item, div.showcase-table div.tc-item, div.tc-item, a.tc-item, div.offer-card, div.card-item"
  ).each((_, card) => {
    const $card = $(card);
    const title = $card
      .find(
        ".tc-item-title, .card-title, .offer-title, .tc-desc-text, .showcase-item-title"
      )
      .first()
      .text()
      .trim();
    let description = $card
      .find(
        ".tc-item-description, .card-desc, .offer-desc, .tc-desc-text, .showcase-item-desc"
      )
      .text()
      .trim();
    if (!description) description = title;
    const priceText = $card
      .find(
        ".tc-item-price, .tc-price, .card-price, .offer-price, .showcase-item-price"
      )
      .text()
      .trim();
    const [price, currency] = splitPrice(priceText);
    const seller = $card.find("a[href*='/user/']").text().trim() || "";
    let lotHref =
      $card.find("a[href*='/lot/'], a[href*='/listing/'], a").attr("href") ||
      "";
    if (!lotHref && $card.is("a")) {
      const selfHref = $card.attr("href");
      if (selfHref) lotHref = selfHref;
    }
    const lotUrl = lotHref ? new URL(lotHref, BASE_URL).toString() : "";

    if (title || description) {
      lots.push({
        category: categoryName,
        title,
        description,
        price,
        currency,
        lot_url: lotUrl,
        images: "",
      });
    }
  });

  if (lots.length) return lots;

  // -------- вариант 2: таблица --------
  $("table tbody tr").each((_, row) => {
    const $row = $(row);
    // описание обычно в первом td (может быть вложенный a)
    const descTd = $row.find("td").first();
    const title = descTd.text().trim();
    const description = title;

    const seller = $row.find("td a[href*='/user/']").text().trim();
    const priceText = $row.find("td:last-child").text().trim();
    const [price, currency] = splitPrice(priceText);
    const lotHref =
      $row.find("a[href*='/lot/'], a[href*='/listing/']").attr("href") || "";
    const lotUrl = lotHref ? new URL(lotHref, BASE_URL).toString() : "";

    if (title || price) {
      lots.push({
        category: categoryName,
        title,
        description,
        price,
        currency,
        lot_url: lotUrl,
        images: "",
      });
    }
  });

  return lots;
}

/**
 * Write CSV header
 * @param {fs.WriteStream} stream
 */
function writeHeader(stream) {
  stream.write(
    "category;title;description;price;currency;lot_url;images" + "\n",
    "utf8"
  );
}

/**
 *
 * @param {string} field
 */
function esc(field) {
  if (field.includes(";")) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/**
 * Write lot row
 * @param {fs.WriteStream} stream
 * @param {object} lot
 */
function writeLot(stream, lot) {
  const line =
    [
      esc(stripEmoji(String(lot.category)) ?? ""),
      esc(stripEmoji(String(lot.title)) ?? ""),
      esc(stripEmoji(String(lot.description)) ?? ""),
      esc(String(lot.price)),
      esc(String(lot.currency)),

      esc(stripEmoji(String(lot.lot_url))),
      esc(String(lot.images || "")),
    ].join(";") + "\n";
  stream.write(line, "utf8");
}

async function uploadToImgur(imgUrl) {
  if (!imgurClientId) throw new Error("IMGUR client_id missing");

  // Пропускаем автоматическое получение OAuth-токена: работаем только с Client-ID или заданным токеном.

  // ---------- скачиваем изображение в каталог imgs ----------
  let origName =
    path.basename(new URL(imgUrl).pathname.split("?")[0]) || "image.jpg";
  if (!/\.[a-z0-9]+$/i.test(origName)) origName += ".jpg";
  const unique =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fileName = `${unique}_${origName}`;
  const filePath = path.join(IMG_DIR, fileName);

  try {
    const imgResp = await axios.get(imgUrl, {
      responseType: "arraybuffer",
      headers: { ...DEFAULT_HEADERS, Referer: BASE_URL },
      timeout: 25000,
    });
    if (imgResp.status !== 200) {
      throw new Error(
        "Не удалось скачать изображение, статус " + imgResp.status
      );
    }
    const ctype = imgResp.headers["content-type"] || "";
    if (!/^image\//i.test(ctype)) {
      throw new Error("Получен не image-файл: " + ctype);
    }
    fs.writeFileSync(filePath, Buffer.from(imgResp.data, "binary"));
  } catch (e) {
    throw new Error("Failed to download image: " + e.message);
  }

  // ---------- загружаем файл на Imgur как multipart ----------
  if (!fs.existsSync(filePath)) {
    throw new Error("Файл не существует: " + filePath);
  }
  try {
    const form = new FormData();
    // только файл, как в рабочем curl
    form.append("image", fs.createReadStream(filePath));

    // вычисляем Content-Length, иначе Imgur иногда отвечает 400
    const contentLength = await new Promise((res, rej) => {
      form.getLength((err, len) => {
        if (err) return rej(err);
        res(len);
      });
    });

    logCurlMultipart(fileName);

    // --- готовим вызов curl ---
    const proxyCfg = getRandomProxyConfig();
    const curlArgs = [];
    if (proxyCfg) {
      const auth = proxyCfg.auth
        ? `${proxyCfg.auth.username}:${proxyCfg.auth.password}@`
        : "";
      curlArgs.push("-x", `http://${auth}${proxyCfg.host}:${proxyCfg.port}`);
    }
    curlArgs.push(
      "-s", // silent
      "-H",
      `Authorization: Client-ID ${imgurClientId}`,
      "-F",
      `image=@${filePath}`,
      "https://api.imgur.com/3/image"
    );
    1452;

    if (verbose) {
      console.log("# CURL cmd:", "curl", curlArgs.join(" "));
    }

    let curlOut;
    try {
      curlOut = execFileSync("curl", curlArgs, { encoding: "utf8" });
    } catch (e) {
      throw new Error("curl upload failed: " + e.stderr || e.message);
    }

    let json;
    try {
      json = JSON.parse(curlOut.trim());
    } catch {
      throw new Error("Unexpected curl output: " + curlOut.slice(0, 200));
    }

    if (json?.success) {
      if (verbose) console.log("Image uploaded:", json.data.link);
      return json.data.link;
    }
    throw new Error("Ошибка от Imgur: " + JSON.stringify(json));
  } catch (err) {
    console.error("Upload error:", err.message);
    throw err;
  }
}

function logCurlMultipart(fileName) {
  if (!verbose) return;
  console.log(
    `\n# CURL: multipart upload\ncurl --location 'https://api.imgur.com/3/image' \\\n  --header 'Authorization: ${
      imgurAccessToken
        ? `Bearer ${imgurAccessToken}`
        : `Client-ID ${imgurClientId}`
    }' \\\n  --form 'image=@"${fileName}"'\n`
  );
}

async function crawl() {
  const categories = targetUrls.length
    ? targetUrls.map((u) => ({ name: new URL(u).pathname, url: u }))
    : await getCategories();
  console.log(`Будет обработано категорий/ссылок: ${categories.length}`);
  const outputPath = path.resolve(__dirname, output);
  const ws = fs.createWriteStream(outputPath, { encoding: "utf8" });
  writeHeader(ws);

  // Глобальный счётчик реально ЗАПИСАННЫХ (попавших в CSV) лотов
  let totalSaved = 0;

  for (const { name, url } of categories) {
    // Множество уже обработанных лотов (по ссылке на лот, либо по заголовку, если ссылки нет)
    /** @type {Set<string>} */
    const seenLots = new Set();
    console.log(`\n[CAT] ${name} → ${url}`);
    let page = 1;
    // URL, который переопределяет переход на следующую страницу (исп. кнопка «Показать ещё»)
    let nextUrlOverride = null;

    while (true) {
      const pageUrl =
        nextUrlOverride ||
        (page === 1
          ? url
          : url + (url.includes("?") ? "&" : "?") + `page=${page}`);
      // сбрасываем override, чтобы применился только для ОДНОГО перехода
      nextUrlOverride = null;
      let $;
      try {
        $ = await getPage(pageUrl);
      } catch (err) {
        console.warn("  [ERR] Не удалось загрузить страницу:", err.message);
        break;
      }
      const lots = parseLots($, name);
      // Если на странице не найдено лотов – конец пагинации
      if (!lots.length) {
        console.log(`  » страница ${page}: лоты не найдены (селектор)`);
        break; // конец пагинации
      }

      // -------- обнаружение повтора первой страницы (FunPay после последней страницы снова отдаёт первую) --------
      const firstLotKey = lots[0].lot_url || lots[0].title;
      if (page > 1 && seenLots.has(firstLotKey)) {
        console.log(
          `  » страница ${page}: распознана как повтор первой страницы – останавливаем обход`
        );
        break;
      }

      // Счётчик записанных лотов на текущей странице
      let savedOnPage = 0;

      for (const lot of lots) {
        // пропускаем уже записанные лоты (по ссылке или заголовку)
        const lotKey = lot.lot_url || lot.title;
        if (seenLots.has(lotKey)) continue;

        // помечаем лот как обработанный
        seenLots.add(lotKey);
        // -------- фильтр по языку (если указан) --------
        if (langFilter) {
          const txt = `${lot.title} ${lot.description}`;
          if (
            (langFilter === "ru" && !hasCyrillic(txt)) ||
            (langFilter === "en" && hasCyrillic(txt))
          ) {
            continue; // пропускаем неподходящий язык
          }
        }
        // --- фильтр по цене: нужны лоты ДОРЖЕ 2 € ---
        const numPrice = priceToNumber(lot.price);
        const cur = lot.currency;
        const EUR_THRESHOLD = 2;
        if (cur.includes("€") && numPrice <= EUR_THRESHOLD) continue;
        if (/₽|руб/i.test(cur) && numPrice * rubEurRate <= EUR_THRESHOLD)
          continue;

        // конвертируем ₽ → € при необходимости
        if (/₽|руб/i.test(cur) && Number.isFinite(numPrice)) {
          lot.price = (numPrice * rubEurRate).toFixed(2);
          lot.currency = "€";
        }

        // заход на страницу лота (без доп. парсинга; нужен лишь запрос)
        if (lot.lot_url) {
          try {
            const resp = await requestWithRetry(lot.lot_url, 3);
            const $lot = cheerio.load(resp.data);
            const detailed = $lot(
              "#content div.col-md-5.col-sm-9 div.param-list > div:nth-child(3) > div"
            )
              .text()
              .trim();
            if (detailed && detailed !== lot.title) {
              lot.description = detailed;
            }

            // -------- ссылка на продавца --------
            const sellerHref = $lot(
              "#content div.chat-header div.media-user-name a"
            ).attr("href");
            if (sellerHref) {
              lot.seller = new URL(sellerHref, BASE_URL).toString();
            }

            // ---------- изображения ----------
            if (uploadImages && imgurClientId) {
              const imgSrcs = [];

              // 1) обычные <img>
              $lot("#content img").each((_, img) => {
                let src =
                  $lot(img).attr("src") ||
                  $lot(img).attr("data-src") ||
                  $lot(img).attr("data-original");
                if (src && !src.startsWith("data:")) {
                  if (!/^https?:/i.test(src))
                    src = new URL(src, BASE_URL).toString();
                  if (
                    isAcceptedImage(src) &&
                    !isUserAvatar(src) &&
                    !imgSrcs.includes(src)
                  )
                    imgSrcs.push(src);
                }
              });

              // 2) элементы со style="background-image:url(...)"
              $lot('#content [style*="background-image"]').each((_, el) => {
                const style = $lot(el).attr("style") || "";
                const m = /background-image\s*:\s*url\(([^)]+)\)/i.exec(style);
                if (m && m[1]) {
                  let url = m[1].replace(/['"\s]/g, "");
                  if (!/^https?:/i.test(url))
                    url = new URL(url, BASE_URL).toString();
                  if (
                    isAcceptedImage(url) &&
                    !isUserAvatar(url) &&
                    !imgSrcs.includes(url)
                  )
                    imgSrcs.push(url);
                }
              });

              // 3) элементы списка param-list ul li (как указал пользователь)
              $lot("#content .param-list ul li").each((_, li) => {
                const style = $lot(li).attr("style") || "";
                const m = /url\(([^)]+)\)/i.exec(style);
                if (m && m[1]) {
                  let url = m[1].replace(/['"\s]/g, "");
                  if (!/^https?:/i.test(url))
                    url = new URL(url, BASE_URL).toString();
                  if (
                    isAcceptedImage(url) &&
                    !isUserAvatar(url) &&
                    !imgSrcs.includes(url)
                  )
                    imgSrcs.push(url);
                }
              });

              const links = [];
              for (const src of imgSrcs.slice(0, 5)) {
                try {
                  const link = await uploadToImgur(src);
                  links.push(link);
                  await sleep(1500);
                } catch (e) {
                  console.warn("    [IMGUR]", e.message);
                }
              }
              lot.images = links.join("|");
            }
          } catch (e) {
            console.warn("    [LOT ERR]", e.message);
          }
        }
        writeLot(ws, lot);
        savedOnPage += 1;
        totalSaved += 1;
      }
      console.log(
        `  » страница ${page}: сохранено ${savedOnPage} лотов (всего ${totalSaved})`
      );

      // --- ищем кнопку «Показать ещё» (или похожую) ---
      const loadMore = $("button[data-url]").first();
      const dataUrl = loadMore.attr("data-url")?.trim();
      if (dataUrl) {
        nextUrlOverride = new URL(dataUrl, BASE_URL).toString();
        if (verbose) console.log(`  [+] loadMore → ${nextUrlOverride}`);
      }

      page += 1;
      const delay = Math.random() * (delayMax - delayMin) + delayMin;
      await sleep(delay);
    }
  }
  ws.end();
  console.log(`\nВсего сохранено лотов: ${totalSaved}`);
  console.log(`Готово. Txt сохранён в ${outputPath}`);
}

crawl().catch((err) => {
  console.error(err);
  process.exit(1);
});
