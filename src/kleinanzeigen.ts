import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "rebrowser-playwright";
import { newInjectedContext } from "fingerprint-injector";
import { createCursor } from "ghost-cursor-playwright";
import type { RawCard } from "./types";

const BASE_URL = "https://www.kleinanzeigen.de";
const SEARCH_PATH = "/s-wohnung-mieten/hamburg/c203l9409";

function resolveChromiumPath(): string | undefined {
  if (process.env.SCRAPE_CHROMIUM_PATH) return process.env.SCRAPE_CHROMIUM_PATH;

  const os = platform();
  const cacheDir =
    os === "darwin"
      ? path.join(homedir(), "Library/Caches/ms-playwright")
      : os === "linux"
        ? path.join(homedir(), ".cache/ms-playwright")
        : null;
  if (!cacheDir || !existsSync(cacheDir)) return undefined;

  const candidates = readdirSync(cacheDir)
    .filter((e) => e.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();

  const subPaths = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac/chrome-headless-shell",
    "chrome-headless-shell-linux/chrome-headless-shell",
    "chrome-mac-arm64/headless_shell",
    "chrome-mac/headless_shell",
    "chrome-linux/headless_shell",
  ];

  for (const entry of candidates) {
    for (const sub of subPaths) {
      const candidate = path.join(cacheDir, entry, sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

async function extractListingsFromPage(page: Page): Promise<RawCard[]> {
  return page.evaluate((origin): RawCard[] => {
    const items = Array.from(
      document.querySelectorAll("article.aditem"),
    ) as HTMLElement[];

    return items
      .map((el): RawCard | null => {
        const id = el.getAttribute("data-adid") ?? "";
        const linkEl = el.querySelector<HTMLAnchorElement>("a.ellipsis");
        const url = linkEl?.getAttribute("href") ?? "";
        const title = (linkEl?.textContent ?? "").trim();
        const priceText = (
          el.querySelector(".aditem-main--middle--price-shipping--price")
            ?.textContent ?? ""
        ).trim();
        const locationText = (
          el.querySelector(".aditem-main--top--left")?.textContent ?? ""
        ).trim();
        const tags = Array.from(
          el.querySelectorAll(".text-module-end, .simpletag"),
        )
          .map((t) => (t.textContent ?? "").trim())
          .filter(Boolean);
        const thumbnailUrl =
          el.querySelector<HTMLImageElement>("img.imagebox-thumbnail")?.src ??
          el.querySelector<HTMLImageElement>(".aditem-image img")?.src ??
          null;
        const postedAt =
          el.querySelector(".aditem-main--top--right")?.textContent?.trim() ??
          null;

        if (!id || !url || !title) return null;

        return {
          id,
          url: url.startsWith("http") ? url : origin + url,
          title,
          priceText,
          locationText,
          tags,
          thumbnailUrl,
          postedAt,
        };
      })
      .filter((x): x is RawCard => x !== null);
  }, BASE_URL);
}

export interface ScrapeOptions {
  maxPages: number;
  headless: boolean;
}

export async function scrapeKleinanzeigen(
  options: ScrapeOptions,
): Promise<RawCard[]> {
  const executablePath = resolveChromiumPath();
  if (executablePath) {
    console.log(`[kleinanzeigen] using chromium at ${executablePath}`);
  } else {
    console.log(
      "[kleinanzeigen] no chromium override — letting rebrowser pick default",
    );
  }

  const browser: Browser = await chromium.launch({
    headless: options.headless,
    ...(executablePath ? { executablePath } : {}),
  });

  const context = await newInjectedContext(
    browser as unknown as Parameters<typeof newInjectedContext>[0],
    {
      fingerprintOptions: {
        devices: ["desktop"],
        operatingSystems: ["macos", "windows"],
        browsers: ["chrome"],
        locales: ["de-DE", "de"],
      },
      newContextOptions: {
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
      },
    },
  );

  const page = (await context.newPage()) as unknown as Page;
  const cursor = await createCursor(
    page as unknown as Parameters<typeof createCursor>[0],
  );

  const collected = new Map<string, RawCard>();

  try {
    for (let i = 1; i <= options.maxPages; i++) {
      const url =
        i === 1
          ? `${BASE_URL}${SEARCH_PATH}`
          : `${BASE_URL}/seite:${i}${SEARCH_PATH}`;
      console.log(`[kleinanzeigen] page ${i} → ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      const blocked = await page.locator("text=Zugriff verweigert").count();
      if (blocked > 0) {
        console.warn("[kleinanzeigen] blocked — stopping early");
        break;
      }

      await page
        .waitForSelector("article.aditem", { timeout: 15000 })
        .catch(() => null);

      const moves = 2 + Math.floor(Math.random() * 2);
      await cursor.actions.randomMove(moves).catch(() => null);

      await randomDelay(800, 1800);

      const cards = await extractListingsFromPage(page);
      console.log(`[kleinanzeigen] page ${i}: ${cards.length} cards`);
      for (const card of cards) {
        if (!collected.has(card.id)) collected.set(card.id, card);
      }

      if (cards.length === 0) break;
      if (i < options.maxPages) await randomDelay(3000, 6000);
    }
  } finally {
    await browser.close();
  }

  return Array.from(collected.values());
}
