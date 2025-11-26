import { Bot, InlineKeyboard } from "grammy";
import { z } from "zod";

const BOT_TOKEN = process.env.BOT_TOKEN!;
const GROUP_ID = Number(process.env.TELEGRAM_GROUP_ID!);
const TOPIC_COMMITS = Number(process.env.TELEGRAM_TOPIC_COMMITS!);
const TOPIC_PRS = Number(process.env.TELEGRAM_TOPIC_PRS!);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH!;

const bot = new Bot(BOT_TOKEN);

const FileNode = z.object({ path: z.string() });

const PullRequestSchema = z.object({
  action: z.string(),
  number: z.number(),
  repository: z.object({
    full_name: z.string(),
    html_url: z.url(),
  }),
  pull_request: z.object({
    html_url: z.url().optional(),
    url: z.url().optional(),
    title: z.string(),
    body: z.string().nullable(),
    user: z.object({ login: z.string(), html_url: z.url() }),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
    changed_files: z.number().optional().default(0),
    additions: z.number().optional().default(0),
    deletions: z.number().optional().default(0),
  }),
});

const PushSchema = z.object({
  ref: z.string(),
  repository: z.object({
    full_name: z.string(),
    html_url: z.url(),
  }),
  head_commit: z
    .object({
      id: z.string(),
      url: z.url(),
      message: z.string(),
      author: z.object({ name: z.string(), email: z.email() }),
      added: z.array(z.string()).optional().default([]),
      modified: z.array(z.string()).optional().default([]),
      removed: z.array(z.string()).optional().default([]),
    })
    .nullable(),
});

function detectLanguage(files: string[]): string {
  const ext = files.map((f) => (f.split(".").pop() || "").toLowerCase());
  if (ext.some((e) => e === "kt" || e === "kts")) return "Kotlin";
  if (ext.some((e) => e === "rs")) return "Rust";
  if (ext.some((e) => e === "c")) return "C";
  if (ext.some((e) => e === "sh")) return "Shell";
  if (ext.some((e) => e === "ts" || e === "tsx")) return "TypeScript";
  return "Other";
}

async function fetchPrFiles(
  repoFullName: string,
  prNumber: number,
): Promise<string[]> {
  const query = `
    query($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner, name:$name) {
        pullRequest(number:$number) {
          files(first:100) {
            nodes {
              path
            }
          }
        }
      }
    }`;
  const [owner, name] = repoFullName.split("/");
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { owner, name, number: prNumber },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub GraphQL API error: ${resp.status} ${body}`);
  }
  const json = (await resp.json()) as any;
  const nodes = json?.data?.repository?.pullRequest?.files?.nodes as
    | { path: string }[]
    | undefined;
  if (!nodes || !Array.isArray(nodes)) return [];
  return nodes.map((n) => n.path);
}

function prUrlOf(pr: { html_url?: string; url?: string }) {
  return pr.html_url ?? pr.url ?? "";
}

async function formatPrMessage(
  evt: z.infer<typeof PullRequestSchema>,
): Promise<{ text: string; fileLink: string }> {
  const pr = evt.pull_request;
  const repo = evt.repository;
  const files = await fetchPrFiles(repo.full_name, evt.number);
  const lang = detectLanguage(files);
  const prUrl = prUrlOf(pr);
  const fileLink = prUrl ? `${prUrl}/files` : repo.html_url;
  const bodyText = pr.body ? pr.body : "_No description provided_";
  const text =
    `### Repository\n[${repo.full_name}](${repo.html_url})\n\n` +
    `**Pull Request #${evt.number}:** [${pr.title}](${prUrl || repo.html_url})\n\n` +
    `**Author:** [${pr.user.login}](${pr.user.html_url})\n` +
    `**Files Changed:** ${pr.changed_files}\n` +
    `**Additions / Deletions:** +${pr.additions} / -${pr.deletions}\n` +
    `**Language:** ${lang}\n\n` +
    `**Description:**\n\`\`\`\n${bodyText}\n\`\`\``;
  return { text, fileLink };
}

function formatPushMessage(evt: z.infer<typeof PushSchema>): {
  text: string;
  fileLink: string;
} {
  const repo = evt.repository;
  const c = evt.head_commit;
  if (!c) {
    const text = `### Repository\n[${repo.full_name}](${repo.html_url})\n\nPush event detected, but no head commit data available.`;
    return { text, fileLink: repo.html_url };
  }
  const added = c.added ?? [];
  const modified = c.modified ?? [];
  const removed = c.removed ?? [];
  const details = [
    added.length ? `➕ Added: ${added.join(", ")}` : "",
    modified.length ? `✏️ Modified: ${modified.join(", ")}` : "",
    removed.length ? `❌ Removed: ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const lang = detectLanguage([...added, ...modified, ...removed]);
  const fileLink = c.url;
  const text =
    `### Repository\n[${repo.full_name}](${repo.html_url})\n\n` +
    `**Commit:** [${c.id}](${c.url})\n` +
    `**Author:** ${c.author.name} <${c.author.email}>\n` +
    `**Message:**\n\`\`\`\n${c.message}\n\`\`\`\n` +
    (details ? `**Changes:**\n${details}\n` : "") +
    `**Language:** ${lang}`;
  return { text, fileLink };
}

async function main(): Promise<void> {
  const raw = await (
    await import("node:fs/promises")
  ).readFile(EVENT_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  let messageObj: { text: string; fileLink: string };
  let topic: number;
  if ("pull_request" in parsed) {
    const prEvt = PullRequestSchema.parse(parsed);
    messageObj = await formatPrMessage(prEvt);
    topic = TOPIC_PRS;
  } else {
    const pushEvt = PushSchema.parse(parsed);
    messageObj = formatPushMessage(pushEvt);
    topic = TOPIC_COMMITS;
  }
  const repoUrl =
    (parsed.repository &&
      (parsed.repository.html_url ?? parsed.repository.url)) ||
    "";
  const keyboard = new InlineKeyboard()
    .url("View on GitHub", repoUrl)
    .row()
    .url("View Files", messageObj.fileLink);
  await bot.api.sendMessage(GROUP_ID, messageObj.text, {
    parse_mode: "Markdown",
    message_thread_id: topic,
    reply_markup: keyboard,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
