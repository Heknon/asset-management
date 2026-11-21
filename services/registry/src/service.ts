import { defineService, envBool, registerBackup } from '@am/platform';
import { sql } from 'kysely';
import { AccessResolver } from './application/access.js';
import { AssetService } from './application/asset-service.js';
import { CatalogService } from './application/catalog-service.js';
import { CommentService } from './application/comment-service.js';
import { ExportService } from './application/export-service.js';
import { ImportService } from './application/import-service.js';
import { TypeService } from './application/type-service.js';
import { VariantService } from './application/variant-service.js';
import { RequestService } from './application/request-service.js';
import { SearchService } from './application/search-service.js';
import { PgRegistryStore } from './infrastructure/pg-registry-store.js';
import { migrations, type RegistryDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';

const registryConfig = {
  /** CSV export of tables, for everyone who can see the rows. */
  CSV_EXPORT_ENABLED: envBool(true),
};

/** Asset types, items, catalogs, requests, search. Runs the same on the server and in the browser. */
export const registryService = defineService<RegistryDB, typeof registryConfig>({
  name: 'registry',
  config: registryConfig,
  migrations,
  // Import chunks (500 rows) are the largest requests.
  bodyLimit: 4 * 1_048_576,
  async register({ config, database, app, bus, logger }) {
    // Typo-tolerant search needs pg_trgm; without it, prefix and substring search still work.
    const fuzzy = !!(await sql<{ ok: number }>`select 1 as ok from pg_extension where extname = 'pg_trgm'`.execute(database.db)).rows.length;
    const store = new PgRegistryStore(database.db, fuzzy);
    const access = new AccessResolver(store);
    const assets = new AssetService(store, access);
    const requests = new RequestService(store, assets);
    const comments = new CommentService(store, assets);
    registerRoutes(
      app,
      {
        types: new TypeService(store),
        variants: new VariantService(store),
        assets,
        catalogs: new CatalogService(store, access),
        comments,
        exports: new ExportService(store, assets, access),
        imports: new ImportService(store, assets),
        requests,
        search: new SearchService(store, assets, requests),
      },
      { csvExport: config.CSV_EXPORT_ENABLED },
    );

    await registerBackup(app, { name: 'registry', database, logger, enabled: config.BACKUP_ENABLED, bus });

    await bus.subscribe('registry', 'unit.changed', async (e) => {
      const prev = await store.getUnit(e.unitId);
      await store.upsertUnitRef({ id: e.unitId, key: e.key, name: e.name, kind: e.kind, parentId: e.parentId, path: e.path, archived: e.archived });
      // Renamed or moved: the search text of everything beneath it mentions the old path.
      if (prev && (prev.name !== e.name || prev.path.join() !== e.path.join())) await assets.reindex({ unitIds: [e.unitId] });
    });
    await bus.subscribe('registry', 'group.changed', (e) => store.upsertGroupRef({ id: e.groupId, name: e.name, source: e.source, memberCount: e.memberCount }));
    await bus.subscribe('registry', 'renewal.check', async (e) => {
      await comments.onRenewalCheck(e);
      await requests.onRenewalCheck(e);
    });
    await bus.subscribe('registry', 'user.changed', async (e) => {
      const { renamed } = await store.upsertUserRef({ id: e.userId, displayName: e.displayName, username: e.username, email: e.email, otherNames: e.otherNames, active: e.active, groupIds: e.groupIds });
      if (renamed) await assets.reindex({ userIds: [e.userId] });
    });

    // Assets created before search existed (or after an upgrade) get indexed in the background.
    // Once: re-store values by the current schemas (team secrets used to be kept with the open values).
    void (async () => {
      if (!(await store.getSetting('values_resplit_v1'))) {
        for (const id of await store.allAssetIds()) await store.transaction((tx) => tx.resplitAsset(id));
        await store.putSetting('values_resplit_v1', true);
      }
    })()
      .then(() => assets.reindex({ unindexed: true }))
      .then((n) => n && logger.info({ assets: n }, 'search index rebuilt'))
      .catch((err) => logger.error({ err }, 'search reindex failed'));
    logger.info({ fuzzy }, 'search ready');
  },
});
