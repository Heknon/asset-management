import { main, runService } from '@am/platform';
import { sql } from 'kysely';
import { AssetService } from './application/asset-service.js';
import { CatalogService } from './application/catalog-service.js';
import { RequestService } from './application/request-service.js';
import { SearchService } from './application/search-service.js';
import { PgRegistryStore } from './infrastructure/pg-registry-store.js';
import { migrations, type RegistryDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';

main(() =>
  runService<RegistryDB, {}>({
    name: 'registry',
    config: {},
    migrations,
    bodyLimit: 2 * 1_048_576,
    async register({ database, app, bus, logger }) {
      // Typo-tolerant search needs pg_trgm; without it, prefix and substring search still work.
      const fuzzy = !!(await sql<{ ok: number }>`select 1 as ok from pg_extension where extname = 'pg_trgm'`.execute(database.db)).rows.length;
      const store = new PgRegistryStore(database.db, fuzzy);
      const assets = new AssetService(store);
      const requests = new RequestService(store);
      registerRoutes(app, new CatalogService(store), assets, requests, new SearchService(store, assets, requests));

      await bus.subscribe('registry', 'unit.changed', async (e) => {
        const prev = await store.getUnit(e.unitId);
        await store.upsertUnitRef({ id: e.unitId, key: e.key, name: e.name, kind: e.kind, parentId: e.parentId, path: e.path, archived: e.archived });
        // Renamed or moved: the search text of everything beneath it mentions the old path.
        if (prev && (prev.name !== e.name || prev.path.join() !== e.path.join())) await assets.reindex({ unitIds: [e.unitId] });
      });
      await bus.subscribe('registry', 'user.changed', async (e) => {
        const { renamed } = await store.upsertUserRef({ id: e.userId, displayName: e.displayName, active: e.active });
        if (renamed) await assets.reindex({ userIds: [e.userId] });
      });

      // Assets created before search existed (or after an upgrade) get indexed in the background.
      void assets
        .reindex({ unindexed: true })
        .then((n) => n && logger.info({ assets: n }, 'search index rebuilt'))
        .catch((err) => logger.error({ err }, 'search reindex failed'));
      logger.info({ fuzzy }, 'search ready');
    },
  }),
);
