import { z } from "zod";

export const TutorSelection = z.strictObject({
  file: z.string().max(200),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string().min(1).max(4_000),
});
export type TutorSelection = z.infer<typeof TutorSelection>;

export const TutorRequest = z.strictObject({
  message: z.string().trim().min(1).max(2_000),
  selection: TutorSelection.optional(),
  threadId: z.string().uuid().optional(),
});
export type TutorRequest = z.infer<typeof TutorRequest>;

export type TutorRole = "user" | "assistant";

export type TutorMessage = { role: TutorRole; content: string };

export type TutorThread = {
  id: string;
  learnerId: string;
  stageId: string;
  messages: TutorMessage[];
};

export type TutorReply = {
  threadId: string;
  reply: string;
  source: "llm" | "offline";
};
