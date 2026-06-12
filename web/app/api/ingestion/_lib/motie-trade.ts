// 산업통상부 보도자료에서 '수출입 동향' PDF 를 찾아 내려받는다.
// 사이트 구조(2026 기준):
//  - 목록: https://www.motir.go.kr/kor/article/ATCL3f49a5a8c?pageIndex=N
//          제목 링크 href="javascript:article.view('171880');" (글ID), 텍스트=제목
//  - 상세: /kor/article/ATCL3f49a5a8c/{id}/view
//  - 첨부: href="javascript:location.href='/attach/down/{h1}/{h2}/{h3}'", 텍스트=파일명 [크기]
// 다운로드는 세션 쿠키(JSESSIONID) + 브라우저 헤더(Referer/Sec-Fetch/Accept-Language)가 필요하다.
import * as cheerio from "cheerio";

const BASE = "https://www.motir.go.kr";
const LIST_PATH = "/kor/article/ATCL3f49a5a8c";
const LIST_MAX_PAGES = 15;
const FETCH_TIMEOUT_MS = 25000;
const FETCH_MAX_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 600;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 정부 사이트가 간헐적으로 끊는(ECONNRESET 등) 일시 오류 판별.
const isTransientNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  const haystack = `${code} ${cause?.message ?? ""} ${error.message}`.toUpperCase();
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "SOCKET HANG UP",
    "FETCH FAILED",
    "TERMINATED",
  ].some((needle) => haystack.includes(needle));
};
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type ItemTradePdf = {
  buffer: Buffer;
  fileName: string;
  postUrl: string;
  reportMonth: string; // YYYY-MM-01
};

// 스크랩 세션: 응답의 JSESSIONID 등을 모아 다음 요청에 보낸다.
class Session {
  private cookies = new Map<string, string>();

  private cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private captureCookies(response: Response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async fetch(url: string, opts: { referer?: string; binary?: boolean } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ko-KR,ko;q=0.9",
        Accept: opts.binary
          ? "application/pdf,application/octet-stream,*/*;q=0.8"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
      };
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = cookie;
      if (opts.referer) headers.Referer = opts.referer;

      let lastError: unknown = null;
      for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers,
            redirect: "follow",
          });
          this.captureCookies(response);
          // 5xx 는 일시 오류로 보고 재시도
          if (response.status >= 500 && attempt < FETCH_MAX_ATTEMPTS) {
            lastError = new Error(`HTTP ${response.status}`);
            await sleep(FETCH_RETRY_BASE_MS * attempt);
            continue;
          }
          if (!response.ok) {
            throw new Error(`산업부 사이트 요청 실패 (HTTP ${response.status})`);
          }
          return response;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(
              `산업부 사이트 응답 시간 초과 (${Math.round(FETCH_TIMEOUT_MS / 1000)}초): ${url}`,
            );
          }
          lastError = error;
          if (isTransientNetworkError(error) && attempt < FETCH_MAX_ATTEMPTS) {
            await sleep(FETCH_RETRY_BASE_MS * attempt);
            continue;
          }
          const cause = (error as { cause?: { code?: string; message?: string } }).cause;
          const detail =
            cause?.code || cause?.message || (error instanceof Error ? error.message : String(error));
          throw new Error(`산업부 사이트 연결 실패 (${detail}): ${url}`);
        }
      }
      const cause = (lastError as { cause?: { code?: string } })?.cause;
      throw new Error(
        `산업부 사이트 연결 실패 (재시도 ${FETCH_MAX_ATTEMPTS}회 초과${
          cause?.code ? `, ${cause.code}` : ""
        }): ${url}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// 제목이 "{year}년 {month}월 수출입 동향" 인지 검사 (상반기/연간 변형 제외).
const matchesMonthlyReport = (title: string, year: number, month: number) => {
  const match = title
    .replace(/\s+/g, " ")
    .match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*수출입\s*동향/);
  if (!match) return false;
  return Number(match[1]) === year && Number(match[2]) === month;
};

type FoundPost = { postId: string; title: string };

const findReport = async (
  session: Session,
  year: number,
  month: number,
): Promise<FoundPost | null> => {
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const response = await session.fetch(`${BASE}${LIST_PATH}?pageIndex=${page}`);
    const html = await response.text();
    const $ = cheerio.load(html);

    let found: FoundPost | null = null;
    // 제목 링크는 href="javascript:article.view('171880');" 형태, 텍스트=제목.
    $("a").each((_, el) => {
      if (found) return;
      const attr = `${$(el).attr("href") ?? ""} ${$(el).attr("onclick") ?? ""}`;
      const idMatch = attr.match(/article\.view\('(\d+)'\)/);
      if (!idMatch) return;
      const title = $(el).text().replace(/\s+/g, " ").trim();
      if (matchesMonthlyReport(title, year, month)) {
        found = { postId: idMatch[1], title };
      }
    });
    if (found) return found;
  }
  return null;
};

type Attachment = { fileName: string; downloadUrl: string };

const getPdfAttachment = async (
  session: Session,
  postUrl: string,
): Promise<Attachment | null> => {
  const response = await session.fetch(postUrl);
  const html = await response.text();
  const $ = cheerio.load(html);

  const pdfs: Attachment[] = [];
  // 다운로드 링크는 href="javascript:location.href='/attach/down/{h1}/{h2}/{h3}'",
  // 파일명 텍스트에는 " [1,783.3 KB]" 같은 크기 접미사가 붙는다.
  $("a").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const pathMatch = href.match(/\/attach\/down\/[^'"\s]+/);
    if (!pathMatch) return;
    const rawText = $(el).text().replace(/\s+/g, " ").trim();
    if (!/\.pdf\b/i.test(rawText)) return;
    const fileName = rawText.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    pdfs.push({ fileName, downloadUrl: `${BASE}${pathMatch[0]}` });
  });

  if (pdfs.length === 0) return null;
  // 파일명에 '수출입동향' 이 포함된 PDF 우선, 없으면 첫 PDF.
  const preferred = pdfs.find((p) =>
    p.fileName.replace(/\s+/g, "").includes("수출입동향"),
  );
  return preferred ?? pdfs[0];
};

const downloadPdf = async (
  session: Session,
  url: string,
  referer: string,
): Promise<Buffer> => {
  const response = await session.fetch(url, { referer, binary: true });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) {
    throw new Error("내려받은 PDF 가 비어 있습니다.");
  }
  if (buffer.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error(
      "첨부 파일이 PDF 형식이 아닙니다. (산업부 사이트 첨부 다운로드 상태를 확인하세요)",
    );
  }
  return buffer;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 지정한 연/월의 '수출입 동향' 보도자료에서 본문 PDF 를 내려받는다.
 */
export const fetchItemTradePdf = async (
  year: number,
  month: number,
): Promise<ItemTradePdf> => {
  const session = new Session();
  const post = await findReport(session, year, month);
  if (!post) {
    throw new Error(
      `산업부 보도자료에서 '${year}년 ${month}월 수출입 동향' 게시글을 찾지 못했습니다.`,
    );
  }
  const postUrl = `${BASE}${LIST_PATH}/${post.postId}/view`;
  const attachment = await getPdfAttachment(session, postUrl);
  if (!attachment) {
    throw new Error("게시글에서 PDF 첨부파일을 찾지 못했습니다.");
  }
  const buffer = await downloadPdf(session, attachment.downloadUrl, postUrl);
  return {
    buffer,
    fileName: attachment.fileName,
    postUrl,
    reportMonth: `${year}-${pad2(month)}-01`,
  };
};
