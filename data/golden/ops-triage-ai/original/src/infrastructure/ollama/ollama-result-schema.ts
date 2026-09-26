import { z } from "zod";
import {
  Category,
  Priority,
  Risk,
} from "../../domain/triage.ts";

export const OllamaClassifierResultSchema = z.strictObject({
  category: z.enum(Category),
  priority: z.enum(Priority),
  risk: z.enum(Risk),
  confidence: z.union([z.literal(0.5), z.literal(0.7), z.literal(0.9)]),
  summary: z.string().min(1).max(160).refine((value) => value.trim().length > 0),
  rationale: z.string().min(1).max(240).refine((value) => value.trim().length > 0),
});

export const OLLAMA_CLASSIFIER_RESULT_JSON_SCHEMA = z.toJSONSchema(
  OllamaClassifierResultSchema,
);
