import * as cheerio from "cheerio";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import type { PageAuthorInfo } from "./types.js";

const config = loadConfig();
const TOKEN7 = "kakushi";
const USER_AGENT = "Notifier/1.0";
const AJAX_MAX_RETRIES = 5;
const AJAX_BASE_DELAY = 400;

export async function queryPageAuthor(
  wiki: string,
  page: string
): Promise<PageAuthorInfo | null> {
  const result = await queryGraphQL(wiki, page);
  if (result) return result;

  log.info({ wiki, page }, "GraphQL failed, falling back to AJAX");
  return queryPageAuthorViaAjax(wiki, page);
}

async function queryGraphQL(
  wiki: string,
  page: string
): Promise<PageAuthorInfo | null> {
  const query = `query { article(wiki: "${wiki}", page: "${page}") { author created_at lastmod } }`;

  try {
    const res = await fetch(config.wikit.graphql_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      log.warn({ status: res.status, wiki, page }, "GraphQL request failed");
      return null;
    }

    const json = (await res.json()) as { data?: { article?: PageAuthorInfo } };
    return json.data?.article ?? null;
  } catch (err) {
    log.warn({ err, wiki, page }, "GraphQL request error");
    return null;
  }
}

async function getPageId(siteUrl: string, page: string): Promise<string | null> {
  try {
    const url = `${siteUrl}/${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/WIKIREQUEST\.info\.pageId\s*=\s*(\d+);/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface AmcResponse {
  status: string;
  body?: string;
  message?: string;
}

async function callAjax(
  wiki: string,
  moduleName: string,
  params: Record<string, string | number>
): Promise<AmcResponse | null> {
  const url = `https://${wiki}.wikidot.com/ajax-module-connector.php`;
  const formData = new URLSearchParams({
    moduleName,
    wikidot_token7: TOKEN7,
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ),
  });

  for (let attempt = 0; attempt < AJAX_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
          Referer: `https://${wiki}.wikidot.com/`,
          Cookie: `wikidot_token7=${TOKEN7}`,
        },
        body: formData.toString(),
      });

      if (res.status === 429 || res.status >= 500) {
        await sleep(AJAX_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }

      const json = (await res.json()) as AmcResponse;
      if (json.status === "try_again") {
        await sleep(AJAX_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      if (json.status !== "ok") return null;
      return json;
    } catch {
      if (attempt === AJAX_MAX_RETRIES - 1) return null;
      await sleep(AJAX_BASE_DELAY * Math.pow(2, attempt));
    }
  }
  return null;
}

async function queryPageAuthorViaAjax(
  wiki: string,
  page: string
): Promise<PageAuthorInfo | null> {
  const siteUrl = `https://${wiki}.wikidot.com`;
  const pageId = await getPageId(siteUrl, page);
  if (!pageId) {
    log.warn({ wiki, page }, "AJAX fallback: pageId not found");
    return null;
  }

  const resp = await callAjax(wiki, "history/PageRevisionListModule", {
    page: 1,
    perpage: 10000,
    page_id: pageId,
  });
  if (!resp?.body) {
    log.warn({ wiki, page }, "AJAX fallback: empty history response");
    return null;
  }

  const $ = cheerio.load(resp.body);
  const rows = $("tr[id^='revision-row-']");
  if (!rows.length) {
    log.warn({ wiki, page }, "AJAX fallback: no revision rows");
    return null;
  }

  let author: string | null = null;
  let createdAt: string | null = null;

  rows.each((_, row) => {
    const tds = $(row).find("td");
    const rev = tds.first().text().trim().replace(/\.$/, "");
    if (rev !== "0") return;

    const img = $(row).find("img[alt]").first();
    if (img.length) {
      author = img.attr("alt")?.trim() ?? null;
    }
    if (!author) {
      const userLink = $(row).find("a[href*='/user:info/']").first();
      if (userLink.length) {
        author = userLink.text().trim() || null;
      }
    }

    const timeSpan = $(row).find("span[class*='time_']").first();
    if (timeSpan.length) {
      const cls = timeSpan.attr("class") ?? "";
      const m = cls.match(/time_(\d+)/);
      if (m) {
        createdAt = new Date(parseInt(m[1], 10) * 1000).toISOString();
      }
    }
  });

  if (!author) {
    log.warn({ wiki, page }, "AJAX fallback: rev:0 author not found");
    return null;
  }

  log.info({ wiki, page, author }, "AJAX fallback: got page author");
  return { author, created_at: createdAt, lastmod: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
