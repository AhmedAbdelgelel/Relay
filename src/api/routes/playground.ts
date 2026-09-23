import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serve(reply: FastifyReply, root: string, file: string): Promise<void> {
  const target = path.normalize(path.join(root, file));
  if (!target.startsWith(root)) {
    reply.status(403).send("forbidden");
    return;
  }
  try {
    const body = await readFile(target);
    const ext = path.extname(target).toLowerCase();
    reply.header("content-type", MIME[ext] ?? "application/octet-stream").send(body);
  } catch {
    reply.status(404).send("not found");
  }
}

export function registerPlayground(app: FastifyInstance): void {
  const root = path.join(process.cwd(), "public");
  app.get("/", async (_req, reply) => {
    await serve(reply, root, "index.html");
  });
  app.get("/styles.css", async (_req, reply) => {
    await serve(reply, root, "styles.css");
  });
  app.get("/js/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    await serve(reply, root, path.join("js", name));
  });
}
