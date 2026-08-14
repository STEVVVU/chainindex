import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { IndexerMetrics } from "./metrics";
import type { IndexStore } from "./store";

const eventQuerySchema = z.object({
  chainId: z.coerce.number().int().positive(),
  streamId: z.string().min(1).optional(),
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  eventName: z.string().min(1).optional(),
  fromBlock: z.coerce.number().int().nonnegative().optional(),
  toBlock: z.coerce.number().int().nonnegative().optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

export const buildApi = (
  store: IndexStore,
  metrics: IndexerMetrics
): FastifyInstance => {
  const app = Fastify({
    logger: true,
    requestTimeout: 10_000
  });

  app.get("/health", () => ({
    status: "ok",
    checkpoints: store.listCheckpoints(),
    backfills: store.listBackfills()
  }));

  app.get("/v1/checkpoints", () => ({
    data: store.listCheckpoints()
  }));

  app.get("/v1/backfills", () => ({
    data: store.listBackfills()
  }));

  app.get("/v1/events", async (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_query",
        details: parsed.error.flatten()
      });
    }
    if (
      parsed.data.fromBlock !== undefined &&
      parsed.data.toBlock !== undefined &&
      parsed.data.fromBlock > parsed.data.toBlock
    ) {
      return reply.code(400).send({
        error: "invalid_query",
        details: "fromBlock must not exceed toBlock"
      });
    }
    const events = store.queryEvents(parsed.data);
    return {
      data: events,
      nextCursor: events.length === parsed.data.limit ? events.at(-1)?.id ?? null : null
    };
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
};
