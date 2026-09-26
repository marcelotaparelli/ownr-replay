import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DB_PATH: z.string().min(1).default("repo-replay.sqlite"),
  DATA_DIR: z.string().min(1).default("data/golden"),
  /** browser: development runner in the learner's tab (not a security boundary). docker: isolated server-side sandbox. */
  RUNNER: z.enum(["browser", "docker"]).default("browser"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TUTOR_MODEL: z.string().min(1).default("claude-opus-5"),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error("Invalid configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  }
  return parsed.data;
}
