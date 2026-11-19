import { main, runService } from '@am/platform';
import { AssetService } from './application/asset-service.js';
import { CatalogService } from './application/catalog-service.js';
import { PgRegistryStore } from './infrastructure/pg-registry-store.js';
import { migrations, type RegistryDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';

main(() =>
  runService<RegistryDB, {}>({
    name: 'registry',
    config: {},
    migrations,
    bodyLimit: 2 * 1_048_576,
    async register({ database, app, bus }) {
      const store = new PgRegistryStore(database.db);
      registerRoutes(app, new CatalogService(store), new AssetService(store));

      await bus.subscribe('registry', 'purchase-class.changed', (e) =>
        store.upsertPurchaseClassRef({ id: e.purchaseClassId, key: e.key, name: e.name, archived: e.archived }),
      );
      await bus.subscribe('registry', 'user.changed', (e) => store.upsertUserRef({ id: e.userId, displayName: e.displayName, active: e.active }));
    },
  }),
);
