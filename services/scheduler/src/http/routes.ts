import { obligationActionSchema, obligationQuerySchema, summaryQuerySchema } from '@am/core';
import { parse, requireAdmin, requirePrincipal } from '@am/platform';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ObligationService } from '../application/obligation-service.js';
import type { ReminderDispatcher } from '../application/reminder-dispatcher.js';

const PREFIX = '/api/scheduler';

export function registerRoutes(app: FastifyInstance, obligations: ObligationService, dispatcher: ReminderDispatcher): void {
  app.get(`${PREFIX}/obligations`, async (req) => obligations.list(requirePrincipal(req), parse(obligationQuerySchema, req.query)));
  app.get(`${PREFIX}/summary`, async (req) => obligations.summary(requirePrincipal(req), parse(summaryQuerySchema, req.query)));
  app.get(`${PREFIX}/units/:id/rollup`, async (req) => obligations.rollup(requirePrincipal(req), parse(z.object({ id: z.string().uuid() }), req.params).id));
  app.post(`${PREFIX}/obligations/:id/actions`, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return obligations.act(requirePrincipal(req), id, parse(obligationActionSchema, req.body));
  });

  app.get(`${PREFIX}/calendar-feed`, async (req) => obligations.feedUrl(requirePrincipal(req), false));
  app.post(`${PREFIX}/calendar-feed/rotate`, async (req) => obligations.feedUrl(requirePrincipal(req), true));
  app.get(`${PREFIX}/calendar/:token`, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}\.ics$/) }), req.params);
    const body = await obligations.feed(token.slice(0, -4));
    return reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'private, max-age=900').send(body);
  });

  /** Lets administrators trigger a reminder run instead of waiting for the schedule. */
  app.post(`${PREFIX}/dispatch`, async (req) => {
    requireAdmin(req);
    return dispatcher.run();
  });
}
