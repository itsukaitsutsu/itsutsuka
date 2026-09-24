/**
 * Cloudflare Pages Function — every /api/* request is served by the exact same
 * Hono app you run locally with `npm run dev:api`.
 *
 * Why this file exists: a Pages deploy uploads `dist/public` as STATIC FILES
 * only. Without it, https://mykotoba.pages.dev/api/me returns your app's own
 * "404 Page Not Found" page instead of JSON, so nothing saves or loads.
 *
 * One-time setup — Cloudflare dashboard → Workers & Pages → mykotoba:
 *   Settings → Functions → D1 database bindings → Add binding
 *       Variable name: DB          D1 database: mykotoba-db
 *   Settings → Environment variables → Add
 *       FIREBASE_PROJECT_ID = kotobacabinet
 *   (add both to Production *and* Preview)
 *   Ranked rooms also require a MATCH_ROOM Durable Object binding to the
 *   MatchRoom class exported by the deployed mykotoba Worker. See
 *   docs/RANKED_PARTY_FIX.md; Pages alone cannot deploy a Durable Object.
 */
import app from '../../worker/index';

type PagesContext = {
  request: Request;
  env: Record<string, unknown>;
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
};

export const onRequest = async (context: PagesContext): Promise<Response> =>
  await app.fetch(
    context.request,
    context.env as Parameters<typeof app.fetch>[1],
    context as unknown as ExecutionContext,
  );
