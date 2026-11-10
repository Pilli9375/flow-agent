import type { Page } from "playwright-core";
import { FLOW_URL, getFlowPage, inEnglish } from "./chrome.js";
import { FlowUiError, find } from "./selectors.js";

export type FlowProject = { id: string; title: string; edited: string };

const ID = /\/project\/([0-9a-f-]{36})/;
const DATE = /^[A-Z][a-z]{2} \d{1,2} - \d{2}:\d{2}$/;
const NOISE = /^(edit|delete|more_vert|more_horiz|add|open_in_new|Edit project title|Delete project|Open project)$/;

export const currentProjectId = (page: Page): string | undefined => ID.exec(page.url())?.[1];

// Reads the project cards on Flow's home page. A card shows its title, or just a date when it is untitled.
async function readProjects(page: Page): Promise<FlowProject[]> {
  await page.waitForSelector("a[href*='/project/']", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/project/']")].map((a) => {
      let card: HTMLElement = a;
      while (card.parentElement && card.parentElement.querySelectorAll("a[href*='/project/']").length === 1) card = card.parentElement;
      return { href: a.getAttribute("href") ?? "", lines: card.innerText.split("\n").map((l) => l.trim()).filter(Boolean) };
    }),
  );
  return raw.flatMap(({ href, lines }) => {
    const id = ID.exec(href)?.[1];
    if (!id) return [];
    const text = lines.filter((l) => !NOISE.test(l));
    const edited = text.find((l) => DATE.test(l)) ?? "";
    return [{ id, title: text.find((l) => !DATE.test(l)) ?? "", edited }];
  });
}

// Lists the account's projects in a throwaway tab, so the open project (and its unsent prompt) is left alone.
export async function listProjects(): Promise<{ projects: FlowProject[]; current?: string }> {
  const main = await getFlowPage();
  const tab = await main.context().newPage();
  try {
    await tab.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
    return { projects: await readProjects(tab), current: currentProjectId(main) };
  } finally {
    await tab.close().catch(() => {});
  }
}

// Opens an existing project (full id or a unique prefix of at least 6 characters) or creates a new one ("new").
export async function openProject(target: string): Promise<string> {
  const page = await getFlowPage();
  if (target === "new") {
    await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
    await (await find(page, "new_project", {}, 20_000)).click();
    await page.waitForURL(ID, { timeout: 30_000 }).catch(() => {
      throw new FlowUiError("Flow did not open a new project after clicking New project.");
    });
  } else {
    let id = target.trim();
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      if (!/^[0-9a-f-]{6,35}$/.test(id)) throw new FlowUiError(`"${target}" is not a project id. Use flow_projects to list them.`);
      const matches = (await listProjects()).projects.filter((p) => p.id.startsWith(id));
      if (matches.length !== 1) throw new FlowUiError(matches.length ? `"${target}" matches ${matches.length} projects; give more of the id.` : `No project starts with "${target}".`);
      id = matches[0].id;
    }
    if (currentProjectId(page) !== id) await page.goto(inEnglish(`${FLOW_URL}project/${id}`), { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "What do you want to create?" }).waitFor({ timeout: 20_000 }).catch(() => {
      throw new FlowUiError(`Project ${id.slice(0, 8)} did not open (no prompt box). Check that it still exists.`);
    });
  }
  return currentProjectId(page) ?? "";
}
