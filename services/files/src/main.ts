import { main, runService } from '@am/platform/node';
import { nodeFilesAdapters } from './node.js';
import { defineFilesService } from './service.js';

main(() => runService(defineFilesService(nodeFilesAdapters())));
