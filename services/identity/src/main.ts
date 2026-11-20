import { main, runService } from '@am/platform/node';
import { nodeIdentityAdapters } from './node.js';
import { defineIdentityService } from './service.js';

main(() => runService(defineIdentityService(nodeIdentityAdapters)));
