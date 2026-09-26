import type { Repository } from "../db/repository.ts";
import type { Journey } from "../domain/journey.ts";
import type { Stage } from "../domain/stage.ts";
import type { TutorMessage, TutorReply, TutorRequest } from "../domain/tutor.ts";
import type { Logger } from "../obs/logger.ts";
import type { Metrics } from "../obs/metrics.ts";
import { systemPrompt, tutorContext, userPrompt } from "./tutor-context.ts";
import { offlineAnswer } from "./tutor-offline.ts";

/** Any LLM able to continue a conversation. The product never depends on a specific one. */
export interface TutorModel {
  complete(input: { system: string; messages: TutorMessage[] }): Promise<string>;
}

export class TutorService {
  constructor(
    private readonly repository: Repository,
    private readonly model: TutorModel | null,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async ask(learnerId: string, journey: Journey, stage: Stage, request: TutorRequest): Promise<TutorReply> {
    const started = performance.now();
    const threadId = request.threadId ?? crypto.randomUUID();
    const context = tutorContext(journey, stage, request.selection);
    const history = request.threadId ? this.repository.tutorHistory(threadId, learnerId, stage.id) : [];

    let reply: string;
    let source: TutorReply["source"] = "offline";
    if (this.model) {
      try {
        reply = await this.model.complete({
          system: systemPrompt(context),
          messages: [...history, { role: "user", content: userPrompt(request.message, request.selection) }],
        });
        source = "llm";
      } catch (error) {
        this.metrics.increment("tutor_llm_failures_total");
        this.logger.error("tutor_llm_failed", { stageId: stage.id, error: String(error) });
        reply = offlineAnswer(context, request.message);
      }
    } else {
      reply = offlineAnswer(context, request.message);
    }

    // The question is stored without the selection; the event keeps its shape.
    this.repository.appendTutorMessage(threadId, learnerId, stage.id, "user", request.message);
    this.repository.appendTutorMessage(threadId, learnerId, stage.id, "assistant", reply);
    this.repository.appendEvent({
      learnerId,
      journeyId: journey.id,
      stageId: stage.id,
      type: "tutor_question",
      data: { source, withSelection: Boolean(request.selection) },
    });
    const ms = performance.now() - started;
    this.metrics.observe("tutor_request_duration", ms);
    this.logger.info("tutor_request", { stageId: stage.id, source, latencyMs: Math.round(ms) });
    return { threadId, reply, source };
  }
}
