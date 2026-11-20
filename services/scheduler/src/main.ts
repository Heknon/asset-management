import { main, runService } from '@am/platform/node';
import { nodeSchedulerAdapters } from './node.js';
import { defineSchedulerService } from './service.js';

main(() => runService(defineSchedulerService(nodeSchedulerAdapters)));
